/**
 * Fiscal-year monthly summary (Aug → Jul) for Reports & Insights.
 * P/L = Net Sales − Distribution − Discount − Casting (sold products) − Expenses (payroll + other).
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
const Product = require('../models/Product');
const Order = require('../models/Order');
const Pharmacy = require('../models/Pharmacy');
const XLSX = require('xlsx');
const { roundPKR } = require('../utils/currency');
const ApiError = require('../utils/ApiError');
const businessTime = require('../utils/businessTime');
const { qScalar } = require('../utils/listQuery');
const {
  EXPENSE_CATEGORY,
  PAYROLL_STATUS,
  LEDGER_ENTITY_TYPE,
  LEDGER_TYPE,
  LEDGER_REFERENCE_TYPE
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
      row.castingCost -
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
    castingCost: zeroDust(row.castingCost),
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

/** Infer bonus qty from delivery line fields (matches Excel export logic). */
const bonusQtyExpr = (qtyField, paidField, bonusField) => ({
  $cond: [
    { $ne: [{ $type: bonusField }, 'missing'] },
    { $ifNull: [bonusField, 0] },
    {
      $max: [
        0,
        {
          $subtract: [qtyField, { $ifNull: [paidField, qtyField] }]
        }
      ]
    }
  ]
});

/** Clinic discount on paid packs + full TP value of bonus/free packs. */
const totalLineDiscountExpr = (tpAtTime, clinicDiscount, paidQty, bonusQty) => ({
  $add: [
    {
      $multiply: [
        { $multiply: [tpAtTime, paidQty] },
        { $divide: [{ $ifNull: [clinicDiscount, 0] }, 100] }
      ]
    },
    { $multiply: [tpAtTime, bonusQty] }
  ]
});

const orderItemForProduct = {
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
};

/** Discount by delivery month: Σ (clinic % on paid qty + TP × bonus qty) per line. */
const deliveryDiscountByMonthPipeline = (companyId, dateRange, ymOn) => [
  { $match: { companyId, isDeleted: nd, deliveredAt: dateRange } },
  { $unwind: '$items' },
  { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'o' } },
  { $unwind: '$o' },
  {
    $addFields: {
      orderItem: orderItemForProduct,
      paidQty: { $ifNull: ['$items.paidQuantity', '$items.quantity'] },
      bonusQty: bonusQtyExpr('$items.quantity', '$items.paidQuantity', '$items.bonusQuantity')
    }
  },
  {
    $addFields: {
      lineDiscount: totalLineDiscountExpr(
        { $ifNull: ['$orderItem.tpAtTime', 0] },
        '$orderItem.clinicDiscount',
        '$paidQty',
        '$bonusQty'
      )
    }
  },
  {
    $group: {
      _id: ymOn('$deliveredAt'),
      discount: { $sum: '$lineDiscount' }
    }
  }
];

/** Return discount reversal: proportional share of delivery line total discount (clinic + bonus). */
const returnDiscountByMonthPipeline = (companyId, dateRange, ymOn) => [
  { $match: { companyId, isDeleted: nd, returnedAt: dateRange } },
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
      orderItem: orderItemForProduct,
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
    $addFields: {
      tpAtTime: { $ifNull: ['$orderItem.tpAtTime', 0] },
      clinicDiscount: { $ifNull: ['$orderItem.clinicDiscount', 0] },
      deliveryPhysicalQty: { $max: [{ $ifNull: ['$deliveryLine.quantity', 0] }, 1] },
      deliveryPaidQty: {
        $ifNull: ['$deliveryLine.paidQuantity', { $ifNull: ['$deliveryLine.quantity', 0] }]
      },
      deliveryBonusQty: bonusQtyExpr(
        { $ifNull: ['$deliveryLine.quantity', 0] },
        '$deliveryLine.paidQuantity',
        '$deliveryLine.bonusQuantity'
      )
    }
  },
  {
    $addFields: {
      deliveryLineTotalDiscount: {
        $cond: [
          { $gt: [{ $ifNull: ['$deliveryLine.quantity', 0] }, 0] },
          totalLineDiscountExpr('$tpAtTime', '$clinicDiscount', '$deliveryPaidQty', '$deliveryBonusQty'),
          totalLineDiscountExpr('$tpAtTime', '$clinicDiscount', '$items.quantity', 0)
        ]
      }
    }
  },
  {
    $addFields: {
      returnDiscount: {
        $multiply: [{ $divide: ['$deliveryLineTotalDiscount', '$deliveryPhysicalQty'] }, '$items.quantity']
      }
    }
  },
  {
    $group: {
      _id: ymOn('$returnedAt'),
      discount: { $sum: '$returnDiscount' }
    }
  }
];

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

  /** Net casting = order line castingAtTime × delivered/returned qty (by delivery/return month). */
  const castingByMonthPipeline = (dateField, matchExtra = {}) => [
    { $match: { companyId: cid, isDeleted: nd, [dateField]: dateRange, ...matchExtra } },
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
        }
      }
    },
    {
      $group: {
        _id: ymOn(`$${dateField}`),
        casting: {
          $sum: {
            $multiply: [{ $ifNull: ['$orderItem.castingAtTime', 0] }, '$items.quantity']
          }
        }
      }
    }
  ];

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
    deliveryCastingByMonth,
    returnCastingByMonth
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
    DeliveryRecord.aggregate(deliveryDiscountByMonthPipeline(cid, dateRange, ymOn)),
    ReturnRecord.aggregate(returnDiscountByMonthPipeline(cid, dateRange, ymOn)),
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
    DeliveryRecord.aggregate(castingByMonthPipeline('deliveredAt')),
    ReturnRecord.aggregate(castingByMonthPipeline('returnedAt'))
  ]);

  const deliveryNetMap = mapByMonth(deliveryNetByMonth, 'net');
  const returnNetMap = mapByMonth(returnNetByMonth, 'returnNet');
  const deliveryCastingMap = mapByMonth(deliveryCastingByMonth, 'casting');
  const returnCastingMap = mapByMonth(returnCastingByMonth, 'casting');

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
    const castingCost = roundPKR(
      (deliveryCastingMap.get(month) || 0) - (returnCastingMap.get(month) || 0)
    );
    const expenses = roundPKR((payrollMap.get(month) || 0) + (otherExpMap.get(month) || 0));
    const marketing = marketingMap.get(month) || 0;
    return normalizeRow({
      month,
      monthLabel: monthLabel(month, tz),
      netSales,
      distribution,
      discount,
      castingCost,
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
        castingCost: roundPKR(acc.castingCost + r.castingCost),
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
        castingCost: 0,
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
        'Net Sales − Distribution − Discount − Casting (products sold) − Expenses (payroll + operating)',
      dateBasis: {
        netSales: 'DeliveryRecord.pharmacyNetPayable minus proportional return pharmacy net (return month)',
        castingCost:
          'Order line castingAtTime × delivered qty (delivery month) minus castingAtTime × returned qty (return month)',
        distribution: 'DeliveryRecord.deliveredAt minus return commission reversals (Ledger.date)',
        discount:
          'Per delivery line: (TP × paid qty × clinicDiscount%) + (TP × bonus qty); returns reduce proportionally',
        expenses: 'Payroll.paidOn (PAID) + Expense.date (category ≠ SALARY)',
        marketing: 'DoctorActivity.createdAt (investedAmount)'
      },
      notes: [
        'Marketing (doctor investment) is not included in P/L.',
        'Casting reflects company purchase price on products sold in each month, not supplier GRN receipts.',
        'Supplier purchases and payments are tracked separately in procurement and payables.'
      ]
    }
  };
};

const monthYmPattern = /^\d{4}-\d{2}$/;

const monthDateRange = (monthYm, tz) => {
  const z = businessTime.requireCompanyIanaZone(tz);
  const start = DateTime.fromFormat(monthYm, 'yyyy-MM', { zone: z }).startOf('month');
  if (!start.isValid) throw new ApiError(400, 'Invalid month — use YYYY-MM');
  const end = start.endOf('month');
  return { $gte: start.toUTC().toJSDate(), $lte: end.toUTC().toJSDate() };
};

const deliveredPacksByProductAgg = (companyId, dateRange) => [
  { $match: { companyId, isDeleted: nd, deliveredAt: dateRange } },
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
              $subtract: ['$items.quantity', { $ifNull: ['$items.bonusQuantity', 0] }]
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
];

const returnedPacksByProductAgg = (companyId, dateRange) => [
  { $match: { companyId, isDeleted: nd, returnedAt: dateRange } },
  { $unwind: '$items' },
  {
    $group: {
      _id: '$items.productId',
      returnedQty: { $sum: '$items.quantity' }
    }
  }
];

/**
 * Net pack sales by product for a calendar month (deliveries minus returns, by delivery/return month).
 */
const productPackSalesForMonth = async (companyId, query = {}, timeZone) => {
  const monthYm = qScalar(query.month);
  if (!monthYm || !monthYmPattern.test(monthYm)) {
    throw new ApiError(400, 'month is required (YYYY-MM)');
  }

  const fiscalYearStart = query.fiscalYearStart ?? query.fiscalYear;
  if (fiscalYearStart != null && fiscalYearStart !== '') {
    const bounds = fiscalYearBounds(fiscalYearStart, timeZone);
    if (!bounds.monthKeys.includes(monthYm)) {
      throw new ApiError(400, 'month must fall within the selected fiscal year');
    }
  }

  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const dateRange = monthDateRange(monthYm, tz);
  const cid = objectId(companyId);

  const [delivered, returned] = await Promise.all([
    DeliveryRecord.aggregate(deliveredPacksByProductAgg(cid, dateRange)),
    ReturnRecord.aggregate(returnedPacksByProductAgg(cid, dateRange))
  ]);

  const retMap = new Map(returned.map((r) => [String(r._id), Math.max(0, Number(r.returnedQty) || 0)]));
  const productIds = new Set([
    ...delivered.map((d) => String(d._id)),
    ...returned.map((r) => String(r._id))
  ]);

  if (!productIds.size) {
    return {
      month: monthYm,
      monthLabel: monthLabel(monthYm, tz),
      rows: [],
      totals: { netPacks: 0, paidPacks: 0, bonusPacks: 0, returnedPacks: 0 }
    };
  }

  const delMap = new Map(
    delivered.map((d) => {
      const pid = String(d._id);
      let paidQty = Math.max(0, Number(d.paidQty) || 0);
      const bonusQty = Math.max(0, Number(d.bonusQty) || 0);
      const physicalQty = Math.max(0, Number(d.physicalQty) || 0);
      if (bonusQty === 0 && paidQty === 0 && physicalQty > 0) paidQty = physicalQty;
      return [pid, { physicalQty, paidQty, bonusQty }];
    })
  );

  const products = await Product.find({
    companyId: cid,
    _id: { $in: [...productIds].map(objectId) },
    isDeleted: nd
  })
    .select('name composition')
    .lean();
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const rows = [];
  let totalNet = 0;
  let totalPaid = 0;
  let totalBonus = 0;
  let totalReturned = 0;

  for (const pid of productIds) {
    const del = delMap.get(pid) || { physicalQty: 0, paidQty: 0, bonusQty: 0 };
    const returnedPacks = retMap.get(pid) || 0;
    const netPacks = Math.max(0, del.physicalQty - returnedPacks);
    if (del.physicalQty === 0 && returnedPacks === 0) continue;

    totalNet += netPacks;
    totalPaid += del.paidQty;
    totalBonus += del.bonusQty;
    totalReturned += returnedPacks;

    const p = productById.get(pid);
    rows.push({
      productId: pid,
      productName: p?.name || 'Unknown product',
      composition: p?.composition ? String(p.composition) : '',
      deliveredPacks: del.physicalQty,
      paidPacks: del.paidQty,
      bonusPacks: del.bonusQty,
      returnedPacks,
      netPacks
    });
  }

  rows.sort((a, b) => b.netPacks - a.netPacks || String(a.productName).localeCompare(String(b.productName)));

  return {
    month: monthYm,
    monthLabel: monthLabel(monthYm, tz),
    rows,
    totals: {
      netPacks: totalNet,
      paidPacks: totalPaid,
      bonusPacks: totalBonus,
      returnedPacks: totalReturned
    }
  };
};

const sumDeliveryUnits = (items = []) => {
  let totalUnits = 0;
  let paidUnits = 0;
  let bonusUnits = 0;
  for (const item of items) {
    const physical = Number(item.quantity) || 0;
    const paid = item.paidQuantity != null ? Number(item.paidQuantity) || 0 : physical;
    const bonus =
      item.bonusQuantity != null ? Number(item.bonusQuantity) || 0 : Math.max(0, physical - paid);
    totalUnits += physical;
    paidUnits += paid;
    bonusUnits += bonus;
  }
  return { totalUnits, paidUnits, bonusUnits };
};

const lineItemUnitsAndDiscount = (order, item) => {
  const oi = order?.items?.find((i) => String(i.productId) === String(item.productId));
  const tpAtTime = Number(oi?.tpAtTime) || 0;
  const clinicPct = Number(oi?.clinicDiscount) || 0;
  const physical = Number(item.quantity) || 0;
  const paid = item.paidQuantity != null ? Number(item.paidQuantity) || 0 : physical;
  const bonus =
    item.bonusQuantity != null ? Number(item.bonusQuantity) || 0 : Math.max(0, physical - paid);
  const clinicDisc = roundPKR((tpAtTime * paid * clinicPct) / 100);
  const bonusDisc = roundPKR(tpAtTime * bonus);
  return {
    physical,
    paid,
    bonus,
    tpAtTime,
    clinicPct,
    clinicDisc,
    bonusDisc,
    totalDisc: roundPKR(clinicDisc + bonusDisc),
    tpLineTotal: roundPKR(item.tpLineTotal ?? tpAtTime * physical),
    linePharmacyNet: roundPKR(item.linePharmacyNet ?? 0)
  };
};

const sumDeliveryDiscountBreakdown = (order, deliveryItems = []) => {
  let clinicDiscount = 0;
  let bonusDiscount = 0;
  for (const item of deliveryItems) {
    const line = lineItemUnitsAndDiscount(order, item);
    clinicDiscount += line.clinicDisc;
    bonusDiscount += line.bonusDisc;
  }
  clinicDiscount = roundPKR(clinicDiscount);
  bonusDiscount = roundPKR(bonusDiscount);
  return {
    clinicDiscount,
    bonusDiscount,
    totalDiscount: roundPKR(clinicDiscount + bonusDiscount)
  };
};

/**
 * Excel workbook for a calendar month: delivery summary, product line detail, and product totals.
 */
const buildDeliveryDetailsExcelBuffer = async (companyId, query = {}, timeZone) => {
  const monthYm = qScalar(query.month);
  if (!monthYm || !monthYmPattern.test(monthYm)) {
    throw new ApiError(400, 'month is required (YYYY-MM)');
  }

  const fiscalYearStart = query.fiscalYearStart ?? query.fiscalYear;
  if (fiscalYearStart != null && fiscalYearStart !== '') {
    const bounds = fiscalYearBounds(fiscalYearStart, timeZone);
    if (!bounds.monthKeys.includes(monthYm)) {
      throw new ApiError(400, 'month must fall within the selected fiscal year');
    }
  }

  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const dateRange = monthDateRange(monthYm, tz);
  const cid = objectId(companyId);
  const ndFilter = { isDeleted: nd };

  const deliveries = await DeliveryRecord.find({
    companyId: cid,
    ...ndFilter,
    deliveredAt: dateRange
  })
    .sort({ deliveredAt: 1 })
    .lean();

  const orderIds = deliveries.map((d) => d.orderId);
  const orders = orderIds.length
    ? await Order.find({ _id: { $in: orderIds } }).lean()
    : [];
  const orderMap = Object.fromEntries(orders.map((o) => [String(o._id), o]));

  const pharmacyIds = [...new Set(orders.map((o) => String(o.pharmacyId)).filter(Boolean))];
  const pharmacies = pharmacyIds.length
    ? await Pharmacy.find({
        _id: { $in: pharmacyIds.map(objectId) }
      })
        .select('name')
        .lean()
    : [];
  const pharmacyMap = Object.fromEntries(pharmacies.map((p) => [String(p._id), p.name]));

  const productIdSet = new Set();
  for (const d of deliveries) {
    for (const item of d.items || []) {
      if (item.productId) productIdSet.add(String(item.productId));
    }
  }
  const products = productIdSet.size
    ? await Product.find({
        companyId: cid,
        _id: { $in: [...productIdSet].map(objectId) },
        isDeleted: nd
      })
        .select('name composition')
        .lean()
    : [];
  const productMap = Object.fromEntries(products.map((p) => [String(p._id), p]));

  const productLineRows = [];
  const productSummaryMap = new Map();

  for (const d of deliveries) {
    const order = orderMap[String(d.orderId)];
    const pharmacyName = pharmacyMap[String(order?.pharmacyId)] || '';
    const deliveredAt = DateTime.fromJSDate(new Date(d.deliveredAt))
      .setZone(tz)
      .toFormat('yyyy-MM-dd HH:mm');
    const invoiceNumber = d.invoiceNumber || '';

    for (const item of d.items || []) {
      const line = lineItemUnitsAndDiscount(order, item);
      const pid = String(item.productId);
      const prod = productMap[pid];
      const productName = prod?.name || 'Unknown product';
      const composition = prod?.composition ? String(prod.composition) : '';

      productLineRows.push({
        'Invoice Number': invoiceNumber,
        'Delivered At': deliveredAt,
        Pharmacy: pharmacyName,
        Product: productName,
        Composition: composition,
        'Total Units': line.physical,
        'Paid Units': line.paid,
        'Bonus Units': line.bonus,
        'TP at Time (PKR)': line.tpAtTime,
        'Clinic Discount %': line.clinicPct,
        'tpLineTotal (PKR)': line.tpLineTotal,
        'linePharmacyNet (PKR)': line.linePharmacyNet,
        'Clinic Discount (PKR)': line.clinicDisc,
        'Bonus Discount (PKR)': line.bonusDisc,
        'Total Line Discount (PKR)': line.totalDisc
      });

      const prev = productSummaryMap.get(pid) || {
        productName,
        composition,
        totalUnits: 0,
        paidUnits: 0,
        bonusUnits: 0,
        tpLineTotal: 0,
        totalDiscount: 0
      };
      prev.totalUnits += line.physical;
      prev.paidUnits += line.paid;
      prev.bonusUnits += line.bonus;
      prev.tpLineTotal = roundPKR(prev.tpLineTotal + line.tpLineTotal);
      prev.totalDiscount = roundPKR(prev.totalDiscount + line.totalDisc);
      productSummaryMap.set(pid, prev);
    }
  }

  const rows = deliveries.map((d, idx) => {
    const order = orderMap[String(d.orderId)];
    const tpSubtotal = roundPKR(d.tpSubtotal ?? 0);
    const pharmacyNet = roundPKR(d.pharmacyNetPayable ?? d.totalAmount ?? 0);
    const units = sumDeliveryUnits(d.items);
    const disc = sumDeliveryDiscountBreakdown(order, d.items);
    const totalDiscountPct = tpSubtotal > 0 ? roundPKR((disc.totalDiscount / tpSubtotal) * 100) : 0;

    return {
      '#': idx + 1,
      'Invoice Number': d.invoiceNumber || '',
      'Order ID': String(d.orderId),
      'Delivery ID': String(d._id),
      Pharmacy: pharmacyMap[String(order?.pharmacyId)] || '',
      'Delivered At': DateTime.fromJSDate(new Date(d.deliveredAt)).setZone(tz).toFormat('yyyy-MM-dd HH:mm'),
      'Line Count': (d.items || []).length,
      'Total Units': units.totalUnits,
      'Paid Units': units.paidUnits,
      'Bonus Units': units.bonusUnits,
      'tpSubtotal (PKR)': tpSubtotal,
      'pharmacyNetPayable (PKR)': pharmacyNet,
      'Clinic Discount (PKR)': disc.clinicDiscount,
      'Bonus Discount (PKR)': disc.bonusDiscount,
      'Total Discount (PKR)': disc.totalDiscount,
      'Total Discount %': totalDiscountPct,
      'Distributor Share (PKR)': roundPKR(d.distributorShareTotal ?? 0),
      'Company Share (PKR)': roundPKR(d.companyShareTotal ?? 0)
    };
  });

  const totals = {
    '#': '',
    'Invoice Number': 'TOTAL',
    'Order ID': `${rows.length} deliveries`,
    'Delivery ID': '',
    Pharmacy: '',
    'Delivered At': '',
    'Line Count': rows.reduce((s, r) => s + r['Line Count'], 0),
    'Total Units': rows.reduce((s, r) => s + r['Total Units'], 0),
    'Paid Units': rows.reduce((s, r) => s + r['Paid Units'], 0),
    'Bonus Units': rows.reduce((s, r) => s + r['Bonus Units'], 0),
    'tpSubtotal (PKR)': roundPKR(rows.reduce((s, r) => s + r['tpSubtotal (PKR)'], 0)),
    'pharmacyNetPayable (PKR)': roundPKR(rows.reduce((s, r) => s + r['pharmacyNetPayable (PKR)'], 0)),
    'Clinic Discount (PKR)': roundPKR(rows.reduce((s, r) => s + r['Clinic Discount (PKR)'], 0)),
    'Bonus Discount (PKR)': roundPKR(rows.reduce((s, r) => s + r['Bonus Discount (PKR)'], 0)),
    'Total Discount (PKR)': roundPKR(rows.reduce((s, r) => s + r['Total Discount (PKR)'], 0)),
    'Total Discount %': '',
    'Distributor Share (PKR)': roundPKR(rows.reduce((s, r) => s + r['Distributor Share (PKR)'], 0)),
    'Company Share (PKR)': roundPKR(rows.reduce((s, r) => s + r['Company Share (PKR)'], 0))
  };

  const productLineTotals = {
    'Invoice Number': 'TOTAL',
    'Delivered At': `${productLineRows.length} lines`,
    Pharmacy: '',
    Product: '',
    Composition: '',
    'Total Units': productLineRows.reduce((s, r) => s + r['Total Units'], 0),
    'Paid Units': productLineRows.reduce((s, r) => s + r['Paid Units'], 0),
    'Bonus Units': productLineRows.reduce((s, r) => s + r['Bonus Units'], 0),
    'TP at Time (PKR)': '',
    'Clinic Discount %': '',
    'tpLineTotal (PKR)': roundPKR(productLineRows.reduce((s, r) => s + r['tpLineTotal (PKR)'], 0)),
    'linePharmacyNet (PKR)': roundPKR(
      productLineRows.reduce((s, r) => s + r['linePharmacyNet (PKR)'], 0)
    ),
    'Clinic Discount (PKR)': roundPKR(
      productLineRows.reduce((s, r) => s + r['Clinic Discount (PKR)'], 0)
    ),
    'Bonus Discount (PKR)': roundPKR(
      productLineRows.reduce((s, r) => s + r['Bonus Discount (PKR)'], 0)
    ),
    'Total Line Discount (PKR)': roundPKR(
      productLineRows.reduce((s, r) => s + r['Total Line Discount (PKR)'], 0)
    )
  };

  const productSummaryRows = [...productSummaryMap.entries()]
    .map(([productId, p]) => ({ productId, ...p }))
    .sort((a, b) => a.productName.localeCompare(b.productName))
    .map((p, idx) => ({
      '#': idx + 1,
      Product: p.productName,
      Composition: p.composition,
      'Total Units': p.totalUnits,
      'Paid Units': p.paidUnits,
      'Bonus Units': p.bonusUnits,
      'tpLineTotal (PKR)': p.tpLineTotal,
      'Total Discount (PKR)': p.totalDiscount
    }));

  const productSummaryTotals = {
    '#': '',
    Product: 'TOTAL',
    Composition: `${productSummaryRows.length} products`,
    'Total Units': productSummaryRows.reduce((s, r) => s + r['Total Units'], 0),
    'Paid Units': productSummaryRows.reduce((s, r) => s + r['Paid Units'], 0),
    'Bonus Units': productSummaryRows.reduce((s, r) => s + r['Bonus Units'], 0),
    'tpLineTotal (PKR)': roundPKR(productSummaryRows.reduce((s, r) => s + r['tpLineTotal (PKR)'], 0)),
    'Total Discount (PKR)': roundPKR(
      productSummaryRows.reduce((s, r) => s + r['Total Discount (PKR)'], 0)
    )
  };

  const wb = XLSX.utils.book_new();

  const deliverySheetData = rows.length
    ? [...rows, totals]
    : [
        {
          '#': '',
          'Invoice Number': `No deliveries recorded for ${monthLabel(monthYm, tz)}`,
          'Order ID': '',
          'Delivery ID': '',
          Pharmacy: '',
          'Delivered At': '',
          'Line Count': 0,
          'Total Units': 0,
          'Paid Units': 0,
          'Bonus Units': 0,
          'tpSubtotal (PKR)': 0,
          'pharmacyNetPayable (PKR)': 0,
          'Clinic Discount (PKR)': 0,
          'Bonus Discount (PKR)': 0,
          'Total Discount (PKR)': 0,
          'Total Discount %': 0,
          'Distributor Share (PKR)': 0,
          'Company Share (PKR)': 0
        },
        totals
      ];
  const wsDeliveries = XLSX.utils.json_to_sheet(deliverySheetData);
  wsDeliveries['!cols'] = [
    { wch: 5 },
    { wch: 22 },
    { wch: 26 },
    { wch: 26 },
    { wch: 28 },
    { wch: 18 },
    { wch: 10 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 16 },
    { wch: 22 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 16 },
    { wch: 20 },
    { wch: 18 }
  ];
  XLSX.utils.book_append_sheet(wb, wsDeliveries, 'Deliveries');

  const wsProductLines = XLSX.utils.json_to_sheet(
    productLineRows.length ? [...productLineRows, productLineTotals] : [productLineTotals]
  );
  wsProductLines['!cols'] = [
    { wch: 22 },
    { wch: 18 },
    { wch: 28 },
    { wch: 32 },
    { wch: 24 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 16 },
    { wch: 16 },
    { wch: 20 },
    { wch: 18 },
    { wch: 18 },
    { wch: 20 }
  ];
  XLSX.utils.book_append_sheet(wb, wsProductLines, 'Product lines');

  const wsProductSummary = XLSX.utils.json_to_sheet(
    productSummaryRows.length ? [...productSummaryRows, productSummaryTotals] : [productSummaryTotals]
  );
  wsProductSummary['!cols'] = [
    { wch: 5 },
    { wch: 32 },
    { wch: 24 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 16 },
    { wch: 18 }
  ];
  XLSX.utils.book_append_sheet(wb, wsProductSummary, 'Product summary');

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  return {
    buffer,
    filename: `delivery-details-${monthYm}.xlsx`,
    month: monthYm,
    monthLabel: monthLabel(monthYm, tz),
    deliveryCount: rows.length
  };
};

module.exports = {
  fiscalYearBounds,
  monthlySummary,
  productPackSalesForMonth,
  buildDeliveryDetailsExcelBuffer
};
