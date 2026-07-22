/**
 * Pharmacy Financial Workspace — aggregates read-only financial context for UI/PDF.
 * Uses existing financialService.computePharmacyReceivableState (FIFO open balances); does not post ledger.
 */
const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const Company = require('../models/Company');
const Pharmacy = require('../models/Pharmacy');
const Territory = require('../models/Territory');
const User = require('../models/User');
const Order = require('../models/Order');
const Collection = require('../models/Collection');
const DeliveryRecord = require('../models/DeliveryRecord');
const Ledger = require('../models/Ledger');
const financialService = require('./financial.service');
const { roundPKR } = require('../utils/currency');
const businessTime = require('../utils/businessTime');
const { LEDGER_ENTITY_TYPE } = require('../constants/enums');

const objectId = (id) => new mongoose.Types.ObjectId(id);
const nd = { $ne: true };

const daysBetweenStartOfDay = (then, nowDt) => {
  const a = DateTime.fromJSDate(then).toUTC().startOf('day');
  const b = nowDt.toUTC().startOf('day');
  return Math.floor(b.diff(a, 'days').days);
};

/**
 * Aging bands for **remaining open balance per delivery** by days since delivery date.
 * Labels match finance workspace copy; methodology note returned for auditors.
 */
const buildAgingFromReceivableRows = (rows, nowDt) => {
  const buckets = {
    current_0_30: 0,
    days_31_60: 0,
    days_61_90: 0,
    days_90_plus: 0
  };
  let overdueAmount = 0;

  for (const r of rows) {
    if (!r.deliveredAt || r.open <= 0.001) continue;
    const days = daysBetweenStartOfDay(new Date(r.deliveredAt), nowDt);
    const amt = roundPKR(r.open);
    if (days <= 30) buckets.current_0_30 = roundPKR(buckets.current_0_30 + amt);
    else if (days <= 60) {
      buckets.days_31_60 = roundPKR(buckets.days_31_60 + amt);
      overdueAmount = roundPKR(overdueAmount + amt);
    } else if (days <= 90) {
      buckets.days_61_90 = roundPKR(buckets.days_61_90 + amt);
      overdueAmount = roundPKR(overdueAmount + amt);
    } else {
      buckets.days_90_plus = roundPKR(buckets.days_90_plus + amt);
      overdueAmount = roundPKR(overdueAmount + amt);
    }
  }

  const display = [
    { key: 'current_0_30', label: 'Current (0–30 days)', amount: buckets.current_0_30 },
    { key: 'days_31_60', label: '31–60 days', amount: buckets.days_31_60 },
    { key: 'days_61_90', label: '61–90 days', amount: buckets.days_61_90 },
    { key: 'days_90_plus', label: 'Over 90 days', amount: buckets.days_90_plus }
  ];

  return { buckets, display, overdueAmount };
};

const pharmacyFinancialWorkspace = async (companyId, pharmacyId, _query = {}, timeZone) => {
  const cid = objectId(companyId);
  const pid = objectId(pharmacyId);
  const zone = businessTime.requireCompanyIanaZone(timeZone);
  const nowDt = DateTime.now().setZone(zone);

  const pharmacy = await Pharmacy.findOne({ _id: pid, companyId: cid, isDeleted: nd }).lean();
  if (!pharmacy) return null;

  const [company, territory, receivableState, lastCollection, lastOrder, repAgg, byRef] = await Promise.all([
    Company.findById(cid).select('name address city state phone email logo currency').lean(),
    pharmacy.territoryId
      ? Territory.findOne({ _id: pharmacy.territoryId, companyId: cid, isDeleted: nd }).select('name code kind').lean()
      : null,
    financialService.computePharmacyReceivableState(companyId, pharmacyId, null),
    Collection.findOne({ companyId: cid, pharmacyId: pid, isDeleted: nd }).sort({ date: -1 }).lean(),
    Order.findOne({ companyId: cid, pharmacyId: pid, isDeleted: nd }).sort({ createdAt: -1 }).select('orderNumber status createdAt').lean(),
    Order.aggregate([
      { $match: { companyId: cid, pharmacyId: pid, isDeleted: nd } },
      { $group: { _id: '$medicalRepId', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 }
    ]),
    Ledger.aggregate([
      { $match: { companyId: cid, entityType: LEDGER_ENTITY_TYPE.PHARMACY, entityId: pid, isDeleted: nd } },
      {
        $group: {
          _id: '$referenceType',
          debit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
          credit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
        }
      },
      { $sort: { _id: 1 } }
    ])
  ]);

  let assignedRep = null;
  if (repAgg[0]?._id) {
    const u = await User.findOne({ _id: repAgg[0]._id, companyId: cid, isDeleted: nd }).select('name').lean();
    if (u) assignedRep = { _id: u._id, name: u.name };
  }

  const startOfMonth = nowDt.startOf('month').toJSDate();
  const endOfMonth = nowDt.endOf('month').toJSDate();

  const orderIds = await Order.find({ companyId: cid, pharmacyId: pid, isDeleted: nd }).distinct('_id');

  const [monthSalesAgg, monthCollAgg] = await Promise.all([
    orderIds.length
      ? DeliveryRecord.aggregate([
          {
            $match: {
              companyId: cid,
              orderId: { $in: orderIds },
              isDeleted: nd,
              deliveredAt: { $gte: startOfMonth, $lte: endOfMonth }
            }
          },
          { $group: { _id: null, t: { $sum: { $ifNull: ['$pharmacyNetPayable', '$totalAmount'] } } } }
        ])
      : [],
    Collection.aggregate([
      {
        $match: {
          companyId: cid,
          pharmacyId: pid,
          isDeleted: nd,
          date: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      { $group: { _id: null, t: { $sum: '$amount' } } }
    ])
  ]);

  const totalOpen = roundPKR(receivableState.totalOpen);
  const aging = buildAgingFromReceivableRows(receivableState.rows, nowDt);

  const shortId = String(pid).slice(-6).toUpperCase();
  const accountCode = `PH-${shortId}`;

  const badges = [];
  if (pharmacy.isActive === false) badges.push({ key: 'inactive', label: 'Inactive', severity: 'warning' });
  else badges.push({ key: 'active', label: 'Active', severity: 'success' });
  if (aging.overdueAmount > 0.001) badges.push({ key: 'payment_delayed', label: 'Payment delayed', severity: 'error' });

  const kpis = {
    currentBalance: totalOpen,
    overdueBalance: aging.overdueAmount,
    creditLimit: null,
    availableCredit: null,
    monthSales: roundPKR(monthSalesAgg[0]?.t || 0),
    monthCollections: roundPKR(monthCollAgg[0]?.t || 0),
    averagePaymentDays: null,
    lastCollectionAmount: lastCollection ? roundPKR(lastCollection.amount) : null,
    lastActivityDate: (() => {
      const ts = [];
      if (lastCollection?.date) ts.push(new Date(lastCollection.date));
      if (lastOrder?.createdAt) ts.push(new Date(lastOrder.createdAt));
      if (!ts.length) return null;
      return new Date(Math.max(...ts.map((d) => d.getTime())));
    })()
  };

  const netOutstanding = roundPKR(
    byRef.reduce((s, r) => s + roundPKR(r.debit) - roundPKR(r.credit), 0)
  );
  const ledgerSummaryByType = byRef.map((r) => ({
    referenceType: r._id,
    debit: roundPKR(r.debit),
    credit: roundPKR(r.credit),
    net: roundPKR(r.debit - r.credit)
  }));

  return {
    generatedAt: businessTime.utcNowIso(),
    methodologyNote:
      'Aging uses days since delivery date on remaining FIFO open balance per delivery (same basis as collection allocation). Credit limit is not configured on pharmacy records in this version.',
    company: company
      ? {
          name: company.name,
          address: company.address,
          city: company.city,
          state: company.state,
          phone: company.phone,
          phones: Array.isArray(company.phones) ? company.phones : company.phone ? [company.phone] : [],
          email: company.email,
          logo: company.logo || null,
          currency: company.currency || 'PKR'
        }
      : null,
    pharmacy: {
      _id: pharmacy._id,
      name: pharmacy.name,
      accountCode,
      address: pharmacy.address,
      city: pharmacy.city,
      state: pharmacy.state,
      phone: pharmacy.phone,
      email: pharmacy.email,
      isActive: pharmacy.isActive !== false,
      territory: territory
        ? { _id: territory._id, name: territory.name, code: territory.code, kind: territory.kind }
        : null,
      assignedRep
    },
    financial: {
      currentOutstanding: totalOpen,
      overdueAmount: aging.overdueAmount,
      creditLimit: null,
      availableCredit: null,
      lastCollectionDate: lastCollection?.date || null,
      lastCollectionAmount: lastCollection ? roundPKR(lastCollection.amount) : null,
      lastOrderDate: lastOrder?.createdAt || null,
      lastOrderNumber: lastOrder?.orderNumber || null
    },
    badges,
    aging: {
      display: aging.display,
      totalAllocatedToBuckets: roundPKR(
        aging.display.reduce((s, x) => s + x.amount, 0)
      )
    },
    kpis,
    netOutstanding,
    ledgerSummaryByType,
    uiHints: {
      summaryIsGlobal: true,
      statementLinesAreFiltered:
        'Ledger line filters apply only to the statement table; KPIs and aging above use live company-wide position for this pharmacy.'
    }
  };
};

module.exports = { pharmacyFinancialWorkspace, buildAgingFromReceivableRows };
