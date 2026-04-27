const mongoose = require('mongoose');
const Company = require('../models/Company');
const User = require('../models/User');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const { LEDGER_TYPE, LEDGER_ENTITY_TYPE } = require('../constants/enums');
const { getPlatformAllowedCompanyIds } = require('../utils/platformAccess.util');
const reportService = require('./report.service');

const nd = { isDeleted: { $ne: true } };

const roundPKR = (n) => Math.round((Number(n) || 0) * 100) / 100;

const toOid = (id) => {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
};

const validDays = (d) => {
  const n = parseInt(d, 10);
  if (n === 7 || n === 30 || n === 90) return n;
  return 30;
};

const dateRange = (dayCount) => {
  const to = new Date();
  to.setHours(23, 59, 59, 999);
  const from = new Date(to);
  from.setDate(from.getDate() - (dayCount - 1));
  from.setHours(0, 0, 0, 0);
  const prevTo = new Date(from);
  prevTo.setMilliseconds(-1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (dayCount - 1));
  prevFrom.setHours(0, 0, 0, 0);
  return { from, to, prevFrom, prevTo, dayCount };
};

function listDaysFn(from, to) {
  const out = [];
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    out.push(
      cur.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
    );
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

const sumRevenue = async (companyId, from, to) => {
  const cid = toOid(companyId);
  const r = await Transaction.aggregate([
    {
      $match: {
        companyId: cid,
        ...nd,
        date: { $gte: from, $lte: to }
      }
    },
    { $group: { _id: null, total: { $sum: '$revenue' } } }
  ]);
  return roundPKR(r[0]?.total ?? 0);
};

const countOrders = async (companyId, from, to) => {
  const cid = toOid(companyId);
  return Order.countDocuments({
    companyId: cid,
    ...nd,
    createdAt: { $gte: from, $lte: to }
  });
};

/** Sum of per-distributor max(0, DR−CR) on clearing — "owed to company" (approx., consistent with report raw net). */
const sumDistributorOwedToCompany = async (companyId) => {
  const cid = toOid(companyId);
  const r = await Ledger.aggregate([
    { $match: { companyId: cid, entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING, ...nd } },
    {
      $group: {
        _id: '$entityId',
        tD: { $sum: { $cond: [{ $eq: ['$type', LEDGER_TYPE.DEBIT] }, '$amount', 0] } },
        tC: { $sum: { $cond: [{ $eq: ['$type', LEDGER_TYPE.CREDIT] }, '$amount', 0] } }
      }
    },
    { $addFields: { net: { $subtract: ['$tD', '$tC'] } } },
    { $group: { _id: null, s: { $sum: { $cond: [{ $gt: ['$net', 0] }, '$net', 0] } } } }
  ]);
  return roundPKR(r[0]?.s ?? 0);
};

const healthFor = (curRev, prevRev, receivables, revInPeriod) => {
  if (prevRev > 0 && curRev < prevRev * 0.75) return 'warning';
  if (revInPeriod > 0 && receivables > revInPeriod * 5) return 'warning';
  return 'healthy';
};

const buildRevenueMatrix = async (ids, from, to) => {
  if (!ids.length) {
    return { dates: listDaysFn(from, to), byCompany: {}, totals: [] };
  }
  const oids = ids.map(toOid).filter(Boolean);
  const dayKeys = listDaysFn(from, to);
  const n = dayKeys.length;
  const byCompany = Object.fromEntries(ids.map((id) => [id, new Array(n).fill(0)]));
  const totals = new Array(n).fill(0);
  const raw = await Transaction.aggregate([
    {
      $match: {
        companyId: { $in: oids },
        ...nd,
        date: { $gte: from, $lte: to }
      }
    },
    {
      $group: {
        _id: {
          d: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          c: '$companyId'
        },
        t: { $sum: '$revenue' }
      }
    }
  ]);
  const idxMap = new Map(dayKeys.map((d, i) => [d, i]));
  for (const row of raw) {
    const d = row._id.d;
    const c = String(row._id.c);
    const j = idxMap.get(d);
    if (j === undefined) continue;
    if (!byCompany[c]) byCompany[c] = new Array(n).fill(0);
    const v = roundPKR(row.t);
    byCompany[c][j] = v;
    totals[j] += v;
  }
  for (let i = 0; i < n; i++) {
    totals[i] = roundPKR(totals[i]);
  }
  return { dates: dayKeys, byCompany, totals: totals.map(roundPKR) };
};

const buildDashboard = async (user, query = {}) => {
  const allAllowed = await getPlatformAllowedCompanyIds(user);
  if (!allAllowed.length) {
    return {
      range: null,
      totals: { revenue: 0, orders: 0, receivablesFromPharmacy: 0, distributorOwedToCompany: 0, companiesCount: 0 },
      previousTotals: { revenue: 0, orders: 0 },
      companies: [],
      revenueByDay: { dates: [], byCompany: {}, totals: [] },
      allCompanyIds: []
    };
  }

  const days = validDays(query?.days);
  const { from, to, prevFrom, prevTo, dayCount } = dateRange(days);

  const requested = (query?.companies && String(query.companies).split(',')) || [];
  const idSet = new Set(allAllowed);
  const filteredRequested = requested.map((s) => s.trim()).filter((s) => mongoose.isValidObjectId(s) && idSet.has(s));
  const ids = filteredRequested.length ? filteredRequested : allAllowed;

  const { dates, byCompany, totals } = await buildRevenueMatrix(ids, from, to);

  const metas = await Company.find({ _id: { $in: ids.map(toOid) } })
    .select('name city isActive')
    .lean();

  const nameBy = Object.fromEntries(metas.map((c) => [String(c._id), c]));

  const companies = [];
  let sumRev = 0;
  let sumOrd = 0;
  let sumPrevRev = 0;
  let sumPrevOrd = 0;
  let sumRec = 0;
  let sumDist = 0;

  for (const id of ids) {
    const c = nameBy[id];
    const [revenue, orders, prevRev, prevOrd, { totals: pbal }, dOwed] = await Promise.all([
      sumRevenue(id, from, to),
      countOrders(id, from, to),
      sumRevenue(id, prevFrom, prevTo),
      countOrders(id, prevFrom, prevTo),
      reportService.pharmacyBalances(id),
      sumDistributorOwedToCompany(id)
    ]);
    const receivables = roundPKR(pbal?.totalReceivable ?? 0);
    const h = healthFor(revenue, prevRev, receivables, revenue);
    sumRev += revenue;
    sumOrd += orders;
    sumPrevRev += prevRev;
    sumPrevOrd += prevOrd;
    sumRec += receivables;
    sumDist += dOwed;
    companies.push({
      companyId: id,
      name: c?.name || 'Company',
      city: c?.city,
      isActive: c?.isActive !== false,
      period: {
        revenue,
        orders,
        receivablesFromPharmacy: receivables,
        distributorOwedToCompany: dOwed
      },
      previous: { revenue: prevRev, orders: prevOrd },
      health: h
    });
  }

  return {
    range: {
      days: dayCount,
      from: from.toISOString(),
      to: to.toISOString(),
      previousFrom: prevFrom.toISOString(),
      previousTo: prevTo.toISOString()
    },
    totals: {
      revenue: roundPKR(sumRev),
      orders: sumOrd,
      receivablesFromPharmacy: roundPKR(sumRec),
      distributorOwedToCompany: roundPKR(sumDist),
      companiesCount: ids.length
    },
    previousTotals: { revenue: roundPKR(sumPrevRev), orders: sumPrevOrd },
    companies: companies.map((r) => ({
      ...r,
      shareOfRevenue: sumRev > 0 ? roundPKR((r.period.revenue / sumRev) * 1e4) / 1e4 : 0
    })),
    revenueByDay: { dates, byCompany, totals },
    allCompanyIds: allAllowed
  };
};

/** Legacy: same as rich dashboard with default range (used if anything still calls `dashboard` directly). */
const dashboard = async (user) => buildDashboard(user, {});

const getForRequestUser = async (userId, query = {}) => {
  const user = await User.findById(userId).lean();
  if (!user) {
    return {
      range: null,
      totals: { revenue: 0, orders: 0, receivablesFromPharmacy: 0, distributorOwedToCompany: 0, companiesCount: 0 },
      previousTotals: { revenue: 0, orders: 0 },
      companies: [],
      revenueByDay: { dates: [], byCompany: {}, totals: [] },
      allCompanyIds: []
    };
  }
  return buildDashboard(user, query);
};

module.exports = { dashboard, getForRequestUser };
