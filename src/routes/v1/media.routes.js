const express = require('express');
const router = express.Router();

const controller = require('../../controllers/media.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { validate } = require('../../middleware/validate');
const { clientUuid } = require('../../middleware/clientUuid');
const { presignSchema, finalizeSchema, linkSchema } = require('../../validators/media.validator');

router.use(authenticate, companyScope, clientUuid());

router.post('/presign', validate(presignSchema), controller.presign);
router.post('/finalize', validate(finalizeSchema), controller.finalize);
router.post('/link', validate(linkSchema), controller.link);
router.get('/:key(*)/signed-url', controller.signedUrl);

module.exports = router;
