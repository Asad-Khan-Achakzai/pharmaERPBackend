const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');
const {
  TAX_REGISTER_ENTRY_TYPE,
  TAX_REGISTER_STATUS,
  TAX_REGISTER_DIRECTION,
  CALCULATION_BASE,
  listTaxTypeCodes
} = require('../constants/taxCatalog');

const taxRegisterEntrySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    entryType: {
      type: String,
      enum: Object.values(TAX_REGISTER_ENTRY_TYPE),
      required: true
    },
    status: {
      type: String,
      enum: Object.values(TAX_REGISTER_STATUS),
      default: TAX_REGISTER_STATUS.OPEN
    },
    taxTypeCode: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator(v) {
          return listTaxTypeCodes().includes(String(v));
        },
        message: 'Unknown taxTypeCode'
      }
    },
    taxSection: { type: String, trim: true, maxlength: 64, default: '' },
    ratePercent: { type: Number, default: null },
    calculationBase: {
      type: String,
      enum: [...Object.values(CALCULATION_BASE), ''],
      default: ''
    },
    taxableAmount: { type: Number, required: true },
    /** Signed: + on invoice, − on reversal. Immutable after create (never shrunk on remit). */
    taxAmount: { type: Number, required: true },
    direction: {
      type: String,
      enum: Object.values(TAX_REGISTER_DIRECTION),
      default: TAX_REGISTER_DIRECTION.PAYABLE
    },
    businessDate: { type: Date, required: true },
    pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', default: null },
    deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRecord', default: null },
    invoiceNumber: { type: String, trim: true, default: '' },
    taxRuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxRule', default: null },
    rateVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    snapshotLineRef: { type: Number, default: null },
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', default: null },
    /** Legacy voucher link from pre-deposit remittance API. */
    remittanceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    taxDepositId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxDeposit', default: null },
    depositNumber: { type: String, trim: true, default: '' },
    depositDate: { type: Date, default: null },
    meta: {
      orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
      amendmentId: { type: mongoose.Schema.Types.ObjectId },
      returnId: { type: mongoose.Schema.Types.ObjectId },
      writeOffId: { type: mongoose.Schema.Types.ObjectId },
      creditNoteId: { type: mongoose.Schema.Types.ObjectId },
      relatedRemittedEntryId: { type: mongoose.Schema.Types.ObjectId },
      narration: { type: String }
    }
  },
  { timestamps: true }
);

taxRegisterEntrySchema.index({ companyId: 1, businessDate: -1 });
taxRegisterEntrySchema.index({ companyId: 1, deliveryId: 1, entryType: 1 });
taxRegisterEntrySchema.index({ companyId: 1, taxTypeCode: 1, status: 1, businessDate: -1 });
taxRegisterEntrySchema.index({ companyId: 1, pharmacyId: 1, businessDate: -1 });
taxRegisterEntrySchema.index({ companyId: 1, taxDepositId: 1 });
taxRegisterEntrySchema.index({ companyId: 1, depositNumber: 1 });
taxRegisterEntrySchema.index({ companyId: 1, invoiceNumber: 1 });

taxRegisterEntrySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('TaxRegisterEntry', taxRegisterEntrySchema);
