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

const productPackSlabSchema = Joi.object({
  fromPacks: Joi.number().integer().min(1).required(),
  toPacks: Joi.number().integer().min(1).allow(null).optional(),
  ratePerPack: Joi.number().min(0).required()
});

const productPackIncentiveSchema = Joi.object({
  type: Joi.string().valid('pack_slab').default('pack_slab'),
  productId: Joi.string().required(),
  includeBonusQty: Joi.boolean().default(true),
  slabs: Joi.array().items(productPackSlabSchema).min(1).required()
});

const createSalaryStructureSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  description: Joi.string().trim().max(500).allow('').optional(),
  code: Joi.string().trim().max(32).allow('').optional(),
  basicSalary: Joi.number().min(0).required(),
  dailyAllowance: Joi.number().min(0).default(0),
  allowances: Joi.array().items(lineItemSchema).default([]),
  deductions: Joi.array().items(lineItemSchema).default([]),
  commission: commissionSchema.default({ type: 'percentage', value: 0 }),
  productPackIncentives: Joi.array().items(productPackIncentiveSchema).default([]),
  isActive: Joi.boolean().default(true),
  extensions: Joi.object().optional()
});

const updateSalaryStructureSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120),
  description: Joi.string().trim().max(500).allow(''),
  code: Joi.string().trim().max(32).allow(''),
  basicSalary: Joi.number().min(0),
  dailyAllowance: Joi.number().min(0),
  allowances: Joi.array().items(lineItemSchema),
  deductions: Joi.array().items(lineItemSchema),
  commission: commissionSchema,
  productPackIncentives: Joi.array().items(productPackIncentiveSchema),
  isActive: Joi.boolean(),
  extensions: Joi.object().optional()
}).min(1);

const assignEmployeesSchema = Joi.object({
  employeeIds: Joi.array().items(Joi.string().hex().length(24)).min(1).required()
});

module.exports = {
  createSalaryStructureSchema,
  updateSalaryStructureSchema,
  assignEmployeesSchema,
  lineItemSchema,
  productPackIncentiveSchema
};
