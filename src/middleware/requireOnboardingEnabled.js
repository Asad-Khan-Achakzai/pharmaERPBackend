const ApiError = require('../utils/ApiError');

const requireOnboardingEnabled = (req, _res, next) => {
  const company = req.context?.company;
  if (!company) return next(new ApiError(500, 'Company context missing'));
  if (company.onboardingKillSwitch === true) {
    return next(new ApiError(423, 'Onboarding is temporarily disabled by platform operations'));
  }
  if (company.onboardingEnabled !== true) {
    return next(new ApiError(403, 'Onboarding is not enabled for this company'));
  }
  return next();
};

module.exports = { requireOnboardingEnabled };
