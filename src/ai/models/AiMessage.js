const mongoose = require('mongoose');

const aiMessageSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiConversation', required: true, index: true },
    role: { type: String, enum: ['user', 'assistant', 'tool', 'system'], required: true },
    content: { type: String, default: '' },
    toolName: { type: String, default: null },
    toolCallId: { type: String, default: null },
    toolInput: { type: mongoose.Schema.Types.Mixed, default: null },
    toolOutput: { type: mongoose.Schema.Types.Mixed, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

aiMessageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports = mongoose.model('AiMessage', aiMessageSchema);
