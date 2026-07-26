const { SYSTEM_PROMPT } = require('../prompts/hallucinationPolicy');
const { getRolePrompt } = require('../prompts/rolePrompts');
const { getIntentPrompt } = require('../prompts/intentPrompts');
const businessTime = require('../../utils/businessTime');

function todayYmd(timeZone) {
  return businessTime.nowInBusinessTime(timeZone).toFormat('yyyy-MM-dd');
}

function buildSystemMessages(ctx, { intent = 'business' } = {}) {
  const parts = [SYSTEM_PROMPT, getRolePrompt(ctx.user), getIntentPrompt(intent)];

  const company = ctx.company;
  if (company) {
    parts.push(
      `Company: ${company.name || 'Unknown'}. Timezone: ${ctx.timeZone}. Currency: ${company.currency || 'PKR'}.`
    );
  }

  const user = ctx.user;
  if (user) {
    parts.push(`User: ${user.name || user.email || 'User'}. Role: ${user.role || 'USER'}.`);
  }

  const today = todayYmd(ctx.timeZone);
  parts.push(`Today's business date (${ctx.timeZone}): ${today}.`);

  const cc = ctx.clientContext || {};
  if (cc.screen) parts.push(`Current screen/module: ${cc.screen}.`);
  if (cc.selectedDoctorId) parts.push(`User has selected doctor ID: ${cc.selectedDoctorId}.`);
  if (cc.selectedPharmacyId) parts.push(`User has selected pharmacy ID: ${cc.selectedPharmacyId}.`);

  return [{ role: 'system', content: parts.join('\n\n') }];
}

function buildPromptMessages({ systemMessages, history, userMessage, toolResults }) {
  const messages = [...systemMessages];

  for (const h of history) {
    if (h.role === 'tool') {
      messages.push({
        role: 'tool',
        content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content),
        tool_call_id: h.toolCallId,
        name: h.toolName
      });
    } else {
      messages.push({ role: h.role, content: h.content || '' });
    }
  }

  messages.push({ role: 'user', content: userMessage });

  if (toolResults?.length) {
    for (const tr of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.toolCallId,
        name: tr.toolName,
        content: JSON.stringify(tr.output)
      });
    }
  }

  return messages;
}

module.exports = { buildSystemMessages, buildPromptMessages };
