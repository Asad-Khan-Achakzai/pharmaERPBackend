const Joi = require('joi');
const { EXPENSE_CATEGORY } = require('../constants/enums');

const createExpenseSchema = Joi.object({
  expenseAccountId: Joi.string().allow(null, ''),
  moneyAccountId: Joi.string().allow(null, ''),
  amount: Joi.number().required().min(0.01),
  description: Joi.string().trim().allow(''),
  date: Joi.date(),
  distributorId: Joi.string().allow(null, ''),
  doctorId: Joi.string().allow(null, ''),
  employeeId: Joi.string().allow(null, ''),
  /** Mobile field reps send category; server maps to COA expense account + default Cash. */
  category: Joi.string()
    .valid(...Object.values(EXPENSE_CATEGORY))
    .allow(null, '')
}).custom((value, helpers) => {
  if (!value.expenseAccountId && !value.category) {
    return helpers.error('any.custom', {
      message: 'Either expenseAccountId or category is required'
    });
  }
  return value;
});

const updateExpenseSchema = Joi.object({
  description: Joi.string().trim().allow(''),
  date: Joi.date()
}).min(1);

module.exports = { createExpenseSchema, updateExpenseSchema };
