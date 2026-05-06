const express = require('express');
const router = express.Router();
const po = require('../../controllers/purchaseOrder.controller');
const grn = require('../../controllers/goodsReceipt.controller');
const invoice = require('../../controllers/supplierInvoice.controller');
const purchaseReturn = require('../../controllers/purchaseReturn.controller');
const reverseGrn = require('../../controllers/reverseGrn.controller');
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
  listSupplierInvoicesQuerySchema,
  createPurchaseReturnSchema,
  updatePurchaseReturnSchema,
  postPurchaseReturnSchema,
  reverseGrnSchema,
  cancelPurchaseOrderSchema,
  listPurchaseReturnsQuerySchema
} = require('../../validators/procurement.validator');

router.use(authenticate, companyScope);

router.get('/purchase-orders', checkPermission('procurement.view'), validateQuery(listPurchaseOrdersQuerySchema), po.list);
router.post('/purchase-orders', checkPermission('procurement.create'), validate(createPurchaseOrderSchema), po.create);
router.get('/purchase-orders/:id', checkPermission('procurement.view'), po.getById);
router.patch('/purchase-orders/:id', checkPermission('procurement.create'), validate(updatePurchaseOrderSchema), po.update);
router.post('/purchase-orders/:id/approve', checkPermission('procurement.approve'), po.approve);
router.post('/purchase-orders/:id/cancel', checkPermission('procurement.cancelPo'), validate(cancelPurchaseOrderSchema), po.cancel);

router.get('/goods-receipt-notes', checkPermission('procurement.view'), validateQuery(listGoodsReceiptNotesQuerySchema), grn.list);
router.post('/goods-receipt-notes', checkPermission('procurement.create'), validate(createGoodsReceiptNoteSchema), grn.create);
router.get(
  '/goods-receipt-notes/:grnId/returnable-quantities',
  checkPermission('procurement.view'),
  purchaseReturn.returnableForGrn
);
router.get('/goods-receipt-notes/:id', checkPermission('procurement.view'), grn.getById);
router.patch('/goods-receipt-notes/:id', checkPermission('procurement.create'), validate(updateGoodsReceiptNoteSchema), grn.update);
router.post('/goods-receipt-notes/:id/post', checkPermission('procurement.receive'), grn.post);
router.post('/goods-receipt-notes/:id/reverse', checkPermission('procurement.grnReverse'), validate(reverseGrnSchema), reverseGrn.reversePosted);

router.get(
  '/purchase-returns',
  checkPermission('procurement.view'),
  validateQuery(listPurchaseReturnsQuerySchema),
  purchaseReturn.list
);
router.post('/purchase-returns', checkPermission('procurement.return'), validate(createPurchaseReturnSchema), purchaseReturn.create);
router.get('/purchase-returns/:id', checkPermission('procurement.view'), purchaseReturn.getById);
router.patch('/purchase-returns/:id', checkPermission('procurement.return'), validate(updatePurchaseReturnSchema), purchaseReturn.update);
router.post(
  '/purchase-returns/:id/post',
  checkPermission('procurement.return'),
  validate(postPurchaseReturnSchema),
  purchaseReturn.post
);

router.get('/supplier-invoices', checkPermission('procurement.view'), validateQuery(listSupplierInvoicesQuerySchema), invoice.list);
router.post('/supplier-invoices', checkPermission('procurement.create'), validate(createSupplierInvoiceSchema), invoice.create);
router.get('/supplier-invoices/:id', checkPermission('procurement.view'), invoice.getById);
router.patch('/supplier-invoices/:id', checkPermission('procurement.create'), validate(updateSupplierInvoiceSchema), invoice.update);
router.post('/supplier-invoices/:id/post', checkPermission('procurement.invoicePost'), invoice.post);

module.exports = router;
