const Joi = require('joi');
const { DOCTOR_LOCATION_SUGGESTION_STATUS } = require('../constants/enums');

const listDoctorLocationSuggestionsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
  status: Joi.string()
    .valid(...Object.values(DOCTOR_LOCATION_SUGGESTION_STATUS))
    .default(DOCTOR_LOCATION_SUGGESTION_STATUS.PENDING),
  sortBy: Joi.string(),
  sortOrder: Joi.string().valid('asc', 'desc')
});

const rejectDoctorLocationSuggestionSchema = Joi.object({
  rejectionReason: Joi.string().trim().max(500).allow('', null)
});

module.exports = {
  listDoctorLocationSuggestionsQuerySchema,
  rejectDoctorLocationSuggestionSchema
};
