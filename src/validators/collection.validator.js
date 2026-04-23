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
  referenceNumber: Joi.string().trim().allow(''),
  date: Joi.date(),
  notes: Joi.string().trim().allow('')
});

module.exports = { createCollectionSchema };
