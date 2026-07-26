const express = require('express');
const router = express.Router();
const c = require('../controllers/aiChat.controller');
const admin = require('../controllers/aiAdmin.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const { requireAiCopilot } = require('../middleware/requireAiCopilot');
const { aiRateLimit } = require('../middleware/aiRateLimit');
const {
  chatBodySchema,
  createConversationSchema,
  listConversationsQuerySchema,
  confirmToolBodySchema
} = require('../validators/ai.validator');

router.use(authenticate, companyScope);

router.get('/status', requireAiCopilot(), checkPermission('copilot.use'), c.status);
router.get(
  '/suggested-prompts',
  requireAiCopilot(),
  checkPermission('copilot.use'),
  c.suggestedPrompts
);

router.post(
  '/conversations',
  requireAiCopilot(),
  checkPermission('copilot.use'),
  validate(createConversationSchema),
  c.createConversation
);
router.get(
  '/conversations',
  requireAiCopilot(),
  checkPermission('copilot.use'),
  validateQuery(listConversationsQuerySchema),
  c.listConversations
);
router.get(
  '/conversations/:id',
  requireAiCopilot(),
  checkPermission('copilot.use'),
  c.getConversation
);
router.delete(
  '/conversations/:id',
  requireAiCopilot(),
  checkPermission('copilot.use'),
  c.deleteConversation
);

router.post(
  '/chat',
  requireAiCopilot(),
  checkPermission('copilot.use'),
  aiRateLimit(),
  validate(chatBodySchema),
  c.chat
);
router.post(
  '/chat/stream',
  requireAiCopilot(),
  checkPermission('copilot.use'),
  aiRateLimit(),
  validate(chatBodySchema),
  c.chatStream
);

router.get(
  '/tools/write-catalog',
  requireAiCopilot(),
  checkPermission('copilot.use'),
  c.writeToolsCatalog
);
router.post(
  '/tools/execute-confirmed',
  requireAiCopilot(),
  checkPermission('copilot.use'),
  aiRateLimit(),
  validate(confirmToolBodySchema),
  c.executeConfirmedTool
);

router.get(
  '/admin/logs',
  requireAiCopilot(),
  checkPermission('admin.access'),
  admin.listLogs
);

module.exports = router;
