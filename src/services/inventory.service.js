const mongoose = require('mongoose');
const DistributorInventory = require('../models/DistributorInventory');
const StockTransfer = require('../models/StockTransfer');
const Distributor = require('../models/Distributor');
const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');
const supplierService = require('./supplier.service');

const getAll = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  if (query.distributorId) filter.distributorId = query.distributorId;
  if (query.productId) filter.productId = query.productId;

  const [docs, total] = await Promise.all([
    DistributorInventory.find(filter)
      .populate('distributorId', 'name')
      .populate('productId', 'name composition mrp tp casting')
      .sort(sort).skip(skip).limit(limit),
    DistributorInventory.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getSummary = async (companyId) => {
  const cid = new mongoose.Types.ObjectId(companyId);

  const byProduct = await DistributorInventory.aggregate([
    { $match: { companyId: cid, isDeleted: { $ne: true } } },
    {
      $group: {
        _id: '$productId',
        totalQuantity: { $sum: '$quantity' },
        totalValue: { $sum: { $multiply: ['$quantity', '$avgCostPerUnit'] } },
        distributorCount: { $sum: 1 },
        weightedCostSum: { $sum: { $multiply: ['$quantity', '$avgCostPerUnit'] } }
      }
    },
    {
      $lookup: {
        from: 'products',
        localField: '_id',
        foreignField: '_id',
        as: 'product'
      }
    },
    { $unwind: '$product' },
    {
      $project: {
        _id: 0,
        productId: '$_id',
        productName: '$product.name',
        composition: '$product.composition',
        mrp: '$product.mrp',
        tp: '$product.tp',
        casting: '$product.casting',
        totalQuantity: 1,
        totalValue: { $round: ['$totalValue', 2] },
        distributorCount: 1,
        avgCostPerUnit: {
          $cond: [
            { $gt: ['$totalQuantity', 0] },
            { $round: [{ $divide: ['$weightedCostSum', '$totalQuantity'] }, 2] },
            0
          ]
        }
      }
    },
    { $sort: { productName: 1 } }
  ]);

  const totals = byProduct.reduce(
    (acc, row) => {
      acc.totalUnits += row.totalQuantity;
      acc.totalValue = roundPKR(acc.totalValue + row.totalValue);
      return acc;
    },
    { totalUnits: 0, totalValue: 0, uniqueProducts: byProduct.length }
  );

  return { byProduct, totals };
};

const getByDistributor = async (companyId, distributorId) => {
  const inventory = await DistributorInventory.find({ companyId, distributorId })
    .populate('productId', 'name composition mrp tp casting');
  return inventory;
};

const loadProductsForTransfer = async (companyId, items) => {
  const productIds = items.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: productIds }, companyId, isActive: true });
  if (products.length !== productIds.length) {
    throw new ApiError(400, 'One or more products not found');
  }
  const productMap = {};
  products.forEach((p) => { productMap[p._id.toString()] = p; });
  return productMap;
};

const mergeIntoDestination = async ({
  session,
  companyId,
  distributorId,
  productId,
  quantity,
  newCostPerUnit,
  reqUser
}) => {
  let inv = await DistributorInventory.findOne(
    { companyId, distributorId, productId }
  ).session(session);

  if (inv && inv.quantity > 0) {
    const totalExistingValue = inv.quantity * inv.avgCostPerUnit;
    const totalNewValue = quantity * newCostPerUnit;
    inv.avgCostPerUnit = roundPKR((totalExistingValue + totalNewValue) / (inv.quantity + quantity));
    inv.quantity += quantity;
  } else if (inv) {
    inv.quantity += quantity;
    inv.avgCostPerUnit = newCostPerUnit;
  } else {
    inv = new DistributorInventory({
      companyId,
      distributorId,
      productId,
      quantity,
      avgCostPerUnit: newCostPerUnit,
      createdBy: reqUser.userId
    });
  }

  inv.lastUpdated = new Date();
  inv.updatedBy = reqUser.userId;
  await inv.save({ session });
};

const transferFromCompany = async (companyId, distributorId, items, totalShippingCost, notes, reqUser, supplierId) => {
  const distributor = await Distributor.findOne({ _id: distributorId, companyId, isActive: true });
  if (!distributor) throw new ApiError(404, 'Distributor not found');

  const productMap = await loadProductsForTransfer(companyId, items);
  const totalUnits = items.reduce((sum, i) => sum + i.quantity, 0);
  const shippingPerUnit = totalUnits > 0 ? roundPKR((totalShippingCost || 0) / totalUnits) : 0;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const transferItems = [];

    for (const item of items) {
      const product = productMap[item.productId];
      const castingAtTime = product.casting;
      const shippingCostPerUnit = shippingPerUnit;
      const newCostPerUnit = roundPKR(castingAtTime + shippingCostPerUnit);

      await mergeIntoDestination({
        session,
        companyId,
        distributorId,
        productId: item.productId,
        quantity: item.quantity,
        newCostPerUnit,
        reqUser
      });

      transferItems.push({
        productId: item.productId,
        quantity: item.quantity,
        castingAtTime,
        shippingCostPerUnit
      });
    }

    const stockTransfer = await StockTransfer.create(
      [{
        companyId,
        supplierId: supplierId && String(supplierId).trim() ? supplierId : null,
        fromDistributorId: null,
        distributorId,
        items: transferItems,
        totalShippingCost: totalShippingCost || 0,
        notes,
        createdBy: reqUser.userId
      }],
      { session }
    );

    if (supplierId && String(supplierId).trim()) {
      await supplierService.recordPurchaseFromStockTransfer({
        session,
        companyId,
        supplierId,
        stockTransferId: stockTransfer[0]._id,
        items,
        productMap,
        reqUser
      });
    }

    await session.commitTransaction();

    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'inventory.transfer',
      entityType: 'StockTransfer',
      entityId: stockTransfer[0]._id,
      changes: { after: stockTransfer[0].toObject() }
    });

    return stockTransfer[0];
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const transferBetweenDistributors = async (
  companyId,
  fromDistributorId,
  toDistributorId,
  items,
  totalShippingCost,
  notes,
  reqUser
) => {
  if (String(fromDistributorId) === String(toDistributorId)) {
    throw new ApiError(400, 'Source and destination distributors must differ');
  }

  const [fromDist, toDist] = await Promise.all([
    Distributor.findOne({ _id: fromDistributorId, companyId, isActive: true }),
    Distributor.findOne({ _id: toDistributorId, companyId, isActive: true })
  ]);
  if (!fromDist) throw new ApiError(404, 'Source distributor not found');
  if (!toDist) throw new ApiError(404, 'Destination distributor not found');

  const productMap = await loadProductsForTransfer(companyId, items);
  const totalUnits = items.reduce((sum, i) => sum + i.quantity, 0);
  const shippingPerUnit = totalUnits > 0 ? roundPKR((totalShippingCost || 0) / totalUnits) : 0;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const transferItems = [];

    for (const item of items) {
      const product = productMap[item.productId];
      const srcInv = await DistributorInventory.findOne({
        companyId,
        distributorId: fromDistributorId,
        productId: item.productId
      }).session(session);

      if (!srcInv || srcInv.quantity < item.quantity) {
        throw new ApiError(400, `Insufficient stock for ${product.name} at the source distributor`);
      }

      const sourceAvgBefore = srcInv.avgCostPerUnit;
      srcInv.quantity -= item.quantity;
      if (srcInv.quantity <= 0) {
        srcInv.quantity = 0;
        srcInv.avgCostPerUnit = 0;
      }
      srcInv.lastUpdated = new Date();
      srcInv.updatedBy = reqUser.userId;
      await srcInv.save({ session });

      const shippingCostPerUnit = shippingPerUnit;
      const newCostPerUnit = roundPKR(sourceAvgBefore + shippingCostPerUnit);

      await mergeIntoDestination({
        session,
        companyId,
        distributorId: toDistributorId,
        productId: item.productId,
        quantity: item.quantity,
        newCostPerUnit,
        reqUser
      });

      transferItems.push({
        productId: item.productId,
        quantity: item.quantity,
        castingAtTime: sourceAvgBefore,
        shippingCostPerUnit
      });
    }

    const stockTransfer = await StockTransfer.create(
      [{
        companyId,
        fromDistributorId,
        distributorId: toDistributorId,
        items: transferItems,
        totalShippingCost: totalShippingCost || 0,
        notes,
        createdBy: reqUser.userId
      }],
      { session }
    );

    await session.commitTransaction();

    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'inventory.transfer',
      entityType: 'StockTransfer',
      entityId: stockTransfer[0]._id,
      changes: { after: stockTransfer[0].toObject() }
    });

    return stockTransfer[0];
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const transfer = async (companyId, data, reqUser) => {
  const { distributorId, items, totalShippingCost, notes, supplierId } = data;
  const fromRaw = data.fromDistributorId;
  const fromId = fromRaw && String(fromRaw).trim() ? fromRaw : null;

  if (fromId) {
    return transferBetweenDistributors(
      companyId,
      fromId,
      distributorId,
      items,
      totalShippingCost,
      notes,
      reqUser
    );
  }

  return transferFromCompany(companyId, distributorId, items, totalShippingCost, notes, reqUser, supplierId);
};

const getTransfers = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  if (query.distributorId) filter.distributorId = query.distributorId;
  if (query.createdAtFrom || query.createdAtTo) {
    filter.createdAt = {};
    if (query.createdAtFrom) {
      const from = new Date(query.createdAtFrom);
      if (!Number.isNaN(from.getTime())) filter.createdAt.$gte = from;
    }
    if (query.createdAtTo) {
      const to = new Date(query.createdAtTo);
      if (!Number.isNaN(to.getTime())) filter.createdAt.$lte = to;
    }
    if (Object.keys(filter.createdAt).length === 0) {
      delete filter.createdAt;
    }
  }

  const [docs, total] = await Promise.all([
    StockTransfer.find(filter)
      .populate('supplierId', 'name')
      .populate('fromDistributorId', 'name')
      .populate('distributorId', 'name')
      .populate('items.productId', 'name')
      .populate('createdBy', 'name')
      .sort(sort).skip(skip).limit(limit),
    StockTransfer.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

module.exports = { getAll, getByDistributor, transfer, getTransfers, getSummary };
