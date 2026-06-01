const Joi = require('joi');
const { VOUCHER_TYPE } = require('../constants/enums');

const voucherLineSchema = Joi.object({
  accountId: Joi.string().hex().length(24).required(),
  debit: Joi.number().min(0).default(0),
  credit: Joi.number().min(0).default(0),
  partyEntityType: Joi.string().allow(null, ''),
  partyEntityId: Joi.string().hex().length(24).allow(null),
  description: Joi.string().allow('', null)
});

const createVoucherSchema = Joi.object({
  voucherType: Joi.string()
    .valid(...Object.values(VOUCHER_TYPE))
    .default(VOUCHER_TYPE.JV),
  date: Joi.date().iso(),
  narration: Joi.string().allow('', null),
  paymentMethod: Joi.string().allow(null, ''),
  lines: Joi.array().items(voucherLineSchema).min(2).required()
});

const fundTransferSchema = Joi.object({
  fromMoneyAccountId: Joi.string().hex().length(24),
  toMoneyAccountId: Joi.string().hex().length(24),
  fromAccountId: Joi.string().hex().length(24),
  toAccountId: Joi.string().hex().length(24),
  amount: Joi.number().min(0.01).required(),
  date: Joi.date().iso(),
  narration: Joi.string().allow('', null)
}).custom((val, helpers) => {
  const from = val.fromMoneyAccountId || val.fromAccountId;
  const to = val.toMoneyAccountId || val.toAccountId;
  if (!from) return helpers.error('any.custom', { message: 'fromMoneyAccountId is required' });
  if (!to) return helpers.error('any.custom', { message: 'toMoneyAccountId is required' });
  if (from === to) return helpers.error('any.custom', { message: 'Source and destination money accounts must differ' });
  return val;
});

module.exports = { createVoucherSchema, fundTransferSchema };
