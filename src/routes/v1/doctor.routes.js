const express = require('express');
const router = express.Router();
const c = require('../../controllers/doctor.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createDoctorSchema, updateDoctorSchema } = require('../../validators/doctor.validator');

router.use(authenticate, companyScope);
router.get('/lookup', allowLookupAccess, c.lookup);
router.get('/', checkPermission('doctors.view'), c.list);
router.post('/', checkPermission('doctors.create'), validate(createDoctorSchema), c.create);
router.get('/:id', checkPermission('doctors.view'), c.getById);
router.put('/:id', checkPermission('doctors.edit'), validate(updateDoctorSchema), c.update);
router.delete('/:id', checkPermission('doctors.delete'), c.remove);

module.exports = router;
