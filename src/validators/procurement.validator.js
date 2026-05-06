const Joi = require('joi');

const poLineSchema = Joi.object({
  productId: Joi.string().trim().required(),
  orderedQty: Joi.number().positive().required(),
  unitPrice: Joi.number().min(0).optional(),
  notes: Joi.string().trim().allow('', null)
});

const createPurchaseOrderSchema = Joi.object({
  supplierId: Joi.string().trim().required(),
  notes: Joi.string().trim().allow('', null),
  lines: Joi.array().items(poLineSchema).min(1).required()
});

const updatePurchaseOrderSchema = createPurchaseOrderSchema;

const grnLineSchema = Joi.object({
  productId: Joi.string().trim().required(),
  purchaseOrderLineId: Joi.string().trim().allow(null, ''),
  qtyReceived: Joi.number().positive().required(),
  /** Landed unit cost (inventory) */
  unitCost: Joi.number().min(0).required(),
  /** Factory unit cost — supplier liability; optional for backward compatibility */
  factoryUnitCost: Joi.number().min(0).optional(),
  distributorId: Joi.string().trim().required(),
  notes: Joi.string().trim().allow('', null)
});

const createGoodsReceiptNoteSchema = Joi.object({
  purchaseOrderId: Joi.string().trim().required(),
  receivedAt: Joi.date().optional(),
  notes: Joi.string().trim().allow('', null),
  lines: Joi.array().items(grnLineSchema).min(1).required()
});

/** Same body as create (lines replace draft lines). */
const updateGoodsReceiptNoteSchema = Joi.object({
  receivedAt: Joi.date().optional(),
  notes: Joi.string().trim().allow('', null),
  totalShippingCost: Joi.number().min(0).optional(),
  lines: Joi.array().items(grnLineSchema).min(1).required()
});

const listPurchaseOrdersQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1),
  sortBy: Joi.string(),
  sortOrder: Joi.string().valid('asc', 'desc'),
  supplierId: Joi.string().trim(),
  status: Joi.string().trim()
});

const listGoodsReceiptNotesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1),
  sortBy: Joi.string(),
  sortOrder: Joi.string().valid('asc', 'desc'),
  purchaseOrderId: Joi.string().trim(),
  supplierId: Joi.string().trim(),
  status: Joi.string().trim()
});

const createSupplierInvoiceSchema = Joi.object({
  supplierId: Joi.string().trim().required(),
  purchaseOrderId: Joi.string().trim().allow(null, ''),
  grnIds: Joi.array().items(Joi.string().trim()).optional(),
  invoiceNumber: Joi.string().trim().allow('', null),
  invoiceDate: Joi.date().optional(),
  taxAmount: Joi.number().min(0),
  discountAmount: Joi.number().min(0),
  freightAmount: Joi.number().min(0),
  subTotalAmount: Joi.number().min(0),
  totalAmount: Joi.number().min(0),
  notes: Joi.string().trim().allow('', null)
});

const updateSupplierInvoiceSchema = Joi.object({
  purchaseOrderId: Joi.string().trim().allow(null, ''),
  grnIds: Joi.array().items(Joi.string().trim()),
  invoiceNumber: Joi.string().trim(),
  invoiceDate: Joi.date(),
  taxAmount: Joi.number().min(0),
  discountAmount: Joi.number().min(0),
  freightAmount: Joi.number().min(0),
  subTotalAmount: Joi.number().min(0),
  totalAmount: Joi.number().min(0),
  notes: Joi.string().trim().allow('', null)
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' });

const listSupplierInvoicesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1),
  sortBy: Joi.string(),
  sortOrder: Joi.string().valid('asc', 'desc'),
  supplierId: Joi.string().trim(),
  status: Joi.string().trim()
});

const purchaseReturnLineSchema = Joi.object({
  goodsReceiptLineId: Joi.string().trim().required(),
  qtyReturned: Joi.number().positive().required(),
  notes: Joi.string().trim().allow('', null)
});

const createPurchaseReturnSchema = Joi.object({
  grnId: Joi.string().trim().required(),
  notes: Joi.string().trim().allow('', null),
  reason: Joi.string().trim().allow('', null),
  lines: Joi.array().items(purchaseReturnLineSchema).min(1).required()
});

const updatePurchaseReturnSchema = Joi.object({
  notes: Joi.string().trim().allow('', null),
  reason: Joi.string().trim().allow('', null),
  lines: Joi.array().items(purchaseReturnLineSchema).min(1).required()
});

const postPurchaseReturnSchema = Joi.object({
  reason: Joi.string().trim().allow('', null)
});

const reverseGrnSchema = Joi.object({
  reason: Joi.string().trim().allow('', null).max(4000)
});

const cancelPurchaseOrderSchema = Joi.object({
  reason: Joi.string().trim().allow('', null).max(4000)
});

const listPurchaseReturnsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1),
  sortBy: Joi.string(),
  sortOrder: Joi.string().valid('asc', 'desc'),
  grnId: Joi.string().trim()
});

module.exports = {
  createPurchaseOrderSchema,
  updatePurchaseOrderSchema,
  createGoodsReceiptNoteSchema,
  updateGoodsReceiptNoteSchema,
  listPurchaseOrdersQuerySchema,
  listGoodsReceiptNotesQuerySchema,
  createSupplierInvoiceSchema,
  updateSupplierInvoiceSchema,
  listSupplierInvoicesQuerySchema,
  createPurchaseReturnSchema,
  updatePurchaseReturnSchema,
  postPurchaseReturnSchema,
  reverseGrnSchema,
  cancelPurchaseOrderSchema,
  listPurchaseReturnsQuerySchema
};
