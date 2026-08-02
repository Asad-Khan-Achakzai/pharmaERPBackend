const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const TaxRegisterEntry = require('../../models/TaxRegisterEntry');
const TaxDeposit = require('../../models/TaxDeposit');
const Account = require('../../models/Account');
const CompanyTaxConfig = require('../../models/CompanyTaxConfig');
const { roundPKR } = require('../../utils/currency');
const {
  TAX_REGISTER_ENTRY_TYPE,
  TAX_REGISTER_STATUS,
  TAX_DEPOSIT_STATUS,
  TAX_ACCOUNT_CODES,
  TAX_TYPE_CODES,
  CALCULATION_BASE,
  normalizeRegisterStatus,
  OUTSTANDING_REGISTER_STATUSES,
  getTaxTypeMeta
} = require('../../constants/taxCatalog');
const { ACCOUNT_CODES } = require('../../constants/coaTemplate');

const oid = (id) => new mongoose.Types.ObjectId(String(id));

const CALC_BASE_LABELS = {
  [CALCULATION_BASE.GROSS_AMOUNT]: 'Gross amount',
  [CALCULATION_BASE.SUBTOTAL]: 'Subtotal',
  [CALCULATION_BASE.AFTER_DISCOUNT]: 'After discount',
  [CALCULATION_BASE.NET_PAYABLE]: 'Net payable',
  [CALCULATION_BASE.BEFORE_TAX_TYPE]: 'Before another tax',
  [CALCULATION_BASE.AFTER_TAX_TYPE]: 'After another tax',
  [CALCULATION_BASE.CUSTOM]: 'Custom base'
};

const STATUS_DISPLAY = {
  OPEN: 'Open',
  INCLUDED_IN_DEPOSIT: 'Included in Deposit',
  REMITTED: 'Remitted',
  ADJUSTED: 'Adjusted',
  REVERSED: 'Reversed',
  PARTIALLY_CLEARED: 'Remitted',
  CLEARED: 'Remitted',
  VOID: 'Cancelled'
};

const ENTRY_TYPE_DISPLAY = {
  INVOICE_TAX: 'Invoice tax',
  TAX_REVERSAL: 'Tax reversal',
  REMITTANCE: 'Remittance',
  ADJUSTMENT: 'Adjustment',
  WRITEOFF_TAX: 'Write-off tax'
};

const resolveRange = (query = {}, timeZone = 'UTC') => {
  const tz = timeZone || 'UTC';
  let from = null;
  let to = null;
  if (query.from) {
    from = DateTime.fromISO(String(query.from), { zone: tz }).startOf('day').toUTC().toJSDate();
  }
  if (query.to) {
    to = DateTime.fromISO(String(query.to), { zone: tz }).endOf('day').toUTC().toJSDate();
  }
  return { from, to };
};

const currentTaxPeriodLabel = (config, timeZone = 'UTC') => {
  const now = DateTime.now().setZone(timeZone || 'UTC');
  const mode = config?.taxYear?.mode || 'CALENDAR';
  const startMonth = Number(config?.taxYear?.startMonth) || 1;
  if (config?.taxYear?.label) {
    return `${config.taxYear.label} · ${now.toFormat('LLLL yyyy')}`;
  }
  if (mode === 'CUSTOM' && startMonth !== 1) {
    const fyStart =
      now.month >= startMonth
        ? DateTime.fromObject({ year: now.year, month: startMonth, day: 1 }, { zone: timeZone })
        : DateTime.fromObject({ year: now.year - 1, month: startMonth, day: 1 }, { zone: timeZone });
    const fyEnd = fyStart.plus({ years: 1 }).minus({ days: 1 });
    return `FY ${fyStart.toFormat('MMM yyyy')} – ${fyEnd.toFormat('MMM yyyy')} · ${now.toFormat('LLLL yyyy')}`;
  }
  return now.toFormat('LLLL yyyy');
};

const displayStatus = (row) => {
  if (row.entryType === TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL) {
    if (row.status === TAX_REGISTER_STATUS.OPEN) return 'Reversed';
    return STATUS_DISPLAY[normalizeRegisterStatus(row.status)] || row.status;
  }
  if (row.entryType === TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT) {
    return STATUS_DISPLAY.ADJUSTED;
  }
  return STATUS_DISPLAY[normalizeRegisterStatus(row.status)] || row.status || '—';
};

const expandStatusFilter = (status) => {
  if (!status) return null;
  const s = String(status);
  if (s === TAX_REGISTER_STATUS.REMITTED || s === 'Remitted') {
    return [
      TAX_REGISTER_STATUS.REMITTED,
      TAX_REGISTER_STATUS.CLEARED,
      TAX_REGISTER_STATUS.PARTIALLY_CLEARED
    ];
  }
  if (s === 'Reversed' || s === TAX_REGISTER_STATUS.REVERSED) {
    return [TAX_REGISTER_STATUS.REVERSED, TAX_REGISTER_STATUS.OPEN];
  }
  return [s];
};

/** Business tax events only — remittance is settlement on TaxDeposit, not a register row. */
const TAX_EVENT_ENTRY_TYPES = [
  TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
  TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL,
  TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT,
  TAX_REGISTER_ENTRY_TYPE.WRITEOFF_TAX
];

const buildRegisterFilter = (companyId, query = {}, timeZone) => {
  const { from, to } = resolveRange(query, timeZone);
  const filter = {
    companyId: oid(companyId),
    isDeleted: { $ne: true },
    entryType: {
      // Exclude REMITTANCE by default (legacy rows may still exist in DB).
      $in: query.includeRemittanceRows === 'true' || query.includeRemittanceRows === true
        ? [...TAX_EVENT_ENTRY_TYPES, TAX_REGISTER_ENTRY_TYPE.REMITTANCE]
        : TAX_EVENT_ENTRY_TYPES
    }
  };
  if (from || to) {
    filter.businessDate = {};
    if (from) filter.businessDate.$gte = from;
    if (to) filter.businessDate.$lte = to;
  }
  if (query.taxTypeCode) filter.taxTypeCode = query.taxTypeCode;
  if (query.taxSection) filter.taxSection = String(query.taxSection);
  if (query.pharmacyId) filter.pharmacyId = oid(query.pharmacyId);
  if (query.invoiceNumber) {
    filter.invoiceNumber = new RegExp(String(query.invoiceNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  if (query.depositNumber) {
    filter.depositNumber = new RegExp(String(query.depositNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  if (query.createdBy) filter.createdBy = oid(query.createdBy);

  const statuses = expandStatusFilter(query.status);
  if (statuses) {
    if (query.status === 'Reversed' || query.status === TAX_REGISTER_STATUS.REVERSED) {
      filter.entryType = TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL;
      filter.status = { $in: [TAX_REGISTER_STATUS.OPEN, TAX_REGISTER_STATUS.REVERSED] };
    } else if (query.status === 'Adjusted' || query.status === TAX_REGISTER_STATUS.ADJUSTED) {
      filter.entryType = TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT;
    } else {
      filter.status = { $in: statuses };
    }
  }

  if (query.search) {
    const q = String(query.search).trim();
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { invoiceNumber: rx },
        { taxSection: rx },
        { depositNumber: rx },
        { taxTypeCode: rx },
        { 'meta.narration': rx }
      ];
    }
  }

  return filter;
};

const enrichRegisterRows = (rows) =>
  rows.map((r) => {
    const orderId =
      r.meta?.orderId ||
      (r.deliveryId && typeof r.deliveryId === 'object' ? r.deliveryId.orderId : null) ||
      null;
    const pharmacyId =
      r.pharmacyId && typeof r.pharmacyId === 'object' ? r.pharmacyId._id : r.pharmacyId;
    const pharmacyName =
      r.pharmacyId && typeof r.pharmacyId === 'object' ? r.pharmacyId.name : null;
    const createdByName =
      r.createdBy && typeof r.createdBy === 'object' ? r.createdBy.name || r.createdBy.email : null;
    const taxMeta = getTaxTypeMeta(r.taxTypeCode);
    const statusNormalized = normalizeRegisterStatus(r.status);
    return {
      ...r,
      orderId: orderId ? String(orderId) : null,
      pharmacyRefId: pharmacyId ? String(pharmacyId) : null,
      pharmacyName: pharmacyName || null,
      taxTypeLabel: taxMeta?.label || r.taxTypeCode,
      calculationBaseLabel: CALC_BASE_LABELS[r.calculationBase] || r.calculationBase || '—',
      statusNormalized,
      statusLabel: displayStatus(r),
      entryTypeLabel: ENTRY_TYPE_DISPLAY[r.entryType] || r.entryType,
      createdByName: createdByName || (r.createdBy ? 'User' : 'System'),
      depositId: r.taxDepositId ? String(r.taxDepositId) : null
    };
  });

const glLiability = async (companyId) => {
  const code = ACCOUNT_CODES.ADVANCE_TAX_PAYABLE || TAX_ACCOUNT_CODES.ADVANCE_TAX_PAYABLE;
  const glAccount = await Account.findOne({
    companyId: oid(companyId),
    code,
    isDeleted: { $ne: true }
  }).lean();
  return {
    accountCode: code,
    accountName: glAccount?.name || 'Advance Tax Payable',
    currentBalance: roundPKR(glAccount?.currentBalance || 0)
  };
};

const registerKpis = async (companyId, query = {}, timeZone = 'UTC') => {
  const { from, to } = resolveRange(query, timeZone);
  const baseMatch = {
    companyId: oid(companyId),
    isDeleted: { $ne: true }
  };
  const dateMatch = {};
  if (from || to) {
    dateMatch.businessDate = {};
    if (from) dateMatch.businessDate.$gte = from;
    if (to) dateMatch.businessDate.$lte = to;
  }

  const [collectedAgg, outstandingAgg, pendingCount, invoicesAgg, depositedAgg, config] =
    await Promise.all([
      TaxRegisterEntry.aggregate([
        {
          $match: {
            ...baseMatch,
            ...dateMatch,
            entryType: TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX
          }
        },
        { $group: { _id: null, total: { $sum: '$taxAmount' }, count: { $sum: 1 } } }
      ]),
      TaxRegisterEntry.aggregate([
        {
          $match: {
            ...baseMatch,
            status: { $in: OUTSTANDING_REGISTER_STATUSES },
            entryType: {
              $in: [
                TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
                TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL,
                TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT
              ]
            }
          }
        },
        { $group: { _id: null, total: { $sum: '$taxAmount' }, count: { $sum: 1 } } }
      ]),
      TaxRegisterEntry.countDocuments({
        ...baseMatch,
        status: TAX_REGISTER_STATUS.OPEN,
        entryType: {
          $in: [
            TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
            TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL,
            TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT
          ]
        }
      }),
      TaxRegisterEntry.aggregate([
        {
          $match: {
            ...baseMatch,
            ...dateMatch,
            entryType: TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
            deliveryId: { $ne: null }
          }
        },
        { $group: { _id: '$deliveryId' } },
        { $count: 'n' }
      ]),
      TaxDeposit.aggregate([
        {
          $match: {
            companyId: oid(companyId),
            isDeleted: { $ne: true },
            status: { $in: [TAX_DEPOSIT_STATUS.SUBMITTED, TAX_DEPOSIT_STATUS.CLOSED] },
            ...(from || to
              ? {
                  paymentDate: {
                    ...(from ? { $gte: from } : {}),
                    ...(to ? { $lte: to } : {})
                  }
                }
              : {})
          }
        },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      CompanyTaxConfig.findOne({ companyId: oid(companyId), isDeleted: { $ne: true } }).lean()
    ]);

  // Tax remitted = submitted TaxDeposit documents only (not register REMITTANCE rows).
  const taxDeposited = roundPKR(depositedAgg[0]?.total || 0);

  const gl = await glLiability(companyId);
  const registerBalance = roundPKR(outstandingAgg[0]?.total || 0);
  const difference = roundPKR(gl.currentBalance - registerBalance);

  return {
    totalTaxCollected: roundPKR(collectedAgg[0]?.total || 0),
    outstandingLiability: registerBalance,
    taxDeposited,
    pendingTaxEntries: pendingCount,
    invoicesWithTax: invoicesAgg[0]?.n || 0,
    currentTaxPeriod: currentTaxPeriodLabel(config, timeZone),
    reconciliation: {
      glBalance: gl.currentBalance,
      registerBalance,
      difference,
      outOfBalance: Math.abs(difference) > 0.01,
      glLiability: gl
    }
  };
};

const taxRegister = async (companyId, query = {}, timeZone) => {
  const filter = buildRegisterFilter(companyId, query, timeZone);
  const limit = Math.min(Number(query.limit) || 500, 2000);
  const skip = Math.max(0, Number(query.skip) || 0);

  const [rows, count, kpis] = await Promise.all([
    TaxRegisterEntry.find(filter)
      .sort({ businessDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('pharmacyId', 'name taxStatus')
      .populate('deliveryId', 'orderId invoiceNumber')
      .populate('createdBy', 'name email')
      .lean(),
    TaxRegisterEntry.countDocuments(filter),
    registerKpis(companyId, query, timeZone)
  ]);

  const enriched = enrichRegisterRows(rows);
  const totals = enriched.reduce(
    (acc, r) => {
      acc.taxAmount = roundPKR(acc.taxAmount + (r.taxAmount || 0));
      acc.taxableAmount = roundPKR(acc.taxableAmount + (r.taxableAmount || 0));
      return acc;
    },
    { taxAmount: 0, taxableAmount: 0 }
  );

  return {
    rows: enriched,
    totals,
    count,
    kpis,
    statusOptions: Object.entries(STATUS_DISPLAY)
      .filter(([k]) => !['PARTIALLY_CLEARED', 'CLEARED'].includes(k))
      .map(([value, label]) => ({ value, label })),
    taxTypeOptions: Object.values(TAX_TYPE_CODES).map((t) => ({ code: t.code, label: t.label }))
  };
};

const monthlySummary = async (companyId, query = {}, timeZone) => {
  const { from, to } = resolveRange(query, timeZone);
  const match = {
    companyId: oid(companyId),
    isDeleted: { $ne: true },
    entryType: {
      $in: [TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX, TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL]
    }
  };
  if (from || to) {
    match.businessDate = {};
    if (from) match.businessDate.$gte = from;
    if (to) match.businessDate.$lte = to;
  }

  const groups = await TaxRegisterEntry.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          taxTypeCode: '$taxTypeCode',
          year: { $year: '$businessDate' },
          month: { $month: '$businessDate' }
        },
        taxAmount: { $sum: '$taxAmount' },
        taxableAmount: { $sum: '$taxableAmount' },
        entryCount: { $sum: 1 }
      }
    },
    { $sort: { '_id.year': 1, '_id.month': 1, '_id.taxTypeCode': 1 } }
  ]);

  const rows = groups.map((g) => ({
    taxTypeCode: g._id.taxTypeCode,
    taxTypeLabel: getTaxTypeMeta(g._id.taxTypeCode)?.label || g._id.taxTypeCode,
    year: g._id.year,
    month: g._id.month,
    periodKey: `${g._id.year}-${String(g._id.month).padStart(2, '0')}`,
    taxAmount: roundPKR(g.taxAmount),
    taxableAmount: roundPKR(g.taxableAmount),
    entryCount: g.entryCount
  }));

  return { rows };
};

const liability = async (companyId) => {
  const openRegister = await TaxRegisterEntry.aggregate([
    {
      $match: {
        companyId: oid(companyId),
        isDeleted: { $ne: true },
        status: { $in: OUTSTANDING_REGISTER_STATUSES },
        entryType: {
          $in: [
            TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
            TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL,
            TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT
          ]
        }
      }
    },
    {
      $group: {
        _id: '$taxTypeCode',
        openTaxAmount: { $sum: '$taxAmount' }
      }
    }
  ]);

  const gl = await glLiability(companyId);
  const registerOpenTotal = roundPKR(openRegister.reduce((s, r) => s + (r.openTaxAmount || 0), 0));
  const difference = roundPKR(gl.currentBalance - registerOpenTotal);

  return {
    registerOpenByType: openRegister.map((r) => ({
      taxTypeCode: r._id,
      taxTypeLabel: getTaxTypeMeta(r._id)?.label || r._id,
      openTaxAmount: roundPKR(r.openTaxAmount)
    })),
    registerOpenTotal,
    glLiability: gl,
    difference,
    outOfBalance: Math.abs(difference) > 0.01
  };
};

const collectionSummary = async (companyId, query = {}, timeZone) => {
  const kpis = await registerKpis(companyId, query, timeZone);
  return {
    collected: kpis.totalTaxCollected,
    remitted: kpis.taxDeposited,
    outstanding: kpis.outstandingLiability,
    pendingEntries: kpis.pendingTaxEntries,
    invoicesWithTax: kpis.invoicesWithTax,
    currentTaxPeriod: kpis.currentTaxPeriod,
    reconciliation: kpis.reconciliation
  };
};

const byPharmacy = async (companyId, query = {}, timeZone) => {
  const { from, to } = resolveRange(query, timeZone);
  const match = {
    companyId: oid(companyId),
    isDeleted: { $ne: true },
    entryType: {
      $in: [TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX, TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL]
    },
    pharmacyId: { $ne: null }
  };
  if (from || to) {
    match.businessDate = {};
    if (from) match.businessDate.$gte = from;
    if (to) match.businessDate.$lte = to;
  }

  const groups = await TaxRegisterEntry.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$pharmacyId',
        taxAmount: { $sum: '$taxAmount' },
        taxableAmount: { $sum: '$taxableAmount' },
        entryCount: { $sum: 1 }
      }
    },
    { $sort: { taxAmount: -1 } },
    {
      $lookup: {
        from: 'pharmacies',
        localField: '_id',
        foreignField: '_id',
        as: 'pharmacy'
      }
    },
    { $unwind: { path: '$pharmacy', preserveNullAndEmptyArrays: true } }
  ]);

  return {
    rows: groups.map((g) => ({
      pharmacyId: g._id ? String(g._id) : null,
      pharmacyName: g.pharmacy?.name || '—',
      taxAmount: roundPKR(g.taxAmount),
      taxableAmount: roundPKR(g.taxableAmount),
      entryCount: g.entryCount
    }))
  };
};

const byTaxType = async (companyId, query = {}, timeZone) => {
  const { from, to } = resolveRange(query, timeZone);
  const match = {
    companyId: oid(companyId),
    isDeleted: { $ne: true },
    entryType: {
      $in: [TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX, TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL]
    }
  };
  if (from || to) {
    match.businessDate = {};
    if (from) match.businessDate.$gte = from;
    if (to) match.businessDate.$lte = to;
  }

  const groups = await TaxRegisterEntry.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$taxTypeCode',
        taxAmount: { $sum: '$taxAmount' },
        taxableAmount: { $sum: '$taxableAmount' },
        entryCount: { $sum: 1 }
      }
    },
    { $sort: { taxAmount: -1 } }
  ]);

  return {
    rows: groups.map((g) => ({
      taxTypeCode: g._id,
      taxTypeLabel: getTaxTypeMeta(g._id)?.label || g._id,
      taxAmount: roundPKR(g.taxAmount),
      taxableAmount: roundPKR(g.taxableAmount),
      entryCount: g.entryCount
    }))
  };
};

const outstandingLiabilityDetail = async (companyId) => {
  const rows = await TaxRegisterEntry.find({
    companyId: oid(companyId),
    isDeleted: { $ne: true },
    status: { $in: OUTSTANDING_REGISTER_STATUSES },
    entryType: {
      $in: [
        TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
        TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL,
        TAX_REGISTER_ENTRY_TYPE.ADJUSTMENT
      ]
    }
  })
    .sort({ businessDate: 1 })
    .populate('pharmacyId', 'name')
    .lean();

  return { rows: enrichRegisterRows(rows), ...(await liability(companyId)) };
};

const governmentFiling = async (companyId, query = {}, timeZone) => {
  const { from, to } = resolveRange(query, timeZone);
  const depositMatch = {
    companyId: oid(companyId),
    isDeleted: { $ne: true },
    status: { $in: [TAX_DEPOSIT_STATUS.SUBMITTED, TAX_DEPOSIT_STATUS.CLOSED] }
  };
  if (from || to) {
    depositMatch.paymentDate = {};
    if (from) depositMatch.paymentDate.$gte = from;
    if (to) depositMatch.paymentDate.$lte = to;
  }

  const [deposits, collected, byType] = await Promise.all([
    TaxDeposit.find(depositMatch).sort({ paymentDate: 1 }).lean(),
    collectionSummary(companyId, query, timeZone),
    byTaxType(companyId, query, timeZone)
  ]);

  return {
    period: { from: query.from || null, to: query.to || null },
    summary: collected,
    byTaxType: byType.rows,
    deposits: deposits.map((d) => ({
      depositNumber: d.depositNumber,
      governmentAuthority: d.governmentAuthority,
      paymentDate: d.paymentDate,
      paymentReference: d.paymentReference,
      bankReference: d.bankReference,
      amount: roundPKR(d.amount),
      status: d.status
    }))
  };
};

const depositHistory = async (companyId, query = {}, timeZone) => {
  const { from, to } = resolveRange(query, timeZone);
  const filter = { companyId: oid(companyId), isDeleted: { $ne: true } };
  if (query.status) filter.status = query.status;
  if (from || to) {
    filter.paymentDate = {};
    if (from) filter.paymentDate.$gte = from;
    if (to) filter.paymentDate.$lte = to;
  }
  const rows = await TaxDeposit.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(query.limit) || 200, 1000))
    .populate('createdBy', 'name')
    .populate('submittedBy', 'name')
    .populate('moneyAccountId', 'name code')
    .lean();

  const totals = {
    amount: roundPKR(rows.reduce((s, r) => s + (r.amount || 0), 0)),
    count: rows.length
  };
  return { rows, totals };
};

const reconciliationReport = async (companyId, query = {}, timeZone) => {
  const kpis = await registerKpis(companyId, query, timeZone);
  const liab = await liability(companyId);
  return {
    glBalance: kpis.reconciliation.glBalance,
    registerBalance: kpis.reconciliation.registerBalance,
    difference: kpis.reconciliation.difference,
    outOfBalance: kpis.reconciliation.outOfBalance,
    glLiability: kpis.reconciliation.glLiability,
    registerOpenByType: liab.registerOpenByType,
    asOf: new Date().toISOString()
  };
};

const chartSeries = async (companyId, query = {}, timeZone) => {
  const monthly = await monthlySummary(companyId, query, timeZone);
  const types = await byTaxType(companyId, query, timeZone);

  // Outstanding liability trend: approximate by month-end open is expensive;
  // use monthly collected as proxy series + current outstanding point.
  const liab = await liability(companyId);
  const byMonth = {};
  for (const r of monthly.rows) {
    if (!byMonth[r.periodKey]) byMonth[r.periodKey] = 0;
    byMonth[r.periodKey] = roundPKR(byMonth[r.periodKey] + r.taxAmount);
  }
  const monthlyCollection = Object.keys(byMonth)
    .sort()
    .map((periodKey) => ({ periodKey, taxAmount: byMonth[periodKey] }));

  return {
    monthlyCollection,
    taxByType: types.rows,
    outstandingLiabilityTrend: monthlyCollection.map((m, idx) => ({
      periodKey: m.periodKey,
      // cumulative net for visual trend (not true open liability history)
      outstandingEstimate: roundPKR(
        monthlyCollection.slice(0, idx + 1).reduce((s, x) => s + x.taxAmount, 0)
      )
    })),
    currentOutstanding: liab.registerOpenTotal
  };
};

const registerExportColumns = () => [
  { key: 'businessDate', header: 'Date', value: (r) => (r.businessDate ? String(r.businessDate).slice(0, 10) : '') },
  { key: 'invoiceNumber', header: 'Invoice' },
  { key: 'pharmacyName', header: 'Pharmacy', value: (r) => r.pharmacyName || '' },
  { key: 'taxTypeLabel', header: 'Tax Type' },
  { key: 'taxSection', header: 'Tax Section' },
  { key: 'ratePercent', header: 'Tax Rate', value: (r) => (r.ratePercent != null ? `${r.ratePercent}%` : '') },
  { key: 'calculationBaseLabel', header: 'Calculation Base' },
  { key: 'taxableAmount', header: 'Taxable Amount' },
  { key: 'taxAmount', header: 'Tax Amount' },
  { key: 'statusLabel', header: 'Status' },
  { key: 'depositNumber', header: 'Deposit Reference' },
  { key: 'createdByName', header: 'Created By' },
  { key: 'entryTypeLabel', header: 'Entry Type' }
];

module.exports = {
  taxRegister,
  monthlySummary,
  liability,
  registerKpis,
  collectionSummary,
  byPharmacy,
  byTaxType,
  outstandingLiabilityDetail,
  governmentFiling,
  depositHistory,
  reconciliationReport,
  chartSeries,
  registerExportColumns,
  enrichRegisterRows,
  buildRegisterFilter,
  STATUS_DISPLAY,
  CALC_BASE_LABELS
};
