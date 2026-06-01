const mongoose = require('mongoose');
const { ACCOUNT_GROUP_TYPE } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const accountSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    groupType: { type: String, enum: Object.values(ACCOUNT_GROUP_TYPE), required: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    isGroup: { type: Boolean, default: false },
    isControlAccount: { type: Boolean, default: false },
    isCash: { type: Boolean, default: false },
    isBank: { type: Boolean, default: false },
    /** True for Cash, Bank, Petty Cash, named bank GL accounts — only these receive real money movements */
    isMoneyAccount: { type: Boolean, default: false },
    moneyAccountNature: { type: String, enum: ['CASH', 'BANK', null], default: null },
    /** PHARMACY | SUPPLIER | DISTRIBUTOR_CLEARING — for detail sub-ledger party linkage */
    linkedEntityType: { type: String, default: null },
    linkedEntityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    openingBalance: { type: Number, default: 0 },
    /** Denormalized running balance (updated on voucher post/reverse). */
    currentBalance: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    isSystem: { type: Boolean, default: false },
    description: { type: String, trim: true, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

accountSchema.index({ companyId: 1, code: 1 }, { unique: true, partialFilterExpression: { isDeleted: { $ne: true } } });
accountSchema.index({ companyId: 1, parentId: 1 });
accountSchema.index({ companyId: 1, groupType: 1 });
accountSchema.index({ companyId: 1, isCash: 1 });
accountSchema.index({ companyId: 1, isMoneyAccount: 1 });

accountSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Account', accountSchema);
