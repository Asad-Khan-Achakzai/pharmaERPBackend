const crypto = require('crypto');
const mongoose = require('mongoose');
const Supplier = require('../models/Supplier');
const SupplierLedger = require('../models/SupplierLedger');
const Company = require('../models/Company');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { parsePagination } = require('../utils/pagination');
const {
  SUPPLIER_LEDGER_TYPE,
  SUPPLIER_LEDGER_REFERENCE_TYPE,
  SUPPLIER_PAYMENT_VERIFICATION
} = require('../constants/enums');
const auditService = require('./audit.service');
const logger = require('../utils/logger');
const { generateSupplierPaymentPdf } = require('../utils/supplierPaymentPdf');

/** Optional warning when recording very large payments (does not block save) */
const PAYMENT_WARN_THRESHOLD = Number(process.env.SUPPLIER_PAYMENT_WARN_PKR) || 10_000_000;

const oid = (id) => new mongoose.Types.ObjectId(id);

const list = async (companyId, query = {}) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId, isDeleted: { $ne: true } };
  if (query.isActive === 'true' || query.isActive === 'false') filter.isActive = query.isActive === 'true';
  const [docs, total] = await Promise.all([
    Supplier.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Supplier.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getById = async (companyId, id) => {
  const s = await Supplier.findOne({ _id: id, companyId, isDeleted: { $ne: true } }).lean();
  if (!s) throw new ApiError(404, 'Supplier not found');
  return s;
};

const create = async (companyId, data, reqUser) => {
  const row = await Supplier.create({
    companyId,
    name: data.name,
    phone: data.phone,
    email: data.email,
    address: data.address,
    openingBalance: roundPKR(data.openingBalance || 0),
    notes: data.notes,
    isActive: data.isActive !== false,
    createdBy: reqUser.userId
  });
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'supplier.create',
    entityType: 'Supplier',
    entityId: row._id,
    changes: { after: row.toObject() }
  });
  return row;
};

const update = async (companyId, id, data, reqUser) => {
  const s = await Supplier.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!s) throw new ApiError(404, 'Supplier not found');
  const before = s.toObject();
  if (data.name !== undefined) s.name = data.name;
  if (data.phone !== undefined) s.phone = data.phone;
  if (data.email !== undefined) s.email = data.email;
  if (data.address !== undefined) s.address = data.address;
  if (data.openingBalance !== undefined) s.openingBalance = roundPKR(data.openingBalance);
  if (data.notes !== undefined) s.notes = data.notes;
  if (data.isActive !== undefined) s.isActive = data.isActive;
  s.updatedBy = reqUser.userId;
  await s.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'supplier.update',
    entityType: 'Supplier',
    entityId: s._id,
    changes: { before, after: s.toObject() }
  });
  return s;
};

const remove = async (companyId, id, reqUser) => {
  const s = await Supplier.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!s) throw new ApiError(404, 'Supplier not found');
  const before = s.toObject();
  await s.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'supplier.delete',
    entityType: 'Supplier',
    entityId: s._id,
    changes: { before }
  });
};

/**
 * Auto PURCHASE from company→distributor stock transfer (casting × qty only).
 * Idempotent: skips if ledger row already exists for this transfer.
 */
const recordPurchaseFromStockTransfer = async (
  { session, companyId, supplierId, stockTransferId, items, productMap, reqUser }
) => {
  if (!supplierId) return null;

  const sid = oid(supplierId);
  const sup = await Supplier.findOne({ _id: sid, companyId, isDeleted: { $ne: true } })
    .session(session || null)
    .lean();
  if (!sup) throw new ApiError(404, 'Supplier not found');

  const existing = await SupplierLedger.findOne({
    companyId: oid(companyId),
    referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.STOCK_TRANSFER,
    referenceId: stockTransferId,
    type: SUPPLIER_LEDGER_TYPE.PURCHASE
  }).session(session || null);

  if (existing) return existing;

  let purchaseAmount = 0;
  for (const item of items) {
    const pid = item.productId?._id?.toString?.() || item.productId?.toString?.() || String(item.productId);
    const p = productMap[pid];
    if (!p) continue;
    purchaseAmount += roundPKR((p.casting || 0) * item.quantity);
  }
  purchaseAmount = roundPKR(purchaseAmount);
  if (purchaseAmount <= 0) return null;

  const [row] = await SupplierLedger.create(
    [
      {
        companyId: oid(companyId),
        supplierId: sid,
        type: SUPPLIER_LEDGER_TYPE.PURCHASE,
        amount: purchaseAmount,
        referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.STOCK_TRANSFER,
        referenceId: stockTransferId,
        date: new Date(),
        notes: 'Stock transfer from company (casting × qty)',
        createdBy: reqUser.userId
      }
    ],
    session ? { session } : {}
  );
  return row;
};

const recordManualPurchase = async (companyId, supplierId, { amount, date, notes }, reqUser) => {
  await getById(companyId, supplierId);
  const a = roundPKR(amount);
  if (a <= 0) throw new ApiError(400, 'Amount must be positive');
  return SupplierLedger.create({
    companyId: oid(companyId),
    supplierId: oid(supplierId),
    type: SUPPLIER_LEDGER_TYPE.PURCHASE,
    amount: a,
    referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.MANUAL,
    date: date ? new Date(date) : new Date(),
    notes: notes || 'Manual purchase / adjustment',
    createdBy: reqUser.userId
  });
};

const recordPayment = async (companyId, supplierId, body, reqUser) => {
  await getById(companyId, supplierId);
  const a = roundPKR(body.amount);
  if (a <= 0) throw new ApiError(400, 'Amount must be positive');
  if (!body.paymentMethod) throw new ApiError(400, 'paymentMethod is required');

  const voucherNumber = `SPAY-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const row = await SupplierLedger.create({
    companyId: oid(companyId),
    supplierId: oid(supplierId),
    type: SUPPLIER_LEDGER_TYPE.PAYMENT,
    amount: a,
    referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.MANUAL,
    date: body.date ? new Date(body.date) : new Date(),
    notes:
      body.notes != null && String(body.notes).trim() !== '' ? String(body.notes).trim() : 'Payment to supplier',
    createdBy: reqUser.userId,
    paymentMethod: body.paymentMethod,
    referenceNumber: body.referenceNumber || undefined,
    attachmentUrl: body.attachmentUrl || undefined,
    verificationStatus: body.verificationStatus || SUPPLIER_PAYMENT_VERIFICATION.UNVERIFIED,
    voucherNumber
  });

  const warnings = [];
  if (a >= PAYMENT_WARN_THRESHOLD) {
    warnings.push(
      `Recorded amount ${a.toLocaleString('en-PK')} PKR meets or exceeds the warning threshold (${PAYMENT_WARN_THRESHOLD.toLocaleString('en-PK')} PKR). Please verify.`
    );
  }

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'supplier.payment.record',
    entityType: 'SupplierLedger',
    entityId: row._id,
    changes: { after: row.toObject() }
  });

  logger.info({
    msg: 'supplier.payment.create',
    companyId: String(companyId),
    supplierId: String(supplierId),
    ledgerId: String(row._id),
    amount: a,
    paymentMethod: body.paymentMethod
  });

  const plain = row.toObject();
  if (warnings.length) plain.warnings = warnings;
  return plain;
};

/**
 * Full supplier ledger with running balance (chronological by date).
 * Balance rule: openingBalance + sum(PURCHASE) − sum(PAYMENT) up to each row.
 */
const listLedger = async (companyId, supplierId, query = {}) => {
  const s = await Supplier.findOne({ _id: supplierId, companyId, isDeleted: { $ne: true } }).lean();
  if (!s) throw new ApiError(404, 'Supplier not found');

  const openingBalance = roundPKR(s.openingBalance || 0);
  const { page, limit, skip } = parsePagination(query);

  const filter = { companyId: oid(companyId), supplierId: oid(supplierId), isDeleted: { $ne: true } };
  const allRaw = await SupplierLedger.find(filter).sort({ date: 1, _id: 1 }).lean();

  let balance = openingBalance;
  const entries = allRaw.map((row) => {
    if (row.type === SUPPLIER_LEDGER_TYPE.PURCHASE) balance = roundPKR(balance + row.amount);
    else if (row.type === SUPPLIER_LEDGER_TYPE.PAYMENT) balance = roundPKR(balance - row.amount);
    return {
      ...row,
      referenceType: row.referenceType,
      referenceId: row.referenceId ?? null,
      runningBalance: balance
    };
  });

  const total = entries.length;
  const docs = entries.slice(skip, skip + limit);

  const pur = allRaw.filter((r) => r.type === SUPPLIER_LEDGER_TYPE.PURCHASE).reduce((sum, r) => sum + r.amount, 0);
  const pay = allRaw.filter((r) => r.type === SUPPLIER_LEDGER_TYPE.PAYMENT).reduce((sum, r) => sum + r.amount, 0);

  return {
    openingBalance,
    docs,
    total,
    page,
    limit,
    summary: {
      totalPurchase: roundPKR(pur),
      totalPayment: roundPKR(pay),
      closingBalance: roundPKR(openingBalance + pur - pay)
    }
  };
};

/** Per-supplier balance: openingBalance + PURCHASE − PAYMENT */
const balanceForSupplier = async (companyId, supplierId) => {
  const s = await Supplier.findOne({ _id: supplierId, companyId, isDeleted: { $ne: true } }).lean();
  if (!s) throw new ApiError(404, 'Supplier not found');

  const agg = await SupplierLedger.aggregate([
    { $match: { companyId: oid(companyId), supplierId: oid(supplierId), isDeleted: { $ne: true } } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } }
  ]);
  const pur = agg.find((x) => x._id === SUPPLIER_LEDGER_TYPE.PURCHASE)?.total || 0;
  const pay = agg.find((x) => x._id === SUPPLIER_LEDGER_TYPE.PAYMENT)?.total || 0;
  const opening = roundPKR(s.openingBalance || 0);
  const payable = roundPKR(opening + pur - pay);

  const lastPay = await SupplierLedger.findOne({
    companyId: oid(companyId),
    supplierId: oid(supplierId),
    type: SUPPLIER_LEDGER_TYPE.PAYMENT,
    isDeleted: { $ne: true }
  })
    .sort({ date: -1, _id: -1 })
    .select('amount date')
    .lean();

  return {
    supplierId: s._id,
    name: s.name,
    openingBalance: opening,
    totalPurchase: roundPKR(pur),
    totalPayment: roundPKR(pay),
    payable,
    totalPurchaseCasting: roundPKR(pur),
    totalPayments: roundPKR(pay),
    netPayable: payable,
    lastPaymentDate: lastPay?.date || null,
    lastPaymentAmount: lastPay ? roundPKR(lastPay.amount) : null,
    note: 'Payable excludes shipping cost (PURCHASE reflects casting-only liability from transfers).'
  };
};

const listPayments = async (companyId, supplierId) => {
  await getById(companyId, supplierId);
  const filter = {
    companyId: oid(companyId),
    supplierId: oid(supplierId),
    type: SUPPLIER_LEDGER_TYPE.PAYMENT,
    isDeleted: { $ne: true }
  };
  const docs = await SupplierLedger.find(filter)
    .sort({ date: -1, _id: -1 })
    .populate('createdBy', 'name email')
    .lean();
  const totalPaid = roundPKR(docs.reduce((sum, d) => sum + d.amount, 0));
  return { docs, totalPaid, total: docs.length };
};

const recentPayments = async (companyId, query = {}) => {
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 8));
  const docs = await SupplierLedger.find({
    companyId: oid(companyId),
    type: SUPPLIER_LEDGER_TYPE.PAYMENT,
    isDeleted: { $ne: true }
  })
    .sort({ date: -1, _id: -1 })
    .limit(limit)
    .populate('supplierId', 'name')
    .lean();
  return { docs };
};

const loadPaymentDoc = async (companyId, supplierId, ledgerId) => {
  if (!mongoose.Types.ObjectId.isValid(ledgerId)) throw new ApiError(400, 'Invalid payment id');
  await getById(companyId, supplierId);
  const row = await SupplierLedger.findOne({
    _id: ledgerId,
    companyId: oid(companyId),
    supplierId: oid(supplierId),
    type: SUPPLIER_LEDGER_TYPE.PAYMENT
  });
  if (!row) throw new ApiError(404, 'Payment not found');
  return row;
};

const updatePayment = async (companyId, supplierId, ledgerId, body, reqUser) => {
  const row = await loadPaymentDoc(companyId, supplierId, ledgerId);
  const before = row.toObject();

  if (body.amount !== undefined) {
    const a = roundPKR(body.amount);
    if (a <= 0) throw new ApiError(400, 'Amount must be positive');
    row.amount = a;
  }
  if (body.date !== undefined) row.date = new Date(body.date);
  if (body.notes !== undefined) {
    row.notes =
      body.notes != null && String(body.notes).trim() !== '' ? String(body.notes).trim() : 'Payment to supplier';
  }
  if (body.paymentMethod !== undefined) row.paymentMethod = body.paymentMethod;
  if (body.referenceNumber !== undefined) row.referenceNumber = body.referenceNumber || undefined;
  if (body.attachmentUrl !== undefined) row.attachmentUrl = body.attachmentUrl || undefined;
  if (body.verificationStatus !== undefined) row.verificationStatus = body.verificationStatus;

  row.updatedBy = reqUser.userId;
  await row.save();

  const warnings = [];
  if (row.amount >= PAYMENT_WARN_THRESHOLD) {
    warnings.push(
      `Amount ${row.amount.toLocaleString('en-PK')} PKR meets or exceeds the warning threshold (${PAYMENT_WARN_THRESHOLD.toLocaleString('en-PK')} PKR). Please verify.`
    );
  }

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'supplier.payment.update',
    entityType: 'SupplierLedger',
    entityId: row._id,
    changes: { before, after: row.toObject() }
  });

  logger.info({
    msg: 'supplier.payment.update',
    companyId: String(companyId),
    supplierId: String(supplierId),
    ledgerId: String(ledgerId),
    amount: row.amount
  });

  const plain = row.toObject();
  if (warnings.length) plain.warnings = warnings;
  return plain;
};

/**
 * Soft-delete the PAYMENT row so it no longer affects payables (same as reversing the payment).
 */
const reversePayment = async (companyId, supplierId, ledgerId, body, reqUser) => {
  const row = await loadPaymentDoc(companyId, supplierId, ledgerId);
  const before = row.toObject();
  await row.softDelete(reqUser.userId);

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'supplier.payment.reverse',
    entityType: 'SupplierLedger',
    entityId: row._id,
    changes: {
      before,
      meta: { reversalReason: body?.reversalReason || null, softDeleted: true }
    }
  });

  logger.info({
    msg: 'supplier.payment.reverse',
    companyId: String(companyId),
    supplierId: String(supplierId),
    ledgerId: String(ledgerId),
    userId: String(reqUser.userId)
  });

  return { reversed: true, ledgerId: row._id };
};

const streamPaymentInvoice = async (companyId, ledgerId, reqUser, res) => {
  if (!mongoose.Types.ObjectId.isValid(ledgerId)) throw new ApiError(400, 'Invalid payment id');
  const row = await SupplierLedger.findOne({
    _id: ledgerId,
    companyId: oid(companyId),
    type: SUPPLIER_LEDGER_TYPE.PAYMENT,
    isDeleted: { $ne: true }
  }).lean();
  if (!row) throw new ApiError(404, 'Payment not found');

  const [company, supplier] = await Promise.all([
    Company.findById(companyId).select('name address city phone email').lean(),
    Supplier.findOne({ _id: row.supplierId, companyId: oid(companyId), isDeleted: { $ne: true } }).lean()
  ]);

  const dateStr = row.date ? new Date(row.date).toISOString().slice(0, 10) : 'nodate';
  const safeName = (supplier?.name || 'supplier').replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 40);
  const filename = `Supplier_Payment_${dateStr}_${safeName}.pdf`;

  logger.info({
    msg: 'supplier.payment.invoice_pdf',
    companyId: String(companyId),
    ledgerId: String(ledgerId),
    userId: String(reqUser.userId)
  });

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'supplier.payment.invoice_pdf',
    entityType: 'SupplierLedger',
    entityId: row._id,
    changes: { meta: { filename } }
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  generateSupplierPaymentPdf({
    stream: res,
    company,
    supplier,
    ledger: row
  });
};

/** Company-wide supplier payables + rows */
const supplierBalances = async (companyId) => {
  const cid = oid(companyId);
  const suppliers = await Supplier.find({ companyId: cid, isDeleted: { $ne: true } })
    .select('name openingBalance isActive')
    .lean();

  const ledgerAgg = await SupplierLedger.aggregate([
    { $match: { companyId: cid, isDeleted: { $ne: true } } },
    {
      $group: {
        _id: '$supplierId',
        totalPurchase: {
          $sum: { $cond: [{ $eq: ['$type', SUPPLIER_LEDGER_TYPE.PURCHASE] }, '$amount', 0] }
        },
        totalPayment: {
          $sum: { $cond: [{ $eq: ['$type', SUPPLIER_LEDGER_TYPE.PAYMENT] }, '$amount', 0] }
        }
      }
    }
  ]);

  const bySupplier = new Map();
  for (const s of suppliers) {
    bySupplier.set(s._id.toString(), {
      supplierId: s._id,
      name: s.name,
      openingBalance: roundPKR(s.openingBalance || 0),
      totalPurchase: 0,
      totalPayment: 0,
      isActive: s.isActive
    });
  }

  for (const row of ledgerAgg) {
    const id = row._id.toString();
    const entry = bySupplier.get(id);
    if (!entry) continue;
    entry.totalPurchase = roundPKR(row.totalPurchase);
    entry.totalPayment = roundPKR(row.totalPayment);
  }

  const rows = Array.from(bySupplier.values()).map((r) => ({
    ...r,
    payable: roundPKR(r.openingBalance + r.totalPurchase - r.totalPayment)
  }));
  rows.sort((a, b) => b.payable - a.payable);

  const totalSupplierPayable = roundPKR(rows.reduce((s, r) => s + Math.max(0, r.payable), 0));
  /** Net if advances (negative payable) matter */
  const totalNetPayable = roundPKR(rows.reduce((s, r) => s + r.payable, 0));

  return {
    rows,
    totals: {
      totalSupplierPayable,
      totalNetPayable,
      help: 'Payable = openingBalance + PURCHASE − PAYMENT. Liability only; does not change delivery profit or expense module.'
    }
  };
};

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
  recordPurchaseFromStockTransfer,
  recordManualPurchase,
  recordPayment,
  listLedger,
  balanceForSupplier,
  supplierBalances,
  listPayments,
  recentPayments,
  streamPaymentInvoice,
  updatePayment,
  reversePayment
};
