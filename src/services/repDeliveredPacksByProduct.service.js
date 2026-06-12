const mongoose = require('mongoose');
const DeliveryRecord = require('../models/DeliveryRecord');
const Product = require('../models/Product');

const nd = { $ne: true };

/**
 * Sum delivered line quantities by product for a rep in a UTC date range.
 * Returns physical, paid, and bonus totals per product (returns excluded).
 */
const deliveredPacksByProduct = async (companyId, employeeId, periodRange) => {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rid = new mongoose.Types.ObjectId(String(employeeId));
  const range = periodRange;

  const agg = await DeliveryRecord.aggregate([
    { $match: { companyId: cid, isDeleted: nd, deliveredAt: range } },
    { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'ord' } },
    { $unwind: '$ord' },
    { $match: { 'ord.medicalRepId': rid, 'ord.isDeleted': nd } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.productId',
        physicalQty: { $sum: '$items.quantity' },
        paidQty: {
          $sum: {
            $cond: [
              { $gt: [{ $ifNull: ['$items.paidQuantity', null] }, null] },
              '$items.paidQuantity',
              {
                $subtract: [
                  '$items.quantity',
                  { $ifNull: ['$items.bonusQuantity', 0] }
                ]
              }
            ]
          }
        },
        bonusQty: {
          $sum: {
            $cond: [
              { $gt: [{ $ifNull: ['$items.bonusQuantity', null] }, null] },
              '$items.bonusQuantity',
              0
            ]
          }
        }
      }
    }
  ]);

  const byProduct = new Map();
  for (const row of agg) {
    const pid = String(row._id);
    const physicalQty = Math.max(0, Number(row.physicalQty) || 0);
    let paidQty = Math.max(0, Number(row.paidQty) || 0);
    const bonusQty = Math.max(0, Number(row.bonusQty) || 0);
    if (bonusQty === 0 && paidQty === 0 && physicalQty > 0) {
      paidQty = physicalQty;
    }
    byProduct.set(pid, { physicalQty, paidQty, bonusQty });
  }

  if (byProduct.size === 0) return { rows: [], byProductId: byProduct };

  const pids = [...byProduct.keys()].map((id) => new mongoose.Types.ObjectId(id));
  const products = await Product.find({ companyId: cid, _id: { $in: pids } })
    .select('name composition')
    .lean();
  const nameById = new Map(products.map((p) => [String(p._id), p]));

  const rows = [];
  for (const [pid, qty] of byProduct.entries()) {
    const p = nameById.get(pid);
    rows.push({
      productId: pid,
      productName: p?.name || 'Unknown product',
      composition: p?.composition ? String(p.composition) : '',
      physicalQty: qty.physicalQty,
      paidQty: qty.paidQty,
      bonusQty: qty.bonusQty
    });
  }
  rows.sort((a, b) => String(a.productName).localeCompare(String(b.productName)));

  return { rows, byProductId: byProduct };
};

const qtyForIncentiveRule = (byProductId, productId, includeBonusQty) => {
  const meta = byProductId.get(String(productId));
  if (!meta) return 0;
  if (includeBonusQty !== false) return meta.physicalQty;
  return meta.paidQty;
};

module.exports = {
  deliveredPacksByProduct,
  qtyForIncentiveRule
};
