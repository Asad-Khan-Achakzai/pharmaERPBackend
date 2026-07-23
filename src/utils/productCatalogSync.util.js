const mongoose = require('mongoose');

/**
 * Build a Mongo filter for product delta sync using (catalogVersion, _id) cursor pagination.
 * When sinceId is omitted, returns rows with catalogVersion > sinceVersion (first page).
 */
function buildProductSyncFilter(companyId, sinceVersion, sinceId) {
  const version = Math.max(0, Number(sinceVersion) || 0);
  const base = { companyId };

  if (!sinceId) {
    return { ...base, catalogVersion: { $gt: version } };
  }

  let objectId;
  try {
    objectId = new mongoose.Types.ObjectId(String(sinceId));
  } catch {
    return { ...base, catalogVersion: { $gt: version } };
  }

  return {
    ...base,
    $or: [
      { catalogVersion: { $gt: version } },
      { catalogVersion: version, _id: { $gt: objectId } }
    ]
  };
}

/** Slice a limit+1 fetch into a page and derive cursor metadata. */
function paginateSyncDocs(docs, limit, sinceVersion) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  const hasMore = docs.length > safeLimit;
  const items = docs.slice(0, safeLimit);
  const maxFromItems = items.reduce((m, d) => Math.max(m, d.catalogVersion || 0), sinceVersion);
  const lastId = items.length ? String(items[items.length - 1]._id) : null;
  return { items, hasMore, maxFromItems, lastId };
}

module.exports = {
  buildProductSyncFilter,
  paginateSyncDocs
};
