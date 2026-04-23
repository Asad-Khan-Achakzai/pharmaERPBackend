const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/enums');

const companyScope = (req, _res, next) => {
  if (!req.user) {
    return next(new ApiError(401, 'Authentication required'));
  }

  if (req.user.role === ROLES.SUPER_ADMIN) {
    if (!req.user.activeCompanyId) {
      return next(
        new ApiError(400, 'No company selected. Open Super Admin and choose a company to continue.')
      );
    }
    req.companyId = req.user.activeCompanyId;
    return next();
  }

  if (!req.user.companyId) {
    return next(new ApiError(401, 'Company context required'));
  }

  req.companyId = req.user.companyId;
  next();
};

module.exports = { companyScope };
