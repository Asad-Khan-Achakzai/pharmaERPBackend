const Joi = require('joi');
const { EXPENSE_CATEGORY } = require('../constants/enums');

const createExpenseSchema = Joi.object({
  expenseAccountId: Joi.string().required(),
  moneyAccountId: Joi.string().required(),
  amount: Joi.number().required().min(0.01),
  description: Joi.string().trim().allow(''),
  date: Joi.date(),
  distributorId: Joi.string().allow(null, ''),
  doctorId: Joi.string().allow(null, ''),
  employeeId: Joi.string().allow(null, ''),
  /** Legacy — ignored when expenseAccountId is provided */
  category: Joi.string()
    .valid(...Object.values(EXPENSE_CATEGORY))
    .allow(null, '')
});

const updateExpenseSchema = Joi.object({
  description: Joi.string().trim().allow(''),
  date: Joi.date()
}).min(1);

module.exports = { createExpenseSchema, updateExpenseSchema };
