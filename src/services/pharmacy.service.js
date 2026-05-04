const Pharmacy = require('../models/Pharmacy');
const { normalizeBonusScheme } = require('../utils/bonus');

const applyBonusSchemeInput = (data) => {
  if (data.bonusScheme !== undefined) {
    data.bonusScheme = normalizeBonusScheme(data.bonusScheme);
  }
};
const Doctor = require('../models/Doctor');
const Ledger = require('../models/Ledger');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');

const list = async (companyId, query, timeZone = "UTC") => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { city: { $regex: rx, $options: 'i' } }
    ];
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    Pharmacy.find(filter).sort(sort).skip(skip).limit(limit),
    Pharmacy.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  applyBonusSchemeInput(data);
  const pharmacy = await Pharmacy.create({ ...data, companyId, createdBy: reqUser.userId });
  await auditService.log({ companyId, userId: reqUser.userId, action: 'pharmacy.create', entityType: 'Pharmacy', entityId: pharmacy._id, changes: { after: pharmacy.toObject() } });
  return pharmacy;
};

const getById = async (companyId, id) => {
  const pharmacy = await Pharmacy.findOne({ _id: id, companyId });
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');

  const [doctors, ledgerBalance] = await Promise.all([
    Doctor.find({ companyId, pharmacyId: id, isActive: true }),
    Ledger.aggregate([
      { $match: { companyId: pharmacy.companyId, entityId: pharmacy._id, entityType: 'PHARMACY' } },
      {
        $group: {
          _id: null,
          totalDebit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
          totalCredit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
        }
      }
    ])
  ]);

  const balance = ledgerBalance[0] || { totalDebit: 0, totalCredit: 0 };
  const outstanding = Math.round((balance.totalDebit - balance.totalCredit) * 100) / 100;

  return { ...pharmacy.toObject(), doctors, outstanding, ledgerSummary: balance };
};

const update = async (companyId, id, data, reqUser) => {
  const pharmacy = await Pharmacy.findOne({ _id: id, companyId });
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  const before = pharmacy.toObject();
  applyBonusSchemeInput(data);
  Object.assign(pharmacy, { ...data, updatedBy: reqUser.userId });
  await pharmacy.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'pharmacy.update', entityType: 'Pharmacy', entityId: pharmacy._id, changes: { before, after: pharmacy.toObject() } });
  return pharmacy;
};

const remove = async (companyId, id, reqUser) => {
  const pharmacy = await Pharmacy.findOne({ _id: id, companyId });
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  await pharmacy.softDelete(reqUser.userId);
  await auditService.log({ companyId, userId: reqUser.userId, action: 'pharmacy.delete', entityType: 'Pharmacy', entityId: pharmacy._id, changes: { after: { isActive: false } } });
  return pharmacy;
};

module.exports = { list, create, getById, update, remove };
