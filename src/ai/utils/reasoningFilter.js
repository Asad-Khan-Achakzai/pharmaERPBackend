/**
 * Strip inline reasoning blocks some models emit inside `content`
 * even when a separate `thinking` field exists.
 */
function stripInlineReasoning(text) {
  if (!text || typeof text !== 'string') return '';

  let out = text;
  const thinkBlock = new RegExp('<' + 'think' + '>[\\s\\S]*?<' + '/think' + '>', 'gi');
  const blockPatterns = [
    thinkBlock,
    /<\|think\|>[\s\S]*?<\|\/think\|>/gi,
    /<(?:redacted_reasoning|redacted_thinking)>[\s\S]*?<\/(?:redacted_reasoning|redacted_thinking)>/gi,
    /<reasoning>[\s\S]*?<\/reasoning>/gi
  ];
  for (const pattern of blockPatterns) {
    out = out.replace(pattern, '');
  }
  return out;
}

/**
 * Extract user-visible assistant text from an Ollama message chunk.
 * Never returns the separate `thinking` field.
 */
function extractPublicContent(message) {
  if (!message || typeof message !== 'object') return '';
  return stripInlineReasoning(message.content || '');
}

module.exports = { stripInlineReasoning, extractPublicContent };
