/**
 * Fiscal-year monthly summary (Aug → Jul) for Reports & Insights.
 * P/L = Net Sales − Distribution − Discount − Stock Purchase (supplier GRN/purchase) − Expenses (payroll + other).
 * Marketing (doctor investment) is informational only.
 */
const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const Payroll = require('../models/Payroll');
const DoctorActivity = require('../models/DoctorActivity');
const Expense = require('../models/Expense');
const Ledger = require('../models/Ledger');
const SupplierLedger = require('../models/SupplierLedger');
const { roundPKR } = require('../utils/currency');
const ApiError = require('../utils/ApiError');
const businessTime = require('../utils/businessTime');
const {
  EXPENSE_CATEGORY,
  PAYROLL_STATUS,
  LEDGER_ENTITY_TYPE,
  LEDGER_TYPE,
  LEDGER_REFERENCE_TYPE,
  SUPPLIER_LEDGER_TYPE
} = require('../constants/enums');

const objectId = (id) => new mongoose.Types.ObjectId(id);
const nd = { $ne: true };
const ymFormat = '%Y-%m';

const fiscalYearBounds = (fiscalYearStart, tz) => {
  const y = parseInt(fiscalYearStart, 10);
  if (!Number.isFinite(y) || y < 2000 || y > 2100) {
    throw new ApiError(400, 'Invalid fiscalYearStart');
  }
  const z = businessTime.requireCompanyIanaZone(tz);
  const start = DateTime.fromObject({ year: y, month: 8, day: 1 }, { zone: z }).startOf('day');
  const end = DateTime.fromObject({ year: y + 1, month: 7, day: 31 }, { zone: z }).endOf('day');
  const monthKeys = [];
  let cur = start;
  for (let i = 0; i < 12; i += 1) {
    monthKeys.push(cur.toFormat('yyyy-MM'));
    cur = cur.plus({ months: 1 });
  }
  return {
    fiscalYearStart: y,
    fiscalYearLabel: `${y}-${y + 1}`,
    period: { from: start.toISODate(), to: end.toISODate() },
    dateRange: { $gte: start.toUTC().toJSDate(), $lte: end.toUTC().toJSDate() },
    monthKeys,
    timeZone: z
  };
};

const monthLabel = (ym, tz) => DateTime.fromFormat(ym, 'yyyy-MM', { zone: tz }).toFormat('MMMM');

const mapByMonth = (rows, valueKey) => {
  const m = new Map();
  for (const r of rows) {
    if (r._id) m.set(r._id, roundPKR(r[valueKey] || 0));
  }
  return m;
};

const computePl = (row) =>
  roundPKR(
    row.netSales -
      row.distribution -
      row.discount -
      row.stockPurchaseExpenses -
      row.expenses
  );

/** Treat sub-paisa residuals from return rounding as zero in management reports. */
const zeroDust = (v) => {
  const n = roundPKR(v || 0);
  return Math.abs(n) < 0.01 ? 0 : n;
};

const normalizeRow = (row) => {
  const base = {
    ...row,
    netSales: zeroDust(row.netSales),
    distribution: zeroDust(row.distribution),
    discount: zeroDust(row.discount),
    stockPurchaseExpenses: zeroDust(row.stockPurchaseExpenses),
    expenses: zeroDust(row.expenses),
    marketing: zeroDust(row.marketing)
  };
  return { ...base, pl: computePl(base) };
};

const defaultFiscalYearStart = (timeZone) => {
  const z = businessTime.requireCompanyIanaZone(timeZone);
  const now = DateTime.now().setZone(z);
  return now.month >= 8 ? now.year : now.year - 1;
};

const monthlySummary = async (companyId, query = {}, timeZone) => {
  const rawStart = query.fiscalYearStart ?? query.fiscalYear;
  const fiscalYearStart =
    rawStart != null && rawStart !== ''
      ? rawStart
      : defaultFiscalYearStart(timeZone);
  const bounds = fiscalYearBounds(fiscalYearStart, timeZone);
  const { dateRange, monthKeys, timeZone: tz } = bounds;
  const cid = objectId(companyId);
  const ymOn = (field) => ({
    $dateToString: { format: ymFormat, date: field, timezone: tz }
  });

  const returnNetPipeline = [
    { $match: { companyId: cid, isDeleted: nd, returnedAt: dateRange } },
    {
      $lookup: {
        from: 'deliveryrecords',
        let: { oid: '$orderId', cid: '$companyId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$orderId', '$$oid'] }, { $eq: ['$companyId', '$$cid'] }]
              },
              isDeleted: { $ne: true }
            }
          },
          { $sort: { deliveredAt: -1 } }
        ],
        as: 'deliveries'
      }
    },
    { $unwind: '$items' },
    {
      $addFields: {
        deliveryLine: {
          $let: {
            vars: {
              lines: {
                $reduce: {
                  input: '$deliveries',
                  initialValue: [],
                  in: { $concatArrays: ['$$value', { $ifNull: ['$$this.items', []] }] }
                }
              }
            },
            in: {
              $arrayElemAt: [
                {
                  $filter: {
                    input: '$$lines',
                    as: 'dl',
                    cond: { $eq: ['$$dl.productId', '$items.productId'] }
                  }
                },
                0
              ]
            }
          }
        }
      }
    },
    {
      $group: {
        _id: ymOn('$returnedAt'),
        returnNet: {
          $sum: {
            $cond: [
              { $gt: [{ $ifNull: ['$deliveryLine.linePharmacyNet', 0] }, 0] },
              {
                $multiply: [
                  {
                    $divide: [
                      '$deliveryLine.linePharmacyNet',
                      { $max: [{ $ifNull: ['$deliveryLine.quantity', 1] }, 1] }
                    ]
                  },
                  '$items.quantity'
                ]
              },
              {
                $multiply: ['$items.quantity', { $ifNull: ['$items.finalSellingPrice', 0] }]
              }
            ]
          }
        }
      }
    }
  ];

  const [
    deliveryNetByMonth,
    returnNetByMonth,
    commDeliveryByMonth,
    commReversalByMonth,
    deliveryDiscountByMonth,
    returnDiscountByMonth,
    payrollByMonth,
    otherExpByMonth,
    marketingByMonth,
    supplierPurchaseByMonth,
    supplierPurchaseReturnByMonth
  ] = await Promise.all([
    DeliveryRecord.aggregate([
      { $match: { companyId: cid, isDeleted: nd, deliveredAt: dateRange } },
      {
        $group: {
          _id: ymOn('$deliveredAt'),
          net: {
            $sum: { $ifNull: ['$pharmacyNetPayable', { $ifNull: ['$totalAmount', 0] }] }
          }
        }
      }
    ]),
    ReturnRecord.aggregate(returnNetPipeline),
    DeliveryRecord.aggregate([
      { $match: { companyId: cid, isDeleted: nd, deliveredAt: dateRange } },
      {
        $group: {
          _id: ymOn('$deliveredAt'),
          distribution: { $sum: { $ifNull: ['$distributorShareTotal', 0] } }
        }
      }
    ]),
    Ledger.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
          referenceType: LEDGER_REFERENCE_TYPE.RETURN_CLEARING_ADJ,
          type: LEDGER_TYPE.DEBIT,
          date: dateRange
        }
      },
      {
        $group: {
          _id: ymOn('$date'),
          commissionReversal: { $sum: '$amount' }
        }
      }
    ]),
    DeliveryRecord.aggregate([
      { $match: { companyId: cid, isDeleted: nd, deliveredAt: dateRange } },
      {
        $group: {
          _id: ymOn('$deliveredAt'),
          discount: {
            $sum: {
              $subtract: [
                { $ifNull: ['$tpSubtotal', 0] },
                { $ifNull: ['$pharmacyNetPayable', { $ifNull: ['$totalAmount', 0] }] }
              ]
            }
          }
        }
      }
    ]),
    ReturnRecord.aggregate([
      { $match: { companyId: cid, isDeleted: nd, returnedAt: dateRange } },
      {
        $lookup: {
          from: 'deliveryrecords',
          let: { oid: '$orderId', cid: '$companyId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [{ $eq: ['$orderId', '$$oid'] }, { $eq: ['$companyId', '$$cid'] }]
                },
                isDeleted: { $ne: true }
              }
            },
            { $sort: { deliveredAt: -1 } }
          ],
          as: 'deliveries'
        }
      },
      { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'o' } },
      { $unwind: '$o' },
      { $unwind: '$items' },
      {
        $addFields: {
          orderItem: {
            $arrayElemAt: [
              {
                $filter: {
                  input: '$o.items',
                  as: 'oi',
                  cond: { $eq: ['$$oi.productId', '$items.productId'] }
                }
              },
              0
            ]
          },
          deliveryLine: {
            $let: {
              vars: {
                lines: {
                  $reduce: {
                    input: '$deliveries',
                    initialValue: [],
                    in: { $concatArrays: ['$$value', { $ifNull: ['$$this.items', []] }] }
                  }
                }
              },
              in: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: '$$lines',
                      as: 'dl',
                      cond: { $eq: ['$$dl.productId', '$items.productId'] }
                    }
                  },
                  0
                ]
              }
            }
          }
        }
      },
      {
        $group: {
          _id: ymOn('$returnedAt'),
          discount: {
            $sum: {
              $subtract: [
                {
                  $multiply: [{ $ifNull: ['$orderItem.tpAtTime', 0] }, '$items.quantity']
                },
                {
                  $cond: [
                    { $gt: [{ $ifNull: ['$deliveryLine.linePharmacyNet', 0] }, 0] },
                    {
                      $multiply: [
                        {
                          $divide: [
                            '$deliveryLine.linePharmacyNet',
                            { $max: [{ $ifNull: ['$deliveryLine.quantity', 1] }, 1] }
                          ]
                        },
                        '$items.quantity'
                      ]
                    },
                    {
                      $multiply: ['$items.quantity', { $ifNull: ['$items.finalSellingPrice', 0] }]
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    ]),
    Payroll.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          status: PAYROLL_STATUS.PAID,
          paidOn: dateRange
        }
      },
      {
        $group: {
          _id: ymOn('$paidOn'),
          payroll: { $sum: '$netSalary' }
        }
      }
    ]),
    Expense.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          category: { $ne: EXPENSE_CATEGORY.SALARY },
          date: dateRange
        }
      },
      {
        $group: {
          _id: ymOn('$date'),
          other: { $sum: '$amount' }
        }
      }
    ]),
    DoctorActivity.aggregate([
      { $match: { companyId: cid, isDeleted: nd, createdAt: dateRange } },
      {
        $group: {
          _id: ymOn('$createdAt'),
          marketing: { $sum: '$investedAmount' }
        }
      }
    ]),
    SupplierLedger.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          type: SUPPLIER_LEDGER_TYPE.PURCHASE,
          date: dateRange
        }
      },
      {
        $group: {
          _id: ymOn('$date'),
          purchase: { $sum: '$amount' }
        }
      }
    ]),
    SupplierLedger.aggregate([
      {
        $match: {
          companyId: cid,
          isDeleted: nd,
          type: SUPPLIER_LEDGER_TYPE.PURCHASE_RETURN,
          date: dateRange
        }
      },
      {
        $group: {
          _id: ymOn('$date'),
          purchaseReturn: { $sum: '$amount' }
        }
      }
    ])
  ]);

  const deliveryNetMap = mapByMonth(deliveryNetByMonth, 'net');
  const returnNetMap = mapByMonth(returnNetByMonth, 'returnNet');
  const supplierPurMap = mapByMonth(supplierPurchaseByMonth, 'purchase');
  const supplierPurRetMap = mapByMonth(supplierPurchaseReturnByMonth, 'purchaseReturn');

  const distDelMap = mapByMonth(commDeliveryByMonth, 'distribution');
  const distRevMap = mapByMonth(commReversalByMonth, 'commissionReversal');
  const delDiscMap = mapByMonth(deliveryDiscountByMonth, 'discount');
  const retDiscMap = mapByMonth(returnDiscountByMonth, 'discount');
  const payrollMap = mapByMonth(payrollByMonth, 'payroll');
  const otherExpMap = mapByMonth(otherExpByMonth, 'other');
  const marketingMap = mapByMonth(marketingByMonth, 'marketing');

  const rows = monthKeys.map((month) => {
    const netSales = roundPKR((deliveryNetMap.get(month) || 0) - (returnNetMap.get(month) || 0));
    const distribution = roundPKR((distDelMap.get(month) || 0) - (distRevMap.get(month) || 0));
    const discount = roundPKR((delDiscMap.get(month) || 0) - (retDiscMap.get(month) || 0));
    const stockPurchaseExpenses = roundPKR(
      (supplierPurMap.get(month) || 0) - (supplierPurRetMap.get(month) || 0)
    );
    const expenses = roundPKR((payrollMap.get(month) || 0) + (otherExpMap.get(month) || 0));
    const marketing = marketingMap.get(month) || 0;
    return normalizeRow({
      month,
      monthLabel: monthLabel(month, tz),
      netSales,
      distribution,
      discount,
      stockPurchaseExpenses,
      expenses,
      marketing
    });
  });

  const totals = normalizeRow(
    rows.reduce(
      (acc, r) => ({
        month: 'total',
        monthLabel: 'Total',
        netSales: roundPKR(acc.netSales + r.netSales),
        distribution: roundPKR(acc.distribution + r.distribution),
        discount: roundPKR(acc.discount + r.discount),
        stockPurchaseExpenses: roundPKR(acc.stockPurchaseExpenses + r.stockPurchaseExpenses),
        expenses: roundPKR(acc.expenses + r.expenses),
        marketing: roundPKR(acc.marketing + r.marketing),
        pl: 0
      }),
      {
        month: 'total',
        monthLabel: 'Total',
        netSales: 0,
        distribution: 0,
        discount: 0,
        stockPurchaseExpenses: 0,
        expenses: 0,
        marketing: 0,
        pl: 0
      }
    )
  );

  return {
    fiscalYearLabel: bounds.fiscalYearLabel,
    fiscalYearStart: bounds.fiscalYearStart,
    period: bounds.period,
    monthKeys,
    rows,
    totals,
    meta: {
      plFormula:
        'Net Sales − Distribution − Discount − Stock Purchase Expenses (supplier GRN/purchase) − Expenses (payroll + operating)',
      dateBasis: {
        netSales: 'DeliveryRecord.pharmacyNetPayable minus proportional return pharmacy net (return month)',
        stockPurchaseExpenses:
          'SupplierLedger.date (type PURCHASE minus PURCHASE_RETURN — goods received, not cash payment)',
        distribution: 'DeliveryRecord.deliveredAt minus return commission reversals (Ledger.date)',
        discount: 'Delivery tpSubtotal − pharmacyNetPayable; returns reduce by returned discount',
        expenses: 'Payroll.paidOn (PAID) + Expense.date (category ≠ SALARY)',
        marketing: 'DoctorActivity.createdAt (investedAmount)'
      },
      notes: [
        'Marketing (doctor investment) is not included in P/L.',
        'Stock Purchase reflects supplier goods receipt (GRN/manual purchase), not supplier payments or delivery COGS.',
        'Supplier payments affect payables/cash only — they do not change this report.'
      ]
    }
  };
};

module.exports = {
  fiscalYearBounds,
  monthlySummary
};
