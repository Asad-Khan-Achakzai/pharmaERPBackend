const Joi = require('joi');
const { UNPLANNED_VISIT_REASON } = require('../constants/enums');

const bulkPlanItemsSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        date: Joi.alternatives()
          .try(Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/), Joi.date())
          .required(),
        type: Joi.string().valid('DOCTOR_VISIT', 'OTHER_TASK'),
        doctorId: Joi.string().allow(null, ''),
        title: Joi.string().trim().allow('', null),
        notes: Joi.string().trim().allow(''),
        plannedTime: Joi.string().trim().max(32).allow('', null)
      })
    )
    .min(1)
    .required()
});

const markVisitSchema = Joi.object({
  notes: Joi.string().trim().allow(''),
  orderTaken: Joi.boolean(),
  visitTime: Joi.date(),
  checkInTime: Joi.date(),
  checkOutTime: Joi.date(),
  location: Joi.object({
    lat: Joi.number(),
    lng: Joi.number()
  }),
  doctorId: Joi.string().allow(null, ''),
  productsDiscussed: Joi.array().items(Joi.string().hex().length(24)).max(50),
  primaryProductId: Joi.string().hex().length(24).allow(null, ''),
  samplesQty: Joi.number().integer().min(0).allow(null),
  samplesGiven: Joi.string().trim().max(500).allow('', null),
  followUpDate: Joi.alternatives().try(Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/), Joi.date()).allow(null, ''),
  outOfOrderReason: Joi.string().trim().max(500).allow('', null)
});

const unplannedVisitSchema = Joi.object({
  doctorId: Joi.string().required(),
  unplannedReason: Joi.string()
    .valid(...Object.values(UNPLANNED_VISIT_REASON))
    .required(),
  notes: Joi.string().trim().allow(''),
  orderTaken: Joi.boolean(),
  visitTime: Joi.date(),
  checkInTime: Joi.date(),
  checkOutTime: Joi.date(),
  location: Joi.object({
    lat: Joi.number(),
    lng: Joi.number()
  }),
  productsDiscussed: Joi.array().items(Joi.string().hex().length(24)).max(50),
  primaryProductId: Joi.string().hex().length(24).allow(null, ''),
  samplesQty: Joi.number().integer().min(0).allow(null),
  samplesGiven: Joi.string().trim().max(500).allow('', null),
  followUpDate: Joi.alternatives().try(Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/), Joi.date()).allow(null, '')
});

const reorderPlanItemsSchema = Joi.object({
  weeklyPlanId: Joi.string().hex().length(24).required(),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  orderedPlanItemIds: Joi.array().items(Joi.string().hex().length(24)).min(1).required()
});

const updatePlanItemSchema = Joi.object({
  status: Joi.string().valid('PENDING', 'VISITED', 'MISSED'),
  notes: Joi.string().trim().allow('')
}).min(1);

const listTodayQuerySchema = Joi.object({
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  employeeId: Joi.string()
});

const visitSummaryQuerySchema = Joi.object({
  weekStart: Joi.string().required().pattern(/^\d{4}-\d{2}-\d{2}$/),
  weekEnd: Joi.string().required().pattern(/^\d{4}-\d{2}-\d{2}$/),
  employeeId: Joi.string()
});

const visitByEmployeeQuerySchema = Joi.object({
  weekStart: Joi.string().required().pattern(/^\d{4}-\d{2}-\d{2}$/),
  weekEnd: Joi.string().required().pattern(/^\d{4}-\d{2}-\d{2}$/)
});

module.exports = {
  bulkPlanItemsSchema,
  markVisitSchema,
  updatePlanItemSchema,
  unplannedVisitSchema,
  listTodayQuerySchema,
  reorderPlanItemsSchema,
  visitSummaryQuerySchema,
  visitByEmployeeQuerySchema
};
