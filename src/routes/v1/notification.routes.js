const express = require('express');
const router = express.Router();
const c = require('../../controllers/notification.controller');
const analytics = require('../../controllers/notificationAnalytics.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');

router.use(authenticate, companyScope);
router.get('/feed', c.feed);
router.get('/unread-count', c.unreadCount);
router.get('/preferences', c.getPreferences);
router.put('/preferences', c.updatePreferences);
router.post('/read-all', c.markAllRead);
router.get('/analytics/health', checkPermission('admin.access'), analytics.health);
router.post('/analytics/rollup', checkPermission('admin.access'), analytics.rollup);
router.post('/:id/read', c.markRead);

module.exports = router;
