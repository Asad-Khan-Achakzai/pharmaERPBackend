/**
 * Thin Credit Note registry — customer financial document linked to OrderAmendment.
 * Does not post accounting; reads commercial content from the amendment.
 */
const path = require('path');
const fs = require('fs');
const CreditNote = require('../models/CreditNote');
const Order = require('../models/Order');
const OrderAmendment = require('../models/OrderAmendment');
const ApiError = require('../utils/ApiError');
const { getNextSequenceNumber } = require('../utils/orderNumber');
const { utcNow } = require('../utils/businessTime');
const { CREDIT_NOTE_STATUS } = require('../constants/enums');
const { assertOrderVisibleToUser } = require('../utils/orderScope.util');
const pdfService = require('./pdf.service');
const logger = require('../utils/logger');

/**
 * Create CreditNote row inside an existing amend transaction (1:1 with amendment).
 */
const createForAmendmentInSession = async (session, ctx) => {
  const {
    companyId,
    orderId,
    amendment,
    reqUser,
    issuedAt = utcNow()
  } = ctx;

  const creditNoteNumber = await getNextSequenceNumber(companyId, 'CN', { session });
  const [creditNote] = await CreditNote.create(
    [
      {
        companyId,
        orderId,
        amendmentId: amendment._id,
        creditNoteNumber,
        status: CREDIT_NOTE_STATUS.ISSUED,
        orderNumber: amendment.orderNumber,
        amendmentNumber: amendment.amendmentNumber,
        pharmacyId: amendment.pharmacyId,
        invoiceNumbers: amendment.invoiceNumbers || [],
        totalAmount: amendment.totalAmount,
        issuedBy: reqUser.userId,
        issuedAt
      }
    ],
    { session, ordered: true }
  );
  return creditNote;
};

/**
 * Lazy-issue CN for historical amendments that predate CreditNote.
 */
const ensureIssuedForAmendment = async (companyId, orderId, amendment, reqUser) => {
  let cn = await CreditNote.findOne({
    companyId,
    amendmentId: amendment._id,
    isDeleted: { $ne: true }
  });
  if (cn) return cn;

  const creditNoteNumber = await getNextSequenceNumber(companyId, 'CN');
  try {
    cn = await CreditNote.create({
      companyId,
      orderId,
      amendmentId: amendment._id,
      creditNoteNumber,
      status: CREDIT_NOTE_STATUS.ISSUED,
      orderNumber: amendment.orderNumber,
      amendmentNumber: amendment.amendmentNumber,
      pharmacyId: amendment.pharmacyId,
      invoiceNumbers: amendment.invoiceNumbers || [],
      totalAmount: amendment.totalAmount,
      issuedBy: reqUser?.userId || amendment.amendedBy,
      issuedAt: amendment.amendedAt || utcNow()
    });
  } catch (err) {
    // Race: another request created it
    if (err?.code === 11000) {
      cn = await CreditNote.findOne({
        companyId,
        amendmentId: amendment._id,
        isDeleted: { $ne: true }
      });
      if (cn) return cn;
    }
    throw err;
  }
  return cn;
};

const listByOrder = async (companyId, orderId, opts = {}) => {
  const order = await Order.findOne({ _id: orderId, companyId }).select('_id medicalRepId').lean();
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);

  return CreditNote.find({ companyId, orderId, isDeleted: { $ne: true } })
    .populate('issuedBy', 'name email')
    .populate('amendmentId', 'amendmentNumber version reason amendedAt')
    .sort({ issuedAt: 1 })
    .lean();
};

const getById = async (companyId, orderId, creditNoteId, opts = {}) => {
  const order = await Order.findOne({ _id: orderId, companyId }).select('_id medicalRepId').lean();
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);

  const cn = await CreditNote.findOne({
    _id: creditNoteId,
    companyId,
    orderId,
    isDeleted: { $ne: true }
  })
    .populate('issuedBy', 'name email')
    .lean();
  if (!cn) throw new ApiError(404, 'Credit note not found');

  const amendment = await OrderAmendment.findOne({
    _id: cn.amendmentId,
    companyId,
    isDeleted: { $ne: true }
  })
    .populate('amendedBy', 'name email')
    .lean();

  return { ...cn, amendment };
};

const mapCreditNotesByAmendmentId = async (companyId, orderId) => {
  const rows = await CreditNote.find({
    companyId,
    orderId,
    isDeleted: { $ne: true }
  })
    .select('amendmentId creditNoteNumber pdfUrl status issuedAt totalAmount invoiceNumbers')
    .lean();
  const map = {};
  for (const r of rows) {
    map[String(r.amendmentId)] = r;
  }
  return map;
};

const ensureCreditNotePdfPath = async (companyId, orderId, creditNoteId, reqUser, opts = {}) => {
  const order = await Order.findOne({ _id: orderId, companyId }).select('_id medicalRepId').lean();
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);

  let cn = await CreditNote.findOne({
    _id: creditNoteId,
    companyId,
    orderId,
    isDeleted: { $ne: true }
  });
  if (!cn) throw new ApiError(404, 'Credit note not found');

  try {
    await pdfService.generateCreditNote(cn._id);
  } catch (err) {
    logger.error('Credit note PDF generation failed on demand', {
      creditNoteId: String(cn._id),
      message: err?.message,
      stack: err?.stack
    });
    throw new ApiError(500, err?.message || 'Credit note PDF could not be generated');
  }

  cn = await CreditNote.findById(cn._id).select('creditNoteNumber pdfUrl');
  const absPath = path.resolve(pdfService.creditNotePdfPath(cn.creditNoteNumber));
  if (!fs.existsSync(absPath)) throw new ApiError(500, 'Credit note PDF file missing after generation');
  return absPath;
};

/**
 * Resolve download by amendment id (issues CN lazily for legacy amendments).
 */
const ensurePdfPathForAmendment = async (companyId, orderId, amendmentId, reqUser, opts = {}) => {
  const order = await Order.findOne({ _id: orderId, companyId }).select('_id medicalRepId').lean();
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);

  const amendment = await OrderAmendment.findOne({
    _id: amendmentId,
    companyId,
    orderId,
    isDeleted: { $ne: true }
  });
  if (!amendment) throw new ApiError(404, 'Amendment not found');

  const cn = await ensureIssuedForAmendment(companyId, orderId, amendment, reqUser);
  return ensureCreditNotePdfPath(companyId, orderId, cn._id, reqUser, opts);
};

module.exports = {
  createForAmendmentInSession,
  ensureIssuedForAmendment,
  listByOrder,
  getById,
  mapCreditNotesByAmendmentId,
  ensureCreditNotePdfPath,
  ensurePdfPathForAmendment
};
