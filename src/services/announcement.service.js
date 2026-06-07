const Announcement = require('../models/Announcement');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const notificationService = require('./notification.service');
const { NOTIFICATION_KIND } = require('../constants/enums');

const nd = { isDeleted: { $ne: true } };

async function feed(companyId, query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const filter = {
    companyId,
    isActive: true,
    publishedAt: { $ne: null },
    ...nd
  };
  const [docs, total] = await Promise.all([
    Announcement.find(filter).sort({ publishedAt: -1 }).skip(skip).limit(limit).lean(),
    Announcement.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
}

async function create(companyId, data, reqUser) {
  const doc = await Announcement.create({
    companyId,
    title: data.title,
    body: data.body,
    publishedAt: data.publish ? new Date() : null,
    publishedBy: data.publish ? reqUser.userId : null,
    isActive: true,
    createdBy: reqUser.userId
  });
  if (data.publish) {
    await fanOutAnnouncement(companyId, doc, reqUser.userId);
  }
  return doc.toObject();
}

async function publish(companyId, id, reqUser) {
  const doc = await Announcement.findOne({ _id: id, companyId, ...nd });
  if (!doc) throw new ApiError(404, 'Announcement not found');
  if (doc.publishedAt) return doc.toObject();
  doc.publishedAt = new Date();
  doc.publishedBy = reqUser.userId;
  await doc.save();
  await fanOutAnnouncement(companyId, doc, reqUser.userId);
  return doc.toObject();
}

async function fanOutAnnouncement(companyId, announcement, actorUserId) {
  const users = await User.find({
    companyId,
    isActive: { $ne: false },
    isDeleted: { $ne: true }
  })
    .select('_id')
    .lean();

  const title = announcement.title;
  const body = announcement.body?.slice(0, 500) || '';
  await Promise.all(
    users.map((u) =>
      notificationService.createForUser({
        companyId,
        userId: u._id,
        title,
        body,
        kind: NOTIFICATION_KIND.ANNOUNCEMENT,
        link: '/notifications',
        meta: { announcementId: String(announcement._id), publishedBy: String(actorUserId) }
      }).catch(() => null)
    )
  );
}

module.exports = { feed, create, publish };
