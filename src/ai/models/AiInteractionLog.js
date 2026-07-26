const mongoose = require('mongoose');

const aiInteractionLogSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiConversation', default: null },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    question: { type: String, default: '' },
    response: { type: String, default: '' },
    toolCalls: { type: [mongoose.Schema.Types.Mixed], default: [] },
    durationMs: { type: Number, default: 0 },
    success: { type: Boolean, default: true },
    errorMessage: { type: String, default: null },
    clientContext: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

aiInteractionLogSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model('AiInteractionLog', aiInteractionLogSchema);
