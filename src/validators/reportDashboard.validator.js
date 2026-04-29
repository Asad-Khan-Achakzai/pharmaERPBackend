const Joi = require('joi');

/** Optional YYYY-MM-DD pair; both or neither (used for /reports/dashboard and /dashboard/home KPIs). */
const dashboardQuerySchema = Joi.object({
  from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
}).custom((v, helpers) => {
  const f = v.from;
  const t = v.to;
  if ((f && !t) || (!f && t)) {
    return helpers.error('any.custom', { message: 'from and to must be provided together' });
  }
  return v;
});

module.exports = { dashboardQuerySchema };
