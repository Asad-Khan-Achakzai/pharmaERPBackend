const mongoose = require('mongoose');
const Settlement = require('../models/Settlement');
const { parsePagination } = require('../utils/pagination');
const financialService = require('./financial.service');
const {
  escapeRegex,
  qScalar,
  applyDateFieldRangeFromQuery,
  applyCreatedByFromQuery
} = require('../utils/listQuery');

const list = async (companyId, query, timeZone = "UTC") => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.distributorId) filter.distributorId = query.distributorId;
  if (query.direction) filter.direction = query.direction;
  applyDateFieldRangeFromQuery(filter, query, 'date', timeZone);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { referenceNumber: { $regex: rx, $options: 'i' } },
      { notes: { $regex: rx, $options: 'i' } }
    ];
  }
  applyCreatedByFromQuery(filter, query);

  const [docs, total] = await Promise.all([
    Settlement.find(filter)
      .populate('distributorId', 'name city')
      .populate('settledBy', 'name')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    Settlement.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const doc = await financialService.createSettlement(companyId, data, reqUser, session);
    await session.commitTransaction();
    return doc;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
};

const getById = async (companyId, id) => {
  return Settlement.findOne({ _id: id, companyId })
    .populate('distributorId', 'name city')
    .populate('settledBy', 'name');
};

module.exports = { list, create, getById };
