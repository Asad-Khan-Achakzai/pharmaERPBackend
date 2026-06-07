const express = require('express');
const router = express.Router();
const c = require('../../controllers/notification.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');

router.use(authenticate, companyScope);
router.get('/feed', c.feed);
router.post('/:id/read', c.markRead);

module.exports = router;
