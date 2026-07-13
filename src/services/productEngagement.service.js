const ProductEngagementEvent = require('../models/ProductEngagementEvent');
const ApiError = require('../utils/ApiError');

const MAX_BATCH = 100;

/**
 * Batch ingest engagement events from mobile/web outbox.
 * Dedupes on (companyId, userId, clientEventId).
 */
const ingestBatch = async (companyId, userId, events = []) => {
  if (!Array.isArray(events) || events.length === 0) {
    throw new ApiError(400, 'events array is required');
  }
  if (events.length > MAX_BATCH) {
    throw new ApiError(400, `Maximum ${MAX_BATCH} events per request`);
  }

  const allowed = new Set(ProductEngagementEvent.ENGAGEMENT_EVENT_TYPES);
  const ops = [];
  for (const e of events) {
    if (!e || !e.clientEventId || !e.eventType) continue;
    if (!allowed.has(e.eventType)) {
      throw new ApiError(400, `Invalid eventType: ${e.eventType}`);
    }
    const occurredAt = e.occurredAt ? new Date(e.occurredAt) : new Date();
    ops.push({
      updateOne: {
        filter: { companyId, userId, clientEventId: String(e.clientEventId).slice(0, 128) },
        update: {
          $setOnInsert: {
            companyId,
            userId,
            clientEventId: String(e.clientEventId).slice(0, 128),
            eventType: e.eventType,
            occurredAt,
            productId: e.productId || null,
            presentationId: e.presentationId || null,
            slideId: e.slideId || null,
            campaignId: e.campaignId || null,
            kitId: e.kitId || null,
            doctorId: e.doctorId || null,
            visitLogId: e.visitLogId || null,
            activeVisitId: e.activeVisitId || null,
            meta: e.meta || null
          }
        },
        upsert: true
      }
    });
  }

  if (!ops.length) throw new ApiError(400, 'No valid events');
  const result = await ProductEngagementEvent.bulkWrite(ops, { ordered: false });
  return {
    accepted: ops.length,
    upserted: result.upsertedCount || 0,
    matched: result.matchedCount || 0
  };
};

module.exports = { ingestBatch, ENGAGEMENT_EVENT_TYPES: ProductEngagementEvent.ENGAGEMENT_EVENT_TYPES };
