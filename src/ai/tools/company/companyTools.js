const Joi = require('joi');
const { defineTool } = require('../baseTool');
const Company = require('../../../models/Company');

const companyProfile = defineTool({
  name: 'company_profile',
  description:
    'Get the logged-in company profile: name, location, timezone, currency, and enabled feature flags.',
  requiredPermissions: ['admin.access', 'dashboard.view', 'copilot.use'],
  parameters: Joi.object({}),
  async run(ctx) {
    const company =
      ctx.company ||
      (await Company.findById(ctx.companyId)
        .select('name city state country timeZone currency isActive aiCopilotEnabled mobileEnabled')
        .lean());
    if (!company) return { error: true, message: 'Company not found.' };
    return {
      name: company.name,
      city: company.city,
      state: company.state,
      country: company.country,
      timeZone: company.timeZone,
      currency: company.currency,
      isActive: company.isActive,
      features: {
        aiCopilotEnabled: !!company.aiCopilotEnabled,
        mobileEnabled: !!company.mobileEnabled
      }
    };
  }
});

module.exports = { companyProfile };
