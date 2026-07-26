const mongoose = require('mongoose');

const aiConversationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, trim: true, default: 'New conversation', maxlength: 200 },
    lastMessageAt: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 0 },
    isArchived: { type: Boolean, default: false }
  },
  { timestamps: true }
);

aiConversationSchema.index({ companyId: 1, userId: 1, lastMessageAt: -1 });

module.exports = mongoose.model('AiConversation', aiConversationSchema);
