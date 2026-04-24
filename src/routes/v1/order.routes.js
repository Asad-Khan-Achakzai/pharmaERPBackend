const express = require('express');
const router = express.Router();
const c = require('../../controllers/order.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createOrderSchema, updateOrderSchema, deliverOrderSchema, returnOrderSchema } = require('../../validators/order.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('orders.view'), c.list);
router.post('/', checkPermission('orders.create'), validate(createOrderSchema), c.create);
router.get('/:id', checkPermission('orders.view'), c.getById);
router.put('/:id', checkPermission('orders.edit'), validate(updateOrderSchema), c.update);
router.post('/:id/deliver', checkPermission('orders.deliver'), validate(deliverOrderSchema), c.deliver);
router.post('/:id/return', checkPermission('orders.return'), validate(returnOrderSchema), c.returnOrder);
router.delete('/:id', checkPermission('orders.edit'), c.cancel);

module.exports = router;
