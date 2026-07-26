const aiEnv = require('../config/aiEnv');
const { getProvider } = require('../config/providerRegistry');
const { buildSystemMessages } = require('./promptBuilder.service');
const { validateClientContext } = require('./contextBuilder.service');
const { runAgentLoopWithContext } = require('./agentLoop.service');
const { classifyUserIntent } = require('../utils/messageIntent.util');
const conversationService = require('./conversation.service');
const { logInteraction } = require('./aiLog.service');
const { ProviderUnavailableError, ProviderTimeoutError } = require('../providers/providerErrors');

async function processChatTurn(ctx, { conversationId, message, onEvent }) {
  const started = Date.now();
  ctx = validateClientContext(ctx);
  const provider = getProvider();

  let conv;
  let priorHistory = [];
  if (conversationId) {
    conv = await conversationService.assertConversationAccess(ctx.companyId, ctx.userId, conversationId);
    priorHistory = await conversationService.loadHistoryForLlm(ctx.companyId, conv._id);
  } else {
    conv = await conversationService.createConversation(ctx.companyId, ctx.userId);
  }

  await conversationService.appendMessage(ctx.companyId, conv._id, {
    role: 'user',
    content: message
  });

  const priorTurns = priorHistory.filter((h) => h.role === 'user' || h.role === 'assistant');
  const intent = classifyUserIntent(message, { hasPriorTurns: priorTurns.length > 0 });
  const systemMessages = buildSystemMessages(ctx, { intent });

  let content = '';
  let toolTrace = [];
  let success = true;
  let errorMessage = null;

  try {
    const result = await runAgentLoopWithContext(ctx, {
      systemMessages,
      history: priorTurns,
      userMessage: message,
      socialMode: intent === 'social',
      onEvent
    });
    content = result.content;
    toolTrace = result.toolTrace;
  } catch (err) {
    success = false;
    if (err instanceof ProviderUnavailableError || err instanceof ProviderTimeoutError) {
      errorMessage = err.userMessage;
      content = err.userMessage;
    } else {
      errorMessage = err.message;
      content = 'Something went wrong while processing your request. Please try again.';
    }
    if (onEvent) onEvent({ type: 'error', message: content });
  }

  const assistantMsg = await conversationService.appendMessage(ctx.companyId, conv._id, {
    role: 'assistant',
    content,
    metadata: { toolTrace }
  });

  await logInteraction({
    companyId: ctx.companyId,
    userId: ctx.userId,
    conversationId: conv._id,
    provider: provider.getName(),
    model: provider.getModel(),
    question: message,
    response: content,
    toolCalls: toolTrace,
    durationMs: Date.now() - started,
    success,
    errorMessage,
    clientContext: ctx.clientContext
  });

  return {
    conversationId: conv._id,
    messageId: assistantMsg._id,
    content,
    toolTrace
  };
}

function getStatus() {
  const provider = getProvider();
  return {
    enabled: aiEnv.globalEnabled,
    provider: provider.getName(),
    model: provider.getModel(),
    streaming: aiEnv.streaming
  };
}

const SUGGESTED_PROMPTS = {
  mrep: [
    'How many visits have I completed today?',
    "Show today's plan.",
    'Show pending visits.',
    "Show today's attendance."
  ],
  manager: [
    "Compare my team's performance.",
    'Which representatives are behind target?',
    'Why are sales lower this month?',
    'Which territories need attention?'
  ],
  admin: [
    'Inventory overview.',
    'Company sales summary.',
    'Revenue trends.',
    'Active users overview.'
  ],
  superadmin: [
    'Platform usage summary.',
    'Company-wide analytics.',
    'Tenant statistics.',
    'Feature adoption overview.'
  ]
};

function getSuggestedPrompts(user) {
  const { resolveRoleKind } = require('../prompts/rolePrompts');
  const kind = resolveRoleKind(user);
  if (kind === 'superadmin') return SUGGESTED_PROMPTS.superadmin;
  if (kind === 'manager') return SUGGESTED_PROMPTS.manager;
  if (kind === 'admin') return SUGGESTED_PROMPTS.admin;
  return SUGGESTED_PROMPTS.mrep;
}

module.exports = { processChatTurn, getStatus, getSuggestedPrompts };
