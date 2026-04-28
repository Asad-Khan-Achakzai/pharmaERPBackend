const mongoose = require('mongoose');
const { SUPPLIER_INVOICE_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const supplierInvoiceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', default: null },
    /** Optional links to one or more GRNs that this invoice relates to */
    grnIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceiptNote' }],
    invoiceNumber: { type: String, required: true, trim: true },
    invoiceDate: { type: Date, default: Date.now },
    /** Simple tax: single amount at header (not line tax in v1) */
    taxAmount: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    freightAmount: { type: Number, default: 0, min: 0 },
    /** Subtotal before tax/discount/freight — service may derive or store */
    subTotalAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: Object.values(SUPPLIER_INVOICE_STATUS),
      default: SUPPLIER_INVOICE_STATUS.DRAFT,
      index: true
    },
    notes: { type: String, trim: true, maxlength: 4000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

supplierInvoiceSchema.index({ companyId: 1, supplierId: 1, invoiceNumber: 1 }, { unique: true });
supplierInvoiceSchema.index({ companyId: 1, invoiceDate: -1 });

supplierInvoiceSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('SupplierInvoice', supplierInvoiceSchema);
