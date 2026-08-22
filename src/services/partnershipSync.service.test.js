/**
 * Partner ↔ Field Day orchestrator: single pass, 409 on foreign Partner,
 * no Field Day write for MR→MR partners.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function preloadStub(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

const COMPANY = '64c000000000000000000001';
const AHMED = '64b0000000000000000000aa';
const ALI = '64b0000000000000000000a1';
const USMAN = '64b0000000000000000000a2';
const BILAL = '64b0000000000000000000a3';
const FELLOW_MR = '64b0000000000000000000a4';
const TZ = 'Asia/Karachi';
const YMD = '2026-08-21';

const state = {
  users: {},
  roles: {},
  fieldDayOps: [],
  partnerOps: [],
  ymdsForDayKey: [YMD],
  currentPartner: {}
};

preloadStub('../models/User', {
  findById: (id) => ({
    select: () => ({
      lean: async () => state.users[String(id)] || null
    })
  })
});

preloadStub('../models/Role', {
  findById: (id) => ({
    select: () => ({
      lean: async () => state.roles[String(id)] || null
    })
  })
});

preloadStub('./managerFieldDay.service', {
  applyRepOnFieldDayInternal: async (opts) => {
    state.fieldDayOps.push({
      action: opts.action,
      managerId: String(opts.managerId),
      medicalRepId: String(opts.medicalRepId),
      ymd: opts.ymd,
      notify: opts.notify
    });
    return { applied: true };
  }
});

preloadStub('./weeklyPlan.service', {
  applyDayPartnerForYmdInternal: async (opts) => {
    state.partnerOps.push({
      action: opts.action,
      managerId: String(opts.managerId),
      medicalRepId: String(opts.medicalRepId),
      ymd: opts.ymd
    });
    const cur = state.currentPartner[String(opts.medicalRepId)] || null;
    if (opts.action === 'ADD' && cur && cur !== String(opts.managerId)) {
      const err = new Error('This rep already has a different Partner for that day');
      err.statusCode = 409;
      throw err;
    }
    if (opts.action === 'ADD') state.currentPartner[String(opts.medicalRepId)] = String(opts.managerId);
    if (opts.action === 'REMOVE' && cur === String(opts.managerId)) {
      state.currentPartner[String(opts.medicalRepId)] = null;
    }
    return { applied: true };
  },
  currentPartnerForYmd: async (_companyId, medicalRepId) => {
    const partnerId = state.currentPartner[String(medicalRepId)] || null;
    return { plan: { _id: 'plan' }, partnerId, dayKey: 'friday' };
  },
  ymdsForDayKey: () => state.ymdsForDayKey
});

const sync = require('./partnershipSync.service');

const reqUser = { userId: ALI };
const ahmedUser = {
  _id: AHMED,
  role: 'USER',
  permissions: ['managerFieldDays.edit'],
  roleId: null
};
const fellowMrUser = {
  _id: FELLOW_MR,
  role: 'USER',
  permissions: ['weeklyPlans.edit', 'weeklyPlans.view'],
  roleId: null
};

beforeEach(() => {
  state.users = {
    [AHMED]: ahmedUser,
    [USMAN]: { _id: USMAN, role: 'USER', permissions: ['managerFieldDays.edit'], roleId: null },
    [FELLOW_MR]: fellowMrUser,
    [ALI]: { _id: ALI, role: 'USER', permissions: ['weeklyPlans.edit'], roleId: null },
    [BILAL]: { _id: BILAL, role: 'USER', permissions: ['weeklyPlans.view'], roleId: null }
  };
  state.roles = {};
  state.fieldDayOps = [];
  state.partnerOps = [];
  state.ymdsForDayKey = [YMD];
  state.currentPartner = {};
});

describe('isFieldDayEligibleManager', () => {
  it('is true when the user can edit Field Days', async () => {
    assert.equal(await sync.isFieldDayEligibleManager(AHMED), true);
  });

  it('is false for a fellow medical rep', async () => {
    assert.equal(await sync.isFieldDayEligibleManager(FELLOW_MR), false);
  });
});

describe('applyPartnershipChange source routing', () => {
  it('PARTNER mutates Field Day only (no Partner re-entry)', async () => {
    await sync.applyPartnershipChange({
      source: 'PARTNER',
      action: 'ADD',
      companyId: COMPANY,
      managerId: AHMED,
      medicalRepId: ALI,
      ymd: YMD,
      reqUser,
      timeZone: TZ
    });
    assert.equal(state.fieldDayOps.length, 1);
    assert.equal(state.fieldDayOps[0].action, 'ADD');
    assert.equal(state.fieldDayOps[0].notify, false);
    assert.equal(state.partnerOps.length, 0);
  });

  it('FIELD_DAY mutates Partner only (no Field Day re-entry)', async () => {
    await sync.applyPartnershipChange({
      source: 'FIELD_DAY',
      action: 'ADD',
      companyId: COMPANY,
      managerId: AHMED,
      medicalRepId: ALI,
      ymd: YMD,
      reqUser: { userId: AHMED },
      timeZone: TZ
    });
    assert.equal(state.partnerOps.length, 1);
    assert.equal(state.partnerOps[0].action, 'ADD');
    assert.equal(state.fieldDayOps.length, 0);
  });
});

describe('syncFieldDayFromPartnerChanges', () => {
  const plan = { medicalRepId: ALI, partnerByDay: {} };

  it('Ali Partner=Ahmed adds Ali to Ahmed Field Day', async () => {
    await sync.syncFieldDayFromPartnerChanges({
      companyId: COMPANY,
      plan,
      partnerChangedDays: { friday: AHMED },
      previousPartnerByDay: {},
      reqUser,
      tz: TZ
    });
    assert.equal(state.fieldDayOps.length, 1);
    assert.deepEqual(state.fieldDayOps[0], {
      action: 'ADD',
      managerId: AHMED,
      medicalRepId: ALI,
      ymd: YMD,
      notify: false
    });
  });

  it('Ali clears Ahmed removes Ali from Ahmed Field Day only', async () => {
    await sync.syncFieldDayFromPartnerChanges({
      companyId: COMPANY,
      plan,
      partnerChangedDays: { friday: null },
      previousPartnerByDay: { friday: AHMED },
      reqUser,
      tz: TZ
    });
    assert.equal(state.fieldDayOps.length, 1);
    assert.equal(state.fieldDayOps[0].action, 'REMOVE');
    assert.equal(state.fieldDayOps[0].managerId, AHMED);
    assert.equal(state.fieldDayOps[0].medicalRepId, ALI);
  });

  it('Ali switches Ahmed→Usman removes from Ahmed and adds to Usman', async () => {
    await sync.syncFieldDayFromPartnerChanges({
      companyId: COMPANY,
      plan,
      partnerChangedDays: { friday: USMAN },
      previousPartnerByDay: { friday: AHMED },
      reqUser,
      tz: TZ
    });
    assert.equal(state.fieldDayOps.length, 2);
    assert.equal(state.fieldDayOps[0].action, 'REMOVE');
    assert.equal(state.fieldDayOps[0].managerId, AHMED);
    assert.equal(state.fieldDayOps[1].action, 'ADD');
    assert.equal(state.fieldDayOps[1].managerId, USMAN);
  });

  it('Ali Partner=fellow MR does not write Field Day', async () => {
    await sync.syncFieldDayFromPartnerChanges({
      companyId: COMPANY,
      plan,
      partnerChangedDays: { friday: FELLOW_MR },
      previousPartnerByDay: {},
      reqUser,
      tz: TZ
    });
    assert.equal(state.fieldDayOps.length, 0);
  });

  it('pending plans retract Field Day instead of adding', async () => {
    await sync.syncFieldDayFromPartnerChanges({
      companyId: COMPANY,
      plan,
      partnerChangedDays: { friday: AHMED },
      previousPartnerByDay: {},
      reqUser,
      tz: TZ,
      publishAdds: false
    });
    assert.equal(state.fieldDayOps.length, 1);
    assert.equal(state.fieldDayOps[0].action, 'REMOVE');
    assert.equal(state.fieldDayOps[0].managerId, AHMED);
  });

  it('retractFieldDayForPlan removes the rep from the partner manager Field Day', async () => {
    await sync.retractFieldDayForPlan({
      companyId: COMPANY,
      plan: { medicalRepId: ALI, partnerByDay: { friday: AHMED } },
      reqUser,
      tz: TZ
    });
    assert.equal(state.fieldDayOps.length, 1);
    assert.equal(state.fieldDayOps[0].action, 'REMOVE');
    assert.equal(state.fieldDayOps[0].managerId, AHMED);
    assert.equal(state.fieldDayOps[0].medicalRepId, ALI);
  });
});

describe('assertFieldDayAddsAllowed / syncFieldDaysForRepDiff', () => {
  it('409 when Ali already has Partner=Bilal; Partner unchanged', async () => {
    state.currentPartner[ALI] = BILAL;
    await assert.rejects(
      () =>
        sync.assertFieldDayAddsAllowed(COMPANY, AHMED, [ALI], YMD, TZ),
      (err) => err.statusCode === 409
    );
    assert.equal(state.currentPartner[ALI], BILAL);
    assert.equal(state.partnerOps.length, 0);
    assert.equal(state.fieldDayOps.length, 0);
  });

  it('Field Day ADD sets Partner when empty', async () => {
    await sync.syncFieldDaysForRepDiff({
      companyId: COMPANY,
      managerId: AHMED,
      ymd: YMD,
      addedIds: [ALI],
      removedIds: [],
      reqUser: { userId: AHMED },
      timeZone: TZ
    });
    assert.equal(state.partnerOps.length, 1);
    assert.equal(state.partnerOps[0].action, 'ADD');
    assert.equal(state.currentPartner[ALI], AHMED);
    assert.equal(state.fieldDayOps.length, 0);
  });

  it('Field Day REMOVE clears Partner only if it was this manager', async () => {
    state.currentPartner[ALI] = AHMED;
    await sync.syncFieldDaysForRepDiff({
      companyId: COMPANY,
      managerId: AHMED,
      ymd: YMD,
      addedIds: [],
      removedIds: [ALI],
      reqUser: { userId: AHMED },
      timeZone: TZ
    });
    assert.equal(state.partnerOps[0].action, 'REMOVE');
    assert.equal(state.currentPartner[ALI], null);
  });

  it('does not re-enter Field Day from Field Day source (single pass)', async () => {
    await sync.syncFieldDaysForRepDiff({
      companyId: COMPANY,
      managerId: AHMED,
      ymd: YMD,
      addedIds: [ALI, USMAN],
      removedIds: [],
      reqUser: { userId: AHMED },
      timeZone: TZ
    });
    assert.equal(state.fieldDayOps.length, 0);
    assert.equal(state.partnerOps.length, 2);
  });
});
