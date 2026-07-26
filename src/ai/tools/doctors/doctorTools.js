const Joi = require('joi');
const { defineTool } = require('../baseTool');
const doctorService = require('../../../services/doctor.service');
const lookupService = require('../../../services/lookup.service');
const { userHasTenantWideAccess } = require('../../../utils/effectivePermissions');

const searchDoctors = defineTool({
  name: 'search_doctors',
  description:
    'Search doctors by name or specialty. Returns a SAMPLE of matching records (max 25) — NOT total counts. For "how many doctors", use doctor_summary instead.',
  requiredPermissions: ['doctors.view', 'weeklyPlans.view'],
  parameters: Joi.object({
    search: Joi.string().trim().allow('').max(200),
    limit: Joi.number().integer().min(1).max(25).default(10)
  }),
  async run(ctx, params) {
    const query = { search: params.search, limit: params.limit };
    if (!userHasTenantWideAccess(ctx.user)) {
      query.assignedRepId = String(ctx.userId);
    }
    const rows = await lookupService.doctors(ctx.companyId, query);
    return {
      sampleSize: rows.length,
      sampleLimit: params.limit,
      isSample: true,
      doctors: rows.map((d) => ({
        id: String(d._id),
        name: d.name,
        specialty: d.specialization,
        city: d.city
      }))
    };
  }
});

const doctorProfile = defineTool({
  name: 'doctor_profile',
  description: 'Get detailed profile for a specific doctor by ID.',
  requiredPermissions: ['doctors.view', 'weeklyPlans.view'],
  parameters: Joi.object({
    doctorId: Joi.string().hex().length(24).required()
  }),
  async run(ctx, params) {
    const doc = await doctorService.getById(ctx.companyId, params.doctorId);
    if (!userHasTenantWideAccess(ctx.user)) {
      const owned = await lookupService.doctors(ctx.companyId, {
        assignedRepId: String(ctx.userId),
        limit: 100
      });
      if (!owned.some((d) => String(d._id) === String(doc._id))) {
        throw new Error('Doctor not found or not accessible.');
      }
    }
    return {
      id: String(doc._id),
      name: doc.name,
      specialty: doc.specialization,
      phone: doc.phone || doc.mobileNo,
      city: doc.city,
      address: doc.address,
      tier: doc.tier,
      monthlyVisitTarget: doc.monthlyVisitTarget
    };
  }
});

module.exports = { searchDoctors, doctorProfile };
