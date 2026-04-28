const {
  Doctor,
  DoctorActivity,
  MedRepTarget,
  WeeklyPlan,
  PlanItem,
  VisitLog,
  Attendance,
  Payment,
  SalaryStructure,
  ReturnRecord,
  Transaction,
  Order
} = require('../../../src/models');
const AuditLog = require('../../../src/models/AuditLog');
const {
  DOCTOR_ACTIVITY_STATUS,
  WEEKLY_PLAN_STATUS,
  PLAN_ITEM_TYPE,
  PLAN_ITEM_STATUS,
  ATTENDANCE_STATUS,
  ATTENDANCE_MARKED_BY,
  PAYMENT_METHOD,
  ORDER_STATUS,
  TRANSACTION_TYPE
} = require('../../../src/constants/enums');
const { roundPKR } = require('../../../src/utils/currency');
const { pick, randInt, dateWithRng, monthKey } = require('../lib/companyOperationalBundle');

function createRng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function utcDay(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/**
 * @param {object} ctx
 * @param {import('mongoose').Document} ctx.company
 * @param {import('mongoose').Document} ctx.admin
 * @param {object} ctx.ops - output of seedCompanyOperationalBundle
 * @param {import('mongoose').Document[]} ctx.medicalReps
 * @param {object} ctx.cfg - scale.ops
 */
async function seedFieldAndAncillary(ctx) {
  const { company, admin, ops, medicalReps, cfg } = ctx;
  const rng = createRng(9001 + String(company._id).length);
  const { pharmacies } = ops;

  const doctorsApprox = cfg.doctorsApprox || Math.ceil((pharmacies?.length || 5) * 3);
  const doctorsPerPharmacy = Math.max(2, Math.floor(doctorsApprox / Math.max(1, pharmacies?.length)));

  /** @type {any[]} */
  const doctors = [];
  let dn = 0;
  for (const ph of pharmacies || []) {
    for (let j = 0; j < doctorsPerPharmacy && doctors.length < doctorsApprox; j += 1) {
      dn += 1;
      doctors.push(
        await Doctor.create({
          companyId: company._id,
          pharmacyId: ph._id,
          name: `${company.name.slice(0, 6)} Doctor ${dn}`,
          specialization: ['Cardiology', 'GP', 'Gastro'][dn % 3],
          phone: `+92-300-${String(dn).padStart(7, '0')}`,
          email: `dr.${dn}.${String(company._id).slice(-4)}@seed.pharmaerp.test`
        })
      );
    }
  }

  const now = new Date();
  const months = [monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)), monthKey(now)];
  for (const rep of medicalReps) {
    for (const m of months) {
      await MedRepTarget.findOneAndUpdate(
        { companyId: company._id, medicalRepId: rep._id, month: m },
        {
          $setOnInsert: {
            companyId: company._id,
            medicalRepId: rep._id,
            month: m,
            salesTarget: roundPKR(800000 + randInt(rng, 0, 400000)),
            packsTarget: randInt(rng, 400, 1200)
          }
        },
        { upsert: true }
      );
    }
  }

  const weekStarts = 5;
  const repCap = Math.min(
    medicalReps.length,
    Math.max(1, Math.ceil((cfg.plansPerCompany || 40) / weekStarts))
  );
  for (const rep of medicalReps.slice(0, repCap)) {
    for (let w = 0; w < weekStarts; w += 1) {
      const start = new Date(Date.now() - (w + 1) * 7 * 24 * 60 * 60 * 1000);
      const day = start.getUTCDay();
      const weekStart = new Date(start);
      weekStart.setUTCDate(start.getUTCDate() - day);
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
      const docPool = sampleDoctors(rng, doctors, 4);
      const plan = await WeeklyPlan.create({
        companyId: company._id,
        medicalRepId: rep._id,
        weekStartDate: weekStart,
        weekEndDate: weekEnd,
        doctorVisits: docPool.map((d) => ({ entityId: d._id, planned: true, completed: w > 0 })),
        distributorVisits: [],
        status: w === 0 ? WEEKLY_PLAN_STATUS.DRAFT : WEEKLY_PLAN_STATUS.ACTIVE,
        createdBy: admin._id
      });
      for (let k = 0; k < docPool.length; k += 1) {
        const d = docPool[k];
        const dayDate = new Date(weekStart);
        dayDate.setUTCDate(weekStart.getUTCDate() + (k % 7));
        const pi = await PlanItem.create({
          companyId: company._id,
          weeklyPlanId: plan._id,
          employeeId: rep._id,
          date: utcDay(dayDate),
          type: PLAN_ITEM_TYPE.DOCTOR_VISIT,
          doctorId: d._id,
          title: `Visit ${d.name}`,
          status: w > 0 ? PLAN_ITEM_STATUS.VISITED : PLAN_ITEM_STATUS.PENDING,
          createdBy: admin._id
        });
        if (w > 0) {
          const vl = await VisitLog.create({
            companyId: company._id,
            planItemId: pi._id,
            employeeId: rep._id,
            doctorId: d._id,
            visitTime: dayDate,
            notes: 'Seed visit',
            createdBy: rep._id
          });
          await PlanItem.updateOne({ _id: pi._id }, { $set: { visitLogId: vl._id } });
        }
      }
    }
  }

  const daysBack = cfg.attendanceDaysBack || 30;
  for (const emp of [...medicalReps, admin]) {
    for (let d = 1; d <= Math.min(daysBack, 35); d += 2) {
      const dd = utcDay(Date.now() - d * 86400000);
      await Attendance.findOneAndUpdate(
        { companyId: company._id, employeeId: emp._id, date: dd },
        {
          $setOnInsert: {
            companyId: company._id,
            employeeId: emp._id,
            date: dd,
            status: ATTENDANCE_STATUS.PRESENT,
            checkInTime: new Date(dd.getTime() + 9 * 3600000),
            checkOutTime: new Date(dd.getTime() + 17 * 3600000),
            markedBy: ATTENDANCE_MARKED_BY.SELF
          }
        },
        { upsert: true }
      );
    }
  }

  for (let ai = 0; ai < Math.min(5, doctors.length); ai += 1) {
    const d = doctors[ai];
    await DoctorActivity.create({
      companyId: company._id,
      doctorId: d._id,
      medicalRepId: pick(rng, medicalReps)._id,
      investedAmount: roundPKR(randInt(rng, 10000, 80000)),
      commitmentAmount: roundPKR(randInt(rng, 30000, 120000)),
      achievedSales: roundPKR(randInt(rng, 5000, 40000)),
      startDate: dateWithRng(rng, 120, 8),
      endDate: dateWithRng(rng, 10, 8),
      status: DOCTOR_ACTIVITY_STATUS.ACTIVE
    });
  }

  for (let p = 0; p < Math.min(6, pharmacies.length); p += 1) {
    await Payment.create({
      companyId: company._id,
      pharmacyId: pharmacies[p]._id,
      amount: roundPKR(randInt(rng, 5000, 45000)),
      paymentMethod: PAYMENT_METHOD.CASH,
      collectedBy: admin._id,
      date: dateWithRng(rng, randInt(rng, 2, 20), 11),
      referenceNumber: `PAY-${String(company._id).slice(-4)}-${p}`
    });
  }

  for (const who of [admin, ...medicalReps.slice(0, 3)]) {
    await SalaryStructure.create({
      companyId: company._id,
      employeeId: who._id,
      basicSalary: randInt(rng, 55000, 110000),
      dailyAllowance: randInt(rng, 500, 2000),
      effectiveFrom: dateWithRng(rng, 400, 8),
      isActive: true
    });
  }

  const delOrder = await Order.findOne({
    companyId: company._id,
    status: { $in: [ORDER_STATUS.DELIVERED, ORDER_STATUS.PARTIALLY_DELIVERED] }
  }).lean();
  if (delOrder && delOrder.items?.length) {
    const first = delOrder.items[0];
    const ret = await ReturnRecord.create({
      companyId: company._id,
      orderId: delOrder._id,
      items: [
        {
          productId: first.productId,
          quantity: 1,
          avgCostAtTime: first.castingAtTime,
          finalSellingPrice: first.tpAtTime,
          profitPerUnit: 0,
          totalProfit: 0
        }
      ],
      totalAmount: roundPKR(first.tpAtTime),
      totalCost: roundPKR(first.castingAtTime),
      totalProfit: roundPKR(first.tpAtTime - first.castingAtTime),
      returnedBy: admin._id
    });
    await Transaction.create({
      companyId: company._id,
      type: TRANSACTION_TYPE.RETURN,
      referenceType: 'RETURN',
      referenceId: ret._id,
      revenue: -roundPKR(first.tpAtTime),
      cost: -roundPKR(first.castingAtTime),
      profit: -roundPKR(first.tpAtTime - first.castingAtTime),
      date: new Date(),
      description: 'Seed return row'
    });
  }

  await AuditLog.create({
    companyId: company._id,
    userId: admin._id,
    action: 'seed.complete',
    entityType: 'Company',
    entityId: company._id,
    changes: { note: 'Deterministic audit row from seed' },
    ipAddress: '127.0.0.1'
  });

  return { doctors: doctors.length, doctorActivities: Math.min(5, doctors.length) };
}

function sampleDoctors(rng, doctors, n) {
  const copy = [...doctors];
  const out = [];
  for (let i = 0; i < n && copy.length; i += 1) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return out;
}

module.exports = { seedFieldAndAncillary };
