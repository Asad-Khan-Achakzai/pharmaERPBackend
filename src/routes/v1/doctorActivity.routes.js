const express = require('express');
const router = express.Router();
const c = require('../../controllers/doctorActivity.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createDoctorActivitySchema, updateDoctorActivitySchema } = require('../../validators/doctorActivity.validator');

router.use(authenticate, companyScope);

router.get('/', checkPermission('doctors.view'), c.list);
router.post('/', checkPermission('doctors.create'), validate(createDoctorActivitySchema), c.create);
router.get('/doctor/:doctorId', checkPermission('doctors.view'), c.getByDoctor);
router.get('/:id', checkPermission('doctors.view'), c.getById);
router.put('/:id', checkPermission('doctors.edit'), validate(updateDoctorActivitySchema), c.update);
router.post('/:id/recalculate', checkPermission('doctors.edit'), c.recalculate);

module.exports = router;
