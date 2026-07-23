/**
 * Pure device-change visibility rules.
 *
 * Source of truth for "who may log in" is MobileDeviceBinding.deviceId.
 * DeviceChangeRequest rows are workflow + audit only. An APPROVED row is
 * actionable ONLY while that device is still the bound device. After a later
 * rebind (A→B→A), prior APPROVED rows for the unbound device must not surface
 * as "Device approved — Sign in now".
 */

const ACTIONABLE = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED',
  NONE: null
};

/**
 * Decide which request (if any) the blocked-device screen should show.
 *
 * @param {object} args
 * @param {object|null} args.pending - open PENDING request for the user (any device)
 * @param {object|null} args.latestForThisDevice - latest request where requestedDeviceId === currentDeviceId
 * @param {string|null|undefined} args.boundDeviceId - MobileDeviceBinding.deviceId (source of truth)
 * @param {string|null|undefined} args.currentDeviceId - this phone's deviceId
 * @returns {object|null} request to expose to the client, or null → show "request change" form
 */
function resolveVisibleDeviceChangeRequest({
  pending,
  latestForThisDevice,
  boundDeviceId,
  currentDeviceId
}) {
  // Prefer an open PENDING request for THIS device. A pending for another device
  // still occupies the single PENDING slot — surface it so the UI can show
  // "request pending" / allow cancel, rather than letting a second device
  // invent a duplicate PENDING (unique index forbids that anyway).
  if (pending) return pending;

  if (!latestForThisDevice) return null;

  const status = latestForThisDevice.status;
  if (status === 'APPROVED') {
    const stillBound =
      boundDeviceId != null &&
      currentDeviceId != null &&
      String(boundDeviceId) === String(currentDeviceId);
    // Historical approval for this device after a later rebind elsewhere → hide.
    return stillBound ? latestForThisDevice : null;
  }

  if (status === 'SUPERSEDED') return null;

  // REJECTED / CANCELLED for this device — show so the user can request again.
  return latestForThisDevice;
}

/**
 * Simulate repeated A↔B admin approvals and assert visibility never loops.
 * Used by automated tests; mirrors approve → getMy semantics.
 *
 * @param {string[]} approveSequence deviceIds approved in order (e.g. ['B','A','B',...])
 * @returns {{ binding: string|null, history: object[], visibility: Record<string, object|null> }}
 */
function simulateSwitchingSequence(approveSequence) {
  let binding = null;
  const history = [];
  let id = 0;

  for (const deviceId of approveSequence) {
    const prev = binding;
    // Create PENDING then approve (same as real flow).
    const req = {
      _id: `r${++id}`,
      requestedDeviceId: deviceId,
      status: 'PENDING',
      currentDeviceId: prev
    };
    history.push(req);
    // Supersede prior APPROVED
    for (const h of history) {
      if (h.status === 'APPROVED' && h._id !== req._id) {
        h.status = 'SUPERSEDED';
      }
    }
    req.status = 'APPROVED';
    binding = deviceId;
  }

  const devices = [...new Set(approveSequence)];
  const visibility = {};
  for (const d of devices) {
    const pending = history.find((h) => h.status === 'PENDING') || null;
    const latestForThisDevice =
      [...history].reverse().find((h) => h.requestedDeviceId === d) || null;
    visibility[d] = resolveVisibleDeviceChangeRequest({
      pending,
      latestForThisDevice,
      boundDeviceId: binding,
      currentDeviceId: d
    });
  }

  return { binding, history, visibility };
}

module.exports = {
  ACTIONABLE,
  resolveVisibleDeviceChangeRequest,
  simulateSwitchingSequence
};
