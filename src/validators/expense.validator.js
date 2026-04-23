const Joi = require('joi');
const { EXPENSE_CATEGORY } = require('../constants/enums');

const createExpenseSchema = Joi.object({
  category: Joi.string().valid(...Object.values(EXPENSE_CATEGORY)).required(),
  amount: Joi.number().required().min(0.01),
  description: Joi.string().trim().allow(''),
  date: Joi.date(),
  distributorId: Joi.string().allow(null, ''),
  doctorId: Joi.string().allow(null, ''),
  employeeId: Joi.string().allow(null, '')
});

const updateExpenseSchema = Joi.object({
  category: Joi.string().valid(...Object.values(EXPENSE_CATEGORY)),
  amount: Joi.number().min(0.01),
  description: Joi.string().trim().allow(''),
  date: Joi.date()
}).min(1);

module.exports = { createExpenseSchema, updateExpenseSchema };
