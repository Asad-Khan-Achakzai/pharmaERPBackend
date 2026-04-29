/**
 * Profit & cost management reports (transaction-based revenue, auditable cost buckets).
 * Revenue: Transaction SALE + RETURN (delivery/return dates via Transaction.date).
 * COGS: Transaction.cost (avg cost at delivery/return).
 * Operating: shipping (StockTransfer), payroll (PAID + paidOn), doctor activities (createdAt + investedAmount),
 *            expenses (category !== SALARY).
 */
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const StockTransfer = require('../models/StockTransfer');
const Payroll = require('../models/Payroll');
const DoctorActivity = require('../models/DoctorActivity');
const Expense = require('../models/Expense');
const Product = require('../models/Product');
const Distributor = require('../models/Distributor');
const Collection = require('../models/Collection');
const Settlement = require('../models/Settlement');
const Ledger = require('../models/Ledger');
const reportService = require('./report.service');
const { roundPKR } = require('../utils/currency');
const {
  FINANCIAL_SCOPE,
  canonicalFromSummary,
  canonicalFromTrends,
  withFinancialEnvelope
} = require('../constants/financialSchema');
const {
  TRANSACTION_TYPE,
  EXPENSE_CATEGORY,
  PAYROLL_STATUS,
  SETTLEMENT_DIRECTION,
  COLLECTOR_TYPE,
  LEDGER_ENTITY_TYPE,
  LEDGER_TYPE,
  LEDGER_REFERENCE_TYPE
} = require('../constants/enums');

const objectId = (id) => new mongoose.Types.ObjectId(id);
const nd = { $ne: true };

/** Company P&L revenue per delivery line (finalCompanyAmount / companyShare). Legacy rows: linePharmacyNet − distributorShare. */
const companyRevenueFromDeliveryLine = {
  $ifNull: [
    '$items.companyShare',
    {
      $subtract: [
        { $ifNull: ['$items.linePharmacyNet', 0] },
        { $ifNull: ['$items.distributorShare', 0] }
      ]
    }
  ]
};

/** Return line: negate company revenue reversed. Legacy: pharmacy net (qty × finalSellingPrice). */
const companyRevenueFromReturnLine = {
  $multiply: [
    {
      $ifNull: [
        '$items.companyShare',
        { $multiply: ['$items.quantity', { $ifNull: ['$items.finalSellingPrice', 0] }] }
      ]
    },
    -1
  ]
};

/** Customer invoice net per return line (additive reporting; mirrors legacy qty × finalSellingPrice). */
const customerNetFromReturnLine = {
  $multiply: [{ $multiply: ['$items.quantity', { $ifNull: ['$items.finalSellingPrice', 0] }] }, -1]
};

const endOfDay = (d) => {
  if (!d) return null;
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

const parseRange = (startDate, endDate) => {
  const r = {};
  if (startDate) r.$gte = new Date(startDate);
  if (endDate) r.$lte = endOfDay(endDate);
  return r;
};

/**
 * Distributor commission expense = delivery distributor share - return clearing reversal.
 * Keeps net profit aligned with actual company earnings without double counting.
 */
const distributorCommissionCostSum = async (companyId, { startDate, endDate, distributorId }) => {
  const cid = objectId(companyId);
  const dateR = parseRange(startDate, endDate);
  const deliveryMatch = {
    companyId: cid,
    isDeleted: nd,
    ...(Object.keys(dateR).length ? { deliveredAt: dateR } : {})
  };
  if (distributorId) {
    deliveryMatch.orderId = { $exists: true };
  }
  const deliveryPipe = [
    { $match: deliveryMatch },
    ...(distributorId
      ? [
          { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'o' } },
          { $unwind: '$o' },
          { $match: { 'o.distributorId': objectId(distributorId) } }
        ]
      : []),
    { $group: { _id: null, total: { $sum: { $ifNull: ['$distributorShareTotal', 0] } } } }
  ];

  const reversalMatch = {
    companyId: cid,
    entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
    referenceType: LEDGER_REFERENCE_TYPE.RETURN_CLEARING_ADJ,
    type: LEDGER_TYPE.DEBIT,
    isDeleted: nd,
    ...(Object.keys(dateR).length ? { date: dateR } : {}),
    ...(distributorId ? { entityId: objectId(distributorId) } : {})
  };

  const [deliveryAgg, reversalAgg] = await Promise.all([
    DeliveryRecord.aggregate(deliveryPipe),
    Ledger.aggregate([
      { $match: reversalMatch },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ])
  ]);

  const deliveryShare = roundPKR(deliveryAgg[0]?.total || 0);
  const reversal = roundPKR(reversalAgg[0]?.total || 0);
  return roundPKR(deliveryShare - reversal);
};

/** Transaction-based revenue + COGS (includes returns). Optional distributor / product filters. */
const sumSalesRevenueAndCogs = async (companyId, { startDate, endDate, distributorId, productId }) => {
  const cid = objectId(companyId);
  const dateR = parseRange(startDate, endDate);
  const baseMatch = {
    companyId: cid,
    isDeleted: nd,
    type: { $in: [TRANSACTION_TYPE.SALE, TRANSACTION_TYPE.RETURN] },
    ...(Object.keys(dateR).length ? { date: dateR } : {})
  };

  if (productId) {
    const pid = objectId(productId);
    const delPipe = [
      { $match: { companyId: cid, isDeleted: nd, ...(Object.keys(dateR).length ? { deliveredAt: dateR } : {}) } },
      { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'o' } },
      { $unwind: '$o' },
      ...(distributorId ? [{ $match: { 'o.distributorId': objectId(distributorId) } }] : []),
      { $unwind: '$items' },
      { $match: { 'items.productId': pid } },
      {
        $group: {
          _id: null,
          revenue: { $sum: { $ifNull: ['$items.linePharmacyNet', 0] } },
          productCost: {
            $sum: {
              $multiply: ['$items.quantity', { $ifNull: ['$items.avgCostAtTime', 0] }]
            }
          }
        }
      }
    ];
    const retPipe = [
      { $match: { companyId: cid, isDeleted: nd, ...(Object.keys(dateR).length ? { returnedAt: dateR } : {}) } },
      { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'o' } },
      { $unwind: '$o' },
      ...(distributorId ? [{ $match: { 'o.distributorId': objectId(distributorId) } }] : []),
      { $unwind: '$items' },
      { $match: { 'items.productId': pid } },
      {
        $group: {
          _id: null,
          revenue: {
            $sum: {
              $multiply: [{ $multiply: ['$items.quantity', { $ifNull: ['$items.finalSellingPrice', 0] }] }, -1]
            }
          },
          productCost: {
            $sum: {
              $multiply: [
                { $multiply: ['$items.quantity', { $ifNull: ['$items.avgCostAtTime', 0] }] },
                -1
              ]
            }
          }
        }
      }
    ];
    const [d1, r1] = await Promise.all([
      DeliveryRecord.aggregate(delPipe),
      ReturnRecord.aggregate(retPipe)
    ]);
    const revenue = roundPKR((d1[0]?.revenue || 0) + (r1[0]?.revenue || 0));
    const productCost = roundPKR((d1[0]?.productCost || 0) + (r1[0]?.productCost || 0));
    return { totalRevenue: revenue, productCost };
  }

  if (!distributorId) {
    const agg = await Transaction.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$revenue' },
          productCost: { $sum: '$cost' }
        }
      }
    ]);
    return {
      totalRevenue: roundPKR(agg[0]?.totalRevenue || 0),
      productCost: roundPKR(agg[0]?.productCost || 0)
    };
  }

  const did = objectId(distributorId);
  const [saleAgg, retAgg] = await Promise.all([
    Transaction.aggregate([
      { $match: { ...baseMatch, type: TRANSACTION_TYPE.SALE, referenceType: 'DELIVERY' } },
      {
        $lookup: {
          from: 'deliveryrecords',
          localField: 'referenceId',
          foreignField: '_id',
          as: 'd'
        }
      },
      { $unwind: '$d' },
      { $lookup: { from: 'orders', localField: 'd.orderId', foreignField: '_id', as: 'o' } },
      { $unwind: '$o' },
      { $match: { 'o.distributorId': did } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$revenue' },
          productCost: { $sum: '$cost' }
        }
      }
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, type: TRANSACTION_TYPE.RETURN, referenceType: 'RETURN' } },
      {
        $lookup: {
          from: 'returnrecords',
          localField: 'referenceId',
          foreignField: '_id',
          as: 'rr'
        }
      },
      { $unwind: '$rr' },
      { $lookup: { from: 'orders', localField: 'rr.orderId', foreignField: '_id', as: 'o' } },
      { $unwind: '$o' },
      { $match: { 'o.distributorId': did } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$revenue' },
          productCost: { $sum: '$cost' }
        }
      }
    ])
  ]);
  return {
    totalRevenue: roundPKR((saleAgg[0]?.totalRevenue || 0) + (retAgg[0]?.totalRevenue || 0)),
    productCost: roundPKR((saleAgg[0]?.productCost || 0) + (retAgg[0]?.productCost || 0))
  };
};

const shippingCost = async (companyId, { startDate, endDate, productId }) => {
  const cid = objectId(companyId);
  const dateR = parseRange(startDate, endDate);
  const match = { companyId: cid, isDeleted: nd, ...(Object.keys(dateR).length ? { transferDate: dateR } : {}) };
  if (productId) {
    match.items = { $elemMatch: { productId: objectId(productId) } };
  }
  const agg = await StockTransfer.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$totalShippingCost', 0] } } } }
  ]);
  return roundPKR(agg[0]?.total || 0);
};

const payrollCostSum = async (companyId, { startDate, endDate, employeeId }) => {
  const cid = objectId(companyId);
  const dateR = parseRange(startDate, endDate);
  const match = {
    companyId: cid,
    isDeleted: nd,
    status: PAYROLL_STATUS.PAID
  };
  if (Object.keys(dateR).length) match.paidOn = dateR;
  else match.paidOn = { $exists: true, $ne: null };
  if (employeeId) match.employeeId = objectId(employeeId);
  const agg = await Payroll.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$netSalary' } } }
  ]);
  return roundPKR(agg[0]?.total || 0);
};

const doctorActivityCostSum = async (companyId, { startDate, endDate }) => {
  const cid = objectId(companyId);
  const dateR = parseRange(startDate, endDate);
  const match = { companyId: cid, isDeleted: nd, ...(Object.keys(dateR).length ? { createdAt: dateR } : {}) };
  const agg = await DoctorActivity.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$investedAmount' } } }
  ]);
  return roundPKR(agg[0]?.total || 0);
};

const otherExpensesSum = async (companyId, { startDate, endDate }) => {
  const cid = objectId(companyId);
  const dateR = parseRange(startDate, endDate);
  const match = {
    companyId: cid,
    isDeleted: nd,
    category: { $ne: EXPENSE_CATEGORY.SALARY },
    ...(Object.keys(dateR).length ? { date: dateR } : {})
  };
  const agg = await Expense.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  return roundPKR(agg[0]?.total || 0);
};

/**
 * Cash collected in the selected period + outstanding pharmacy receivables (ledger snapshot).
 * Period filters apply to collections/settlements only; receivable totals are company-wide as of now.
 * Only collections where collectorType is COMPANY count as cash received by the company; distributor-held
 * collections appear separately until a distributor→company settlement is recorded.
 */
const liquiditySnapshot = async (companyId, query = {}) => {
  const { startDate, endDate } = query;
  const cid = objectId(companyId);
  const dateR = parseRange(startDate, endDate);
  const dateMatch = Object.keys(dateR).length ? { date: dateR } : {};

  const [colCompanyAgg, colDistributorAgg, setInAgg, setOutAgg, pb] = await Promise.all([
    Collection.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          collectorType: COLLECTOR_TYPE.COMPANY,
          ...dateMatch
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    Collection.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          collectorType: COLLECTOR_TYPE.DISTRIBUTOR,
          ...dateMatch
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    Settlement.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          direction: SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY,
          ...dateMatch
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    Settlement.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          direction: SETTLEMENT_DIRECTION.COMPANY_TO_DISTRIBUTOR,
          ...dateMatch
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    reportService.pharmacyBalances(companyId, {})
  ]);

  const pharmacyCollectionsByCompany = roundPKR(colCompanyAgg[0]?.total || 0);
  const pharmacyCollectionsHeldByDistributors = roundPKR(colDistributorAgg[0]?.total || 0);
  const settlementsFromDistributors = roundPKR(setInAgg[0]?.total || 0);
  const settlementsToDistributors = roundPKR(setOutAgg[0]?.total || 0);
  const totalReceivedInPeriod = roundPKR(pharmacyCollectionsByCompany + settlementsFromDistributors);
  const netCashMovementInPeriod = roundPKR(totalReceivedInPeriod - settlementsToDistributors);

  const totals = pb.totals || {};

  return {
    period: { startDate: startDate || null, endDate: endDate || null },
    receivedInPeriod: {
      pharmacyCollectionsByCompany,
      pharmacyCollectionsHeldByDistributors,
      settlementsFromDistributors,
      total: totalReceivedInPeriod
    },
    paidOutInPeriod: {
      settlementsToDistributors
    },
    netCashMovementInPeriod,
    snapshot: {
      outstandingReceivableFromPharmacies: roundPKR(totals.totalReceivable ?? 0),
      customerPrepaidCredits: roundPKR(totals.totalPharmacyCreditBalance ?? 0)
    },
    help: {
      received:
        'Company cash in the period: collections taken by the company plus distributor→company settlements. Distributor-held collections are not company cash until settled.',
      distributorHeld:
        'Amount collected from pharmacies by distributors in the period; cash is with the distributor until you record a distributor→company settlement.',
      outstanding:
        'Invoice amounts pharmacies still owe (ledger receivable). Not filtered by product/distributor/employee.',
      prepaid: 'Prepaid balances owed back to pharmacies (credit on their account).'
    }
  };
};

const summary = async (companyId, query = {}) => {
  const {
    startDate,
    endDate,
    productId,
    employeeId,
    distributorId
  } = query;

  const { totalRevenue, productCost } = await sumSalesRevenueAndCogs(companyId, {
    startDate,
    endDate,
    distributorId,
    productId
  });

  const [ship, payroll, doctor, other] = await Promise.all([
    shippingCost(companyId, { startDate, endDate, productId }),
    payrollCostSum(companyId, { startDate, endDate, employeeId }),
    doctorActivityCostSum(companyId, { startDate, endDate }),
    otherExpensesSum(companyId, { startDate, endDate })
  ]);
  const distributorCommission = await distributorCommissionCostSum(companyId, {
    startDate,
    endDate,
    distributorId
  });

  const grossProfit = roundPKR(totalRevenue - productCost);
  const netProfit = roundPKR(grossProfit - distributorCommission - payroll - other);
  const totalCost = roundPKR(productCost + distributorCommission + payroll + other);
  const profitMarginPercent =
    totalRevenue > 0 ? roundPKR((netProfit / totalRevenue) * 100) : totalRevenue === 0 && netProfit === 0 ? 0 : null;

  const ratio = totalCost > 0 ? roundPKR(totalRevenue / totalCost) : null;

  const costBreakdown = [
    { key: 'productCost', label: 'Product (COGS)', amount: productCost },
    { key: 'shippingCost', label: 'Shipping (transfers)', amount: ship },
    { key: 'payrollCost', label: 'Payroll (paid)', amount: payroll },
    { key: 'doctorActivityCost', label: 'Doctor activities', amount: doctor },
    { key: 'otherExpenses', label: 'Other expenses', amount: other }
  ];
  const highestCostCategory = [...costBreakdown].sort((a, b) => b.amount - a.amount)[0] || null;

  const products = await productProfitability(companyId, { ...query, limit: 200 });
  const sorted = [...products].sort((a, b) => b.profit - a.profit);
  const topProfitableProducts = sorted.slice(0, 5);
  const lossSorted = [...products].sort((a, b) => a.profit - b.profit);
  const topLossMakingProducts = lossSorted.slice(0, 5);

  const liquidity = await liquiditySnapshot(companyId, { startDate, endDate });

  /** Sum of delivery/return company-share lines (same basis as product table `revenue`); additive KPI. */
  const totalNetSalesCompany = roundPKR(products.reduce((s, p) => s + (Number(p.revenue) || 0), 0));

  const response = {
    basis: 'transaction_delivery',
    period: { startDate: startDate || null, endDate: endDate || null },
    filters: {
      productId: productId || null,
      employeeId: employeeId || null,
      distributorId: distributorId || null
    },
    totalRevenue,
    totalNetSalesCompany,
    grossProfit,
    totalCost,
    netProfit,
    profitMarginPercent,
    revenueVsCostRatio: ratio,
    breakdown: {
      productCost,
      shippingCost: ship,
      distributorCommissionCost: distributorCommission,
      payrollCost: payroll,
      doctorActivityCost: doctor,
      otherExpenses: other
    },
    insights: {
      topProfitableProducts,
      topLossMakingProducts,
      highestCostCategory,
      revenueVsCostRatio: ratio
    },
    liquidity
  };

  return withFinancialEnvelope({
    data: response,
    scope: FINANCIAL_SCOPE.PERIOD,
    canonical: canonicalFromSummary(response)
  });
};

/** Merge two { _id: monthKey, revenue } arrays by month */
const mergeMonthly = (a, b) => {
  const m = new Map();
  for (const x of a) m.set(x._id, (m.get(x._id) || 0) + x.revenue);
  for (const x of b) m.set(x._id, (m.get(x._id) || 0) + x.revenue);
  return [...m.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([month, revenue]) => ({ month, revenue: roundPKR(revenue) }));
};

/** Revenue groupings: month (SALE+RETURN), product (delivery lines net of returns), distributor */
const revenue = async (companyId, query = {}) => {
  const { startDate, endDate, distributorId, productId } = query;
  const cid = objectId(companyId);
  const dateR = parseRange(startDate, endDate);
  const txDate = { companyId: cid, isDeleted: nd, ...(Object.keys(dateR).length ? { date: dateR } : {}) };

  let byMonth = [];

  if (!productId) {
    if (!distributorId) {
      const raw = await Transaction.aggregate([
        {
          $match: {
            ...txDate,
            type: { $in: [TRANSACTION_TYPE.SALE, TRANSACTION_TYPE.RETURN] }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$date', timezone: 'UTC' } },
            revenue: { $sum: '$revenue' }
          }
        },
        { $sort: { _id: 1 } }
      ]);
      byMonth = raw.map((r) => ({ month: r._id, revenue: roundPKR(r.revenue) }));
    } else {
      const did = objectId(distributorId);
      const [saleM, retM] = await Promise.all([
        Transaction.aggregate([
          { $match: { ...txDate, type: TRANSACTION_TYPE.SALE, referenceType: 'DELIVERY' } },
          { $lookup: { from: 'deliveryrecords', localField: 'referenceId', foreignField: '_id', as: 'd' } },
          { $unwind: '$d' },
          { $lookup: { from: 'orders', localField: 'd.orderId', foreignField: '_id', as: 'o' } },
          { $unwind: '$o' },
          { $match: { 'o.distributorId': did } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$date', timezone: 'UTC' } },
              revenue: { $sum: '$revenue' }
            }
          }
        ]),
        Transaction.aggregate([
          { $match: { ...txDate, type: TRANSACTION_TYPE.RETURN, referenceType: 'RETURN' } },
          { $lookup: { from: 'returnrecords', localField: 'referenceId', foreignField: '_id', as: 'rr' } },
          { $unwind: '$rr' },
          { $lookup: { from: 'orders', localField: 'rr.orderId', foreignField: '_id', as: 'o' } },
          { $unwind: '$o' },
          { $match: { 'o.distributorId': did } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$date', timezone: 'UTC' } },
              revenue: { $sum: '$revenue' }
            }
          }
        ])
      ]);
      byMonth = mergeMonthly(saleM, retM).map((r) => ({ month: r.month, revenue: r.revenue }));
    }
  } else {
    byMonth = [];
  }

  const pipe = [
    { $match: { companyId: cid, isDeleted: nd, ...(Object.keys(dateR).length ? { deliveredAt: dateR } : {}) } },
    ...(distributorId
      ? [
          { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'o' } },
          { $unwind: '$o' },
          { $match: { 'o.distributorId': objectId(distributorId) } }
        ]
      : []),
    { $unwind: '$items' },
    ...(productId ? [{ $match: { 'items.productId': objectId(productId) } }] : []),
    {
      $group: {
        _id: '$items.productId',
        revenue: { $sum: { $ifNull: ['$items.linePharmacyNet', 0] } },
        quantity: { $sum: '$items.quantity' }
      }
    },
    {
      $lookup: {
        from: 'products',
        localField: '_id',
        foreignField: '_id',
        as: 'p'
      }
    },
    { $unwind: { path: '$p', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        productId: '$_id',
        productName: { $ifNull: ['$p.name', 'Unknown'] },
        revenue: 1,
        quantity: 1
      }
    },
    { $sort: { revenue: -1 } },
    { $limit: 500 }
  ];
  let byProduct = await DeliveryRecord.aggregate(pipe);
  byProduct = byProduct.map((r) => ({ ...r, revenue: roundPKR(r.revenue) }));

  const distSale = await Transaction.aggregate([
    { $match: { ...txDate, type: TRANSACTION_TYPE.SALE, referenceType: 'DELIVERY' } },
    { $lookup: { from: 'deliveryrecords', localField: 'referenceId', foreignField: '_id', as: 'd' } },
    { $unwind: '$d' },
    { $lookup: { from: 'orders', localField: 'd.orderId', foreignField: '_id', as: 'o' } },
    { $unwind: '$o' },
    ...(distributorId ? [{ $match: { 'o.distributorId': objectId(distributorId) } }] : []),
    { $group: { _id: '$o.distributorId', revenue: { $sum: '$revenue' } } }
  ]);
  const distRet = await Transaction.aggregate([
    { $match: { ...txDate, type: TRANSACTION_TYPE.RETURN, referenceType: 'RETURN' } },
    { $lookup: { from: 'returnrecords', localField: 'referenceId', foreignField: '_id', as: 'rr' } },
    { $unwind: '$rr' },
    { $lookup: { from: 'orders', localField: 'rr.orderId', foreignField: '_id', as: 'o' } },
    { $unwind: '$o' },
    ...(distributorId ? [{ $match: { 'o.distributorId': objectId(distributorId) } }] : []),
    { $group: { _id: '$o.distributorId', revenue: { $sum: '$revenue' } } }
  ]);
  const distMap = new Map();
  for (const x of distSale) distMap.set(x._id.toString(), (distMap.get(x._id.toString()) || 0) + x.revenue);
  for (const x of distRet) distMap.set(x._id.toString(), (distMap.get(x._id.toString()) || 0) + x.revenue);
  const distIds = [...distMap.keys()].map((id) => objectId(id));
  const distDocs = await Distributor.find({ _id: { $in: distIds } }).select('name').lean();
  const distName = new Map(distDocs.map((d) => [d._id.toString(), d.name]));
  let byDistributor = [...distMap.entries()]
    .map(([id, rev]) => ({
      distributorId: objectId(id),
      distributorName: distName.get(id) || 'Unknown',
      revenue: roundPKR(rev)
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const totalAgg = await sumSalesRevenueAndCogs(companyId, { startDate, endDate, distributorId, productId });

  return {
    totalRevenue: totalAgg.totalRevenue,
    byMonth,
    byProduct,
    byDistributor
  };
};

const costs = async (companyId, query = {}) => {
  const { startDate, endDate, productId, employeeId } = query;
  const [productCost, ship, payroll, doctor, other, distributorCommission] = await Promise.all([
    sumSalesRevenueAndCogs(companyId, { startDate, endDate, distributorId: query.distributorId, productId }).then(
      (x) => x.productCost
    ),
    shippingCost(companyId, { startDate, endDate, productId }),
    payrollCostSum(companyId, { startDate, endDate, employeeId }),
    doctorActivityCostSum(companyId, { startDate, endDate }),
    otherExpensesSum(companyId, { startDate, endDate }),
    distributorCommissionCostSum(companyId, {
      startDate,
      endDate,
      distributorId: query.distributorId
    })
  ]);

  const totalCost = roundPKR(productCost + distributorCommission + payroll + other);
  return {
    totalCost,
    grossProfitFormula: 'totalRevenue - productCost',
    netProfitFormula: 'grossProfit - distributorCommissionCost - payrollCost - otherExpenses',
    byType: [
      { type: 'product_cogs', label: 'Product (COGS)', amount: productCost },
      { type: 'shipping', label: 'Shipping', amount: ship },
      { type: 'distributor_commission', label: 'Distributor commission', amount: distributorCommission },
      { type: 'payroll', label: 'Payroll', amount: payroll },
      { type: 'doctor_activities', label: 'Doctor activities', amount: doctor },
      { type: 'other_expenses', label: 'Other expenses', amount: other }
    ]
  };
};

const productProfitability = async (companyId, query = {}) => {
  const { startDate, endDate, distributorId, productId, limit = 200 } = query;
  const cid = objectId(companyId);
  const dateR = parseRange(startDate, endDate);

  const delPipe = [
    { $match: { companyId: cid, isDeleted: nd, ...(Object.keys(dateR).length ? { deliveredAt: dateR } : {}) } },
    { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'o' } },
    { $unwind: '$o' },
    ...(distributorId ? [{ $match: { 'o.distributorId': objectId(distributorId) } }] : []),
    { $unwind: '$items' },
    ...(productId ? [{ $match: { 'items.productId': objectId(productId) } }] : []),
    {
      $group: {
        _id: '$items.productId',
        totalSold: { $sum: '$items.quantity' },
        revenue: { $sum: companyRevenueFromDeliveryLine },
        netSalesCustomer: { $sum: { $ifNull: ['$items.linePharmacyNet', 0] } },
        cost: {
          $sum: {
            $multiply: ['$items.quantity', { $ifNull: ['$items.avgCostAtTime', 0] }]
          }
        }
      }
    }
  ];

  const retPipe = [
    { $match: { companyId: cid, isDeleted: nd, ...(Object.keys(dateR).length ? { returnedAt: dateR } : {}) } },
    { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'o' } },
    { $unwind: '$o' },
    ...(distributorId ? [{ $match: { 'o.distributorId': objectId(distributorId) } }] : []),
    { $unwind: '$items' },
    ...(productId ? [{ $match: { 'items.productId': objectId(productId) } }] : []),
    {
      $group: {
        _id: '$items.productId',
        totalSold: { $sum: { $multiply: ['$items.quantity', -1] } },
        revenue: { $sum: companyRevenueFromReturnLine },
        netSalesCustomer: { $sum: customerNetFromReturnLine },
        cost: {
          $sum: {
            $multiply: [
              { $multiply: ['$items.quantity', { $ifNull: ['$items.avgCostAtTime', 0] }] },
              -1
            ]
          }
        }
      }
    }
  ];

  const [delivered, returned] = await Promise.all([
    DeliveryRecord.aggregate(delPipe),
    ReturnRecord.aggregate(retPipe)
  ]);

  const map = new Map();
  for (const row of delivered) {
    const id = row._id.toString();
    map.set(id, {
      productId: row._id,
      totalSold: row.totalSold,
      revenue: row.revenue,
      netSalesCustomer: row.netSalesCustomer || 0,
      cost: row.cost
    });
  }
  for (const row of returned) {
    const id = row._id.toString();
    const cur = map.get(id) || {
      productId: row._id,
      totalSold: 0,
      revenue: 0,
      netSalesCustomer: 0,
      cost: 0
    };
    cur.totalSold += row.totalSold;
    cur.revenue += row.revenue;
    cur.netSalesCustomer = (cur.netSalesCustomer || 0) + (row.netSalesCustomer || 0)
    cur.cost += row.cost;
    map.set(id, cur);
  }

  const ids = [...map.keys()].map((k) => objectId(k));
  const products = await Product.find({ _id: { $in: ids } })
    .select('name')
    .lean();
  const nameById = new Map(products.map((p) => [p._id.toString(), p.name]));

  let rows = [...map.values()].map((r) => {
    const rev = roundPKR(r.revenue);
    const nsc = roundPKR(r.netSalesCustomer || 0);
    const c = roundPKR(r.cost);
    const profit = roundPKR(rev - c);
    return {
      productId: r.productId,
      productName: nameById.get(r.productId.toString()) || 'Unknown',
      totalSold: roundPKR(r.totalSold),
      revenue: rev,
      netSalesCustomer: nsc,
      cost: c,
      profit
    };
  });
  rows.sort((a, b) => b.profit - a.profit);
  if (limit) rows = rows.slice(0, Number(limit));
  return rows;
};

/** Monthly trend: revenue (transactions), cost components by natural dates */
const trends = async (companyId, query = {}) => {
  const { startDate, endDate, granularity = 'month' } = query;
  const cid = objectId(companyId);
  const dateR = parseRange(startDate, endDate);
  const dateFormat = granularity === 'day' ? '%Y-%m-%d' : '%Y-%m';

  const transMatch = {
    companyId: cid,
    isDeleted: nd,
    type: { $in: [TRANSACTION_TYPE.SALE, TRANSACTION_TYPE.RETURN] },
    ...(Object.keys(dateR).length ? { date: dateR } : {})
  };

  const [revByPeriod, shipBy, payBy, docBy, expBy, commBy, commRevBy] = await Promise.all([
    Transaction.aggregate([
      { $match: transMatch },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$date', timezone: 'UTC' } },
          revenue: { $sum: '$revenue' },
          cogs: { $sum: '$cost' }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    StockTransfer.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          ...(Object.keys(dateR).length ? { transferDate: dateR } : {})
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$transferDate', timezone: 'UTC' } },
          shippingCost: { $sum: { $ifNull: ['$totalShippingCost', 0] } }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    Payroll.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          status: PAYROLL_STATUS.PAID,
          ...(Object.keys(dateR).length ? { paidOn: dateR } : { paidOn: { $exists: true, $ne: null } })
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$paidOn', timezone: 'UTC' } },
          payrollCost: { $sum: '$netSalary' }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    DoctorActivity.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          ...(Object.keys(dateR).length ? { createdAt: dateR } : {})
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$createdAt', timezone: 'UTC' } },
          doctorActivityCost: { $sum: '$investedAmount' }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    Expense.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          category: { $ne: EXPENSE_CATEGORY.SALARY },
          ...(Object.keys(dateR).length ? { date: dateR } : {})
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$date', timezone: 'UTC' } },
          otherExpenses: { $sum: '$amount' }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    DeliveryRecord.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          ...(Object.keys(dateR).length ? { deliveredAt: dateR } : {})
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$deliveredAt', timezone: 'UTC' } },
          distributorCommissionCost: { $sum: { $ifNull: ['$distributorShareTotal', 0] } }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    Ledger.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
          referenceType: LEDGER_REFERENCE_TYPE.RETURN_CLEARING_ADJ,
          type: LEDGER_TYPE.DEBIT,
          ...(Object.keys(dateR).length ? { date: dateR } : {})
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$date', timezone: 'UTC' } },
          commissionReversal: { $sum: '$amount' }
        }
      },
      { $sort: { _id: 1 } }
    ])
  ]);

  const keys = new Set();
  [...revByPeriod, ...shipBy, ...payBy, ...docBy, ...expBy, ...commBy, ...commRevBy].forEach((x) => keys.add(x._id));

  const merged = [...keys]
    .filter(Boolean)
    .sort()
    .map((period) => {
      const r = revByPeriod.find((x) => x._id === period) || {};
      const s = shipBy.find((x) => x._id === period) || {};
      const p = payBy.find((x) => x._id === period) || {};
      const d = docBy.find((x) => x._id === period) || {};
      const e = expBy.find((x) => x._id === period) || {};
      const c = commBy.find((x) => x._id === period) || {};
      const cr = commRevBy.find((x) => x._id === period) || {};
      const revenue = roundPKR(r.revenue || 0);
      const cogs = roundPKR(r.cogs || 0);
      const shippingCost = roundPKR(s.shippingCost || 0);
      const payrollCost = roundPKR(p.payrollCost || 0);
      const doctorActivityCost = roundPKR(d.doctorActivityCost || 0);
      const otherExpenses = roundPKR(e.otherExpenses || 0);
      const distributorCommissionCost = roundPKR((c.distributorCommissionCost || 0) - (cr.commissionReversal || 0));
      const grossProfit = roundPKR(revenue - cogs);
      const netProfit = roundPKR(grossProfit - distributorCommissionCost - payrollCost - otherExpenses);
      const totalCost = roundPKR(cogs + distributorCommissionCost + payrollCost + otherExpenses);
      return {
        period,
        revenue,
        grossProfit,
        totalCost,
        netProfit,
        breakdown: {
          productCost: cogs,
          shippingCost,
          distributorCommissionCost,
          payrollCost,
          doctorActivityCost,
          otherExpenses
        }
      };
    });

  const response = { granularity, series: merged };
  return withFinancialEnvelope({
    data: response,
    scope: FINANCIAL_SCOPE.LINE,
    canonical: canonicalFromTrends(response)
  });
};

module.exports = {
  summary,
  revenue,
  costs,
  productProfitability,
  trends
};
