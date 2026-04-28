const mongoose = require('mongoose');
const {
  SUPPLIER_LEDGER_TYPE,
  SUPPLIER_LEDGER_REFERENCE_TYPE,
  SUPPLIER_LEDGER_ADJUSTMENT_EFFECT,
  SUPPLIER_PAYMENT_METHOD,
  SUPPLIER_PAYMENT_VERIFICATION
} = require('../constants/enums');

const supplierPaymentAllocationSchema = new mongoose.Schema(
  {
    supplierInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplierInvoice', required: true },
    /** Portion of this payment (PKR) applied to the invoice */
    amount: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);
const { softDeletePlugin } = require('../plugins/softDelete');

const supplierLedgerSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    type: { type: String, enum: Object.values(SUPPLIER_LEDGER_TYPE), required: true },
    /** Always positive PKR */
    amount: { type: Number, required: true, min: 0 },
    /**
     * PURCHASE: payable up (GRN posted — reference GOODS_RECEIPT_NOTE).
     * PAYMENT: payable down — optional paymentAllocations for invoice matching.
     * ADJUSTMENT: invoice vs GRN mismatch — use adjustmentEffect + referenceType PROCUREMENT_ADJUSTMENT / SUPPLIER_INVOICE.
     */
    adjustmentEffect: {
      type: String,
      enum: Object.values(SUPPLIER_LEDGER_ADJUSTMENT_EFFECT),
      default: undefined
    },
    referenceType: {
      type: String,
      enum: [...Object.values(SUPPLIER_LEDGER_REFERENCE_TYPE)],
      default: 'MANUAL'
    },
    referenceId: { type: mongoose.Schema.Types.ObjectId },
    date: { type: Date, default: Date.now },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /** PAYMENT rows only — optional for legacy rows */
    paymentMethod: { type: String, enum: [...Object.values(SUPPLIER_PAYMENT_METHOD)] },
    referenceNumber: { type: String, trim: true },
    /** Optional receipt image URL (e.g. cloud or pasted link) */
    attachmentUrl: { type: String, trim: true },
    verificationStatus: {
      type: String,
      enum: [...Object.values(SUPPLIER_PAYMENT_VERIFICATION)],
      default: SUPPLIER_PAYMENT_VERIFICATION.UNVERIFIED
    },
    /** Printable voucher id (unique when set) */
    voucherNumber: { type: String, trim: true, sparse: true, unique: true },
    /** PAYMENT rows: partial allocation against supplier invoices (Phase 4+) */
    paymentAllocations: { type: [supplierPaymentAllocationSchema], default: undefined }
  },
  { timestamps: true }
);

supplierLedgerSchema.index({ companyId: 1, supplierId: 1, date: -1 });
supplierLedgerSchema.index({ companyId: 1, type: 1, date: -1 });
supplierLedgerSchema.index({ companyId: 1, referenceType: 1, referenceId: 1 });
supplierLedgerSchema.index({ companyId: 1, type: 1, supplierId: 1, date: -1 });

supplierLedgerSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('SupplierLedger', supplierLedgerSchema);
