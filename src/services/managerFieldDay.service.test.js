/**
 * Manager Field Day — isolated from WeeklyPlan.partnerByDay / PlanItem.participants.
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
const OUTSIDER = '64b0000000000000000000ff';
const TZ = 'Asia/Karachi';
const YMD = '2026-08-21';

const state = {
  users: [],
  docs: [],
  notifies: [],
  audits: [],
  partnerByDayWrites: 0,
  planItemWrites: 0,
  partnerPlans: []
};

const makeDoc = (fields) => {
  const doc = {
    _id: fields._id || '64d000000000000000000001',
    companyId: COMPANY,
    isDeleted: false,
    medicalRepIds: [],
    notes: '',
    ...fields,
    populate: async () => doc,
    save: async () => {
      const idx = state.docs.findIndex((d) => String(d._id) === String(doc._id));
      if (idx >= 0) state.docs[idx] = doc;
      return doc;
    },
    softDelete: async (userId) => {
      doc.isDeleted = true;
      doc.deletedBy = userId;
      const idx = state.docs.findIndex((d) => String(d._id) === String(doc._id));
      if (idx >= 0) state.docs.splice(idx, 1);
      return doc;
    }
  };
  return doc;
};

preloadStub('../models/User', {
  find: (q) => ({
    select: () => ({
      lean: async () => {
        const ids = new Set((q._id?.$in || []).map((id) => String(id)));
        return state.users.filter(
          (u) => ids.has(String(u._id)) && u.companyId === q.companyId && u.isActive !== false
        );
      }
    })
  }),
  findById: (id) => ({
    select: () => ({
      lean: async () => state.users.find((u) => String(u._id) === String(id)) || { _id: id, name: 'Ahmed' }
    })
  })
});

preloadStub('../models/ManagerFieldDay', {
  findOne: (q) => {
    const doc =
      state.docs.find((d) => {
        if (q._id && String(d._id) !== String(q._id)) return false;
        if (q.companyId && String(d.companyId) !== String(q.companyId)) return false;
        if (q.managerId && String(d.managerId) !== String(q.managerId)) return false;
        if (q.date && new Date(d.date).getTime() !== new Date(q.date).getTime()) return false;
        return !d.isDeleted;
      }) || null;
    const chain = {
      select() {
        return this;
      },
      populate() {
        return this;
      },
      lean: async () => doc,
      then(resolve, reject) {
        return Promise.resolve(doc).then(resolve, reject);
      }
    };
    return chain;
  },
  find: (q) => ({
    sort: () => ({
      populate: async () =>
        state.docs.filter((d) => {
          if (q.companyId && String(d.companyId) !== String(q.companyId)) return false;
          if (q.managerId && String(d.managerId) !== String(q.managerId)) return false;
          if (q.date?.$gte && new Date(d.date) < q.date.$gte) return false;
          if (q.date?.$lte && new Date(d.date) > q.date.$lte) return false;
          return !d.isDeleted;
        })
    })
  }),
  findById: async (id) => state.docs.find((d) => String(d._id) === String(id)) || null,
  create: async (fields) => {
    const doc = makeDoc(fields);
    state.docs.push(doc);
    return doc;
  }
});

preloadStub('../models/WeeklyPlan', {
  updateOne: async () => {
    state.partnerByDayWrites += 1;
    return {};
  },
  find: () => ({
    select() {
      return this;
    },
    populate() {
      return this;
    },
    lean: async () => state.partnerPlans || []
  })
});
preloadStub('../models/PlanItem', {
  updateMany: async () => {
    state.planItemWrites += 1;
    return {};
  }
});

state.repPartners = {};
state.plansByRep = {};
state.partnerOps = [];

preloadStub('./weeklyPlan.service', {
  currentPartnerForYmd: async (_companyId, medicalRepId) => {
    const hasPlan = Boolean(state.plansByRep[String(medicalRepId)]);
    if (!hasPlan) return { plan: null, partnerId: null, dayKey: 'friday' };
    const partnerId = state.repPartners[String(medicalRepId)] || null;
    return { plan: { _id: 'plan' }, partnerId, dayKey: 'friday' };
  },
  applyDayPartnerForYmdInternal: async (opts) => {
    state.partnerOps.push({
      action: opts.action,
      medicalRepId: String(opts.medicalRepId),
      managerId: String(opts.managerId)
    });
    const key = String(opts.medicalRepId);
    if (!state.plansByRep[key]) return { applied: false, reason: 'NO_PLAN' };
    if (opts.action === 'ADD') {
      const cur = state.repPartners[key] || null;
      if (cur && cur !== String(opts.managerId)) {
        const err = new Error('This rep already has a different Partner for that day');
        err.statusCode = 409;
        throw err;
      }
      state.repPartners[key] = String(opts.managerId);
      return { applied: true };
    }
    if (state.repPartners[key] === String(opts.managerId)) {
      state.repPartners[key] = null;
      return { applied: true };
    }
    return { applied: false, reason: 'NOT_THIS_MANAGER' };
  },
  ymdsForDayKey: () => [YMD],
  syncPartnerByDay: async () => {}
});

preloadStub('../models/Role', {
  findById: () => ({
    select: () => ({
      lean: async () => null
    })
  })
});

preloadStub('./audit.service', {
  log: async (payload) => {
    state.audits.push(payload);
  }
});

preloadStub('./managerFieldDayNotification.service', {
  notifyFieldDayDiff: async (payload) => {
    state.notifies.push(payload);
  }
});

const svc = require('./managerFieldDay.service');

const reqUser = { userId: AHMED };
const subtree = [AHMED, ALI, USMAN, BILAL];

beforeEach(() => {
  state.users = [
    { _id: ALI, companyId: COMPANY, isActive: true, name: 'Ali' },
    { _id: USMAN, companyId: COMPANY, isActive: true, name: 'Usman' },
    { _id: BILAL, companyId: COMPANY, isActive: true, name: 'Bilal' },
    { _id: OUTSIDER, companyId: COMPANY, isActive: true, name: 'Outsider' }
  ];
  state.docs = [];
  state.notifies = [];
  state.audits = [];
  state.partnerByDayWrites = 0;
  state.planItemWrites = 0;
  state.partnerPlans = [];
  state.repPartners = {};
  state.plansByRep = {};
  state.partnerOps = [];
});

describe('normalizeMedicalRepIds', () => {
  it('dedupes and preserves order', () => {
    const ids = svc.normalizeMedicalRepIds([ALI, USMAN, ALI], AHMED);
    assert.deepEqual(ids, [ALI, USMAN]);
  });

  it('rejects the manager selecting themselves', () => {
    assert.throws(() => svc.normalizeMedicalRepIds([ALI, AHMED], AHMED), (err) => err.statusCode === 400);
  });

  it('allows an empty list (clear the day)', () => {
    assert.deepEqual(svc.normalizeMedicalRepIds([], AHMED), []);
  });
});

describe('assertRepsInCallerScope', () => {
  it('allows subtree reps', () => {
    svc.assertRepsInCallerScope([ALI, USMAN], subtree);
  });

  it('rejects a rep outside the subtree with 403', () => {
    assert.throws(() => svc.assertRepsInCallerScope([ALI, OUTSIDER], subtree), (err) => err.statusCode === 403);
  });

  it('allows any ids when visibleRepIds is null (admin)', () => {
    svc.assertRepsInCallerScope([OUTSIDER], null);
  });
});

describe('upsertForManager', () => {
  it('saves one rep', async () => {
    const doc = await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    assert.ok(doc);
    assert.deepEqual(doc.medicalRepIds.map(String), [ALI]);
    assert.equal(state.docs.length, 1);
    assert.equal(state.partnerByDayWrites, 0);
    assert.equal(state.planItemWrites, 0);
    assert.equal(state.notifies.length, 1);
    assert.deepEqual(state.notifies[0].addedIds, [ALI]);
  });

  it('saves multiple reps', async () => {
    const doc = await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI, USMAN, BILAL] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    assert.deepEqual(doc.medicalRepIds.map(String), [ALI, USMAN, BILAL]);
  });

  it('rejects inactive reps', async () => {
    state.users[0].isActive = false;
    await assert.rejects(
      () =>
        svc.upsertForManager(
          COMPANY,
          { date: YMD, medicalRepIds: [ALI] },
          reqUser,
          TZ,
          { visibleRepIds: subtree }
        ),
      (err) => err.statusCode === 400
    );
  });

  it('rejects out-of-subtree reps', async () => {
    await assert.rejects(
      () =>
        svc.upsertForManager(
          COMPANY,
          { date: YMD, medicalRepIds: [OUTSIDER] },
          reqUser,
          TZ,
          { visibleRepIds: subtree }
        ),
      (err) => err.statusCode === 403
    );
  });

  it('upserts the same day instead of duplicating', async () => {
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI, USMAN] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    assert.equal(state.docs.length, 1);
    assert.deepEqual(state.docs[0].medicalRepIds.map(String), [ALI, USMAN]);
    const last = state.notifies[state.notifies.length - 1];
    assert.deepEqual(last.addedIds, [USMAN]);
    assert.deepEqual(last.removedIds, []);
  });

  it('clears the day when medicalRepIds is empty', async () => {
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI, USMAN] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    const cleared = await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    assert.equal(cleared, null);
    assert.equal(state.docs.length, 0);
    const last = state.notifies[state.notifies.length - 1];
    assert.deepEqual(last.removedIds.sort(), [ALI, USMAN].sort());
  });

  it('stores different days independently', async () => {
    await svc.upsertForManager(
      COMPANY,
      { date: '2026-08-21', medicalRepIds: [ALI] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    await svc.upsertForManager(
      COMPANY,
      { date: '2026-08-22', medicalRepIds: [USMAN] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    assert.equal(state.docs.length, 2);
  });

  it('allows two managers to list the same rep (separate documents)', async () => {
    const otherManager = '64b0000000000000000000bb';
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI], managerId: otherManager },
      { userId: otherManager },
      TZ,
      { visibleRepIds: [otherManager, ALI] }
    );
    assert.equal(state.docs.length, 2);
  });

  it('does not write Partner when the rep has no covering weekly plan', async () => {
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI, USMAN] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    assert.equal(state.docs.length, 1);
    assert.deepEqual(state.repPartners, {});
    assert.equal(
      state.partnerOps.filter((o) => o.action === 'ADD').length,
      2
    );
  });

  it('sets Partner = this manager when a covering plan exists', async () => {
    state.plansByRep[ALI] = true;
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    assert.equal(state.repPartners[ALI], AHMED);
  });

  it('sets Partner on each selected rep that has a plan', async () => {
    state.plansByRep[ALI] = true;
    state.plansByRep[USMAN] = true;
    state.plansByRep[BILAL] = true;
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI, USMAN, BILAL] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    assert.equal(state.repPartners[ALI], AHMED);
    assert.equal(state.repPartners[USMAN], AHMED);
    assert.equal(state.repPartners[BILAL], AHMED);
  });

  it('skipPartnerSync does not write Partner', async () => {
    state.plansByRep[ALI] = true;
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI] },
      reqUser,
      TZ,
      { visibleRepIds: subtree, skipPartnerSync: true }
    );
    assert.equal(state.docs.length, 1);
    assert.equal(state.partnerOps.length, 0);
    assert.equal(state.repPartners[ALI], undefined);
  });

  it('rejects 409 when the rep already has a different Partner and does not write Field Day', async () => {
    state.plansByRep[ALI] = true;
    state.repPartners[ALI] = BILAL;
    await assert.rejects(
      () =>
        svc.upsertForManager(
          COMPANY,
          { date: YMD, medicalRepIds: [ALI] },
          reqUser,
          TZ,
          { visibleRepIds: subtree }
        ),
      (err) => err.statusCode === 409
    );
    assert.equal(state.docs.length, 0);
    assert.equal(state.repPartners[ALI], BILAL);
  });

  it('clears Partner only if it was this manager', async () => {
    state.plansByRep[ALI] = true;
    state.repPartners[ALI] = AHMED;
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    assert.equal(state.repPartners[ALI], null);
  });

  it('does not clear a different Partner when this manager removes the rep', async () => {
    state.plansByRep[ALI] = true;
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI] },
      reqUser,
      TZ,
      { visibleRepIds: subtree, skipPartnerSync: true }
    );
    state.repPartners[ALI] = BILAL;
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    assert.equal(state.repPartners[ALI], BILAL);
  });
});

describe('applyRepOnFieldDayInternal', () => {
  it('adds a rep to Field Day without writing Partner', async () => {
    state.plansByRep[ALI] = true;
    const result = await svc.applyRepOnFieldDayInternal({
      companyId: COMPANY,
      managerId: AHMED,
      ymd: YMD,
      medicalRepId: ALI,
      action: 'ADD',
      reqUser,
      timeZone: TZ,
      notify: false
    });
    assert.equal(result.applied, true);
    assert.equal(state.docs.length, 1);
    assert.deepEqual(state.docs[0].medicalRepIds.map(String), [ALI]);
    assert.equal(state.partnerOps.length, 0);
    assert.equal(state.notifies.length, 0);
  });
});

describe('medicalRepIdsForManagerOnDate', () => {
  const businessTime = require('../utils/businessTime');

  it('returns selected reps for that manager and day', async () => {
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI, USMAN] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    const dateAnchor = businessTime.businessDayStartUtc(YMD, TZ);
    const ids = await svc.medicalRepIdsForManagerOnDate(COMPANY, AHMED, dateAnchor);
    assert.deepEqual(ids.sort(), [ALI, USMAN].sort());
  });

  it('returns empty after Field Day is cleared', async () => {
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI, USMAN] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    const dateAnchor = businessTime.businessDayStartUtc(YMD, TZ);
    const ids = await svc.medicalRepIdsForManagerOnDate(COMPANY, AHMED, dateAnchor);
    assert.deepEqual(ids, []);
  });

  it('hides reps whose covering weekly plan is still pending approval', async () => {
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI, USMAN] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    state.partnerPlans = [
      {
        medicalRepId: ALI,
        status: 'SUBMITTED',
        approvalRequired: true,
        weekStartDate: new Date('2026-08-16T19:00:00.000Z'),
        weekEndDate: new Date('2026-08-23T18:59:59.999Z')
      }
    ];
    const dateAnchor = businessTime.businessDayStartUtc(YMD, TZ);
    const ids = await svc.medicalRepIdsForManagerOnDate(COMPANY, AHMED, dateAnchor);
    assert.deepEqual(ids, [USMAN]);
  });

  it('keeps reps after their weekly plan is accepted', async () => {
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    state.partnerPlans = [
      {
        medicalRepId: ALI,
        status: 'ACTIVE',
        approvalRequired: true,
        weekStartDate: new Date('2026-08-16T19:00:00.000Z'),
        weekEndDate: new Date('2026-08-23T18:59:59.999Z')
      }
    ];
    const dateAnchor = businessTime.businessDayStartUtc(YMD, TZ);
    const ids = await svc.medicalRepIdsForManagerOnDate(COMPANY, AHMED, dateAnchor);
    assert.deepEqual(ids, [ALI]);
  });
});

describe('partnerIdOnPlanForYmd', () => {
  it('reads friday partner without writing the plan', () => {
    const plan = { partnerByDay: { friday: ALI, saturday: null } };
    // 2026-08-21 is Friday
    assert.equal(svc.partnerIdOnPlanForYmd(plan, '2026-08-21', TZ), ALI);
    assert.equal(svc.partnerIdOnPlanForYmd(plan, '2026-08-22', TZ), null);
  });
});

describe('partnerListingsForManager', () => {
  it('lists reps who set this manager as Partner for that weekday (read-only)', async () => {
    state.partnerPlans = [
      {
        medicalRepId: { _id: ALI, name: 'Ali' },
        weekStartDate: new Date('2026-08-16T19:00:00.000Z'),
        weekEndDate: new Date('2026-08-23T18:59:59.999Z'),
        partnerByDay: { friday: AHMED }
      }
    ];
    const byYmd = await svc.partnerListingsForManager(COMPANY, AHMED, '2026-08-17', '2026-08-23', TZ, {
      visibleRepIds: subtree
    });
    assert.equal(byYmd['2026-08-21'].length, 1);
    assert.equal(byYmd['2026-08-21'][0]._id, ALI);
    assert.equal(byYmd['2026-08-20'].length, 0);
    assert.equal(state.partnerByDayWrites, 0);
  });
});

describe('Field Day pending-plan overlay', () => {
  it('hides a selected rep while their weekly plan is pending approval', async () => {
    await svc.upsertForManager(
      COMPANY,
      { date: YMD, medicalRepIds: [ALI] },
      reqUser,
      TZ,
      { visibleRepIds: subtree }
    );
    state.partnerPlans = [
      {
        medicalRepId: ALI,
        status: 'SUBMITTED',
        approvalRequired: true,
        weekStartDate: new Date('2026-08-16T19:00:00.000Z'),
        weekEndDate: new Date('2026-08-23T18:59:59.999Z')
      }
    ];
    const listed = await svc.list(COMPANY, { from: YMD, to: YMD }, reqUser, TZ, { visibleRepIds: subtree });
    assert.equal(listed.length, 1);
    assert.deepEqual(
      (listed[0].medicalRepIds || []).map((id) => String(id._id || id)),
      []
    );
  });
});
