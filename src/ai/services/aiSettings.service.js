function resolveAiCopilotEnabled(company) {
  if (!company) return false;
  return !!company.aiCopilotEnabled;
}

function getPublicAiConfig(company) {
  return {
    enabled: resolveAiCopilotEnabled(company)
  };
}

module.exports = { resolveAiCopilotEnabled, getPublicAiConfig };
