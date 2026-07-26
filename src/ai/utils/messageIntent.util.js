/**
 * Classify user message intent for Copilot response mode.
 * @returns {'social' | 'business'}
 */
function classifyUserIntent(message, { hasPriorTurns = false } = {}) {
  const raw = String(message || '').trim();
  if (!raw) return 'business';

  const text = raw.toLowerCase().replace(/[!?.]+$/g, '').trim();

  const erpPattern =
    /\b(inventory|stock|warehouse|sales|revenue|doctor|doctors|order|orders|visit|visits|attendance|employee|employees|staff|headcount|product|products|pharmacy|pharmacies|customer|customers|distributor|kpi|team|performance|report|summary|overview|coverage|territory|compare|trend|how many|count|show me|show my|list|pending|missed|plan|procurement|users?)\b/i;

  if (erpPattern.test(raw)) return 'business';

  const socialExact =
    /^(hi|hello|hey|hiya|yo|good morning|good afternoon|good evening|good day|how are you|how are u|how'?s it going|what'?s up|sup|thanks?|thank you|thx|thanks a lot|many thanks|bye|goodbye|see you|see ya|take care|nice to meet you|pleased to meet you|good night|gn)$/i;

  if (socialExact.test(text)) return 'social';

  // Mixed: "good morning, show inventory" → business (erpPattern catches show/inventory)
  // Short social with extra punctuation only
  if (socialExact.test(text.replace(/\s+/g, ' '))) return 'social';

  // Follow-up in ongoing chat defaults to business unless clearly social
  if (hasPriorTurns && /^(ok|okay|cool|great|got it|sure|alright)$/i.test(text)) {
    return 'social';
  }

  return 'business';
}

module.exports = { classifyUserIntent };
