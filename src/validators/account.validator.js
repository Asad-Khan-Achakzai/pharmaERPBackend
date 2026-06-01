const Joi = require('joi');
const { ACCOUNT_GROUP_TYPE, VOUCHER_TYPE } = require('../constants/enums');

const createAccountSchema = Joi.object({
  code: Joi.string().trim().required(),
  name: Joi.string().trim().required(),
  groupType: Joi.string()
    .valid(...Object.values(ACCOUNT_GROUP_TYPE))
    .required(),
  parentId: Joi.string().hex().length(24).allow(null),
  isGroup: Joi.boolean().default(false),
  isControlAccount: Joi.boolean().default(false),
  isCash: Joi.boolean().default(false),
  isBank: Joi.boolean().default(false),
  linkedEntityType: Joi.string().allow(null, ''),
  openingBalance: Joi.number().default(0),
  description: Joi.string().allow('', null)
});

const updateAccountSchema = Joi.object({
  name: Joi.string().trim(),
  description: Joi.string().allow('', null),
  isActive: Joi.boolean()
}).min(1);

const openingBalanceSchema = Joi.object({
  openingBalance: Joi.number().required()
});

module.exports = { createAccountSchema, updateAccountSchema, openingBalanceSchema };
