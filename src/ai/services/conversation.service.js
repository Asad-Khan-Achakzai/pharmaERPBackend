const ApiError = require('../../utils/ApiError');
const aiEnv = require('../config/aiEnv');
const AiConversation = require('../models/AiConversation');
const AiMessage = require('../models/AiMessage');

async function assertConversationAccess(companyId, userId, conversationId) {
  const conv = await AiConversation.findOne({
    _id: conversationId,
    companyId,
    userId,
    isArchived: { $ne: true }
  });
  if (!conv) throw new ApiError(404, 'Conversation not found');
  return conv;
}

async function createConversation(companyId, userId, title) {
  return AiConversation.create({
    companyId,
    userId,
    title: title || 'New conversation'
  });
}

async function listConversations(companyId, userId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const filter = { companyId, userId, isArchived: { $ne: true } };
  const [docs, total] = await Promise.all([
    AiConversation.find(filter).sort({ lastMessageAt: -1 }).skip(skip).limit(limit).lean(),
    AiConversation.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
}

async function getConversationWithMessages(companyId, userId, conversationId) {
  const conv = await assertConversationAccess(companyId, userId, conversationId);
  const messages = await AiMessage.find({ companyId, conversationId })
    .sort({ createdAt: 1 })
    .lean();
  return { conversation: conv, messages };
}

async function archiveConversation(companyId, userId, conversationId) {
  const conv = await assertConversationAccess(companyId, userId, conversationId);
  conv.isArchived = true;
  await conv.save();
  return conv;
}

async function loadHistoryForLlm(companyId, conversationId, maxHistory = aiEnv.maxHistory) {
  const messages = await AiMessage.find({
    companyId,
    conversationId,
    role: { $in: ['user', 'assistant', 'tool'] }
  })
    .sort({ createdAt: -1 })
    .limit(maxHistory)
    .lean();

  return messages.reverse().map((m) => ({
    role: m.role,
    content: m.content,
    toolCallId: m.toolCallId,
    toolName: m.toolName
  }));
}

async function appendMessage(companyId, conversationId, payload) {
  const msg = await AiMessage.create({
    companyId,
    conversationId,
    ...payload
  });

  await AiConversation.findByIdAndUpdate(conversationId, {
    $inc: { messageCount: 1 },
    lastMessageAt: new Date(),
    ...(payload.role === 'user' && payload.content
      ? { title: String(payload.content).slice(0, 80) }
      : {})
  });

  return msg;
}

module.exports = {
  createConversation,
  listConversations,
  getConversationWithMessages,
  archiveConversation,
  loadHistoryForLlm,
  appendMessage,
  assertConversationAccess
};
