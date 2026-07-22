const express = require('express');
const router = express.Router();
const c = require('../../controllers/announcement.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createAnnouncementSchema } = require('../../validators/phase2.validator');

router.use(authenticate, companyScope);
router.get('/feed', c.feed);
router.get('/admin', checkPermission('admin.access'), c.adminList);
router.post('/', checkPermission('admin.access'), validate(createAnnouncementSchema), c.create);
router.post('/:id/publish', checkPermission('admin.access'), c.publish);

module.exports = router;
