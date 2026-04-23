const Joi = require('joi');
const { PAYMENT_METHOD } = require('../constants/enums');

const createPaymentSchema = Joi.object({
  pharmacyId: Joi.string().required(),
  amount: Joi.number().required().min(0.01),
  paymentMethod: Joi.string().valid(...Object.values(PAYMENT_METHOD)).required(),
  referenceNumber: Joi.string().trim().allow(''),
  collectedBy: Joi.string().allow(''),
  date: Joi.date(),
  notes: Joi.string().trim().allow('')
});

module.exports = { createPaymentSchema };
