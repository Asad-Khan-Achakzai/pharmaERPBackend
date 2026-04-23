const Joi = require('joi');

const lineItemSchema = Joi.object({
  name: Joi.string().trim().required(),
  type: Joi.string().valid('fixed', 'percentage').required(),
  value: Joi.when('type', {
    is: 'percentage',
    then: Joi.number().min(0).max(100).required().messages({ 'number.max': 'Percentage must be between 0 and 100' }),
    otherwise: Joi.number().min(0).required()
  })
});

const commissionSchema = Joi.object({
  type: Joi.string().valid('percentage').default('percentage'),
  value: Joi.number().min(0).max(100).default(0)
});

const createSalaryStructureSchema = Joi.object({
  employeeId: Joi.string().required(),
  basicSalary: Joi.number().min(0).required(),
  dailyAllowance: Joi.number().min(0).default(0),
  allowances: Joi.array().items(lineItemSchema).default([]),
  deductions: Joi.array().items(lineItemSchema).default([]),
  commission: commissionSchema.default({ type: 'percentage', value: 0 }),
  effectiveFrom: Joi.date().required(),
  isActive: Joi.boolean().default(true),
  extensions: Joi.object().optional()
});

const updateSalaryStructureSchema = Joi.object({
  basicSalary: Joi.number().min(0),
  dailyAllowance: Joi.number().min(0),
  allowances: Joi.array().items(lineItemSchema),
  deductions: Joi.array().items(lineItemSchema),
  commission: commissionSchema,
  effectiveFrom: Joi.date(),
  isActive: Joi.boolean(),
  extensions: Joi.object().optional()
}).min(1);

module.exports = { createSalaryStructureSchema, updateSalaryStructureSchema, lineItemSchema };
