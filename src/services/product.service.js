const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');

const list = async (companyId, query) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { composition: { $regex: search, $options: 'i' } }
    ];
  }
  const [docs, total] = await Promise.all([
    Product.find(filter).sort(sort).skip(skip).limit(limit),
    Product.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const product = await Product.create({ ...data, companyId, createdBy: reqUser.userId });
  await auditService.log({ companyId, userId: reqUser.userId, action: 'product.create', entityType: 'Product', entityId: product._id, changes: { after: product.toObject() } });
  return product;
};

const getById = async (companyId, id) => {
  const product = await Product.findOne({ _id: id, companyId });
  if (!product) throw new ApiError(404, 'Product not found');
  return product;
};

const update = async (companyId, id, data, reqUser) => {
  const product = await Product.findOne({ _id: id, companyId });
  if (!product) throw new ApiError(404, 'Product not found');
  const before = product.toObject();
  Object.assign(product, { ...data, updatedBy: reqUser.userId });
  await product.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'product.update', entityType: 'Product', entityId: product._id, changes: { before, after: product.toObject() } });
  return product;
};

const remove = async (companyId, id, reqUser) => {
  const product = await Product.findOne({ _id: id, companyId });
  if (!product) throw new ApiError(404, 'Product not found');
  await product.softDelete(reqUser.userId);
  await auditService.log({ companyId, userId: reqUser.userId, action: 'product.delete', entityType: 'Product', entityId: product._id, changes: { after: { isActive: false } } });
  return product;
};

module.exports = { list, create, getById, update, remove };
