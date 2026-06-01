const Joi = require('joi');
const { SIMPLE_ACCOUNT_TYPE } = require('../constants/simpleAccountTypes');

const createSimpleAccountSchema = Joi.object({
  accountType: Joi.string()
    .valid(...Object.values(SIMPLE_ACCOUNT_TYPE))
    .required(),
  name: Joi.string().trim().min(1).max(120).required(),
  openingBalance: Joi.number().min(0).default(0),
  accountNumber: Joi.string().trim().max(64).allow('', null),
  notes: Joi.string().trim().max(500).allow('', null)
});

module.exports = { createSimpleAccountSchema };
