const express = require('express');
const router = express.Router();
const c = require('../../controllers/doctorLocationSuggestion.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const {
  listDoctorLocationSuggestionsQuerySchema,
  rejectDoctorLocationSuggestionSchema
} = require('../../validators/doctorLocationSuggestion.validator');

router.use(authenticate, companyScope);

router.get(
  '/',
  checkPermission('doctorLocations.review'),
  validateQuery(listDoctorLocationSuggestionsQuerySchema),
  c.list
);
router.post(
  '/:id/approve',
  checkPermission('doctorLocations.review'),
  c.approve
);
router.post(
  '/:id/reject',
  checkPermission('doctorLocations.review'),
  validate(rejectDoctorLocationSuggestionSchema),
  c.reject
);

module.exports = router;
