const Joi = require('joi');
const { PAYMENT_METHOD, SETTLEMENT_DIRECTION } = require('../constants/enums');

const createSettlementSchema = Joi.object({
  distributorId: Joi.string().required(),
  direction: Joi.string()
    .valid(...Object.values(SETTLEMENT_DIRECTION))
    .required(),
  amount: Joi.number().required().min(0.01),
  paymentMethod: Joi.string()
    .valid(...Object.values(PAYMENT_METHOD))
    .required(),
  referenceNumber: Joi.string().trim().allow(''),
  date: Joi.date(),
  notes: Joi.string().trim().allow(''),
  isNetSettlement: Joi.boolean(),
  grossDistributorToCompany: Joi.number().min(0),
  grossCompanyToDistributor: Joi.number().min(0)
});

module.exports = { createSettlementSchema };
