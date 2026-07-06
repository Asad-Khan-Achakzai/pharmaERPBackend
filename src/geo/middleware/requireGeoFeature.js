const ApiError = require('../../utils/ApiError');
const { assertGeoFeatureEnabled, resolveGeoPlatform } = require('../utils/geoPlatformResolver');

function requireGeoFeature(featureKey) {
  return (req, _res, next) => {
    try {
      const company = req.context?.company;
      if (!company) {
        return next(new ApiError(401, 'Authentication required'));
      }
      const geo = resolveGeoPlatform(company);
      req.context.geoPlatform = geo;
      if (!geo.enabled) {
        const err = new ApiError(403, 'Geo Platform is not enabled for this company');
        err.code = 'GEO_PLATFORM_DISABLED';
        throw err;
      }
      assertGeoFeatureEnabled(company, featureKey);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function attachGeoPlatform(req, _res, next) {
  req.context.geoPlatform = resolveGeoPlatform(req.context?.company);
  next();
}

module.exports = { requireGeoFeature, attachGeoPlatform };
