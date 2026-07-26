const ApiError = require('../../utils/ApiError');
const { getTool } = require('../tools/registry');
const { sanitizeToolResult } = require('../utils/sanitizeToolResult');

async function executeTool(ctx, toolName, params) {
  const tool = getTool(toolName);
  if (!tool) {
    throw new ApiError(400, `Unknown tool: ${toolName}`);
  }
  if (tool.mutability === 'write') {
    throw new ApiError(403, 'Write tools require explicit user confirmation.');
  }
  try {
    const raw = await tool.execute(ctx, params);
    return sanitizeToolResult(raw, ctx);
  } catch (err) {
    const message = err.message || 'Tool execution failed';
    return { error: true, message };
  }
}

module.exports = { executeTool };
