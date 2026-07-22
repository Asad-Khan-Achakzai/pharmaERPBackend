const Announcement = require('../models/Announcement');
const AnnouncementFanout = require('../models/AnnouncementFanout');
const { FANOUT_STATUS } = require('../models/AnnouncementFanout');
const User = require('../models/User');
const { publishEventSafe } = require('./notificationPublisher.service');
const logger = require('../utils/logger');

const BATCH = 100;

async function enqueueFanout(companyId, announcement, actorUserId) {
  try {
    await AnnouncementFanout.create({
      companyId,
      announcementId: announcement._id,
      actorUserId,
      status: FANOUT_STATUS.PENDING
    });
  } catch (err) {
    if (err && (err.code === 11000 || String(err.message || '').includes('E11000'))) {
      logger.info('announcement.fanout_already_queued', { id: String(announcement._id) });
      return;
    }
    throw err;
  }
}

async function processFanoutBatch(limit = 5) {
  let processedJobs = 0;
  let enqueued = 0;

  for (let j = 0; j < limit; j += 1) {
    const job = await AnnouncementFanout.findOneAndUpdate(
      { status: FANOUT_STATUS.PENDING },
      { $set: { status: FANOUT_STATUS.PROCESSING } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!job) break;
    processedJobs += 1;

    try {
      const announcement = await Announcement.findById(job.announcementId).lean();
      if (!announcement) {
        job.status = FANOUT_STATUS.FAILED;
        job.lastError = 'announcement_missing';
        job.processedAt = new Date();
        await job.save();
        continue;
      }

      const title = announcement.title;
      const body = announcement.body?.slice(0, 500) || '';
      const announcementId = String(announcement._id);
      let cursor = job.cursorUserId;

      for (;;) {
        const filter = {
          companyId: job.companyId,
          isActive: { $ne: false },
          isDeleted: { $ne: true }
        };
        if (cursor) filter._id = { $gt: cursor };

        const users = await User.find(filter)
          .select('_id')
          .sort({ _id: 1 })
          .limit(BATCH)
          .lean();

        if (!users.length) break;

        await Promise.all(
          users.map((u) =>
            publishEventSafe({
              eventName: 'announcement.published',
              companyId: job.companyId,
              userId: u._id,
              title,
              body,
              link: '/notifications',
              meta: {
                announcementId,
                publishedBy: String(job.actorUserId)
              },
              dedupeKey: `announcement:${announcementId}:fanout`
            })
          )
        );

        enqueued += users.length;
        job.enqueuedUsers += users.length;
        cursor = users[users.length - 1]._id;
        job.cursorUserId = cursor;
        await job.save();

        if (users.length < BATCH) break;
      }

      job.status = FANOUT_STATUS.DONE;
      job.processedAt = new Date();
      job.lastError = null;
      await job.save();
      logger.info('announcement.fanout_done', {
        announcementId,
        users: job.enqueuedUsers
      });
    } catch (err) {
      job.status = FANOUT_STATUS.PENDING;
      job.lastError = String(err.message || err).slice(0, 500);
      await job.save();
      logger.error('announcement.fanout_tick_failed', { err: err.message });
    }
  }

  return { processedJobs, enqueued };
}

module.exports = { enqueueFanout, processFanoutBatch, BATCH };
