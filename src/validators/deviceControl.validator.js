const Joi = require('joi');

const rejectRequestSchema = Joi.object({
  note: Joi.string().trim().allow('', null).max(500)
});

module.exports = { rejectRequestSchema };
