const mongoose = require('mongoose');
const Order = require('../models/Order');
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const DistributorInventory = require('../models/DistributorInventory');
const doctorActivityService = require('./doctorActivity.service');
const MedRepTarget = require('../models/MedRepTarget');
const Ledger = require('../models/Ledger');
const Transaction = require('../models/Transaction');
const Product = require('../models/Product');
const Distributor = require('../models/Distributor');
const Pharmacy = require('../models/Pharmacy');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { getNextSequenceNumber } = require('../utils/orderNumber');
const { parsePagination } = require('../utils/pagination');
const { ORDER_STATUS, LEDGER_TYPE, LEDGER_REFERENCE_TYPE, TRANSACTION_TYPE, LEDGER_ENTITY_TYPE } = require('../constants/enums');
const auditService = require('./audit.service');
const pdfService = require('./pdf.service');
const financialService = require('./financial.service');
const { calculateBonus, normalizeBonusScheme, lineTotalQuantity } = require('../utils/bonus');

const paidUnitsInDeliveryBatch = (orderItem, alreadyDelivered, physicalBatchQty) => {
  const paidCap = Number(orderItem.quantity) || 0;
  const paidDeliveredSoFar = Math.min(alreadyDelivered, paidCap);
  return Math.min(physicalBatchQty, Math.max(0, paidCap - paidDeliveredSoFar));
};

const buildLineItemsFromPayload = (data, productMap, pharmacy, distributor) => {
  const scheme = normalizeBonusScheme(pharmacy.bonusScheme);
  return data.items.map((item) => {
    const product = productMap[item.productId];
    const qty = Number(item.quantity);
    if (Number.isNaN(qty) || qty < 0) throw new ApiError(400, 'Invalid quantity');
    if (qty < 1) throw new ApiError(400, 'Paid quantity must be at least 1');
    const autoBonus = calculateBonus(qty, scheme.buyQty, scheme.getQty);
    let bonusQuantity = autoBonus;
    if (item.bonusQuantity !== undefined && item.bonusQuantity !== null && item.bonusQuantity !== '') {
      bonusQuantity = Number(item.bonusQuantity);
      if (Number.isNaN(bonusQuantity) || bonusQuantity < 0) throw new ApiError(400, 'Invalid bonus quantity');
    }
    if (lineTotalQuantity(qty, bonusQuantity) < 1) throw new ApiError(400, 'Invalid line total quantity');
    return {
      productId: item.productId,
      productName: product.name,
      quantity: qty,
      bonusScheme: { buyQty: scheme.buyQty, getQty: scheme.getQty },
      bonusQuantity,
      tpAtTime: product.tp,
      castingAtTime: product.casting,
      distributorDiscount: item.distributorDiscount ?? distributor.discountOnTP ?? 0,
      clinicDiscount: item.clinicDiscount ?? pharmacy.discountOnTP ?? 0
    };
  });
};

const list = async (companyId, query) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const filter = { companyId };
  if (query.status) filter.status = query.status;
  if (query.distributorId) filter.distributorId = query.distributorId;
  if (query.pharmacyId) filter.pharmacyId = query.pharmacyId;
  if (query.medicalRepId) filter.medicalRepId = query.medicalRepId;
  if (search) {
    filter.$or = [{ orderNumber: { $regex: search, $options: 'i' } }];
  }

  const [docs, total] = await Promise.all([
    Order.find(filter)
      .populate('pharmacyId', 'name city')
      .populate('doctorId', 'name')
      .populate('distributorId', 'name')
      .populate('medicalRepId', 'name')
      .sort(sort).skip(skip).limit(limit),
    Order.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  let medicalRepId = reqUser.userId;
  if (data.medicalRepId) {
    const rep = await User.findOne({ _id: data.medicalRepId, companyId, isActive: true });
    if (!rep) throw new ApiError(400, 'Selected user is not an active member of this company');
    medicalRepId = data.medicalRepId;
  }

  const [pharmacy, distributor] = await Promise.all([
    Pharmacy.findOne({ _id: data.pharmacyId, companyId, isActive: true }),
    Distributor.findOne({ _id: data.distributorId, companyId, isActive: true })
  ]);
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  if (!distributor) throw new ApiError(404, 'Distributor not found');

  const productIds = data.items.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: productIds }, companyId, isActive: true });
  if (products.length !== productIds.length) throw new ApiError(400, 'One or more products not found');

  const productMap = {};
  products.forEach((p) => { productMap[p._id.toString()] = p; });

  const items = buildLineItemsFromPayload(data, productMap, pharmacy, distributor);

  const { items: itemsWithSnap, totals } = financialService.enrichOrderItemsWithFinancialSnapshot(items, distributor);
  const totalOrderedAmount = totals.totalAmount;

  const createPayload = () => ({
    companyId,
    pharmacyId: data.pharmacyId,
    doctorId: data.doctorId || null,
    distributorId: data.distributorId,
    medicalRepId,
    items: itemsWithSnap,
    totalOrderedAmount,
    totalAmount: totals.totalAmount,
    pharmacyDiscountAmount: totals.pharmacyDiscountAmount,
    amountAfterPharmacyDiscount: totals.amountAfterPharmacyDiscount,
    distributorCommissionAmount: totals.distributorCommissionAmount,
    finalCompanyRevenue: totals.finalCompanyRevenue,
    totalBonusQuantity: totals.totalBonusQuantity,
    totalCastingCost: totals.totalCastingCost,
    notes: data.notes,
    createdBy: reqUser.userId
  });

  const orderNumber = await getNextSequenceNumber(companyId, 'ORD');
  const order = await Order.create({ ...createPayload(), orderNumber });

  await auditService.log({ companyId, userId: reqUser.userId, action: 'order.create', entityType: 'Order', entityId: order._id, changes: { after: order.toObject() } });

  return order;
};

const getById = async (companyId, id) => {
  const order = await Order.findOne({ _id: id, companyId })
    .populate('pharmacyId', 'name city address phone bonusScheme discountOnTP')
    .populate('doctorId', 'name specialization')
    .populate('distributorId', 'name city discountOnTP commissionPercentOnTP')
    .populate('medicalRepId', 'name')
    .populate('items.productId', 'name composition');
  if (!order) throw new ApiError(404, 'Order not found');

  const [deliveries, returns] = await Promise.all([
    DeliveryRecord.find({ companyId, orderId: id }).populate('deliveredBy', 'name').sort({ deliveredAt: -1 }),
    ReturnRecord.find({ companyId, orderId: id }).populate('returnedBy', 'name').sort({ returnedAt: -1 })
  ]);

  return { ...order.toObject(), deliveries, returns };
};

const update = async (companyId, id, data, reqUser) => {
  const order = await Order.findOne({ _id: id, companyId });
  if (!order) throw new ApiError(404, 'Order not found');
  if (order.status !== ORDER_STATUS.PENDING) throw new ApiError(400, 'Only pending orders can be edited');

  const before = order.toObject();

  if (data.pharmacyId !== undefined) {
    const pharmacy = await Pharmacy.findOne({ _id: data.pharmacyId, companyId, isActive: true });
    if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
    order.pharmacyId = data.pharmacyId;
  }
  if (data.distributorId !== undefined) {
    const distributor = await Distributor.findOne({ _id: data.distributorId, companyId, isActive: true });
    if (!distributor) throw new ApiError(404, 'Distributor not found');
    order.distributorId = data.distributorId;
  }
  if (data.doctorId !== undefined) {
    order.doctorId = data.doctorId && String(data.doctorId).trim() ? data.doctorId : null;
  }
  if (data.medicalRepId !== undefined) {
    const rep = await User.findOne({ _id: data.medicalRepId, companyId, isActive: true });
    if (!rep) throw new ApiError(400, 'Selected user is not an active member of this company');
    order.medicalRepId = data.medicalRepId;
  }
  if (data.notes !== undefined) order.notes = data.notes;
  if (data.items) {
    const [pharmacy, distributor] = await Promise.all([
      Pharmacy.findOne({ _id: order.pharmacyId, companyId }),
      Distributor.findOne({ _id: order.distributorId, companyId })
    ]);
    const productIds = data.items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds }, companyId, isActive: true });
    const productMap = {};
    products.forEach((p) => { productMap[p._id.toString()] = p; });

    const rawItems = buildLineItemsFromPayload(data, productMap, pharmacy, distributor).map((row) => ({
      ...row,
      deliveredQty: 0,
      returnedQty: 0
    }));
    const { items: itemsWithSnap, totals } = financialService.enrichOrderItemsWithFinancialSnapshot(rawItems, distributor);
    order.items = itemsWithSnap;
    order.totalOrderedAmount = totals.totalAmount;
    order.totalAmount = totals.totalAmount;
    order.pharmacyDiscountAmount = totals.pharmacyDiscountAmount;
    order.amountAfterPharmacyDiscount = totals.amountAfterPharmacyDiscount;
    order.distributorCommissionAmount = totals.distributorCommissionAmount;
    order.finalCompanyRevenue = totals.finalCompanyRevenue;
    order.totalBonusQuantity = totals.totalBonusQuantity;
    order.totalCastingCost = totals.totalCastingCost;
  }
  order.updatedBy = reqUser.userId;
  await order.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'order.update', entityType: 'Order', entityId: order._id, changes: { before, after: order.toObject() } });
  return order;
};

const deliver = async (companyId, orderId, deliveryItems, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findOne({ _id: orderId, companyId }).session(session);
    if (!order) throw new ApiError(404, 'Order not found');
    if (![ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_DELIVERED].includes(order.status)) {
      throw new ApiError(400, 'Order cannot be delivered in its current status');
    }

    const distributor = await Distributor.findOne({ _id: order.distributorId, companyId }).session(session);
    if (!distributor) throw new ApiError(404, 'Distributor not found');

    const deliveryRecordItems = [];
    let totalAmount = 0;
    let totalCost = 0;
    let totalPacks = 0;
    let tpSubtotal = 0;
    let distributorShareTotal = 0;
    let companyShareTotal = 0;
    let commissionPctSnapshot = null;

    for (const dItem of deliveryItems) {
      const orderItem = order.items.find((i) => i.productId.toString() === dItem.productId);
      if (!orderItem) throw new ApiError(400, `Product ${dItem.productId} not in this order`);

      const lineMax = lineTotalQuantity(orderItem.quantity, orderItem.bonusQuantity || 0);
      const alreadyDelivered = orderItem.deliveredQty;
      const remaining = lineMax - alreadyDelivered;
      if (dItem.quantity > remaining) {
        throw new ApiError(400, `Cannot deliver ${dItem.quantity} of ${orderItem.productName}. Remaining: ${remaining}`);
      }

      const inv = await DistributorInventory.findOne({ companyId, distributorId: order.distributorId, productId: dItem.productId }).session(session);
      if (!inv || inv.quantity < dItem.quantity) {
        throw new ApiError(400, `Insufficient inventory for ${orderItem.productName}`);
      }

      const physicalQty = dItem.quantity;
      const paidThisBatch = paidUnitsInDeliveryBatch(orderItem, alreadyDelivered, physicalQty);
      const snap = financialService.computeLineSnapshot(orderItem, paidThisBatch, distributor);
      commissionPctSnapshot = snap.commissionPct;

      const avgCostAtTime = inv.avgCostPerUnit;
      const linePharmacyNet = snap.linePharmacyNet;
      const lineCost = roundPKR(avgCostAtTime * physicalQty);
      const totalProfit = roundPKR(linePharmacyNet - lineCost);
      const finalSellingPrice = physicalQty > 0 ? roundPKR(linePharmacyNet / physicalQty) : 0;
      const profitPerUnit = physicalQty > 0 ? roundPKR(totalProfit / physicalQty) : 0;

      await DistributorInventory.updateOne(
        { _id: inv._id },
        { $inc: { quantity: -physicalQty }, $set: { lastUpdated: new Date() } },
        { session }
      );

      orderItem.deliveredQty += physicalQty;

      deliveryRecordItems.push({
        productId: dItem.productId,
        quantity: physicalQty,
        avgCostAtTime,
        finalSellingPrice,
        profitPerUnit,
        totalProfit,
        tpLineTotal: snap.tpLineTotal,
        distributorShare: snap.distributorShare,
        linePharmacyNet: snap.linePharmacyNet,
        companyShare: snap.companyShare
      });

      const lineNet = linePharmacyNet;
      totalAmount += lineNet;
      tpSubtotal += snap.tpLineTotal;
      distributorShareTotal += snap.distributorShare;
      companyShareTotal += snap.companyShare;
      totalCost += lineCost;
      totalPacks += physicalQty;
    }

    totalAmount = roundPKR(totalAmount);
    tpSubtotal = roundPKR(tpSubtotal);
    distributorShareTotal = roundPKR(distributorShareTotal);
    companyShareTotal = roundPKR(companyShareTotal);

    const totalProfit = roundPKR(totalAmount - totalCost);

    const allDelivered = order.items.every((i) => i.deliveredQty >= lineTotalQuantity(i.quantity, i.bonusQuantity || 0));
    order.status = allDelivered ? ORDER_STATUS.DELIVERED : ORDER_STATUS.PARTIALLY_DELIVERED;
    order.updatedBy = reqUser.userId;
    await order.save({ session });

    const invoiceNumber = await getNextSequenceNumber(companyId, 'INV', { session });

    const pharmacyNetPayable = totalAmount;
    const [delivery] = await DeliveryRecord.create(
      [
        {
          companyId,
          orderId,
          invoiceNumber,
          items: deliveryRecordItems,
          totalAmount,
          totalCost,
          totalProfit,
          tpSubtotal,
          distributorShareTotal,
          pharmacyNetPayable,
          companyShareTotal,
          distributorCommissionPercent: commissionPctSnapshot,
          deliveredBy: reqUser.userId
        }
      ],
      { session, ordered: true }
    );

    if (order.doctorId && tpSubtotal > 0) {
      await doctorActivityService.applyDeliveryTp(session, companyId, {
        doctorId: order.doctorId,
        tpAmount: tpSubtotal,
        deliveredAt: delivery.deliveredAt
      });
    }

    const month = new Date().toISOString().slice(0, 7);
    await MedRepTarget.updateOne(
      { companyId, medicalRepId: order.medicalRepId, month },
      { $inc: { achievedSales: totalAmount, achievedPacks: totalPacks } },
      { session }
    );

    await financialService.postDeliveryLedgers(session, {
      companyId,
      pharmacyId: order.pharmacyId,
      deliveryId: delivery._id,
      orderId: order._id,
      invoiceNumber,
      pharmacyNetPayable,
      date: new Date()
    });

    await Transaction.create(
      [{ companyId, type: TRANSACTION_TYPE.SALE, referenceType: 'DELIVERY', referenceId: delivery._id, revenue: totalAmount, cost: totalCost, profit: totalProfit, date: new Date(), description: `Sale - ${invoiceNumber}` }],
      { session, ordered: true }
    );

    await auditService.logInSession(session, { companyId, userId: reqUser.userId, action: 'order.deliver', entityType: 'Order', entityId: orderId, changes: { deliveryId: delivery._id, items: deliveryRecordItems } });

    await session.commitTransaction();

    // Generate PDF async (non-blocking)
    pdfService.generateInvoice(delivery._id).catch(() => {});

    return delivery;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const returnOrder = async (companyId, orderId, returnItems, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findOne({ _id: orderId, companyId }).session(session);
    if (!order) throw new ApiError(404, 'Order not found');
    if (![ORDER_STATUS.DELIVERED, ORDER_STATUS.PARTIALLY_DELIVERED, ORDER_STATUS.PARTIALLY_RETURNED].includes(order.status)) {
      throw new ApiError(400, 'Order cannot be returned in its current status');
    }

    const returnRecordItems = [];
    let totalAmount = 0;
    let totalCost = 0;
    let totalPacks = 0;
    let tpReturnTotal = 0;

    for (const rItem of returnItems) {
      const orderItem = order.items.find((i) => i.productId.toString() === rItem.productId);
      if (!orderItem) throw new ApiError(400, `Product ${rItem.productId} not in this order`);

      const returnable = orderItem.deliveredQty - orderItem.returnedQty;
      if (rItem.quantity > returnable) {
        throw new ApiError(400, `Cannot return ${rItem.quantity} of ${orderItem.productName}. Returnable: ${returnable}`);
      }

      const lastDelivery = await DeliveryRecord.findOne(
        { companyId, orderId, 'items.productId': rItem.productId }
      )
        .sort({ deliveredAt: -1 })
        .session(session);

      const dLine = lastDelivery?.items?.find((i) => i.productId.toString() === rItem.productId);
      const avgCostAtTime = dLine?.avgCostAtTime || 0;
      const finalSellingPrice = dLine?.finalSellingPrice || 0;
      const profitPerUnit = roundPKR(finalSellingPrice - avgCostAtTime);
      const totalProfit = roundPKR(profitPerUnit * rItem.quantity);

      await DistributorInventory.updateOne(
        { companyId, distributorId: order.distributorId, productId: rItem.productId },
        { $inc: { quantity: rItem.quantity }, $set: { lastUpdated: new Date() } },
        { session }
      );

      orderItem.returnedQty += rItem.quantity;

      const returnLineAmount = roundPKR(finalSellingPrice * rItem.quantity);

      const lineQty = dLine?.quantity > 0 ? dLine.quantity : rItem.quantity;
      const returnCompanyShare =
        dLine && dLine.companyShare != null
          ? roundPKR((dLine.companyShare / lineQty) * rItem.quantity)
          : roundPKR(
              returnLineAmount -
                (dLine && dLine.distributorShare != null
                  ? roundPKR((dLine.distributorShare / lineQty) * rItem.quantity)
                  : 0)
            );

      returnRecordItems.push({
        productId: rItem.productId,
        quantity: rItem.quantity,
        avgCostAtTime,
        finalSellingPrice,
        companyShare: returnCompanyShare,
        profitPerUnit,
        totalProfit,
        reason: rItem.reason || ''
      });
      totalAmount += returnLineAmount;
      totalCost += roundPKR(avgCostAtTime * rItem.quantity);
      totalPacks += rItem.quantity;
      tpReturnTotal += roundPKR(orderItem.tpAtTime * rItem.quantity);
    }

    tpReturnTotal = roundPKR(tpReturnTotal);

    const totalProfit = roundPKR(totalAmount - totalCost);

    const allReturned = order.items.every((i) => i.returnedQty >= i.deliveredQty);
    if (allReturned) {
      order.status = ORDER_STATUS.RETURNED;
    } else {
      const anyReturned = order.items.some((i) => i.returnedQty > 0);
      order.status = anyReturned ? ORDER_STATUS.PARTIALLY_RETURNED : order.status;
    }
    order.updatedBy = reqUser.userId;
    await order.save({ session });

    const [returnRecord] = await ReturnRecord.create(
      [{ companyId, orderId, items: returnRecordItems, totalAmount, totalCost, totalProfit, returnedBy: reqUser.userId }],
      { session, ordered: true }
    );

    if (order.doctorId && tpReturnTotal > 0) {
      await doctorActivityService.applyReturnTp(session, companyId, {
        doctorId: order.doctorId,
        tpAmount: tpReturnTotal,
        returnedAt: returnRecord.returnedAt
      });
    }

    const month = new Date().toISOString().slice(0, 7);
    await MedRepTarget.updateOne(
      { companyId, medicalRepId: order.medicalRepId, month },
      { $inc: { achievedSales: -totalAmount, achievedPacks: -totalPacks } },
      { session }
    );

    const retDate = new Date();
    await Ledger.create(
      [{ companyId, entityType: LEDGER_ENTITY_TYPE.PHARMACY, entityId: order.pharmacyId, type: LEDGER_TYPE.CREDIT, amount: totalAmount, referenceType: LEDGER_REFERENCE_TYPE.RETURN, referenceId: returnRecord._id, description: `Return for order ${order.orderNumber}`, date: retDate }],
      { session, ordered: true }
    );

    for (const row of returnRecordItems) {
      const returnLineAmount = roundPKR(row.finalSellingPrice * row.quantity);
      const lastDelivery = await DeliveryRecord.findOne({
        companyId,
        orderId,
        'items.productId': row.productId
      })
        .sort({ deliveredAt: -1 })
        .session(session);
      if (!lastDelivery) continue;
      const line = lastDelivery.items.find((i) => i.productId.toString() === row.productId.toString());
      if (!line) continue;
      const linePharmacyNet = roundPKR(line.linePharmacyNet ?? line.finalSellingPrice * line.quantity);
      if (linePharmacyNet <= 0) continue;
      const f = Math.min(1, returnLineAmount / linePharmacyNet);
      const lineCompany = line.companyShare != null ? roundPKR(line.companyShare) : roundPKR(linePharmacyNet - (line.distributorShare || 0));
      const lineDist = line.distributorShare != null ? roundPKR(line.distributorShare) : 0;
      await financialService.postReturnClearingAdjustment(session, {
        companyId,
        distributorId: order.distributorId,
        deliveryId: lastDelivery._id,
        orderId: order._id,
        fraction: f,
        companyShareTotal: lineCompany,
        distributorShareTotal: lineDist,
        returnRecordId: returnRecord._id,
        date: retDate
      });
    }

    await Transaction.create(
      [{ companyId, type: TRANSACTION_TYPE.RETURN, referenceType: 'RETURN', referenceId: returnRecord._id, revenue: -totalAmount, cost: -totalCost, profit: -totalProfit, date: new Date(), description: `Return - ${order.orderNumber}` }],
      { session, ordered: true }
    );

    await auditService.logInSession(session, { companyId, userId: reqUser.userId, action: 'order.return', entityType: 'Order', entityId: orderId, changes: { returnId: returnRecord._id, items: returnRecordItems } });

    await session.commitTransaction();
    return returnRecord;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const cancel = async (companyId, id, reqUser) => {
  const order = await Order.findOne({ _id: id, companyId });
  if (!order) throw new ApiError(404, 'Order not found');
  if (order.status !== ORDER_STATUS.PENDING) throw new ApiError(400, 'Only pending orders can be cancelled');
  order.status = ORDER_STATUS.CANCELLED;
  order.updatedBy = reqUser.userId;
  await order.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'order.cancel', entityType: 'Order', entityId: order._id, changes: { after: { status: 'CANCELLED' } } });
  return order;
};

module.exports = { list, create, getById, update, deliver, returnOrder, cancel };
