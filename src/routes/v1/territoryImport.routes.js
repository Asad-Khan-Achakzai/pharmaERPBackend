const express = require('express');
const router = express.Router();

const c = require('../../controllers/territoryImport.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { territoryImportPreviewSchema, territoryImportCommitSchema } = require('../../validators/territoryImport.validator');

router.use(authenticate, companyScope);

router.get('/template', checkPermission('territories.manage'), c.template);
router.post('/preview', checkPermission('territories.manage'), validate(territoryImportPreviewSchema), c.preview);
router.post('/commit', checkPermission('territories.manage'), validate(territoryImportCommitSchema), c.commit);

module.exports = router;
