const Joi = require('joi');
const { defineTool } = require('../baseTool');
const orderService = require('../../../services/order.service');
const auditService = require('../../../services/audit.service');

const createOrder = defineTool({
  name: 'create_order',
  description: 'Create a new order. Requires explicit user confirmation before execution.',
  mutability: 'write',
  requiredPermissions: ['orders.create'],
  parameters: Joi.object({
    pharmacyId: Joi.string().hex().length(24).required(),
    distributorId: Joi.string().hex().length(24).required(),
    items: Joi.array()
      .items(
        Joi.object({
          productId: Joi.string().hex().length(24).required(),
          quantity: Joi.number().integer().min(1).required()
        })
      )
      .min(1)
      .required(),
    notes: Joi.string().trim().max(500).allow('', null)
  }),
  async run(ctx, params) {
    const order = await orderService.create(ctx.companyId, params, ctx.user, ctx.timeZone);
    await auditService.log({
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: 'ORDER_CREATE_AI',
      entityType: 'Order',
      entityId: order._id,
      changes: { source: 'ai_copilot_confirmed' }
    });
    return {
      id: String(order._id),
      orderNumber: order.orderNumber,
      status: order.status,
      netAmount: order.netAmount
    };
  }
});

module.exports = { createOrder };
