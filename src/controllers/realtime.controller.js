const realtimeHub = require('../realtime/RealtimeHub');
const { attachSseClient } = require('../realtime/SseConnectionManager');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');
const { resolveSubtreeUserIds } = require('../utils/teamScope');
const { userHasTenantWideAccess } = require('../utils/effectivePermissions');

const ALLOWED_CHANNELS = new Set(['live-map', 'notifications']);
const LIVE_SCOPE_TTL_MS = 5 * 60 * 1000;

/** null = unrestricted (tenant-wide access); otherwise Set of visible userIds. */
async function resolveLiveMapScope(req) {
  if (userHasTenantWideAccess(req.user)) return null;
  const ids = await resolveSubtreeUserIds(req.companyId, req.user.userId, {
    includeSelf: true,
    activeOnly: true
  });
  return new Set(ids.map((id) => String(id)));
}

const stream = asyncHandler(async (req, res) => {
  const raw = String(req.query.channel || 'live-map');
  const channels = [...new Set(raw.split(',').map((c) => c.trim()).filter(Boolean))];
  if (!channels.length) {
    throw new ApiError(400, 'Invalid realtime channel');
  }
  for (const channel of channels) {
    if (!ALLOWED_CHANNELS.has(channel)) {
      throw new ApiError(400, `Invalid realtime channel: ${channel}`);
    }
  }

  // Scope live-location fan-out to the viewer's team subtree so a manager
  // never receives rep positions they cannot see via /geo/live.
  let liveMapScope = channels.includes('live-map') ? await resolveLiveMapScope(req) : null;
  let scopeRefreshedAt = Date.now();

  const filter = (event, channel) => {
    if (channel !== 'live-map') return true;
    if (event?.type !== 'rep.location.updated') return true;
    if (!liveMapScope) return true;
    if (Date.now() - scopeRefreshedAt > LIVE_SCOPE_TTL_MS) {
      scopeRefreshedAt = Date.now();
      resolveLiveMapScope(req)
        .then((scope) => {
          liveMapScope = scope;
        })
        .catch(() => {
          /* keep last known scope */
        });
    }
    return liveMapScope.has(String(event?.payload?.userId || ''));
  };

  attachSseClient(res, String(req.companyId), channels, undefined, filter);
});

const stats = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, realtimeHub.stats());
});

module.exports = { stream, stats };
