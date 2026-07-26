const aiEnv = require('../config/aiEnv');
const { getProvider } = require('../config/providerRegistry');
const { getToolSchemasForLlm } = require('../tools/registry');
const { executeTool } = require('./toolEngine.service');
const { getToolStatusLabel } = require('../utils/toolProgressLabels');

function emitStatus(onEvent, message) {
  if (onEvent && message) onEvent({ type: 'status', message });
}

async function callProvider(
  provider,
  { messages, tools, onEvent, forwardTokens, bufferTokens = false }
) {
  const streamOpts = { think: true };
  let buffered = '';

  if (onEvent && aiEnv.streaming) {
    const result = await provider.stream(
      messages,
      tools,
      (ev) => {
        if (ev.type === 'token') {
          if (forwardTokens) onEvent(ev);
          else if (bufferTokens) buffered += ev.content;
        } else if (ev.type === 'tool_calls') {
          onEvent?.(ev);
        }
      },
      streamOpts
    );

    if (bufferTokens && buffered && !result.toolCalls?.length && onEvent) {
      onEvent({ type: 'token', content: buffered });
      result.content = buffered;
    }

    return result;
  }

  const result = await provider.chat(messages, tools, streamOpts);
  if (result.content && onEvent && forwardTokens) {
    onEvent({ type: 'token', content: result.content });
  } else if (result.content && onEvent && bufferTokens && !result.toolCalls?.length) {
    onEvent({ type: 'token', content: result.content });
  }
  return result;
}

async function synthesizeFromTools(provider, workingMessages, toolTrace, onEvent) {
  const summary = toolTrace
    .map((t) => `Tool ${t.tool}: ${JSON.stringify(t.output).slice(0, 4000)}`)
    .join('\n');
  const messages = [
    ...workingMessages,
    {
      role: 'user',
      content: `Using ONLY the ERP data below, write a natural, colleague-style answer. Rules: answer the user's question in the first sentence; no greeting, recap, or closing pleasantries; no tool names; no forced "Key Metrics / Observation / Recommendations" headings — explain what matters in plain language and suggest next steps naturally when appropriate.\n\n${summary}`
    }
  ];
  emitStatus(onEvent, 'Writing your answer…');
  const result = await callProvider(provider, {
    messages,
    tools: [],
    onEvent,
    forwardTokens: true
  });
  return result.content || '';
}

async function runAgentLoop(ctx, { messages, onEvent, socialMode = false }) {
  const provider = getProvider();
  const allTools = socialMode || !provider.supportsTools() ? [] : getToolSchemasForLlm();
  const toolTrace = [];
  let workingMessages = [...messages];
  let finalContent = '';

  if (!socialMode) emitStatus(onEvent, 'Thinking…');

  for (let i = 0; i < aiEnv.maxToolIterations; i++) {
    const selectingTools = allTools.length > 0 && toolTrace.length === 0;
    const toolsForPass = selectingTools ? allTools : [];
    let sawToolCalls = false;
    const onStreamEvent = (ev) => {
      if (ev.type === 'tool_calls') sawToolCalls = true;
      else if (onEvent) onEvent(ev);
    };

    const result = await callProvider(provider, {
      messages: workingMessages,
      tools: toolsForPass,
      onEvent: onStreamEvent,
      forwardTokens: !selectingTools,
      bufferTokens: selectingTools
    });

    finalContent = result.content || '';
    const toolCalls = result.toolCalls || [];

    if (!toolCalls.length) {
      if (!finalContent.trim() && toolTrace.length) {
        finalContent = await synthesizeFromTools(provider, workingMessages, toolTrace, onEvent);
      }
      return { content: finalContent, toolTrace };
    }

    // Tool-selection pass may emit filler tokens before tool_calls; discard them.
    if (selectingTools || sawToolCalls) {
      finalContent = '';
    }

    workingMessages.push({
      role: 'assistant',
      content: finalContent,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {}
        }
      }))
    });

    for (const tc of toolCalls) {
      const statusLabel = getToolStatusLabel(tc.name);
      emitStatus(onEvent, statusLabel);
      if (onEvent) onEvent({ type: 'tool_start', tool: tc.name, input: tc.arguments, label: statusLabel });

      const output = await executeTool(ctx, tc.name, tc.arguments);
      toolTrace.push({ tool: tc.name, input: tc.arguments, output });

      if (onEvent) {
        onEvent({
          type: 'tool_end',
          tool: tc.name,
          summary: output?.error ? output.message : 'ok',
          label: statusLabel
        });
      }

      workingMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: JSON.stringify(output)
      });
    }

    emitStatus(onEvent, 'Preparing your answer…');
  }

  if (toolTrace.length && !finalContent.trim()) {
    finalContent = await synthesizeFromTools(provider, workingMessages, toolTrace, onEvent);
  }

  return {
    content:
      finalContent ||
      'I reached the maximum number of analysis steps. Please ask a follow-up for more detail.',
    toolTrace
  };
}

function runAgentLoopWithContext(ctx, { systemMessages, history, userMessage, onEvent, socialMode }) {
  const messages = [
    ...systemMessages,
    ...history.map((h) => ({
      role: h.role,
      content: h.content
    })),
    { role: 'user', content: userMessage }
  ];
  return runAgentLoop(ctx, { messages, onEvent, socialMode: !!socialMode });
}

module.exports = { runAgentLoop, runAgentLoopWithContext, synthesizeFromTools };
