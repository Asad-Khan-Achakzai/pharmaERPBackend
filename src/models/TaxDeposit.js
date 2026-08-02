const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');
const { TAX_DEPOSIT_STATUS } = require('../constants/taxCatalog');

const receiptAttachmentSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true, default: '' },
    fileName: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' },
    mediaAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', default: null },
    uploadedAt: { type: Date, default: null },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { _id: false }
);

const taxDepositSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    depositNumber: { type: String, required: true, trim: true, maxlength: 64 },
    governmentAuthority: { type: String, trim: true, maxlength: 200, default: 'FBR' },
    taxPeriodFrom: { type: Date, default: null },
    taxPeriodTo: { type: Date, default: null },
    paymentDate: { type: Date, default: null },
    paymentReference: { type: String, trim: true, maxlength: 200, default: '' },
    bankReference: { type: String, trim: true, maxlength: 200, default: '' },
    moneyAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    amount: { type: Number, default: 0 },
    currency: { type: String, trim: true, uppercase: true, maxlength: 8, default: 'PKR' },
    status: {
      type: String,
      enum: Object.values(TAX_DEPOSIT_STATUS),
      default: TAX_DEPOSIT_STATUS.DRAFT,
      index: true
    },
    receiptAttachment: { type: receiptAttachmentSchema, default: () => ({}) },
    registerEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxRegisterEntry' }],
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', default: null },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true, maxlength: 500, default: '' },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reverseReason: { type: String, trim: true, maxlength: 1000, default: '' },
    reverseVoucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', default: null }
  },
  { timestamps: true }
);

taxDepositSchema.index({ companyId: 1, depositNumber: 1 }, { unique: true });
taxDepositSchema.index({ companyId: 1, status: 1, paymentDate: -1 });
taxDepositSchema.index({ companyId: 1, taxPeriodFrom: 1, taxPeriodTo: 1 });

taxDepositSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('TaxDeposit', taxDepositSchema);
