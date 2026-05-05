const mongoose = require('mongoose');
const User = require('../models/User');

/**
 * Manager-scope resolver (Phase 1).
 *
 * Given a manager userId, returns the set of *active* user ids in their reporting subtree
 * (descendants only by default; pass { includeSelf: true } to include the caller).
 *
 * Implementation note: traversal is BFS on `managerId`. With Phase 1 hierarchy depth ≤ 4
 * (RM → ASM → MR; future: Director → RM → ASM → MR) the worst-case is a few hundred users
 * in tens of milliseconds, which is fine for synchronous resolution. If we ever scale to
 * 10k+ employees per company we can swap this for a `managerPath` materialised path on User.
 *
 * Soft-deleted users are excluded by the `User` softDelete plugin's auto-filter.
 */
const resolveSubtreeUserIds = async (companyId, managerUserId, { includeSelf = false } = {}) => {
  if (!managerUserId || !mongoose.Types.ObjectId.isValid(managerUserId)) return [];
  const cid = new mongoose.Types.ObjectId(companyId);
  const rootId = new mongoose.Types.ObjectId(managerUserId);

  const collected = new Set(includeSelf ? [String(rootId)] : []);
  let frontier = [rootId];

  while (frontier.length) {
    const children = await User.find({
      companyId: cid,
      managerId: { $in: frontier }
    })
      .select('_id')
      .lean();
    if (!children.length) break;
    const next = [];
    for (const c of children) {
      const key = String(c._id);
      if (collected.has(key)) continue;
      collected.add(key);
      next.push(c._id);
    }
    frontier = next;
  }
  return Array.from(collected, (s) => new mongoose.Types.ObjectId(s));
};

/**
 * Throws when newManagerId is `userId` itself or any of its descendants — keeps the tree acyclic.
 */
const assertNoCycle = async (companyId, userId, newManagerId) => {
  if (!newManagerId) return;
  if (String(newManagerId) === String(userId)) {
    const ApiError = require('./ApiError');
    throw new ApiError(400, 'A user cannot report to themselves');
  }
  const subtree = await resolveSubtreeUserIds(companyId, userId, { includeSelf: false });
  const inSubtree = subtree.some((id) => String(id) === String(newManagerId));
  if (inSubtree) {
    const ApiError = require('./ApiError');
    throw new ApiError(400, 'New manager is one of this user\'s descendants — would create a cycle');
  }
};

module.exports = { resolveSubtreeUserIds, assertNoCycle };
