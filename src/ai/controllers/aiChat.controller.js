const asyncHandler = require('../../middleware/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const { buildAiRequestContext } = require('../utils/aiRequestContext');
const { initSse, writeSse } = require('../utils/streamWriter');
const chatService = require('../services/chat.service');
const conversationService = require('../services/conversation.service');
const { executeConfirmedWriteTool, listWriteTools } = require('../services/writeTool.service');

const status = asyncHandler(async (req, res) => {
  ApiResponse.success(res, chatService.getStatus());
});

const suggestedPrompts = asyncHandler(async (req, res) => {
  ApiResponse.success(res, { prompts: chatService.getSuggestedPrompts(req.user) });
});

const createConversation = asyncHandler(async (req, res) => {
  const conv = await conversationService.createConversation(
    req.companyId,
    req.user.userId,
    req.body.title
  );
  ApiResponse.created(res, conv);
});

const listConversations = asyncHandler(async (req, res) => {
  const result = await conversationService.listConversations(req.companyId, req.user.userId, req.query);
  ApiResponse.paginated(res, result);
});

const getConversation = asyncHandler(async (req, res) => {
  const data = await conversationService.getConversationWithMessages(
    req.companyId,
    req.user.userId,
    req.params.id
  );
  ApiResponse.success(res, data);
});

const deleteConversation = asyncHandler(async (req, res) => {
  await conversationService.archiveConversation(req.companyId, req.user.userId, req.params.id);
  ApiResponse.success(res, { archived: true });
});

const chat = asyncHandler(async (req, res) => {
  const ctx = buildAiRequestContext(req, req.body.context);
  const result = await chatService.processChatTurn(ctx, {
    conversationId: req.body.conversationId,
    message: req.body.message
  });
  ApiResponse.success(res, result);
});

const chatStream = asyncHandler(async (req, res) => {
  initSse(res);
  writeSse(res, 'status', { message: 'Connected' });

  const ctx = buildAiRequestContext(req, req.body.context);

  try {
    const result = await chatService.processChatTurn(ctx, {
      conversationId: req.body.conversationId,
      message: req.body.message,
      onEvent: (ev) => {
        if (ev.type === 'token') writeSse(res, 'token', { content: ev.content });
        else if (ev.type === 'status') writeSse(res, 'status', { message: ev.message });
        else if (ev.type === 'tool_start') writeSse(res, 'tool_start', ev);
        else if (ev.type === 'tool_end') writeSse(res, 'tool_end', ev);
        else if (ev.type === 'error') writeSse(res, 'error', ev);
      }
    });
    writeSse(res, 'done', {
      conversationId: result.conversationId,
      messageId: result.messageId,
      content: result.content
    });
  } catch (err) {
    writeSse(res, 'error', {
      message: err.message || 'AI Copilot is temporarily unavailable.'
    });
  } finally {
    res.end();
  }
});

const executeConfirmedTool = asyncHandler(async (req, res) => {
  const ctx = buildAiRequestContext(req, req.body.context);
  const result = await executeConfirmedWriteTool(ctx, req.body.toolName, req.body.parameters);
  ApiResponse.success(res, result);
});

const writeToolsCatalog = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, { tools: listWriteTools() });
});

module.exports = {
  status,
  suggestedPrompts,
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  chat,
  chatStream,
  executeConfirmedTool,
  writeToolsCatalog
};
