const express = require('express');
const router = express.Router();
const po = require('../../controllers/purchaseOrder.controller');
const grn = require('../../controllers/goodsReceipt.controller');
const invoice = require('../../controllers/supplierInvoice.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const {
  createPurchaseOrderSchema,
  createGoodsReceiptNoteSchema,
  listPurchaseOrdersQuerySchema,
  listGoodsReceiptNotesQuerySchema,
  createSupplierInvoiceSchema,
  updatePurchaseOrderSchema,
  updateGoodsReceiptNoteSchema,
  updateSupplierInvoiceSchema,
  listSupplierInvoicesQuerySchema
} = require('../../validators/procurement.validator');

router.use(authenticate, companyScope);

router.get('/purchase-orders', checkPermission('procurement.view'), validateQuery(listPurchaseOrdersQuerySchema), po.list);
router.post('/purchase-orders', checkPermission('procurement.create'), validate(createPurchaseOrderSchema), po.create);
router.get('/purchase-orders/:id', checkPermission('procurement.view'), po.getById);
router.patch('/purchase-orders/:id', checkPermission('procurement.create'), validate(updatePurchaseOrderSchema), po.update);
router.post('/purchase-orders/:id/approve', checkPermission('procurement.approve'), po.approve);

router.get('/goods-receipt-notes', checkPermission('procurement.view'), validateQuery(listGoodsReceiptNotesQuerySchema), grn.list);
router.post('/goods-receipt-notes', checkPermission('procurement.create'), validate(createGoodsReceiptNoteSchema), grn.create);
router.get('/goods-receipt-notes/:id', checkPermission('procurement.view'), grn.getById);
router.patch('/goods-receipt-notes/:id', checkPermission('procurement.create'), validate(updateGoodsReceiptNoteSchema), grn.update);
router.post('/goods-receipt-notes/:id/post', checkPermission('procurement.receive'), grn.post);

router.get('/supplier-invoices', checkPermission('procurement.view'), validateQuery(listSupplierInvoicesQuerySchema), invoice.list);
router.post('/supplier-invoices', checkPermission('procurement.create'), validate(createSupplierInvoiceSchema), invoice.create);
router.get('/supplier-invoices/:id', checkPermission('procurement.view'), invoice.getById);
router.patch('/supplier-invoices/:id', checkPermission('procurement.create'), validate(updateSupplierInvoiceSchema), invoice.update);
router.post('/supplier-invoices/:id/post', checkPermission('procurement.invoicePost'), invoice.post);

module.exports = router;
