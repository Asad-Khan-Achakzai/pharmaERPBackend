const mongoose = require('mongoose');
const Collection = require('../models/Collection');
const { parsePagination } = require('../utils/pagination');
const financialService = require('./financial.service');

const list = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  if (query.pharmacyId) filter.pharmacyId = query.pharmacyId;
  if (query.collectorType) filter.collectorType = query.collectorType;

  const [docs, total] = await Promise.all([
    Collection.find(filter)
      .populate('pharmacyId', 'name city')
      .populate('distributorId', 'name city')
      .populate('collectedBy', 'name')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    Collection.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const doc = await financialService.createCollection(companyId, data, reqUser, session);
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
  const doc = await Collection.findOne({ _id: id, companyId })
    .populate('pharmacyId', 'name city address')
    .populate('distributorId', 'name city')
    .populate('collectedBy', 'name');
  return doc;
};

const getByPharmacy = async (companyId, pharmacyId) => {
  return Collection.find({ companyId, pharmacyId })
    .populate('collectedBy', 'name')
    .sort({ date: -1 });
};

module.exports = { list, create, getById, getByPharmacy };
