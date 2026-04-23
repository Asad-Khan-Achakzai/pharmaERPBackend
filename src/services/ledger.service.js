const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const { parsePagination } = require('../utils/pagination');
const { roundPKR } = require('../utils/currency');
const { LEDGER_ENTITY_TYPE } = require('../constants/enums');
const financialService = require('./financial.service');

const list = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  if (query.entityId) filter.entityId = query.entityId;
  if (query.type) filter.type = query.type;
  if (query.from || query.to) {
    filter.date = {};
    if (query.from) filter.date.$gte = new Date(query.from);
    if (query.to) filter.date.$lte = new Date(query.to);
  }

  const [docs, total] = await Promise.all([
    Ledger.find(filter).sort(sort).skip(skip).limit(limit),
    Ledger.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getByPharmacy = async (companyId, pharmacyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId, entityId: new mongoose.Types.ObjectId(pharmacyId), entityType: LEDGER_ENTITY_TYPE.PHARMACY };

  const [docs, total] = await Promise.all([
    Ledger.find(filter).sort(sort).skip(skip).limit(limit),
    Ledger.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getBalance = async (companyId, pharmacyId) => {
  const result = await Ledger.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(companyId), entityId: new mongoose.Types.ObjectId(pharmacyId), entityType: LEDGER_ENTITY_TYPE.PHARMACY, isDeleted: { $ne: true } } },
    {
      $group: {
        _id: null,
        totalDebit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
        totalCredit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
      }
    }
  ]);

  const bal = result[0] || { totalDebit: 0, totalCredit: 0 };
  return {
    totalDebit: roundPKR(bal.totalDebit),
    totalCredit: roundPKR(bal.totalCredit),
    outstanding: roundPKR(bal.totalDebit - bal.totalCredit)
  };
};

const getDistributorClearingBalance = (companyId, distributorId) =>
  financialService.getDistributorClearingBalance(companyId, distributorId);

module.exports = { list, getByPharmacy, getBalance, getDistributorClearingBalance };
