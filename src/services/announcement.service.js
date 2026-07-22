const Announcement = require('../models/Announcement');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const logger = require('../utils/logger');
const announcementFanoutService = require('./announcementFanout.service');

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

/** Admin list: published + drafts (for authoring UI). */
async function adminList(companyId, query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const filter = { companyId, ...nd };
  const [docs, total] = await Promise.all([
    Announcement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
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
    // Non-blocking: queue fan-out job; worker creates notifications + push outbox rows.
    void announcementFanoutService.enqueueFanout(companyId, doc, reqUser.userId).catch((err) => {
      logger.error('announcement.fanout_failed', { id: String(doc._id), err: err.message });
    });
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
  void announcementFanoutService.enqueueFanout(companyId, doc, reqUser.userId).catch((err) => {
    logger.error('announcement.fanout_failed', { id: String(doc._id), err: err.message });
  });
  return doc.toObject();
}

module.exports = { feed, adminList, create, publish };
