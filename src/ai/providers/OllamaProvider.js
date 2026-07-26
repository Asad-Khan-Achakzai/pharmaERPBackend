const aiEnv = require('../config/aiEnv');
const { ProviderUnavailableError, ProviderTimeoutError } = require('./providerErrors');
const { extractPublicContent } = require('../utils/reasoningFilter');
const logger = require('../../utils/logger');

function parseToolArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function normalizeToolCalls(message) {
  const calls = message?.tool_calls || [];
  return calls
    .map((tc, idx) => ({
      id: tc.id || `call_${idx}_${Date.now()}`,
      name: tc.function?.name || tc.name || '',
      arguments: parseToolArguments(tc.function?.arguments ?? tc.arguments)
    }))
    .filter((c) => c.name);
}

function mergeToolCalls(existing, incoming) {
  if (!incoming?.length) return existing;
  const map = new Map(existing.map((c) => [c.id, c]));
  for (const call of incoming) {
    map.set(call.id, { ...map.get(call.id), ...call });
  }
  return [...map.values()];
}

class OllamaProvider {
  constructor() {
    this.baseUrl = aiEnv.ollamaBaseUrl;
    this.model = aiEnv.ollamaModel;
    this.timeoutMs = aiEnv.requestTimeoutMs;
  }

  getName() {
    return 'ollama';
  }

  getModel() {
    return this.model;
  }

  supportsTools() {
    return true;
  }

  supportsVision() {
    return false;
  }

  supportsReasoning() {
    return true;
  }

  _normalizeToolCallsForRequest(toolCalls) {
    return toolCalls.map((tc) => ({
      id: tc.id,
      type: tc.type || 'function',
      function: {
        name: tc.function?.name || tc.name || '',
        arguments: parseToolArguments(tc.function?.arguments ?? tc.arguments)
      }
    }));
  }

  _buildPayload(messages, tools, stream, { think = true } = {}) {
    const payload = {
      model: this.model,
      messages: messages.map((m) => {
        const out = { role: m.role, content: m.content || '' };
        if (m.tool_calls?.length) {
          out.tool_calls = this._normalizeToolCallsForRequest(m.tool_calls);
        }
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.name) out.name = m.name;
        return out;
      }),
      stream: !!stream,
      think,
      options: { temperature: 0.3, num_predict: 4096 }
    };
    if (tools?.length) {
      payload.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));
    }
    return payload;
  }

  async _fetchJson(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn('Ollama API error', { status: res.status, body: text.slice(0, 500) });
        throw new ProviderUnavailableError(
          'AI Copilot is temporarily unavailable. Please try again in a moment.'
        );
      }
      return res;
    } catch (err) {
      if (err.name === 'AbortError') throw new ProviderTimeoutError();
      if (err instanceof ProviderUnavailableError) throw err;
      logger.warn('Ollama fetch failed', { error: err.message });
      throw new ProviderUnavailableError('AI Copilot is temporarily unavailable. Please try again later.');
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(messages, tools, options) {
    const res = await this._fetchJson('/api/chat', this._buildPayload(messages, tools, false, options));
    const data = await res.json();
    const message = data.message || {};
    return {
      content: extractPublicContent(message),
      toolCalls: normalizeToolCalls(message),
      done: true
    };
  }

  async stream(messages, tools, onEvent, options) {
    const res = await this._fetchJson('/api/chat', this._buildPayload(messages, tools, true, options));
    const reader = res.body?.getReader();
    if (!reader) {
      return this.chat(messages, tools, options);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let toolCalls = [];
    let toolCallsNotified = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let chunk;
        try {
          chunk = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const msg = chunk.message || {};
        // `msg.thinking` is intentionally ignored — never forward chain-of-thought to clients.

        if (msg.tool_calls?.length) {
          toolCalls = mergeToolCalls(toolCalls, normalizeToolCalls(msg));
          if (!toolCallsNotified) {
            toolCallsNotified = true;
            onEvent?.({ type: 'tool_calls', toolCalls });
          }
        }

        const publicText = extractPublicContent(msg);
        if (publicText) {
          content += publicText;
          onEvent?.({ type: 'token', content: publicText });
        }

        if (chunk.done) {
          if (msg.tool_calls?.length) {
            toolCalls = mergeToolCalls(toolCalls, normalizeToolCalls(msg));
            if (!toolCallsNotified) {
              toolCallsNotified = true;
              onEvent?.({ type: 'tool_calls', toolCalls });
            }
          }
        }
      }
    }

    return { content, toolCalls, done: true };
  }
}

module.exports = OllamaProvider;
