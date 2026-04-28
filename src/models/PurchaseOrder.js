const mongoose = require('mongoose');
const { PURCHASE_ORDER_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const purchaseOrderSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    /** Unique per company — generated in service (e.g. PO-YYYYMMDD-####) */
    orderNumber: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: Object.values(PURCHASE_ORDER_STATUS),
      default: PURCHASE_ORDER_STATUS.DRAFT,
      index: true
    },
    currency: { type: String, default: 'PKR', trim: true },
    /** Optional header roll-up; lines are source of truth for quantities */
    expectedTotalAmount: { type: Number, default: 0, min: 0 },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, trim: true, maxlength: 4000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

purchaseOrderSchema.index({ companyId: 1, orderNumber: 1 }, { unique: true });
purchaseOrderSchema.index({ companyId: 1, supplierId: 1, status: 1, createdAt: -1 });

purchaseOrderSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
