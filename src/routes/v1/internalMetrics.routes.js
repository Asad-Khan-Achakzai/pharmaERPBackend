const express = require('express');
const router = express.Router();
const c = require('../../controllers/trackingMetrics.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');

router.use(authenticate, companyScope);

router.post('/tracking', c.ingest);

module.exports = router;
