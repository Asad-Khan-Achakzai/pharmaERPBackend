const express = require('express');
const router = express.Router();
const c = require('../../controllers/supplier.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const {
  createSchema,
  updateSchema,
  ledgerEntrySchema,
  paymentRecordSchema,
  paymentUpdateSchema,
  paymentReverseSchema
} = require('../../validators/supplier.validator');
const Joi = require('joi');

const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
  sort: Joi.string(),
  isActive: Joi.string().valid('true', 'false')
});

const recentPaymentsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(50)
});

router.use(authenticate, companyScope);

router.get('/lookup', allowLookupAccess, c.lookup);
router.get('/balances/summary', checkPermission('suppliers.view'), c.balancesSummary);
router.get(
  '/payments/recent',
  checkPermission('suppliers.view'),
  validateQuery(recentPaymentsQuerySchema),
  c.recentPayments
);
router.get('/payments/:ledgerId/invoice', checkPermission('suppliers.view'), c.paymentInvoice);
router.get('/', checkPermission('suppliers.view'), validateQuery(listQuerySchema), c.list);
router.post('/', checkPermission('suppliers.manage'), validate(createSchema), c.create);
router.get('/:id/payments', checkPermission('suppliers.view'), c.listPayments);
router.patch(
  '/:id/payments/:ledgerId',
  checkPermission('suppliers.manage'),
  validate(paymentUpdateSchema),
  c.updatePayment
);
router.post(
  '/:id/payments/:ledgerId/reverse',
  checkPermission('suppliers.manage'),
  validate(paymentReverseSchema),
  c.reversePayment
);
router.get('/:id/ledger', checkPermission('suppliers.view'), c.ledger);
router.get('/:id/balance', checkPermission('suppliers.view'), c.balance);
router.post('/:id/payments', checkPermission('suppliers.manage'), validate(paymentRecordSchema), c.recordPayment);
router.post('/:id/purchases', checkPermission('suppliers.manage'), validate(ledgerEntrySchema), c.recordPurchase);
router.get('/:id', checkPermission('suppliers.view'), c.getById);
router.put('/:id', checkPermission('suppliers.manage'), validate(updateSchema), c.update);
router.delete('/:id', checkPermission('suppliers.manage'), c.remove);

module.exports = router;
