const collectionService = require('./collection.service');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { COLLECTOR_TYPE } = require('../constants/enums');

/**
 * Legacy "payments" API — records a collection by the company (same as POST /collections with collector COMPANY).
 */
const list = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const Collection = require('../models/Collection');
  const filter = { companyId, collectorType: COLLECTOR_TYPE.COMPANY };
  if (query.pharmacyId) filter.pharmacyId = query.pharmacyId;
  if (query.collectedBy) filter.collectedBy = query.collectedBy;

  const [docs, total] = await Promise.all([
    Collection.find(filter)
      .populate('pharmacyId', 'name city')
      .populate('collectedBy', 'name')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    Collection.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const Pharmacy = require('../models/Pharmacy');
  const pharmacy = await Pharmacy.findOne({ _id: data.pharmacyId, companyId });
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');

  return collectionService.create(
    companyId,
    {
      pharmacyId: data.pharmacyId,
      collectorType: COLLECTOR_TYPE.COMPANY,
      amount: data.amount,
      paymentMethod: data.paymentMethod,
      referenceNumber: data.referenceNumber,
      date: data.date,
      notes: data.notes
    },
    { ...reqUser, userId: data.collectedBy || reqUser.userId }
  );
};

const getById = async (companyId, id) => {
  return collectionService.getById(companyId, id);
};

const getByPharmacy = async (companyId, pharmacyId) => {
  return collectionService.getByPharmacy(companyId, pharmacyId);
};

module.exports = { list, create, getById, getByPharmacy };
