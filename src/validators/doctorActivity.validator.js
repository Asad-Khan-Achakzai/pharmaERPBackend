const Joi = require('joi');

const createDoctorActivitySchema = Joi.object({
  doctorId: Joi.string().required(),
  medicalRepId: Joi.string().optional().allow(null, ''),
  investedAmount: Joi.number().required().min(0),
  commitmentAmount: Joi.number().required().min(0),
  startDate: Joi.date().required(),
  endDate: Joi.date().required().greater(Joi.ref('startDate'))
});

const updateDoctorActivitySchema = Joi.object({
  doctorId: Joi.string(),
  medicalRepId: Joi.string().allow(null, ''),
  investedAmount: Joi.number().min(0),
  commitmentAmount: Joi.number().min(0),
  startDate: Joi.date(),
  endDate: Joi.date()
}).min(1);

module.exports = { createDoctorActivitySchema, updateDoctorActivitySchema };
