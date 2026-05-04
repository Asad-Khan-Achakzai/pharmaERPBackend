const Joi = require('joi');

const bonusSchemeSchema = Joi.object({
  buyQty: Joi.number().min(0).default(0),
  getQty: Joi.number().min(0).default(0)
});

const createPharmacySchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  address: Joi.string().trim().allow(''),
  city: Joi.string().trim().allow(''),
  state: Joi.string().trim().allow(''),
  phone: Joi.string().trim().allow(''),
  email: Joi.string().email().trim().allow(''),
  discountOnTP: Joi.number().min(0).max(100).default(0),
  bonusScheme: bonusSchemeSchema.optional()
});

const updatePharmacySchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  address: Joi.string().trim().allow(''),
  city: Joi.string().trim().allow(''),
  state: Joi.string().trim().allow(''),
  phone: Joi.string().trim().allow(''),
  email: Joi.string().email().trim().allow(''),
  discountOnTP: Joi.number().min(0).max(100),
  isActive: Joi.boolean(),
  bonusScheme: bonusSchemeSchema.optional()
}).min(1);

const doctorBodyFields = {
  pharmacyId: Joi.string().hex().length(24).allow(null, ''),
  name: Joi.string().trim().min(1).max(200),
  specialization: Joi.string().trim().allow('').max(200),
  phone: Joi.string().trim().allow('').max(32),
  email: Joi.alternatives().try(Joi.string().trim().email(), Joi.valid('', null)),
  zone: Joi.string().trim().allow('').max(120),
  doctorBrick: Joi.string().trim().allow('').max(120),
  doctorCode: Joi.string().trim().allow('').max(64),
  qualification: Joi.string().trim().allow('').max(200),
  mobileNo: Joi.string().trim().allow('').max(32),
  gender: Joi.string().trim().allow('').max(32),
  frequency: Joi.string().trim().allow('').max(120),
  locationName: Joi.string().trim().allow('').max(200),
  address: Joi.string().trim().allow('').max(500),
  city: Joi.string().trim().allow('').max(120),
  grade: Joi.string().trim().allow('').max(64),
  pmdcRegistration: Joi.string().trim().allow('').max(200),
  designation: Joi.string().trim().allow('').max(200),
  patientCount: Joi.number().integer().min(0).allow(null)
};

const createDoctorSchema = Joi.object({
  ...doctorBodyFields,
  name: Joi.string().required().trim().min(1).max(200),
  pharmacyId: Joi.string().hex().length(24).allow(null, '')
});

const updateDoctorSchema = Joi.object({
  ...doctorBodyFields,
  isActive: Joi.boolean()
}).min(1);

module.exports = {
  createPharmacySchema, updatePharmacySchema,
  createDoctorSchema, updateDoctorSchema
};
