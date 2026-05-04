const planItemService = require('./planItem.service');

const createUnplanned = async (companyId, body, reqUser, timeZone) => {
  return planItemService.createUnplannedAsPlanItem(companyId, body, reqUser, timeZone);
};

module.exports = { createUnplanned };
