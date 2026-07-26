const Joi = require('joi');
const { defineTool } = require('../baseTool');
const orderService = require('../../../services/order.service');
const { resolveOrderVisibleMedicalRepIds } = require('../../../utils/orderScope.util');

const searchOrders = defineTool({
  name: 'search_orders',
  description: 'Search and list orders with optional filters (status, date range, pharmacy).',
  requiredPermissions: ['orders.view'],
  parameters: Joi.object({
    search: Joi.string().trim().allow('').max(200),
    status: Joi.string().trim().allow('').optional(),
    fromDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: Joi.number().integer().min(1).max(25).default(10)
  }),
  async run(ctx, params) {
    const visibleRepIds = await resolveOrderVisibleMedicalRepIds(ctx.companyId, ctx.user);
    const result = await orderService.list(
      ctx.companyId,
      {
        search: params.search,
        status: params.status,
        fromDate: params.fromDate,
        toDate: params.toDate,
        limit: params.limit,
        page: 1
      },
      ctx.timeZone,
      { visibleRepIds }
    );
    const docs = result.docs || [];
    return {
      total: result.total,
      count: docs.length,
      orders: docs.map((o) => ({
        id: String(o._id),
        orderNumber: o.orderNumber,
        status: o.status,
        pharmacyName: o.pharmacyId?.name || o.pharmacyName,
        netAmount: o.netAmount,
        createdAt: o.createdAt
      }))
    };
  }
});

module.exports = { searchOrders };
