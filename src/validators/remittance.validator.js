const Joi = require('joi');
const { PAYMENT_METHOD, REMITTANCE_DIFFERENCE_REASON } = require('../constants/enums');

const objectId = Joi.string().hex().length(24);

const newCollectionLine = Joi.object({
  pharmacyId: objectId.required(),
  amount: Joi.number().required().min(0.01),
  notes: Joi.string().trim().allow('')
});

const createRemittanceSchema = Joi.object({
  distributorId: objectId.required(),
  newCollections: Joi.array().items(newCollectionLine).default([]),
  collectionIds: Joi.array().items(objectId).default([]),
  receivedAmount: Joi.number().required().min(0.01),
  paymentMethod: Joi.string()
    .valid(...Object.values(PAYMENT_METHOD))
    .required(),
  moneyAccountId: objectId.required(),
  referenceNumber: Joi.string().trim().allow(''),
  date: Joi.date(),
  notes: Joi.string().trim().allow(''),
  differenceReason: Joi.string().valid(...Object.values(REMITTANCE_DIFFERENCE_REASON))
}).custom((value, helpers) => {
  if ((!value.newCollections || !value.newCollections.length) && (!value.collectionIds || !value.collectionIds.length)) {
    return helpers.message('Add at least one pharmacy collection or existing collection');
  }
  return value;
});

const previewRemittanceSchema = Joi.object({
  distributorId: objectId.required(),
  newCollections: Joi.array().items(newCollectionLine).default([]),
  collectionIds: Joi.array().items(objectId).default([]),
  receivedAmount: Joi.number().min(0)
});

const reverseRemittanceSchema = Joi.object({
  reversalReason: Joi.string().trim().max(500).allow('', null)
});

module.exports = { createRemittanceSchema, previewRemittanceSchema, reverseRemittanceSchema };
