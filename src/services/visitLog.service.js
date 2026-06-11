const planItemService = require('./planItem.service');

const createUnplanned = async (companyId, body, reqUser, timeZone, companyDoc = null) => {
  return planItemService.createUnplannedAsPlanItem(companyId, body, reqUser, timeZone, companyDoc);
};

module.exports = { createUnplanned };
