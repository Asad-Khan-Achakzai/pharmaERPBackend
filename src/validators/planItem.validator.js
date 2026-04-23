const Joi = require('joi');

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
        notes: Joi.string().trim().allow('')
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
  doctorId: Joi.string().allow(null, '')
});

const unplannedVisitSchema = Joi.object({
  doctorId: Joi.string().required(),
  notes: Joi.string().trim().allow(''),
  orderTaken: Joi.boolean(),
  visitTime: Joi.date(),
  checkInTime: Joi.date(),
  checkOutTime: Joi.date(),
  location: Joi.object({
    lat: Joi.number(),
    lng: Joi.number()
  })
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
  visitSummaryQuerySchema,
  visitByEmployeeQuerySchema
};
