const Notification = require('../models/Notification');
const Company = require('../models/Company');
const ApiError = require('../utils/ApiError');
const { NOTIFICATION_KIND } = require('../constants/enums');
const { parsePagination } = require('../utils/pagination');
const pushService = require('./push.service');
const logger = require('../utils/logger');
const { getPushBackendStatus } = require('../utils/pushDiagnostics');

async function createForUser({ companyId, userId, title, body, kind = NOTIFICATION_KIND.GENERAL, link, meta }) {
  const doc = await Notification.create({
    companyId,
    userId,
    title,
    body: body || '',
    kind,
    link: link || null,
    meta: meta || null
  });

  logger.info('notification.created', {
    notificationId: String(doc._id),
    companyId: String(companyId),
    userId: String(userId),
    kind,
    title,
    hasLink: !!link
  });

  const company = await Company.findById(companyId).select('mobilePushEnabled name').lean();

  if (!company?.mobilePushEnabled) {
    logger.info('push.skipped_company_flag_off', {
      notificationId: String(doc._id),
      companyId: String(companyId),
      companyName: company?.name || null,
      userId: String(userId),
      fix: 'Super Admin → Companies → enable "Mobile push notifications" for this company'
    });
    return doc.toObject();
  }

  const backend = getPushBackendStatus();
  logger.info('push.dispatching', {
    notificationId: String(doc._id),
    userId: String(userId),
    companyId: String(companyId),
    backendReady: backend.backendReady,
    backend
  });

  try {
    const result = await pushService.sendToUser({
      userId,
      title,
      body,
      data: { notificationId: String(doc._id), kind, link: link || undefined },
      context: {
        notificationId: String(doc._id),
        kind,
        source: 'notification.createForUser'
      }
    });

    logger.info('push.dispatch_finished', {
      notificationId: String(doc._id),
      userId: String(userId),
      result
    });
  } catch (err) {
    logger.error('push.dispatch_unhandled_error', {
      notificationId: String(doc._id),
      userId: String(userId),
      err: err.message,
      stack: err.stack
    });
  }

  return doc.toObject();
}

async function feed(companyId, userId, query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const filter = { companyId, userId };
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
    link: d.link
  }));
  return { docs: rows, total, page, limit };
}

async function markRead(companyId, userId, notificationId) {
  const doc = await Notification.findOneAndUpdate(
    { _id: notificationId, companyId, userId },
    { $set: { readAt: new Date() } },
    { new: true }
  ).lean();
  if (!doc) throw new ApiError(404, 'Notification not found');
  return doc;
}

module.exports = { createForUser, feed, markRead, NOTIFICATION_KIND };
