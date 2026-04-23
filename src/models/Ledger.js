const mongoose = require('mongoose');
const { LEDGER_TYPE, LEDGER_ENTITY_TYPE, LEDGER_REFERENCE_TYPE } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const ledgerSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    entityType: { type: String, enum: Object.values(LEDGER_ENTITY_TYPE), default: LEDGER_ENTITY_TYPE.PHARMACY },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    type: { type: String, enum: Object.values(LEDGER_TYPE), required: true },
    amount: { type: Number, required: true },
    referenceType: { type: String, enum: Object.values(LEDGER_REFERENCE_TYPE), required: true },
    referenceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    description: { type: String },
    date: { type: Date, default: Date.now },
    meta: {
      deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRecord' },
      orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
      portion: { type: String }
    }
  },
  { timestamps: true }
);

ledgerSchema.index({ companyId: 1, entityId: 1, entityType: 1, date: -1 });
ledgerSchema.index({ companyId: 1, referenceId: 1, referenceType: 1 });
ledgerSchema.index({ companyId: 1, date: -1 });

ledgerSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Ledger', ledgerSchema);
