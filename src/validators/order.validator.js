const Joi = require('joi');

const createOrderSchema = Joi.object({
  pharmacyId: Joi.string().required(),
  doctorId: Joi.string().allow(null, ''),
  distributorId: Joi.string().required(),
  /** Assigned medical rep for the order; defaults to creator on server if omitted */
  medicalRepId: Joi.string().optional(),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().integer().min(1).required(),
      distributorDiscount: Joi.number().min(0).max(100),
      clinicDiscount: Joi.number().min(0).max(100)
    })
  ).min(1).required(),
  notes: Joi.string().trim().allow('')
});

const updateOrderSchema = Joi.object({
  pharmacyId: Joi.string(),
  doctorId: Joi.string().allow(null, ''),
  distributorId: Joi.string(),
  medicalRepId: Joi.string().optional(),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().integer().min(1).required(),
      distributorDiscount: Joi.number().min(0).max(100),
      clinicDiscount: Joi.number().min(0).max(100)
    })
  ).min(1),
  notes: Joi.string().trim().allow('')
}).min(1);

const deliverOrderSchema = Joi.object({
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

module.exports = { createOrderSchema, updateOrderSchema, deliverOrderSchema, returnOrderSchema };
