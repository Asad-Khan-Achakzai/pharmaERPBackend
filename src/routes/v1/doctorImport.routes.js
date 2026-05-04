const express = require('express');
const router = express.Router();

const c = require('../../controllers/doctorImport.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');

router.use(authenticate, companyScope);

/** Reuses the same permission as creating a single doctor — bulk import is just N creates. */
router.get('/template', checkPermission('doctors.create'), c.template);
router.post('/preview', checkPermission('doctors.create'), c.preview);
router.post('/commit', checkPermission('doctors.create'), c.commit);

module.exports = router;
