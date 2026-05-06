/**
 * Read-side sales roll-ups by rep / team (Phase 3). Uses Order.finalCompanyRevenue; excludes cancelled rows.
 */
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { ORDER_STATUS } = require('../constants/enums');
const businessTime = require('../utils/businessTime');

const nd = { $ne: true };

const applyOrderDateRange = (match, fromYmd, toYmd, zone) => {
  if (!fromYmd && !toYmd) return;
  match.orderDate = {};
  if (fromYmd) {
    match.orderDate.$gte = businessTime.businessDayStartUtc(fromYmd, zone);
  }
  if (toYmd) {
    match.orderDate.$lte = businessTime.filterUpperBoundUtc(toYmd, zone);
  }
  if (!Object.keys(match.orderDate).length) delete match.orderDate;
};

const byRep = async (companyId, repId, fromYmd, toYmd, tz) => {
  const zone = businessTime.requireCompanyIanaZone(tz);
  const match = {
    companyId: new mongoose.Types.ObjectId(String(companyId)),
    medicalRepId: new mongoose.Types.ObjectId(String(repId)),
    status: { $ne: ORDER_STATUS.CANCELLED },
    isDeleted: nd
  };
  applyOrderDateRange(match, fromYmd, toYmd, zone);

  const [agg] = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        orderCount: { $sum: 1 },
        grossRevenue: { $sum: { $ifNull: ['$finalCompanyRevenue', 0] } },
        distinctDoctors: { $addToSet: '$doctorId' }
      }
    }
  ]);

  if (!agg) {
    return { orderCount: 0, grossRevenue: 0, distinctDoctorCount: 0 };
  }
  const distinctDoctorCount = (agg.distinctDoctors || []).filter((x) => x != null).length;
  return {
    orderCount: agg.orderCount,
    grossRevenue: Math.round((agg.grossRevenue || 0) * 100) / 100,
    distinctDoctorCount
  };
};

const byTeam = async (companyId, repIds, fromYmd, toYmd, tz) => {
  if (!repIds?.length) {
    return {
      orderCount: 0,
      grossRevenue: 0,
      distinctDoctorCount: 0,
      byRep: []
    };
  }
  const zone = businessTime.requireCompanyIanaZone(tz);
  const oids = repIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  const match = {
    companyId: new mongoose.Types.ObjectId(String(companyId)),
    medicalRepId: { $in: oids },
    status: { $ne: ORDER_STATUS.CANCELLED },
    isDeleted: nd
  };
  applyOrderDateRange(match, fromYmd, toYmd, zone);

  const [totalsAgg, perRep] = await Promise.all([
    Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          orderCount: { $sum: 1 },
          grossRevenue: { $sum: { $ifNull: ['$finalCompanyRevenue', 0] } },
          distinctDoctors: { $addToSet: '$doctorId' }
        }
      }
    ]),
    Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$medicalRepId',
          orderCount: { $sum: 1 },
          grossRevenue: { $sum: { $ifNull: ['$finalCompanyRevenue', 0] } }
        }
      },
      { $sort: { grossRevenue: -1 } }
    ])
  ]);

  const totals = totalsAgg[0] || { orderCount: 0, grossRevenue: 0, distinctDoctors: [] };
  const distinctDoctorCount = (totals.distinctDoctors || []).filter((x) => x != null).length;

  return {
    orderCount: totals.orderCount,
    grossRevenue: Math.round((totals.grossRevenue || 0) * 100) / 100,
    distinctDoctorCount,
    byRep: perRep.map((r) => ({
      medicalRepId: String(r._id),
      orderCount: r.orderCount,
      grossRevenue: Math.round((r.grossRevenue || 0) * 100) / 100
    }))
  };
};

module.exports = { byRep, byTeam };
