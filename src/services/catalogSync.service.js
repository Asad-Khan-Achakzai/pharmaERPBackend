const productService = require('./product.service');
const productTaxonomyService = require('./productTaxonomy.service');
const brandService = require('./brand.service');
const productPresentationService = require('./productPresentation.service');
const catalogCampaignService = require('./catalogCampaign.service');
const productKitService = require('./productKit.service');

/**
 * Unified catalog sync envelope for mobile offline bootstrap/delta.
 */
const catalogSync = async (companyId, query, reqUser) => {
  const sinceVersion = Math.max(0, Number(query.sinceVersion) || 0);
  const since = query.since || null;
  const productSync = await productService.sync(companyId, query, reqUser);

  const [taxonomy, brands, presentations, campaigns, kits] = await Promise.all([
    productTaxonomyService.lookup(companyId, { limit: 500 }),
    brandService.lookup(companyId, { limit: 500 }),
    productPresentationService.listPublishedDefaults(companyId, {
      since: since || undefined,
      limit: 300
    }),
    catalogCampaignService.listActive(companyId),
    productKitService.lookup(companyId, { limit: 200 })
  ]);

  return {
    products: productSync.items,
    deletedProductIds: productSync.deletedIds,
    maxVersion: productSync.maxVersion,
    hasMore: productSync.hasMore,
    lastId: productSync.lastId,
    taxonomy,
    brands,
    presentations,
    campaigns,
    kits,
    sinceVersion
  };
};

module.exports = { catalogSync };
