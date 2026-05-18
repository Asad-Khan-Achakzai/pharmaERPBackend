const mongoose = require('mongoose');

const toObjectId = (companyId) =>
  companyId instanceof mongoose.Types.ObjectId
    ? companyId
    : new mongoose.Types.ObjectId(String(companyId));

/**
 * Guard helper for aggregation pipelines on soft-delete models.
 * Always scopes to tenant + non-deleted documents.
 */
const tenantAggregateMatch = (companyId, extra = {}) => ({
  companyId: toObjectId(companyId),
  isDeleted: { $ne: true },
  ...extra
});

module.exports = { tenantAggregateMatch, toObjectId };
