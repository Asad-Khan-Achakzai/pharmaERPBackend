const mongoose = require('mongoose');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Per-company, per-day sequence: ORD-YYYYMMDD-####
 * Max sequence is computed numerically (not lexicographic string sort) so e.g. ...-1000 sorts after ...-999.
 */
const generateOrderNumber = async (Model, companyId, prefix = 'ORD') => {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const pattern = `${prefix}-${dateStr}-`;
  const companyObjectId = typeof companyId === 'string' ? new mongoose.Types.ObjectId(companyId) : companyId;
  const regex = new RegExp(`^${escapeRegex(pattern)}`);

  const [row] = await Model.aggregate([
    { $match: { companyId: companyObjectId, orderNumber: { $regex: regex } } },
    {
      $project: {
        seq: {
          $convert: {
            input: { $ifNull: [{ $arrayElemAt: [{ $split: ['$orderNumber', '-'] }, 2] }, '0'] },
            to: 'int',
            onError: 0,
            onNull: 0
          }
        }
      }
    },
    { $group: { _id: null, maxSeq: { $max: '$seq' } } }
  ]);

  const nextSeq = (row && Number.isFinite(row.maxSeq) ? row.maxSeq : 0) + 1;
  // 4 digits supports up to 9999 orders/day; padding avoids lexicographic bugs vs older 3-digit rows
  return `${pattern}${String(nextSeq).padStart(4, '0')}`;
};

module.exports = { generateOrderNumber };
