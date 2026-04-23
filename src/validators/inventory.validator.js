const Joi = require('joi');

const transferSchema = Joi.object({
  distributorId: Joi.string().required(),
  /** Factory / supplier — when issuing from company, creates supplier PURCHASE (casting × qty); not an expense */
  supplierId: Joi.string().optional().allow(null, ''),
  /** When set, stock moves from this distributor to `distributorId` (distributor-to-distributor). */
  fromDistributorId: Joi.string().optional().allow(null, ''),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().integer().min(1).required()
    })
  ).min(1).required(),
  totalShippingCost: Joi.number().min(0).default(0).messages({
    'number.base': 'Total shipping cost must be a number',
    'number.min': 'Total shipping cost must be greater than or equal to 0'
  }),
  notes: Joi.string().trim().allow('')
});

module.exports = { transferSchema };
