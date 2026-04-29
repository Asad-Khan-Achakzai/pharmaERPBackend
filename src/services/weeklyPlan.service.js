const WeeklyPlan = require('../models/WeeklyPlan');
const PlanItem = require('../models/PlanItem');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');
const planItemService = require('./planItem.service');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');

const list = async (companyId, query) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.medicalRepId) filter.medicalRepId = query.medicalRepId;
  if (query.status) filter.status = query.status;
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.notes = { $regex: rx, $options: 'i' };
  }
  applyCreatedAtRangeFromQuery(filter, query);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    WeeklyPlan.find(filter).populate('medicalRepId', 'name').sort(sort).skip(skip).limit(limit),
    WeeklyPlan.countDocuments(filter)
  ]);
  const ids = docs.map((d) => d._id);
  let byPlan = {};
  if (ids.length) {
    const counts = await PlanItem.aggregate([
      { $match: { weeklyPlanId: { $in: ids }, companyId, isDeleted: { $ne: true } } },
      { $group: { _id: '$weeklyPlanId', n: { $sum: 1 } } }
    ]);
    byPlan = Object.fromEntries(counts.map((c) => [c._id.toString(), c.n]));
  }
  const enriched = docs.map((d) => {
    const o = d.toObject();
    o.planItemsCount = byPlan[d._id.toString()] || 0;
    return o;
  });
  return { docs: enriched, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const plan = await WeeklyPlan.create({ ...data, companyId, medicalRepId: data.medicalRepId || reqUser.userId, createdBy: reqUser.userId });
  await auditService.log({ companyId, userId: reqUser.userId, action: 'weeklyPlan.create', entityType: 'WeeklyPlan', entityId: plan._id, changes: { after: plan.toObject() } });
  return plan;
};

const update = async (companyId, id, data, reqUser) => {
  const plan = await WeeklyPlan.findOne({ _id: id, companyId });
  if (!plan) throw new ApiError(404, 'Weekly plan not found');
  const before = plan.toObject();
  Object.assign(plan, data);
  plan.updatedBy = reqUser.userId;
  await plan.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'weeklyPlan.update', entityType: 'WeeklyPlan', entityId: plan._id, changes: { before, after: plan.toObject() } });
  return plan;
};

const getByRep = async (companyId, repId) => {
  return WeeklyPlan.find({ companyId, medicalRepId: repId }).sort({ weekStartDate: -1 });
};

const getById = async (companyId, id) => {
  const plan = await WeeklyPlan.findOne({ _id: id, companyId, isDeleted: { $ne: true } }).populate(
    'medicalRepId',
    'name email'
  );
  if (!plan) throw new ApiError(404, 'Weekly plan not found');
  const planItems = await planItemService.listByPlan(companyId, id);
  return { ...plan.toObject(), planItems };
};

module.exports = { list, create, update, getByRep, getById };
