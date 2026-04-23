const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const DistributorInventory = require('../models/DistributorInventory');
const DoctorActivity = require('../models/DoctorActivity');
const MedRepTarget = require('../models/MedRepTarget');
const Order = require('../models/Order');
const Expense = require('../models/Expense');
const Payroll = require('../models/Payroll');
const DeliveryRecord = require('../models/DeliveryRecord');
const Payment = require('../models/Payment');
const Collection = require('../models/Collection');
const Settlement = require('../models/Settlement');
const Pharmacy = require('../models/Pharmacy');
const Distributor = require('../models/Distributor');
const Company = require('../models/Company');
const SupplierLedger = require('../models/SupplierLedger');
const { roundPKR } = require('../utils/currency');
const { LEDGER_ENTITY_TYPE, SETTLEMENT_DIRECTION, SUPPLIER_LEDGER_TYPE } = require('../constants/enums');
const {
  FINANCIAL_SCOPE,
  canonicalFromDashboard,
  canonicalFromProfit,
  withFinancialEnvelope
} = require('../constants/financialSchema');
const financialService = require('./financial.service');
const supplierService = require('./supplier.service');
const auditService = require('./audit.service');
const ApiError = require('../utils/ApiError');

const objectId = (id) => new mongoose.Types.ObjectId(id);

const nd = { $ne: true };

/**
 * Distributor commission to deduct from company earnings:
 * delivery distributor share minus return clearing reversals.
 */
const distributorCommissionNet = async (companyId, dateRange = null) => {
  const cid = objectId(companyId);
  const deliveryMatch = { companyId: cid, isDeleted: nd };
  const reversalMatch = {
    companyId: cid,
    entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
    referenceType: 'RETURN_CLEARING_ADJ',
    type: 'DEBIT',
    isDeleted: nd
  };
  if (dateRange) {
    deliveryMatch.deliveredAt = dateRange;
    reversalMatch.date = dateRange;
  }
  const [deliveryAgg, reversalAgg] = await Promise.all([
    DeliveryRecord.aggregate([
      { $match: deliveryMatch },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$distributorShareTotal', 0] } } } }
    ]),
    Ledger.aggregate([
      { $match: reversalMatch },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ])
  ]);
  const deliveryShare = roundPKR(deliveryAgg[0]?.total || 0);
  const reversal = roundPKR(reversalAgg[0]?.total || 0);
  return roundPKR(deliveryShare - reversal);
};

const dashboard = async (companyId) => {
  const cid = objectId(companyId);
  const [salesAgg, orderCounts, paymentAgg, outstandingAgg, bonusAgg, payrollAgg, expenseAgg, distributorCommissionTotal] = await Promise.all([
    Transaction.aggregate([
      { $match: { companyId: cid, type: { $in: ['SALE', 'RETURN'] }, isDeleted: nd } },
      { $group: { _id: null, totalRevenue: { $sum: '$revenue' }, totalProfit: { $sum: '$profit' } } }
    ]),
    Order.aggregate([
      { $match: { companyId: cid, isDeleted: nd } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    Collection.aggregate([
      { $match: { companyId: cid, isDeleted: nd } },
      { $group: { _id: null, totalPaid: { $sum: '$amount' } } }
    ]),
    Ledger.aggregate([
      { $match: { companyId: cid, entityType: LEDGER_ENTITY_TYPE.PHARMACY, isDeleted: nd } },
      {
        $group: {
          _id: null,
          totalDebit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
          totalCredit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
        }
      }
    ]),
    Order.aggregate([
      { $match: { companyId: cid, isDeleted: nd } },
      { $group: { _id: null, totalBonusUnitsOnOrders: { $sum: { $ifNull: ['$totalBonusQuantity', 0] } } } }
    ]),
    Payroll.aggregate([
      { $match: { companyId: cid, status: 'PAID', isDeleted: nd } },
      { $group: { _id: null, totalPayroll: { $sum: '$netSalary' } } }
    ]),
    Expense.aggregate([
      { $match: { companyId: cid, isDeleted: nd, category: { $ne: 'SALARY' } } },
      { $group: { _id: null, totalExpenses: { $sum: '$amount' } } }
    ]),
    distributorCommissionNet(companyId)
  ]);

  const sales = salesAgg[0] || { totalRevenue: 0, totalProfit: 0 };
  const paid = paymentAgg[0] || { totalPaid: 0 };
  const outstanding = outstandingAgg[0] || { totalDebit: 0, totalCredit: 0 };

  const payroll = payrollAgg[0]?.totalPayroll || 0;
  const expenses = expenseAgg[0] || { totalExpenses: 0 };
  const grossProfit = roundPKR(sales.totalProfit);
  const netProfit = roundPKR(grossProfit - distributorCommissionTotal - payroll - expenses.totalExpenses);

  const orderStatusMap = {};
  orderCounts.forEach((o) => { orderStatusMap[o._id] = o.count; });

  const bonusRow = bonusAgg[0] || { totalBonusUnitsOnOrders: 0 };

  const response = {
    totalSales: roundPKR(sales.totalRevenue),
    grossProfit,
    distributorCommissionTotal: roundPKR(distributorCommissionTotal),
    totalPayroll: roundPKR(payroll),
    totalExpenses: roundPKR(expenses.totalExpenses),
    netProfit,
    totalPaid: roundPKR(paid.totalPaid),
    totalOutstanding: roundPKR(outstanding.totalDebit - outstanding.totalCredit),
    ordersByStatus: orderStatusMap,
    totalBonusGiven: bonusRow.totalBonusUnitsOnOrders || 0
  };

  return withFinancialEnvelope({
    data: response,
    scope: FINANCIAL_SCOPE.SNAPSHOT,
    canonical: canonicalFromDashboard(response)
  });
};

const sales = async (companyId, from, to) => {
  const match = { companyId: objectId(companyId), type: 'SALE', isDeleted: nd };
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = new Date(from);
    if (to) match.date.$lte = new Date(to);
  }
  return Transaction.aggregate([
    { $match: match },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, revenue: { $sum: '$revenue' }, cost: { $sum: '$cost' }, profit: { $sum: '$profit' }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);
};

const profit = async (companyId, from, to) => {
  const match = { companyId: objectId(companyId), isDeleted: nd };
  const dateR = {};
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = new Date(from);
    if (to) match.date.$lte = new Date(to);
    if (from) dateR.$gte = new Date(from);
    if (to) dateR.$lte = new Date(to);
  }
  const [result, distributorCommissionTotal, payrollAgg, expenseAgg] = await Promise.all([
    Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$type',
          revenue: { $sum: '$revenue' },
          cost: { $sum: '$cost' },
          profit: { $sum: '$profit' }
        }
      }
    ]),
    distributorCommissionNet(companyId, Object.keys(dateR).length ? dateR : null),
    Payroll.aggregate([
      {
        $match: {
          companyId: objectId(companyId),
          isDeleted: nd,
          status: 'PAID',
          ...(Object.keys(dateR).length ? { paidOn: dateR } : {})
        }
      },
      { $group: { _id: null, total: { $sum: '$netSalary' } } }
    ]),
    Expense.aggregate([
      {
        $match: {
          companyId: objectId(companyId),
          isDeleted: nd,
          category: { $ne: 'SALARY' },
          ...(Object.keys(dateR).length ? { date: dateR } : {})
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ])
  ]);

  const map = {};
  result.forEach((r) => { map[r._id] = r; });

  const grossProfit = roundPKR((map.SALE?.profit || 0) + (map.RETURN?.profit || 0));
  const totalPayroll = roundPKR(payrollAgg[0]?.total || 0);
  const totalExpenses = roundPKR(expenseAgg[0]?.total || 0);
  const netProfit = roundPKR(grossProfit - distributorCommissionTotal - totalExpenses - totalPayroll);

  const response = {
    grossProfit,
    distributorCommissionTotal: roundPKR(distributorCommissionTotal),
    totalExpenses,
    totalPayroll,
    netProfit,
    breakdown: result
  };

  return withFinancialEnvelope({
    data: response,
    scope: FINANCIAL_SCOPE.PERIOD,
    canonical: canonicalFromProfit(response)
  });
};

const expenses = async (companyId, from, to) => {
  const match = { companyId: objectId(companyId), isDeleted: nd };
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = new Date(from);
    if (to) match.date.$lte = new Date(to);
  }
  return Expense.aggregate([
    { $match: match },
    { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } }
  ]);
};

const inventoryValuation = async (companyId) => {
  return DistributorInventory.aggregate([
    { $match: { companyId: objectId(companyId), isDeleted: nd } },
    {
      $lookup: { from: 'distributors', localField: 'distributorId', foreignField: '_id', as: 'distributor' }
    },
    { $unwind: '$distributor' },
    {
      $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' }
    },
    { $unwind: '$product' },
    {
      $group: {
        _id: '$distributorId',
        distributorName: { $first: '$distributor.name' },
        totalItems: { $sum: 1 },
        totalQuantity: { $sum: '$quantity' },
        totalValue: { $sum: { $multiply: ['$quantity', '$avgCostPerUnit'] } }
      }
    },
    { $sort: { totalValue: -1 } }
  ]);
};

const doctorROI = async (companyId) => {
  return DoctorActivity.aggregate([
    { $match: { companyId: objectId(companyId), isDeleted: nd } },
    {
      $lookup: { from: 'doctors', localField: 'doctorId', foreignField: '_id', as: 'doctor' }
    },
    { $unwind: '$doctor' },
    {
      $project: {
        doctorName: '$doctor.name', specialization: '$doctor.specialization',
        investedAmount: 1, commitmentAmount: 1, achievedSales: 1, status: 1,
        startDate: 1, endDate: 1,
        roiPercent: { $cond: [{ $gt: ['$investedAmount', 0] }, { $multiply: [{ $divide: ['$achievedSales', '$investedAmount'] }, 100] }, 0] }
      }
    },
    { $sort: { roiPercent: -1 } }
  ]);
};

const repPerformance = async (companyId) => {
  return MedRepTarget.aggregate([
    { $match: { companyId: objectId(companyId), isDeleted: nd } },
    {
      $lookup: { from: 'users', localField: 'medicalRepId', foreignField: '_id', as: 'rep' }
    },
    { $unwind: '$rep' },
    {
      $project: {
        repName: '$rep.name', month: 1,
        salesTarget: 1, achievedSales: 1, packsTarget: 1, achievedPacks: 1,
        salesPercent: { $cond: [{ $gt: ['$salesTarget', 0] }, { $multiply: [{ $divide: ['$achievedSales', '$salesTarget'] }, 100] }, 0] },
        packsPercent: { $cond: [{ $gt: ['$packsTarget', 0] }, { $multiply: [{ $divide: ['$achievedPacks', '$packsTarget'] }, 100] }, 0] }
      }
    },
    { $sort: { month: -1 } }
  ]);
};

const outstanding = async (companyId) => {
  return Ledger.aggregate([
    { $match: { companyId: objectId(companyId), entityType: LEDGER_ENTITY_TYPE.PHARMACY, isDeleted: nd } },
    {
      $group: {
        _id: '$entityId',
        totalDebit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
        totalCredit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
      }
    },
    { $addFields: { outstanding: { $subtract: ['$totalDebit', '$totalCredit'] } } },
    { $match: { outstanding: { $gt: 0 } } },
    {
      $lookup: { from: 'pharmacies', localField: '_id', foreignField: '_id', as: 'pharmacy' }
    },
    { $unwind: '$pharmacy' },
    { $project: { pharmacyName: '$pharmacy.name', city: '$pharmacy.city', totalDebit: 1, totalCredit: 1, outstanding: 1 } },
    { $sort: { outstanding: -1 } }
  ]);
};

const endOfDay = (d) => {
  if (!d) return null;
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

const cashFlow = async (companyId, from, to) => {
  const cid = objectId(companyId);
  const dateRange = {};
  if (from) dateRange.$gte = new Date(from);
  if (to) dateRange.$lte = endOfDay(to);

  const collectionMatch = { companyId: cid, isDeleted: nd };
  const paymentLegacyMatch = { companyId: cid, isDeleted: nd };
  const expenseMatch = { companyId: cid, isDeleted: nd };
  const settlementMatch = { companyId: cid, isDeleted: nd };
  if (from || to) {
    const dr = {};
    if (from) dr.$gte = new Date(from);
    if (to) dr.$lte = endOfDay(to);
    collectionMatch.date = dr;
    paymentLegacyMatch.date = { ...dr };
    expenseMatch.date = { ...dr };
    settlementMatch.date = { ...dr };
  }

  const [collectionsIn, paymentsLegacyIn, expensesOut, settlementsD2C, settlementsC2D] = await Promise.all([
    Collection.aggregate([
      { $match: collectionMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, amount: { $sum: '$amount' } } },
      { $sort: { _id: 1 } }
    ]),
    Payment.aggregate([
      { $match: paymentLegacyMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, amount: { $sum: '$amount' } } },
      { $sort: { _id: 1 } }
    ]),
    Expense.aggregate([
      { $match: expenseMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, amount: { $sum: '$amount' } } },
      { $sort: { _id: 1 } }
    ]),
    Settlement.aggregate([
      { $match: { ...settlementMatch, direction: SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, amount: { $sum: '$amount' } } },
      { $sort: { _id: 1 } }
    ]),
    Settlement.aggregate([
      { $match: { ...settlementMatch, direction: SETTLEMENT_DIRECTION.COMPANY_TO_DISTRIBUTOR } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, amount: { $sum: '$amount' } } },
      { $sort: { _id: 1 } }
    ])
  ]);

  return {
    collectionsFromPharmacies: collectionsIn,
    legacyPayments: paymentsLegacyIn,
    settlementsDistributorToCompany: settlementsD2C,
    settlementsCompanyToDistributor: settlementsC2D,
    expenses: expensesOut
  };
};

/** All pharmacies: invoice receivable balance (DR−CR on pharmacy ledger). */
const pharmacyBalances = async (companyId, query = {}) => {
  const cid = objectId(companyId);
  const ledgerAgg = await Ledger.aggregate([
    { $match: { companyId: cid, entityType: LEDGER_ENTITY_TYPE.PHARMACY, isDeleted: nd } },
    {
      $group: {
        _id: '$entityId',
        totalDebit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
        totalCredit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
      }
    },
    { $addFields: { outstanding: { $subtract: ['$totalDebit', '$totalCredit'] } } }
  ]);
  const ledgerMap = new Map(ledgerAgg.map((x) => [x._id.toString(), x]));

  const pharmFilter = { companyId: cid, isDeleted: nd };
  if (query.pharmacyId) pharmFilter._id = objectId(query.pharmacyId);

  const pharmacies = await Pharmacy.find(pharmFilter).select('name city phone isActive').lean();
  const rows = pharmacies.map((p) => {
    const L = ledgerMap.get(p._id.toString()) || { totalDebit: 0, totalCredit: 0, outstanding: 0 };
    const o = roundPKR(L.outstanding);
    return {
      pharmacyId: p._id,
      name: p.name,
      city: p.city,
      phone: p.phone,
      isActive: p.isActive,
      totalDebit: roundPKR(L.totalDebit),
      totalCredit: roundPKR(L.totalCredit),
      outstanding: o,
      receivableFromPharmacy: roundPKR(Math.max(0, o)),
      advanceOrCreditFromPharmacy: roundPKR(Math.max(0, -o))
    };
  });

  rows.sort((a, b) => b.receivableFromPharmacy - a.receivableFromPharmacy);

  const totals = {
    totalOutstandingNet: roundPKR(rows.reduce((s, r) => s + r.outstanding, 0)),
    totalReceivable: roundPKR(rows.reduce((s, r) => s + r.receivableFromPharmacy, 0)),
    totalPharmacyCreditBalance: roundPKR(rows.reduce((s, r) => s + r.advanceOrCreditFromPharmacy, 0))
  };

  return { rows, totals, help: 'Positive receivableFromPharmacy = pharmacy still owes on invoices. Negative outstanding = pharmacy has prepaid / credit.' };
};

/** Ledger breakdown for one pharmacy (by reference type). */
const pharmacyBalanceDetail = async (companyId, pharmacyId) => {
  const cid = objectId(companyId);
  const pid = objectId(pharmacyId);
  const p = await Pharmacy.findOne({ _id: pid, companyId: cid }).lean();
  if (!p) return null;

  const byRef = await Ledger.aggregate([
    { $match: { companyId: cid, entityType: LEDGER_ENTITY_TYPE.PHARMACY, entityId: pid, isDeleted: nd } },
    {
      $group: {
        _id: '$referenceType',
        debit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
        credit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  const net = roundPKR(
    byRef.reduce((s, r) => s + roundPKR(r.debit) - roundPKR(r.credit), 0)
  );

  return {
    pharmacy: { _id: p._id, name: p.name, city: p.city, phone: p.phone },
    netOutstanding: net,
    byReferenceType: byRef.map((r) => ({
      referenceType: r._id,
      debit: roundPKR(r.debit),
      credit: roundPKR(r.credit),
      net: roundPKR(r.debit - r.credit)
    }))
  };
};

/** All distributors: clearing net (DR−CR). Positive = distributor owes company net. */
const distributorBalances = async (companyId, query = {}) => {
  const cid = objectId(companyId);
  const ledgerAgg = await Ledger.aggregate([
    { $match: { companyId: cid, entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING, isDeleted: nd } },
    {
      $group: {
        _id: '$entityId',
        totalDebit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
        totalCredit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
      }
    },
    { $addFields: { net: { $subtract: ['$totalDebit', '$totalCredit'] } } }
  ]);
  const ledgerMap = new Map(ledgerAgg.map((x) => [x._id.toString(), x]));

  const distFilter = { companyId: cid, isDeleted: nd };
  if (query.distributorId) distFilter._id = objectId(query.distributorId);

  const distributors = await Distributor.find(distFilter).select('name city phone isActive').lean();
  const rows = await Promise.all(
    distributors.map(async (d) => {
      const L = ledgerMap.get(d._id.toString()) || { totalDebit: 0, totalCredit: 0, net: 0 };
      const n = roundPKR(L.net);
      const ob = await financialService.getDistributorObligations(companyId, d._id);
      return {
        distributorId: d._id,
        name: d.name,
        city: d.city,
        phone: d.phone,
        isActive: d.isActive,
        totalDebit: roundPKR(L.totalDebit),
        totalCredit: roundPKR(L.totalCredit),
        /** Raw ledger net (DR−CR) on distributor clearing — for audit; use obligations for business meaning */
        netDistributorOwesCompany: n,
        companyOwesDistributorNet: roundPKR(Math.max(0, -n)),
        /** Cash collected by distributor not yet remitted to company (open remittance lines − settlements) */
        remittanceDueFromDistributor: ob.remittanceDueFromDistributor,
        /** Commission on TP owed by company to distributor when company collected from pharmacy (open − settlements) */
        commissionPayableByCompanyToDistributor: ob.commissionPayableByCompanyToDistributor
      };
    })
  );

  rows.sort((a, b) => b.remittanceDueFromDistributor - a.remittanceDueFromDistributor);

  const totals = {
    sumNetOwedByDistributorsToCompany: roundPKR(rows.reduce((s, r) => s + Math.max(0, r.netDistributorOwesCompany), 0)),
    sumNetOwedByCompanyToDistributors: roundPKR(rows.reduce((s, r) => s + r.companyOwesDistributorNet, 0)),
    sumRemittanceDueFromDistributors: roundPKR(rows.reduce((s, r) => s + r.remittanceDueFromDistributor, 0)),
    sumCommissionPayableByCompanyToDistributors: roundPKR(rows.reduce((s, r) => s + r.commissionPayableByCompanyToDistributor, 0))
  };

  return {
    rows,
    totals,
    help:
      'Delivery only creates pharmacy receivables (invoice to pharmacy). Distributor commission on TP and company share are snapshotted on the delivery record. Clearing lines for distributor vs company appear when cash is collected: if the distributor collected from the pharmacy, a remittance-due line shows what they still owe the company; if the company collected, a commission-payable line shows what the company owes the distributor on that cash. Use remittance due / commission payable columns for real-world obligations; raw net (DR−CR) is the full clearing account for audit.',
    helpShort:
      'Remittance due = cash the distributor must still pay the company from collections. Commission payable = TP commission the company owes the distributor when company collected. Pharmacy column = invoice balances.'
  };
};

const distributorBalanceDetail = async (companyId, distributorId) => {
  const cid = objectId(companyId);
  const did = objectId(distributorId);
  const d = await Distributor.findOne({ _id: did, companyId: cid }).lean();
  if (!d) return null;

  const byRef = await Ledger.aggregate([
    { $match: { companyId: cid, entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING, entityId: did, isDeleted: nd } },
    {
      $group: {
        _id: '$referenceType',
        debit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
        credit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  const net = roundPKR(byRef.reduce((s, r) => s + roundPKR(r.debit) - roundPKR(r.credit), 0));

  const deliveryAgg = byRef.find((r) => r._id === 'DELIVERY');
  const deliveryCompanyShareDebit = deliveryAgg ? roundPKR(deliveryAgg.debit) : 0;
  const deliveryCommissionCredit = deliveryAgg ? roundPKR(deliveryAgg.credit) : 0;

  const obligations = await financialService.getDistributorObligations(companyId, distributorId);

  return {
    distributor: { _id: d._id, name: d.name, city: d.city, phone: d.phone },
    netDistributorOwesCompany: net,
    obligations,
    byReferenceType: byRef.map((r) => ({
      referenceType: r._id,
      debit: roundPKR(r.debit),
      credit: roundPKR(r.credit),
      net: roundPKR(r.debit - r.credit)
    })),
    deliverySplit:
      deliveryAgg != null && (deliveryCompanyShareDebit > 0 || deliveryCommissionCredit > 0)
        ? {
            companyShareOnDeliveries: deliveryCompanyShareDebit,
            distributorCommissionOnTp: deliveryCommissionCredit,
            netDeliveryClearing: roundPKR(deliveryCompanyShareDebit - deliveryCommissionCredit),
            note: 'Legacy delivery postings on clearing (older data). New deliveries only hit pharmacy receivables; splits are on the delivery document until cash is collected.'
          }
        : null,
    clearingHelp:
      'Remittance due from distributor = cash they collected for you and still owe back (see obligations). Commission payable by company = when your team collected from the pharmacy, TP commission still owed to the distributor. Raw net = full clearing DR−CR for audit. Delivery no longer posts to distributor clearing by default — only collections and settlements do.'
  };
};

const collectionsPeriod = async (companyId, from, to, filters = {}) => {
  const cid = objectId(companyId);
  const match = { companyId: cid, isDeleted: nd };
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = new Date(from);
    if (to) match.date.$lte = endOfDay(to);
  }
  if (filters.pharmacyId) match.pharmacyId = objectId(filters.pharmacyId);
  if (filters.collectorType) match.collectorType = filters.collectorType;

  const [grand, byCollector, byPharmacy, byDay, rows] = await Promise.all([
    Collection.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]),
    Collection.aggregate([
      { $match: match },
      { $group: { _id: '$collectorType', total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]),
    Collection.aggregate([
      { $match: match },
      {
        $group: { _id: '$pharmacyId', total: { $sum: '$amount' }, count: { $sum: 1 } }
      },
      {
        $lookup: { from: 'pharmacies', localField: '_id', foreignField: '_id', as: 'ph' }
      },
      { $unwind: '$ph' },
      { $project: { pharmacyId: '$_id', pharmacyName: '$ph.name', city: '$ph.city', total: 1, count: 1 } },
      { $sort: { total: -1 } }
    ]),
    Collection.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    Collection.find(match)
      .populate('pharmacyId', 'name city')
      .populate('collectedBy', 'name')
      .sort({ date: -1 })
      .limit(500)
      .lean()
  ]);

  const g = grand[0] || { total: 0, count: 0 };
  return {
    period: { from: from || null, to: to || null },
    summary: { totalAmount: roundPKR(g.total), count: g.count },
    byCollector: byCollector.map((x) => ({
      collectorType: x._id,
      total: roundPKR(x.total),
      count: x.count
    })),
    byPharmacy: byPharmacy.map((x) => ({
      pharmacyId: x.pharmacyId,
      pharmacyName: x.pharmacyName,
      city: x.city,
      total: roundPKR(x.total),
      count: x.count
    })),
    byDay: byDay.map((x) => ({ date: x._id, total: roundPKR(x.total), count: x.count })),
    recentRows: rows
  };
};

const settlementsPeriod = async (companyId, from, to, filters = {}) => {
  const cid = objectId(companyId);
  const match = { companyId: cid, isDeleted: nd };
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = new Date(from);
    if (to) match.date.$lte = endOfDay(to);
  }
  if (filters.distributorId) match.distributorId = objectId(filters.distributorId);
  if (filters.direction) match.direction = filters.direction;

  const [grand, byDirection, byDistributor, byDay, rows] = await Promise.all([
    Settlement.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Settlement.aggregate([
      { $match: match },
      { $group: { _id: '$direction', total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]),
    Settlement.aggregate([
      { $match: match },
      { $group: { _id: '$distributorId', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      {
        $lookup: { from: 'distributors', localField: '_id', foreignField: '_id', as: 'd' }
      },
      { $unwind: '$d' },
      { $project: { distributorId: '$_id', distributorName: '$d.name', city: '$d.city', total: 1, count: 1 } },
      { $sort: { total: -1 } }
    ]),
    Settlement.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    Settlement.find(match)
      .populate('distributorId', 'name city')
      .populate('settledBy', 'name')
      .sort({ date: -1 })
      .limit(500)
      .lean()
  ]);

  const g = grand[0] || { total: 0, count: 0 };
  const d2c = byDirection.find((x) => x._id === SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY);
  const c2d = byDirection.find((x) => x._id === SETTLEMENT_DIRECTION.COMPANY_TO_DISTRIBUTOR);

  return {
    period: { from: from || null, to: to || null },
    summary: { totalAmount: roundPKR(g.total), count: g.count },
    distributorToCompany: {
      total: roundPKR(d2c?.total || 0),
      count: d2c?.count || 0
    },
    companyToDistributor: {
      total: roundPKR(c2d?.total || 0),
      count: c2d?.count || 0
    },
    byDirection: byDirection.map((x) => ({ direction: x._id, total: roundPKR(x.total), count: x.count })),
    byDistributor: byDistributor.map((x) => ({
      distributorId: x.distributorId,
      distributorName: x.distributorName,
      city: x.city,
      total: roundPKR(x.total),
      count: x.count
    })),
    byDay: byDay.map((x) => ({ date: x._id, total: roundPKR(x.total), count: x.count })),
    recentRows: rows
  };
};

/** Money-in / money-out story for the company in a period (collections + settlements). */
const financialCashSummary = async (companyId, from, to, filters = {}) => {
  const colFilters = {
    pharmacyId: filters.pharmacyId,
    collectorType: filters.collectorType
  };
  const setFilters = {
    distributorId: filters.distributorId,
    direction: filters.direction
  };
  const col = await collectionsPeriod(companyId, from, to, colFilters);
  const set = await settlementsPeriod(companyId, from, to, setFilters);

  const collectionsTotal = col.summary.totalAmount;
  const inFromDistributors = set.distributorToCompany.total;
  const outToDistributors = set.companyToDistributor.total;
  const net = roundPKR(collectionsTotal + inFromDistributors - outToDistributors);

  return {
    period: { from: from || null, to: to || null },
    pharmacyCollectionsTotal: collectionsTotal,
    collectionsDetail: col.summary,
    settlementsInFromDistributors: inFromDistributors,
    settlementsOutToDistributors: outToDistributors,
    /** Collections + D→C settlements − C→D settlements (cash-like view; not full P&L). */
    netCashStyleMovement: net,
    notes: [
      'Pharmacy collections are amounts recorded against pharmacy receivables (FIFO on server).',
      'Distributor→company settlements are additional cash in from distributors.',
      'Company→distributor settlements are cash out to distributors.',
      'Legacy Payment documents (if any) are included in cash-flow legacyPayments series, not in collections total.'
    ]
  };
};

/** Single endpoint: balances + optional period activity (if from/to provided). */
const financialOverview = async (companyId, query = {}) => {
  const { from, to, pharmacyId, distributorId } = query;
  const [pharmacies, distributors] = await Promise.all([
    pharmacyBalances(companyId, { pharmacyId }),
    distributorBalances(companyId, { distributorId })
  ]);

  const out = {
    generatedAt: new Date().toISOString(),
    pharmacyReceivables: pharmacies,
    distributorClearing: distributors
  };

  if (from || to) {
    out.period = { from: from || null, to: to || null };
    const periodFilters = {
      pharmacyId,
      collectorType: query.collectorType,
      distributorId,
      direction: query.direction
    };
    out.collections = await collectionsPeriod(companyId, from, to, {
      pharmacyId,
      collectorType: query.collectorType
    });
    out.settlements = await settlementsPeriod(companyId, from, to, {
      distributorId,
      direction: query.direction
    });
    out.cashSummary = await financialCashSummary(companyId, from, to, periodFilters);
  }

  return out;
};

/**
 * Implied bank/cash position: opening + collections + D→C settlements − C→D − expenses − supplier payments.
 * Not double-counting inventory casting (supplier PURCHASE is liability only).
 */
const computeImpliedCashBalance = async (companyId) => {
  const cid = objectId(companyId);
  const company = await Company.findById(cid).select('cashOpeningBalance').lean();
  const opening = roundPKR(company?.cashOpeningBalance || 0);

  const [cCol, cSet, cExp, cSup] = await Promise.all([
    Collection.aggregate([
      { $match: { companyId: cid, isDeleted: nd } },
      { $group: { _id: null, t: { $sum: '$amount' } } }
    ]),
    Settlement.aggregate([
      { $match: { companyId: cid, isDeleted: nd } },
      { $group: { _id: '$direction', t: { $sum: '$amount' } } }
    ]),
    Expense.aggregate([{ $match: { companyId: cid, isDeleted: nd } }, { $group: { _id: null, t: { $sum: '$amount' } } }]),
    SupplierLedger.aggregate([
      { $match: { companyId: cid, type: SUPPLIER_LEDGER_TYPE.PAYMENT, isDeleted: nd } },
      { $group: { _id: null, t: { $sum: '$amount' } } }
    ])
  ]);

  const totalPharmacyCollections = roundPKR(cCol[0]?.t || 0);
  const settlementsInFromDistributors = roundPKR(
    cSet.find((x) => x._id === SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY)?.t || 0
  );
  const settlementsOutToDistributors = roundPKR(
    cSet.find((x) => x._id === SETTLEMENT_DIRECTION.COMPANY_TO_DISTRIBUTOR)?.t || 0
  );
  const totalOperatingExpenses = roundPKR(cExp[0]?.t || 0);
  const supplierPaymentsCashOut = roundPKR(cSup[0]?.t || 0);

  const cashBalance = roundPKR(
    opening +
      totalPharmacyCollections +
      settlementsInFromDistributors -
      settlementsOutToDistributors -
      totalOperatingExpenses -
      supplierPaymentsCashOut
  );

  return {
    cashOpeningBalance: opening,
    cashBalance,
    components: {
      totalPharmacyCollections,
      settlementsInFromDistributors,
      settlementsOutToDistributors,
      totalOperatingExpenses,
      supplierPaymentsCashOut
    },
    help: 'Payroll posts through Expense. Supplier PURCHASE lines do not affect cash; only PAYMENT does.'
  };
};

/**
 * Unified balance-sheet-style snapshot. Distributor payable = commission owed to distributors (existing clearing).
 */
const financialSummary = async (companyId) => {
  const [cashData, pharm, dist, sup] = await Promise.all([
    computeImpliedCashBalance(companyId),
    pharmacyBalances(companyId),
    distributorBalances(companyId),
    supplierService.supplierBalances(companyId)
  ]);

  const totalPharmacyReceivable = pharm.totals.totalReceivable;
  const totalSupplierPayable = sup.totals.totalNetPayable;
  const totalDistributorPayable = dist.totals.sumCommissionPayableByCompanyToDistributors;

  const netPosition = roundPKR(
    cashData.cashBalance + totalPharmacyReceivable - totalSupplierPayable - totalDistributorPayable
  );

  return {
    generatedAt: new Date().toISOString(),
    cashBalance: cashData.cashBalance,
    cashOpeningBalance: cashData.cashOpeningBalance,
    cashComponents: cashData.components,
    totalPharmacyReceivable,
    totalSupplierPayable,
    totalDistributorPayable,
    netPosition,
    notes: [
      'Supplier PURCHASE increases payable only (not PnL). Delivery profit unchanged.',
      'Pharmacy receivables from ledger. Distributor payable = commission owed (sumCommissionPayableByCompanyToDistributors).',
      'Cash is implied from movements + optional company.cashOpeningBalance.'
    ],
    pharmacyTotals: pharm.totals,
    distributorTotals: dist.totals,
    supplierTotals: sup.totals
  };
};

/** Monthly inflow vs outflow for charts (last N calendar months including current). */
const financialFlowMonthly = async (companyId, months = 12) => {
  const n = Math.min(36, Math.max(1, parseInt(months, 10) || 12));
  const cid = objectId(companyId);
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth() - (n - 1), 1);
  start.setHours(0, 0, 0, 0);

  const dateRange = { $gte: start, $lte: end };

  const monthKeys = [];
  {
    const cur = new Date(start);
    while (cur <= end) {
      monthKeys.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  const [cols, sets, exps, sups] = await Promise.all([
    Collection.aggregate([
      { $match: { companyId: cid, isDeleted: nd, date: dateRange } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, t: { $sum: '$amount' } } }
    ]),
    Settlement.aggregate([
      { $match: { companyId: cid, isDeleted: nd, date: dateRange } },
      {
        $group: {
          _id: { ym: { $dateToString: { format: '%Y-%m', date: '$date' } }, direction: '$direction' },
          t: { $sum: '$amount' }
        }
      }
    ]),
    Expense.aggregate([
      { $match: { companyId: cid, isDeleted: nd, date: dateRange } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, t: { $sum: '$amount' } } }
    ]),
    SupplierLedger.aggregate([
      { $match: { companyId: cid, type: SUPPLIER_LEDGER_TYPE.PAYMENT, isDeleted: nd, date: dateRange } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, t: { $sum: '$amount' } } }
    ])
  ]);

  const setMap = new Map();
  for (const r of sets) {
    const k = r._id.ym;
    if (!setMap.has(k)) setMap.set(k, { d2c: 0, c2d: 0 });
    const o = setMap.get(k);
    if (r._id.direction === SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY) o.d2c += roundPKR(r.t);
    if (r._id.direction === SETTLEMENT_DIRECTION.COMPANY_TO_DISTRIBUTOR) o.c2d += roundPKR(r.t);
  }

  const series = monthKeys.map((ym) => {
    const col = cols.find((c) => c._id === ym)?.t || 0;
    const s = setMap.get(ym) || { d2c: 0, c2d: 0 };
    const exp = exps.find((e) => e._id === ym)?.t || 0;
    const sup = sups.find((x) => x._id === ym)?.t || 0;
    const inflow = roundPKR(col + s.d2c);
    const outflow = roundPKR(s.c2d + exp + sup);
    return { month: ym, inflow, outflow, net: roundPKR(inflow - outflow) };
  });

  return { monthKeys, series };
};

const patchCompanyCashOpening = async (companyId, cashOpeningBalance, reqUser) => {
  const c = await Company.findById(objectId(companyId));
  if (!c) throw new ApiError(404, 'Company not found');
  const before = c.toObject();
  c.cashOpeningBalance = roundPKR(cashOpeningBalance ?? 0);
  await c.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'company.cashOpeningBalance',
    entityType: 'Company',
    entityId: c._id,
    changes: { before, after: c.toObject() }
  });
  return c;
};

module.exports = {
  dashboard,
  sales,
  profit,
  expenses,
  inventoryValuation,
  doctorROI,
  repPerformance,
  outstanding,
  cashFlow,
  pharmacyBalances,
  pharmacyBalanceDetail,
  distributorBalances,
  distributorBalanceDetail,
  collectionsPeriod,
  settlementsPeriod,
  financialCashSummary,
  financialOverview,
  computeImpliedCashBalance,
  financialSummary,
  financialFlowMonthly,
  patchCompanyCashOpening
};
