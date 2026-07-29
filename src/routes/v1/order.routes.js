const express = require('express');
const router = express.Router();
const c = require('../../controllers/order.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const {
  createOrderSchema,
  updateOrderSchema,
  deliverOrderSchema,
  returnOrderSchema,
  amendOrderSchema
} = require('../../validators/order.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('orders.view'), c.list);
router.post('/', checkPermission('orders.create'), validate(createOrderSchema), c.create);
router.get('/:orderId/deliveries/:deliveryId/invoice', checkPermission('orders.view'), c.downloadDeliveryInvoice);
router.get('/:id/receipt', checkPermission('orders.view'), c.downloadOrderReceipt);
router.get('/:id/amendments', checkPermission('orders.view'), c.listAmendments);
router.get('/:id/amendments/:amendmentId', checkPermission('orders.view'), c.getAmendment);
router.get(
  '/:id/amendments/:amendmentId/credit-note',
  checkPermission('orders.view'),
  c.downloadAmendmentCreditNote
);
router.get('/:id/credit-notes', checkPermission('orders.view'), c.listCreditNotes);
router.get('/:id/credit-notes/:creditNoteId', checkPermission('orders.view'), c.getCreditNote);
router.get(
  '/:id/credit-notes/:creditNoteId/pdf',
  checkPermission('orders.view'),
  c.downloadCreditNote
);
router.post(
  '/:id/amendments/preview',
  checkPermission('orders.amend'),
  validate(amendOrderSchema),
  c.previewAmendment
);
router.post('/:id/amendments', checkPermission('orders.amend'), validate(amendOrderSchema), c.createAmendment);
router.get('/:id', checkPermission('orders.view'), c.getById);
router.put('/:id', checkPermission('orders.edit'), validate(updateOrderSchema), c.update);
router.post('/:id/deliver', checkPermission('orders.deliver'), validate(deliverOrderSchema), c.deliver);
router.post('/:id/return', checkPermission('orders.return'), validate(returnOrderSchema), c.returnOrder);
router.delete('/:id', checkPermission('orders.edit'), c.cancel);

module.exports = router;
