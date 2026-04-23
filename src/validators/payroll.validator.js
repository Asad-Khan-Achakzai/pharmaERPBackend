const Joi = require('joi');

const createPayrollSchema = Joi.object({
  employeeId: Joi.string().required(),
  month: Joi.string().required().pattern(/^\d{4}-\d{2}$/),
  manual: Joi.boolean().default(false),
  baseSalary: Joi.number().min(0),
  bonus: Joi.number().min(0).default(0),
  deductions: Joi.number().min(0).default(0)
}).custom((value, helpers) => {
  if (value.manual === true) {
    if (value.baseSalary === undefined) {
      return helpers.error('any.custom', { message: 'baseSalary is required when manual is true' });
    }
  }
  return value;
});

const updatePayrollSchema = Joi.object({
  baseSalary: Joi.number().min(0),
  bonus: Joi.number().min(0),
  deductions: Joi.number().min(0),
  manualOverride: Joi.boolean()
}).min(1);

const previewPayrollSchema = Joi.object({
  employeeId: Joi.string().required(),
  month: Joi.string().required().pattern(/^\d{4}-\d{2}$/),
  manual: Joi.boolean().default(false),
  baseSalary: Joi.number().min(0),
  bonus: Joi.number().min(0).default(0),
  deductions: Joi.number().min(0).default(0)
}).custom((value, helpers) => {
  if (value.manual === true && value.baseSalary === undefined) {
    return helpers.error('any.custom', { message: 'baseSalary is required when manual is true' });
  }
  return value;
});

module.exports = { createPayrollSchema, updatePayrollSchema, previewPayrollSchema };
