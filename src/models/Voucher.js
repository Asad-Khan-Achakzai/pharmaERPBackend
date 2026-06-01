const mongoose = require('mongoose');
const { VOUCHER_TYPE, VOUCHER_STATUS, GL_SOURCE_MODULE } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const voucherLineSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    accountCode: { type: String, required: true, trim: true },
    accountName: { type: String, required: true, trim: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    partyEntityType: { type: String, default: null },
    partyEntityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    description: { type: String, trim: true, default: null },
    lineOrder: { type: Number, default: 0 }
  },
  { _id: true }
);

const voucherSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    voucherNumber: { type: String, required: true, trim: true },
    voucherType: { type: String, enum: Object.values(VOUCHER_TYPE), required: true },
    status: { type: String, enum: Object.values(VOUCHER_STATUS), default: VOUCHER_STATUS.POSTED },
    date: { type: Date, required: true },
    narration: { type: String, trim: true, default: null },
    lines: { type: [voucherLineSchema], default: [] },
    totalDebit: { type: Number, required: true, min: 0 },
    totalCredit: { type: Number, required: true, min: 0 },
    sourceModule: { type: String, enum: [...Object.values(GL_SOURCE_MODULE), null], default: null },
    sourceRefId: { type: mongoose.Schema.Types.ObjectId, default: null },
    fiscalPeriodId: { type: mongoose.Schema.Types.ObjectId, ref: 'FiscalPeriod', default: null },
    paymentMethod: { type: String, default: null },
    /** Primary money account for receipt/payment (Dr or Cr side) */
    moneyAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    /** Transfer destination money account (contra) */
    toMoneyAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    moneyAccountNature: { type: String, enum: ['CASH', 'BANK', null], default: null },
    reversedVoucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', default: null },
    reversalOfVoucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', default: null },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    postedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

voucherSchema.index(
  { companyId: 1, voucherNumber: 1 },
  { unique: true, partialFilterExpression: { isDeleted: { $ne: true } } }
);
voucherSchema.index({ companyId: 1, voucherType: 1, date: -1 });
voucherSchema.index({ companyId: 1, status: 1, date: -1 });
voucherSchema.index({ companyId: 1, sourceModule: 1, sourceRefId: 1 });

voucherSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Voucher', voucherSchema);
