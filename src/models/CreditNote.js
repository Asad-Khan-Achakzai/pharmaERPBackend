const mongoose = require('mongoose');
const { CREDIT_NOTE_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

/**
 * Thin customer-facing Credit Note identity.
 * Commercial line/amount SoT remains OrderAmendment; this document is CN number + PDF only.
 */
const creditNoteSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    amendmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OrderAmendment',
      required: true
    },
    creditNoteNumber: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(CREDIT_NOTE_STATUS),
      default: CREDIT_NOTE_STATUS.ISSUED
    },
    pdfUrl: { type: String },
    /** Denormalized list crumbs (not economic SoT). */
    orderNumber: { type: String },
    amendmentNumber: { type: String },
    pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy' },
    invoiceNumbers: [{ type: String }],
    totalAmount: { type: Number },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    issuedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

creditNoteSchema.index({ companyId: 1, orderId: 1 });
creditNoteSchema.index({ companyId: 1, amendmentId: 1 }, { unique: true });
creditNoteSchema.index(
  { companyId: 1, creditNoteNumber: 1 },
  { unique: true, partialFilterExpression: { creditNoteNumber: { $type: 'string' } } }
);

creditNoteSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CreditNote', creditNoteSchema);
