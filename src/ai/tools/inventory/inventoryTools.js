const Joi = require('joi');
const { defineTool } = require('../baseTool');
const inventoryService = require('../../../services/inventory.service');

const stockLookup = defineTool({
  name: 'stock_lookup',
  description:
    'Look up distributor inventory / stock levels for specific products or distributors. Returns a sample of rows — for overall inventory totals use warehouse_stock.',
  requiredPermissions: ['inventory.view'],
  parameters: Joi.object({
    search: Joi.string().trim().allow('').max(200),
    distributorId: Joi.string().hex().length(24).optional(),
    limit: Joi.number().integer().min(1).max(25).default(15)
  }),
  async run(ctx, params) {
    if (params.distributorId) {
      const rows = await inventoryService.getByDistributor(ctx.companyId, params.distributorId);
      return { count: rows.length, stock: rows.slice(0, params.limit) };
    }
    const result = await inventoryService.getAll(ctx.companyId, {
      search: params.search,
      limit: params.limit,
      page: 1
    });
    const docs = result.docs || [];
    return {
      totalMatching: result.total ?? docs.length,
      sampleSize: docs.length,
      sampleLimit: params.limit,
      isSample: true,
      stock: docs.slice(0, params.limit)
    };
  }
});

const warehouseStock = defineTool({
  name: 'warehouse_stock',
  description: 'Get inventory summary across all distributors.',
  requiredPermissions: ['inventory.view'],
  parameters: Joi.object({}),
  async run(ctx) {
    const full = await inventoryService.getSummary(ctx.companyId);
    const rows = full.byProduct || [];
    return {
      totals: full.totals,
      productLineCount: rows.length,
      topProductsByQuantity: rows
        .slice()
        .sort((a, b) => (b.totalQuantity || 0) - (a.totalQuantity || 0))
        .slice(0, 15)
        .map((r) => ({
          productName: r.productName,
          totalQuantity: r.totalQuantity,
          totalValue: r.totalValue,
          distributorCount: r.distributorCount
        }))
    };
  }
});

module.exports = { stockLookup, warehouseStock };
