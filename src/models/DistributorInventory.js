const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const distributorInventorySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    distributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Distributor', required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, default: 0 },
    avgCostPerUnit: { type: Number, default: 0 },
    lastUpdated: { type: Date }
  },
  { timestamps: true }
);

distributorInventorySchema.index({ companyId: 1, distributorId: 1, productId: 1 }, { unique: true });
distributorInventorySchema.index({ companyId: 1, distributorId: 1 });

distributorInventorySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('DistributorInventory', distributorInventorySchema);
