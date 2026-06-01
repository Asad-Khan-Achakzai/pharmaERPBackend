const mongoose = require('mongoose');
const { EXPENSE_CATEGORY } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const expenseSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    /** @deprecated Legacy enum — new expenses use expenseAccountId from Chart of Accounts */
    category: { type: String, enum: Object.values(EXPENSE_CATEGORY), default: null },
    /** Dr side — EXPENSE group account from COA */
    expenseAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    /** Cr side — Cash/Bank money account */
    moneyAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    /** Auto-posted payment voucher (PV) */
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', default: null },
    amount: { type: Number, required: true },
    description: { type: String },
    date: { type: Date, default: Date.now },
    distributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Distributor' },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

expenseSchema.index({ companyId: 1, expenseAccountId: 1, date: -1 });
expenseSchema.index({ companyId: 1, date: -1 });
expenseSchema.index({ companyId: 1, voucherId: 1 });

expenseSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Expense', expenseSchema);
