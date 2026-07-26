const ApiError = require('../../utils/ApiError');
const { getTool, ALL_TOOLS } = require('../tools/registry');
const { sanitizeToolResult } = require('../utils/sanitizeToolResult');
const { logInteraction } = require('../services/aiLog.service');
const { getProvider } = require('../config/providerRegistry');

async function executeConfirmedWriteTool(ctx, toolName, parameters) {
  const tool = getTool(toolName);
  if (!tool) throw new ApiError(400, `Unknown tool: ${toolName}`);
  if (tool.mutability !== 'write') {
    throw new ApiError(400, 'This endpoint is only for confirmed write tools.');
  }

  const started = Date.now();
  let success = true;
  let errorMessage = null;
  let result;

  try {
    result = sanitizeToolResult(await tool.execute(ctx, parameters), ctx);
  } catch (err) {
    success = false;
    errorMessage = err.message;
    throw err;
  } finally {
    const provider = getProvider();
    await logInteraction({
      companyId: ctx.companyId,
      userId: ctx.userId,
      provider: provider.getName(),
      model: provider.getModel(),
      question: `[confirmed write] ${toolName}`,
      response: success ? JSON.stringify(result) : errorMessage,
      toolCalls: [{ tool: toolName, input: parameters, confirmed: true }],
      durationMs: Date.now() - started,
      success,
      errorMessage,
      clientContext: ctx.clientContext
    });
  }

  return result;
}

function listWriteTools() {
  return ALL_TOOLS.filter((t) => t.mutability === 'write').map((t) => ({
    name: t.name,
    description: t.description
  }));
}

module.exports = { executeConfirmedWriteTool, listWriteTools };
