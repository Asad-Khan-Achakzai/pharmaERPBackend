const mongoose = require('mongoose');

/**
 * Mongoose plugin that adds soft-delete capability and user-tracking fields.
 *
 * Fields added:
 *   createdBy  – ObjectId ref User (set once on creation)
 *   updatedBy  – ObjectId ref User (set on every update)
 *   deletedBy  – ObjectId ref User (set when soft-deleted)
 *   isDeleted  – Boolean, default false, indexed
 *   deletedAt  – Date, null until soft-deleted
 *
 * Query middleware auto-injects { isDeleted: { $ne: true } } on
 * find / findOne / findOneAndUpdate / findOneAndDelete / countDocuments
 * unless the caller explicitly includes `isDeleted` in the filter.
 *
 * Aggregation pipelines are NOT auto-filtered — add the match manually.
 */
function softDeletePlugin(schema) {
  schema.add({
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null }
  });

  const autoFilterMethods = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'countDocuments'
  ];

  for (const method of autoFilterMethods) {
    schema.pre(method, function () {
      const filter = this.getFilter();

      if (!Object.prototype.hasOwnProperty.call(filter, 'isDeleted')) {
        this.where({ isDeleted: { $ne: true } });
      }
    });
  }

  schema.methods.softDelete = function (userId) {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = userId || null;
    return this.save();
  };

  schema.statics.findWithDeleted = function (filter = {}) {
    return this.find({ ...filter, isDeleted: { $exists: true } });
  };

  schema.statics.findDeleted = function (filter = {}) {
    return this.find({ ...filter, isDeleted: true });
  };
}

module.exports = { softDeletePlugin };
