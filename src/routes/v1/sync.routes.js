const express = require('express');
const router = express.Router();

const controller = require('../../controllers/sync.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');

router.get('/server-time', controller.serverTime);
router.get('/server-config', authenticate, companyScope, controller.serverConfig);

module.exports = router;
