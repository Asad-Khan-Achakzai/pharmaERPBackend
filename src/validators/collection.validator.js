const Joi = require('joi');
const { PAYMENT_METHOD, COLLECTOR_TYPE } = require('../constants/enums');

const createCollectionSchema = Joi.object({
  pharmacyId: Joi.string().required(),
  collectorType: Joi.string()
    .valid(...Object.values(COLLECTOR_TYPE))
    .required(),
  distributorId: Joi.string().when('collectorType', {
    is: COLLECTOR_TYPE.DISTRIBUTOR,
    then: Joi.required(),
    otherwise: Joi.optional().allow('', null)
  }),
  amount: Joi.number().required().min(0.01),
  paymentMethod: Joi.string()
    .valid(...Object.values(PAYMENT_METHOD))
    .required(),
  moneyAccountId: Joi.string().hex().length(24).required(),
  referenceNumber: Joi.string().trim().allow(''),
  date: Joi.date(),
  notes: Joi.string().trim().allow('')
});

const updateCollectionSchema = Joi.object({
  date: Joi.date(),
  notes: Joi.string().trim().allow(''),
  referenceNumber: Joi.string().trim().allow('')
}).min(1);

const reverseCollectionSchema = Joi.object({
  reversalReason: Joi.string().trim().max(500).allow('', null)
});

module.exports = { createCollectionSchema, updateCollectionSchema, reverseCollectionSchema };
