const mongoose = require('mongoose');
const { ORDER_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String },
    quantity: { type: Number, required: true },
    deliveredQty: { type: Number, default: 0 },
    returnedQty: { type: Number, default: 0 },
    tpAtTime: { type: Number, required: true },
    castingAtTime: { type: Number, required: true },
    distributorDiscount: { type: Number, default: 0 },
    clinicDiscount: { type: Number, default: 0 },
    bonusScheme: {
      buyQty: { type: Number, default: 0 },
      getQty: { type: Number, default: 0 }
    },
    bonusQuantity: { type: Number, default: 0 },
    /** Snapshotted at order create/update; matches delivery computeLineSnapshot for full line qty */
    grossAmount: { type: Number },
    pharmacyDiscountAmount: { type: Number },
    netAfterPharmacy: { type: Number },
    distributorCommissionAmount: { type: Number },
    finalCompanyAmount: { type: Number },
    /** casting × (paid + bonus) units — snapshot at order time */
    inventoryCostAmount: { type: Number }
  },
  { _id: true }
);

const orderSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    orderNumber: { type: String },
    pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
    distributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Distributor', required: true },
    medicalRepId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [orderItemSchema],
    status: {
      type: String,
      enum: Object.values(ORDER_STATUS),
      default: ORDER_STATUS.PENDING
    },
    totalOrderedAmount: { type: Number, default: 0 },
    /** Gross TP total (same basis as totalOrderedAmount); stored for API clarity */
    totalAmount: { type: Number, default: 0 },
    pharmacyDiscountAmount: { type: Number, default: 0 },
    amountAfterPharmacyDiscount: { type: Number, default: 0 },
    distributorCommissionAmount: { type: Number, default: 0 },
    finalCompanyRevenue: { type: Number, default: 0 },
    /** Sum of line bonus (free) units — reporting */
    totalBonusQuantity: { type: Number, default: 0 },
    /** casting × (paid + bonus) per line, summed — inventory cost snapshot at order time */
    totalCastingCost: { type: Number, default: 0 },
    notes: { type: String }
  },
  { timestamps: true }
);

orderSchema.index({ companyId: 1, status: 1 });
/**
 * orderNumber is unique per company (compound index with companyId).
 * Do NOT assume global uniqueness.
 */
orderSchema.index(
  { companyId: 1, orderNumber: 1 },
  { unique: true, partialFilterExpression: { orderNumber: { $type: 'string' } } }
);
orderSchema.index({ companyId: 1, pharmacyId: 1 });
orderSchema.index({ companyId: 1, distributorId: 1 });
orderSchema.index({ companyId: 1, medicalRepId: 1 });
orderSchema.index({ companyId: 1, createdAt: -1 });

orderSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Order', orderSchema);
