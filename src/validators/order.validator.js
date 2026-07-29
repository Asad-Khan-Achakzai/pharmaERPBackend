const Joi = require('joi');

const createOrderSchema = Joi.object({
  pharmacyId: Joi.string().required(),
  doctorId: Joi.string().allow(null, ''),
  distributorId: Joi.string().required(),
  /** Assigned medical rep for the order; defaults to creator on server if omitted */
  medicalRepId: Joi.string().optional(),
  /** Optional soft link to a field visit (same company) for analytics */
  visitLogId: Joi.string().hex().length(24).allow(null, ''),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().integer().min(1).required(),
      distributorDiscount: Joi.number().min(0).max(100),
      clinicDiscount: Joi.number().min(0).max(100),
      /** Manual bonus (free) units; if omitted, server uses pharmacy buy/get scheme */
      bonusQuantity: Joi.number().integer().min(0).optional()
    })
  ).min(1).required(),
  notes: Joi.string().trim().allow('')
});

const updateOrderSchema = Joi.object({
  pharmacyId: Joi.string(),
  doctorId: Joi.string().allow(null, ''),
  distributorId: Joi.string(),
  medicalRepId: Joi.string().optional(),
  visitLogId: Joi.string().hex().length(24).allow(null, ''),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().integer().min(1).required(),
      distributorDiscount: Joi.number().min(0).max(100),
      clinicDiscount: Joi.number().min(0).max(100),
      bonusQuantity: Joi.number().integer().min(0).optional()
    })
  ).min(1),
  notes: Joi.string().trim().allow('')
}).min(1);

const deliverOrderSchema = Joi.object({
  deliveredById: Joi.string().hex().length(24).optional(),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().integer().min(1).required()
    })
  ).min(1).required()
});

const returnOrderSchema = Joi.object({
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().integer().min(1).required(),
      reason: Joi.string().trim().allow('')
    })
  ).min(1).required()
});

const amendOrderSchema = Joi.object({
  reason: Joi.string().trim().min(3).required(),
  amendmentType: Joi.string().valid('QUANTITY_REDUCTION').optional(),
  source: Joi.string().valid('DELIVERED_ORDER_CORRECTION').optional(),
  items: Joi.array()
    .items(
      Joi.object({
        productId: Joi.string().required(),
        newQuantity: Joi.number().integer().min(0).required()
      })
    )
    .min(1)
    .required()
});

module.exports = {
  createOrderSchema,
  updateOrderSchema,
  deliverOrderSchema,
  returnOrderSchema,
  amendOrderSchema
};
