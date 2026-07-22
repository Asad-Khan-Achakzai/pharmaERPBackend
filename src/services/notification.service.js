const Notification = require('../models/Notification');
const NotificationOutbox = require('../models/NotificationOutbox');
const NotificationPreference = require('../models/NotificationPreference');
const { OUTBOX_STATUS } = require('../models/NotificationOutbox');
const { PUSH_STATUS, READ_SOURCE } = require('../models/Notification');
const Company = require('../models/Company');
const ApiError = require('../utils/ApiError');
const { NOTIFICATION_KIND, NOTIFICATION_CATEGORY } = require('../constants/enums');
const { parsePagination } = require('../utils/pagination');
const { sanitizePushContent, buildPushData, channelIdForMeta } = require('../utils/pushPayload');
const logger = require('../utils/logger');

async function unreadCount(companyId, userId) {
  return Notification.countDocuments({
    companyId,
    userId,
    readAt: null
  });
}

async function getPreference(companyId, userId) {
  return NotificationPreference.findOne({ companyId, userId }).lean();
}

function isCategoryMuted(pref, category) {
  if (!pref) return false;
  if (pref.pushEnabled === false) return true;
  const cat = category || NOTIFICATION_CATEGORY.GENERAL;
  return Array.isArray(pref.mutedCategories) && pref.mutedCategories.includes(cat);
}

/**
 * Create in-app notification (idempotent when dedupeKey set) and enqueue push outbox.
 */
async function createForUser({
  companyId,
  userId,
  title,
  body,
  kind = NOTIFICATION_KIND.GENERAL,
  link,
  meta,
  dedupeKey
}) {
  const key = dedupeKey ? String(dedupeKey).trim().slice(0, 200) : null;
  const category = meta?.category || NOTIFICATION_CATEGORY.GENERAL;
  const pref = await getPreference(companyId, userId);

  if (pref?.muteInApp && isCategoryMuted(pref, category)) {
    logger.info('notification.suppressed_preference', {
      userId: String(userId),
      category,
      eventName: meta?.eventName
    });
    return { _suppressed: true };
  }

  if (key) {
    const existing = await Notification.findOne({ companyId, userId, dedupeKey: key }).lean();
    if (existing) {
      return { ...existing, _deduped: true };
    }
  }

  let doc;
  try {
    doc = await Notification.create({
      companyId,
      userId,
      title,
      body: body || '',
      kind,
      link: link || null,
      meta: meta || null,
      dedupeKey: key,
      pushStatus: PUSH_STATUS.PENDING
    });
  } catch (err) {
    if (key && err && (err.code === 11000 || String(err.message || '').includes('E11000'))) {
      const existing = await Notification.findOne({ companyId, userId, dedupeKey: key }).lean();
      if (existing) return { ...existing, _deduped: true };
    }
    throw err;
  }

  const company = await Company.findById(companyId).select('mobilePushEnabled').lean();
  const skipPush =
    !company?.mobilePushEnabled || isCategoryMuted(pref, category) || pref?.pushEnabled === false;

  if (skipPush) {
    await Notification.updateOne(
      { _id: doc._id },
      { $set: { pushStatus: PUSH_STATUS.SKIPPED } }
    );
    return { ...doc.toObject(), pushStatus: PUSH_STATUS.SKIPPED };
  }

  const sanitized = sanitizePushContent({ kind, title, body });
  const data = buildPushData({
    notificationId: doc._id,
    kind,
    link,
    meta
  });
  const channelId = channelIdForMeta(meta);
  const badge = await unreadCount(companyId, userId);

  try {
    await NotificationOutbox.create({
      companyId,
      userId,
      notificationId: doc._id,
      status: OUTBOX_STATUS.PENDING,
      attempts: 0,
      nextAttemptAt: new Date(),
      payload: {
        title: sanitized.title,
        body: sanitized.body,
        data,
        badge,
        channelId
      }
    });
  } catch (err) {
    if (err && (err.code === 11000 || String(err.message || '').includes('E11000'))) {
      logger.info('push.outbox_already_enqueued', { notificationId: String(doc._id) });
    } else {
      logger.error('push.outbox_enqueue_failed', {
        notificationId: String(doc._id),
        err: err.message
      });
      await Notification.updateOne(
        { _id: doc._id },
        { $set: { pushStatus: PUSH_STATUS.FAILED, pushErrorCode: 'outbox_enqueue_failed' } }
      );
    }
  }

  try {
    const realtimeHub = require('../realtime/RealtimeHub');
    realtimeHub.publish(String(companyId), 'notifications', {
      type: 'notification.created',
      payload: {
        notificationId: String(doc._id),
        userId: String(userId),
        kind,
        title
      }
    });
  } catch {
    /* realtime optional */
  }

  return doc.toObject();
}

async function feed(companyId, userId, query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const filter = { companyId, userId };
  if (query.kind && Object.values(NOTIFICATION_KIND).includes(String(query.kind))) {
    filter.kind = String(query.kind);
  }
  const [docs, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter)
  ]);
  const rows = docs.map((d) => ({
    _id: d._id,
    title: d.title,
    body: d.body,
    kind: d.kind,
    read: !!d.readAt,
    createdAt: d.createdAt,
    link: d.link,
    meta: d.meta || null
  }));
  return { docs: rows, total, page, limit };
}

async function markRead(companyId, userId, notificationId, source = READ_SOURCE.IN_APP) {
  const readSource = Object.values(READ_SOURCE).includes(source) ? source : READ_SOURCE.OTHER;
  const doc = await Notification.findOneAndUpdate(
    { _id: notificationId, companyId, userId },
    { $set: { readAt: new Date(), readSource } },
    { new: true }
  ).lean();
  if (!doc) throw new ApiError(404, 'Notification not found');
  logger.info('notification.opened', {
    notificationId: String(notificationId),
    userId: String(userId),
    source: readSource
  });
  return doc;
}

async function markAllRead(companyId, userId, source = READ_SOURCE.IN_APP) {
  const readSource = Object.values(READ_SOURCE).includes(source) ? source : READ_SOURCE.OTHER;
  const result = await Notification.updateMany(
    { companyId, userId, readAt: null },
    { $set: { readAt: new Date(), readSource } }
  );
  logger.info('notification.mark_all_read', {
    userId: String(userId),
    count: result.modifiedCount || 0
  });
  return { modifiedCount: result.modifiedCount || 0 };
}

async function getOrCreatePreferences(companyId, userId) {
  let doc = await NotificationPreference.findOne({ companyId, userId });
  if (!doc) {
    doc = await NotificationPreference.create({
      companyId,
      userId,
      mutedCategories: [],
      muteInApp: false,
      pushEnabled: true
    });
  }
  return doc.toObject();
}

async function updatePreferences(companyId, userId, data) {
  const update = {};
  if (data.mutedCategories !== undefined) {
    const allowed = new Set(Object.values(NOTIFICATION_CATEGORY));
    update.mutedCategories = (data.mutedCategories || []).filter((c) => allowed.has(c));
  }
  if (data.muteInApp !== undefined) update.muteInApp = !!data.muteInApp;
  if (data.pushEnabled !== undefined) update.pushEnabled = !!data.pushEnabled;

  const doc = await NotificationPreference.findOneAndUpdate(
    { companyId, userId },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return doc;
}

module.exports = {
  createForUser,
  feed,
  markRead,
  markAllRead,
  unreadCount,
  getOrCreatePreferences,
  updatePreferences,
  NOTIFICATION_KIND,
  PUSH_STATUS,
  READ_SOURCE
};
