/**
 * Product catalog search helpers.
 *
 * Phase G: MongoDB text index is the default. When Atlas Search is enabled
 * (env ATLAS_SEARCH_PRODUCTS_INDEX), swap the $text path for an aggregation
 * $search stage without changing API contracts.
 *
 * AI-ready: callers may log SEARCH / SEARCH_CLICK engagement events with the
 * raw query string (anonymized upstream if required).
 */
const Product = require('../models/Product');
const { escapeRegex, qScalar } = require('../utils/listQuery');

/**
 * @param {string} companyId
 * @param {{ search?: string, limit?: number, isActive?: boolean }} query
 * @returns {Promise<object[]>}
 */
async function searchProducts(companyId, query = {}) {
  const searchTerm = qScalar(query.search);
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
  const filter = { companyId };
  if (query.isActive !== undefined) {
    filter.isActive = query.isActive === 'true' || query.isActive === true;
  } else {
    filter.isActive = true;
  }

  if (!searchTerm) {
    return Product.find(filter)
      .select('name sku genericName packSize dosageForm strength brandId taxonomyPathLabels mrp tp')
      .sort({ name: 1 })
      .limit(limit)
      .lean();
  }

  // Future Atlas Search: set ATLAS_SEARCH_PRODUCTS_INDEX and implement $search here.
  const atlasIndex = process.env.ATLAS_SEARCH_PRODUCTS_INDEX;
  void atlasIndex;

  try {
    const textHits = await Product.find({
      ...filter,
      $text: { $search: searchTerm }
    })
      .select({
        name: 1,
        sku: 1,
        genericName: 1,
        packSize: 1,
        dosageForm: 1,
        strength: 1,
        brandId: 1,
        taxonomyPathLabels: 1,
        mrp: 1,
        tp: 1,
        score: { $meta: 'textScore' }
      })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean();
    if (textHits.length) return textHits;
  } catch {
    // Text index may not exist yet on fresh DBs — fall through to regex.
  }

  const rx = escapeRegex(searchTerm);
  return Product.find({
    ...filter,
    $or: [
      { name: { $regex: rx, $options: 'i' } },
      { sku: { $regex: rx, $options: 'i' } },
      { genericName: { $regex: rx, $options: 'i' } },
      { composition: { $regex: rx, $options: 'i' } },
      { manufacturer: { $regex: rx, $options: 'i' } },
      { indications: { $regex: rx, $options: 'i' } }
    ]
  })
    .select('name sku genericName packSize dosageForm strength brandId taxonomyPathLabels mrp tp')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
}

module.exports = { searchProducts };
