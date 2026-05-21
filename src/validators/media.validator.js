const Joi = require('joi');

const MEDIA_KINDS = [
  'VISIT_PHOTO',
  'ATTENDANCE_SELFIE',
  'EXPENSE_RECEIPT',
  'PAYMENT_RECEIPT',
  'PRODUCT_VISUAL',
  'OTHER'
];

const presignSchema = Joi.object({
  kind: Joi.string()
    .valid(...MEDIA_KINDS)
    .required(),
  mime: Joi.string().required(),
  size: Joi.number().integer().min(1).max(50 * 1024 * 1024).required()
});

const finalizeSchema = Joi.object({
  assetId: Joi.string().required(),
  size: Joi.number().integer().min(1).max(50 * 1024 * 1024),
  mime: Joi.string(),
  width: Joi.number().integer().min(1),
  height: Joi.number().integer().min(1)
});

const linkSchema = Joi.object({
  resource: Joi.string()
    .valid('visits', 'attendance', 'expenses', 'collections', 'payments', 'products')
    .required(),
  id: Joi.string().required(),
  assetIds: Joi.array().items(Joi.string()).min(1).required()
});

module.exports = { presignSchema, finalizeSchema, linkSchema };
