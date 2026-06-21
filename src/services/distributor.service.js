const Distributor = require('../models/Distributor');
const DistributorInventory = require('../models/DistributorInventory');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const auditService = require('./audit.service');
const mediaAttach = require('./media.attach');

/** Attach a transient signed imageUrl to distributor docs (MediaAsset = source of truth). */
async function withImages(companyId, docs) {
  const list = Array.isArray(docs) ? docs : [docs];
  const ids = list.filter(Boolean).map((d) => String(d._id));
  const images = await mediaAttach.resolveEntityImages({ companyId, resource: 'distributors', ids });
  const decorate = (d) => {
    if (!d) return d;
    const obj = typeof d.toObject === 'function' ? d.toObject() : d;
    const img = images.get(String(obj._id));
    obj.imageUrl = img ? img.url : null;
    return obj;
  };
  return Array.isArray(docs) ? list.map(decorate) : decorate(docs);
}

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
    Distributor.find(filter).sort(sort).skip(skip).limit(limit),
    Distributor.countDocuments(filter)
  ]);
  const withUrls = await withImages(companyId, docs);
  return { docs: withUrls, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const { assetId, ...distributorData } = data;
  const distributor = await Distributor.create({ ...distributorData, companyId, createdBy: reqUser.userId });
  if (assetId) {
    await mediaAttach.attachEntityImage({
      companyId,
      uploadedBy: reqUser.userId,
      resource: 'distributors',
      id: distributor._id,
      assetId
    });
  }
  await auditService.log({ companyId, userId: reqUser.userId, action: 'distributor.create', entityType: 'Distributor', entityId: distributor._id, changes: { after: distributor.toObject() } });
  return withImages(companyId, distributor);
};

const getById = async (companyId, id) => {
  const distributor = await Distributor.findOne({ _id: id, companyId });
  if (!distributor) throw new ApiError(404, 'Distributor not found');

  const inventory = await DistributorInventory.find({ companyId, distributorId: id })
    .populate('productId', 'name composition');

  const decorated = await withImages(companyId, distributor);
  return { ...decorated, inventory };
};

const update = async (companyId, id, data, reqUser) => {
  const distributor = await Distributor.findOne({ _id: id, companyId });
  if (!distributor) throw new ApiError(404, 'Distributor not found');
  const before = distributor.toObject();
  const { assetId, ...distributorData } = data;
  Object.assign(distributor, { ...distributorData, updatedBy: reqUser.userId });
  await distributor.save();
  if (assetId) {
    await mediaAttach.attachEntityImage({
      companyId,
      uploadedBy: reqUser.userId,
      resource: 'distributors',
      id: distributor._id,
      assetId
    });
  }
  await auditService.log({ companyId, userId: reqUser.userId, action: 'distributor.update', entityType: 'Distributor', entityId: distributor._id, changes: { before, after: distributor.toObject() } });
  return withImages(companyId, distributor);
};

const remove = async (companyId, id, reqUser) => {
  const distributor = await Distributor.findOne({ _id: id, companyId });
  if (!distributor) throw new ApiError(404, 'Distributor not found');
  await distributor.softDelete(reqUser.userId);
  await auditService.log({ companyId, userId: reqUser.userId, action: 'distributor.delete', entityType: 'Distributor', entityId: distributor._id, changes: { after: { isActive: false } } });
  return distributor;
};

module.exports = { list, create, getById, update, remove };
