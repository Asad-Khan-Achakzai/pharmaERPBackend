const Joi = require('joi');
const Doctor = require('../../../models/Doctor');
const { defineTool } = require('../baseTool');
const doctorService = require('../../../services/doctor.service');
const pharmacyService = require('../../../services/pharmacy.service');
const productService = require('../../../services/product.service');
const distributorService = require('../../../services/distributor.service');
const { userHasTenantWideAccess } = require('../../../utils/effectivePermissions');

async function doctorTotals(ctx, activeOnly) {
  const query = { limit: 1, page: 1 };
  if (activeOnly) query.isActive = 'true';
  if (!userHasTenantWideAccess(ctx.user)) {
    query.assignedRepId = String(ctx.userId);
  }
  const { total } = await doctorService.list(ctx.companyId, query, ctx.timeZone);
  const scope = userHasTenantWideAccess(ctx.user) ? 'company' : 'assigned_territory';
  return { total, scope };
}

const doctorSummary = defineTool({
  name: 'doctor_summary',
  description:
    'Get total doctor count and high-level breakdown for the company or the user\'s assigned scope. Use this for "how many doctors" questions — NOT search_doctors.',
  requiredPermissions: ['doctors.view', 'weeklyPlans.view'],
  parameters: Joi.object({
    activeOnly: Joi.boolean().default(true)
  }),
  async run(ctx, params) {
    const { total, scope } = await doctorTotals(ctx, params.activeOnly);
    const result = {
      scope,
      totalDoctors: total,
      activeOnly: params.activeOnly
    };

    if (scope === 'company') {
      const base = { companyId: ctx.companyId };
      if (params.activeOnly) base.isActive = true;

      const [missingCity, topSpecialties, unassignedRep] = await Promise.all([
        Doctor.countDocuments({
          ...base,
          $or: [{ city: { $exists: false } }, { city: null }, { city: '' }]
        }),
        Doctor.aggregate([
          { $match: { ...base, specialization: { $nin: [null, ''] } } },
          { $group: { _id: '$specialization', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 }
        ]),
        Doctor.countDocuments({ ...base, assignedRepId: null })
      ]);

      result.dataQuality = {
        missingCityCount: missingCity,
        unassignedRepCount: unassignedRep
      };
      result.topSpecialties = topSpecialties.map((r) => ({
        specialty: r._id,
        count: r.count
      }));
    } else {
      result.note = 'Totals reflect doctors in your assigned territory only.';
    }

    return result;
  }
});

const pharmacySummary = defineTool({
  name: 'pharmacy_summary',
  description:
    'Get total pharmacy count for the company. Use for "how many pharmacies" questions.',
  requiredPermissions: ['pharmacies.view'],
  parameters: Joi.object({
    activeOnly: Joi.boolean().default(true)
  }),
  async run(ctx, params) {
    const query = { limit: 1, page: 1 };
    if (params.activeOnly) query.isActive = 'true';
    const { total } = await pharmacyService.list(ctx.companyId, query, ctx.timeZone);
    return { scope: 'company', totalPharmacies: total, activeOnly: params.activeOnly };
  }
});

const productSummary = defineTool({
  name: 'product_summary',
  description:
    'Get total product/SKU count for the company. Use for "how many products" questions.',
  requiredPermissions: ['products.view'],
  parameters: Joi.object({
    activeOnly: Joi.boolean().default(true)
  }),
  async run(ctx, params) {
    const query = { limit: 1, page: 1 };
    if (params.activeOnly) query.isActive = 'true';
    const { total } = await productService.list(ctx.companyId, query, ctx.user, ctx.timeZone);
    return { scope: 'company', totalProducts: total, activeOnly: params.activeOnly };
  }
});

const distributorSummary = defineTool({
  name: 'distributor_summary',
  description:
    'Get total distributor count for the company. Use for "how many distributors" questions.',
  requiredPermissions: ['distributors.view'],
  parameters: Joi.object({
    activeOnly: Joi.boolean().default(true)
  }),
  async run(ctx, params) {
    const query = { limit: 1, page: 1 };
    if (params.activeOnly) query.isActive = 'true';
    const { total } = await distributorService.list(ctx.companyId, query, ctx.timeZone);
    return { scope: 'company', totalDistributors: total, activeOnly: params.activeOnly };
  }
});

module.exports = { doctorSummary, pharmacySummary, productSummary, distributorSummary };
