const Joi = require('joi');
const {
  SLIDE_TYPES,
  SECTION_KEYS,
  COMPONENT_TYPES
} = require('../models/ProductPresentation');

const objectId = Joi.string().hex().length(24).allow(null, '');

const componentSchema = Joi.object({
  componentId: objectId,
  type: Joi.string()
    .valid(...COMPONENT_TYPES)
    .required(),
  version: Joi.number().integer().min(1),
  props: Joi.object().unknown(true),
  style: Joi.object().unknown(true).allow(null),
  analyticsId: Joi.string().trim().max(64).allow('', null)
});

const slideSchema = Joi.object({
  slideId: objectId,
  sortOrder: Joi.number().integer().min(0),
  type: Joi.string()
    .valid(...SLIDE_TYPES)
    .required(),
  sectionId: objectId,
  title: Joi.string().trim().max(300).allow('', null),
  body: Joi.string().trim().max(10000).allow('', null),
  bullets: Joi.array().items(Joi.string().trim().max(300)).max(8),
  highlight: Joi.string().trim().max(200).allow('', null),
  assetId: objectId,
  backgroundAssetId: objectId,
  iconKey: Joi.string().trim().max(64).allow('', null),
  durationHintSec: Joi.number().min(0).allow(null),
  isOfflineEligible: Joi.boolean(),
  components: Joi.array().items(componentSchema).max(20)
});

const sectionSchema = Joi.object({
  sectionId: objectId,
  key: Joi.string()
    .valid(...SECTION_KEYS)
    .required(),
  title: Joi.string().trim().max(200).allow('', null),
  sortOrder: Joi.number().integer().min(0),
  isOptional: Joi.boolean(),
  slideIds: Joi.array().items(Joi.string().hex().length(24)).max(50)
});

const themeSchema = Joi.object({
  primaryColor: Joi.string().trim().max(32),
  secondaryColor: Joi.string().trim().max(32),
  surfaceStyle: Joi.string().valid('dark', 'light', 'brandWash'),
  logoAssetId: objectId,
  backgroundAssetId: objectId,
  fontStyle: Joi.string().valid('modern', 'classic')
});

const createPresentationSchema = Joi.object({
  title: Joi.string().trim().max(200),
  audience: Joi.string().valid(
    'GENERAL',
    'CARDIOLOGIST',
    'GP',
    'PEDIATRICIAN',
    'GYNAECOLOGIST',
    'CUSTOM'
  ),
  origin: Joi.string().valid('MANUAL', 'AI_DRAFT'),
  theme: themeSchema,
  sections: Joi.array().items(sectionSchema).max(20),
  slides: Joi.array().items(slideSchema).default([])
});

const updatePresentationSchema = Joi.object({
  title: Joi.string().trim().max(200),
  audience: Joi.string().valid(
    'GENERAL',
    'CARDIOLOGIST',
    'GP',
    'PEDIATRICIAN',
    'GYNAECOLOGIST',
    'CUSTOM'
  ),
  theme: themeSchema,
  sections: Joi.array().items(sectionSchema).max(20),
  slides: Joi.array().items(slideSchema)
}).min(1);

module.exports = { createPresentationSchema, updatePresentationSchema };
