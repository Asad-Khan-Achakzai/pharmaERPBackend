const mongoose = require('mongoose');
const Payroll = require('../models/Payroll');
const Order = require('../models/Order');
const Expense = require('../models/Expense');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Company = require('../models/Company');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { PAYROLL_STATUS, TRANSACTION_TYPE, EXPENSE_CATEGORY, ORDER_STATUS } = require('../constants/enums');
const { roundPKR } = require('../utils/currency');
const auditService = require('./audit.service');
const salaryStructureService = require('./salaryStructure.service');
const attendanceService = require('./attendance.service');
const { deliveredPacksByProduct } = require('./repDeliveredPacksByProduct.service');
const { monthCalendarUtcRange } = require('./medRepTargetAchieved.service');
const { calculateProductIncentives } = require('../utils/productIncentiveCalculator');
const { snapshotProductPackIncentives } = require('../utils/productPackIncentiveNormalize');
const { generatePayslipPdf } = require('../utils/payslipPdf');
const { DateTime } = require('luxon');
const businessTime = require('../utils/businessTime');
const {
  escapeRegex,
  qScalar,
  applyCreatedAtRangeFromQuery,
  applyCreatedByFromQuery
} = require('../utils/listQuery');

const lineAmount = (basic, item) => {
  if (item.type === 'fixed') return roundPKR(item.value);
  return roundPKR((basic * item.value) / 100);
};

const sumMedicalRepSalesForMonth = async (companyId, employeeId, monthStr, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const [Y, M] = monthStr.split('-').map(Number);
  if (!Y || !M || M < 1 || M > 12) return 0;
  const start = DateTime.fromObject({ year: Y, month: M, day: 1 }, { zone: tz }).startOf('month').toUTC().toJSDate();
  const end = DateTime.fromObject({ year: Y, month: M, day: 1 }, { zone: tz }).endOf('month').toUTC().toJSDate();

  const agg = await Order.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        medicalRepId: new mongoose.Types.ObjectId(employeeId),
        status: { $ne: ORDER_STATUS.CANCELLED },
        createdAt: { $gte: start, $lte: end },
        isDeleted: { $ne: true }
      }
    },
    { $group: { _id: null, total: { $sum: '$totalOrderedAmount' } } }
  ]);
  return roundPKR(agg[0]?.total || 0);
};

const resolvePayrollPeriod = (monthStr, timeZone) => {
  const range = monthCalendarUtcRange(monthStr, timeZone);
  return {
    range,
    periodFrom: range.$gte,
    periodTo: range.$lte
  };
};

const computeProductIncentivesForStructure = async (companyId, employeeId, structure, monthStr, timeZone) => {
  const rules = structure.productPackIncentives || [];
  if (!rules.length) {
    return {
      productIncentiveLines: [],
      productIncentiveTotal: 0,
      productIncentiveRulesSnapshot: []
    };
  }
  const { range } = resolvePayrollPeriod(monthStr, timeZone);
  const { byProductId, rows } = await deliveredPacksByProduct(companyId, employeeId, range);
  const nameMap = new Map(rows.map((r) => [r.productId, { name: r.productName, composition: r.composition }]));
  const { lines, total } = calculateProductIncentives(rules, byProductId, nameMap);
  return {
    productIncentiveLines: lines,
    productIncentiveTotal: total,
    productIncentiveRulesSnapshot: snapshotProductPackIncentives(rules)
  };
};

const buildFromStructure = (structure, salesTotal, attendanceStats, productIncentiveResult = {}) => {
  const basic = structure.basicSalary;
  const totalDaysInMonth = attendanceStats.totalDaysInMonth;

  const dailyAllowanceRate = roundPKR(structure.dailyAllowance || 0);
  const { presentDays, absentDays, halfDays, leaveDays } = attendanceStats;

  const dailyAllowanceTotal = roundPKR(
    presentDays * dailyAllowanceRate + halfDays * dailyAllowanceRate * 0.5
  );

  const allowanceLines = [];
  let allowancesSum = 0;
  for (const a of structure.allowances || []) {
    const amount = lineAmount(basic, a);
    allowanceLines.push({ name: a.name, amount });
    allowancesSum += amount;
  }
  allowancesSum = roundPKR(allowancesSum);

  const deductionLines = [];
  let deductionsSum = 0;
  for (const d of structure.deductions || []) {
    const amount = lineAmount(basic, d);
    deductionLines.push({ name: d.name, amount });
    deductionsSum += amount;
  }
  deductionsSum = roundPKR(deductionsSum);

  const pct = structure.commission?.value || 0;
  const commissionAmount = roundPKR((salesTotal * pct) / 100);
  const commission = {
    type: 'percentage',
    value: pct,
    salesTotal,
    amount: commissionAmount
  };

  const productIncentiveTotal = roundPKR(productIncentiveResult.productIncentiveTotal || 0);
  const productIncentiveLines = productIncentiveResult.productIncentiveLines || [];
  const productIncentiveRulesSnapshot = productIncentiveResult.productIncentiveRulesSnapshot || [];

  const grossSalary = roundPKR(
    basic + allowancesSum + commissionAmount + dailyAllowanceTotal + productIncentiveTotal
  );

  /** No pay cut for absences until product supports configurable attendance deductions. */
  const attendanceDeduction = 0;

  const netSalary = roundPKR(grossSalary - deductionsSum - attendanceDeduction);

  return {
    baseSalary: basic,
    bonus: 0,
    deductions: deductionsSum,
    grossSalary,
    netSalary,
    allowanceLines,
    deductionLines,
    commission,
    productIncentiveTotal,
    productIncentiveLines,
    productIncentiveRulesSnapshot,
    calculationMode: 'structure',
    dailyAllowance: dailyAllowanceRate,
    presentDays,
    absentDays,
    halfDays,
    leaveDays,
    totalDaysInMonth,
    dailyAllowanceTotal,
    attendanceDeduction
  };
};

const buildManual = (data) => {
  const baseSalary = data.baseSalary;
  const bonus = data.bonus || 0;
  const deductions = data.deductions || 0;
  const grossSalary = roundPKR(baseSalary + bonus);
  const netSalary = roundPKR(grossSalary - deductions);
  return {
    baseSalary,
    bonus,
    deductions,
    grossSalary,
    netSalary,
    allowanceLines: [],
    deductionLines: [],
    commission: { type: 'percentage', value: 0, salesTotal: 0, amount: 0 },
    productIncentiveTotal: 0,
    productIncentiveLines: [],
    productIncentiveRulesSnapshot: [],
    calculationMode: 'manual',
    dailyAllowance: 0,
    presentDays: 0,
    absentDays: 0,
    halfDays: 0,
    leaveDays: 0,
    totalDaysInMonth: 0,
    dailyAllowanceTotal: 0,
    attendanceDeduction: 0
  };
};

const previewPayroll = async (companyId, body, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const { employeeId, month } = body;
  const employee = await User.findOne({ _id: employeeId, companyId });
  if (!employee) throw new ApiError(404, 'Employee not found');

  const manual = body.manual === true || body.baseSalary !== undefined;

  if (manual) {
    if (body.baseSalary === undefined) throw new ApiError(400, 'baseSalary required for manual preview');
    return { ...buildManual(body), employee };
  }

  const structure = await salaryStructureService.getStructureForEmployee(companyId, employeeId);
  if (!structure) {
    throw new ApiError(400, 'No active salary structure. Pass manual: true with baseSalary, bonus, deductions or assign a salary structure template.');
  }

  const salesTotal = await sumMedicalRepSalesForMonth(companyId, employeeId, month, tz);
  const attendanceStats = await attendanceService.getMonthStatsForPayroll(
    companyId,
    employeeId,
    month,
    businessTime.utcNow(),
    tz
  );
  const productIncentiveResult = await computeProductIncentivesForStructure(
    companyId,
    employeeId,
    structure,
    month,
    tz
  );
  const { periodFrom, periodTo } = resolvePayrollPeriod(month, tz);
  const calc = buildFromStructure(structure, salesTotal, attendanceStats, productIncentiveResult);
  return {
    ...calc,
    periodFrom,
    periodTo,
    salaryStructureId: structure._id,
    salaryStructureNameSnapshot: structure.name || undefined,
    employee,
    structure
  };
};

const applyPayrollListFilters = (filter, query, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  if (query.employeeId) filter.employeeId = query.employeeId;
  if (query.status) filter.status = query.status;

  if (query.month) {
    filter.month = query.month;
  } else if (query.monthFrom || query.monthTo) {
    filter.month = {};
    if (query.monthFrom) filter.month.$gte = query.monthFrom;
    if (query.monthTo) filter.month.$lte = query.monthTo;
  }

  const searchTerm = qScalar(query.search);
  if (searchTerm && !query.month && !query.monthFrom && !query.monthTo) {
    const rx = escapeRegex(searchTerm);
    filter.month = { $regex: rx, $options: 'i' };
  }

  applyCreatedAtRangeFromQuery(filter, query, tz);
  applyCreatedByFromQuery(filter, query);

  if (query.paidOnFrom || query.paidOnTo) {
    businessTime.applyOptionalUtcRange(filter, 'paidOn', query.paidOnFrom, query.paidOnTo, tz);
  }
};

const list = async (companyId, query, timeZone) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  applyPayrollListFilters(filter, query, timeZone);

  const [docs, total] = await Promise.all([
    Payroll.find(filter).populate('employeeId', 'name email role').sort(sort).skip(skip).limit(limit),
    Payroll.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const nd = { isDeleted: { $ne: true } };

/**
 * Who still needs salary action for a given month: unpaid payroll rows + employees on a
 * salary structure with no payroll created yet.
 */
const pendingSummary = async (companyId, month) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    throw new ApiError(400, 'month must be YYYY-MM');
  }

  const cid = new mongoose.Types.ObjectId(companyId);

  const [unpaidRows, payrollEmployeeIds, paidCount] = await Promise.all([
    Payroll.find({ companyId: cid, month, status: PAYROLL_STATUS.PENDING, ...nd })
      .populate('employeeId', 'name email role')
      .lean(),
    Payroll.find({ companyId: cid, month, ...nd }).distinct('employeeId'),
    Payroll.countDocuments({ companyId: cid, month, status: PAYROLL_STATUS.PAID, ...nd })
  ]);

  const employeesMissingPayroll = await User.find({
    companyId: cid,
    isActive: true,
    salaryStructureId: { $ne: null },
    _id: { $nin: payrollEmployeeIds },
    ...nd
  })
    .select('name email role salaryStructureId')
    .populate('salaryStructureId', 'name')
    .sort({ name: 1 })
    .lean();

  const readyToPay = unpaidRows
    .map((p) => ({
      payrollId: String(p._id),
      employeeId: String(p.employeeId?._id ?? p.employeeId),
      name: p.employeeId?.name ?? 'Unknown',
      netSalary: roundPKR(p.netSalary),
      status: p.status
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const missingPayroll = employeesMissingPayroll.map((u) => ({
    employeeId: String(u._id),
    name: u.name,
    salaryStructureName: u.salaryStructureId?.name ?? null
  }));

  const unpaidTotal = roundPKR(readyToPay.reduce((sum, row) => sum + row.netSalary, 0));

  return {
    month,
    summary: {
      readyToPayCount: readyToPay.length,
      unpaidTotal,
      missingPayrollCount: missingPayroll.length,
      paidCount
    },
    readyToPay,
    missingPayroll
  };
};

const create = async (companyId, data, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const employee = await User.findOne({ _id: data.employeeId, companyId });
  if (!employee) throw new ApiError(404, 'Employee not found');

  const dup = await Payroll.findOne({ companyId, employeeId: data.employeeId, month: data.month });
  if (dup) throw new ApiError(400, 'Payroll already exists for this employee and month');

  /** Legacy clients send baseSalary without manual:true — treat as manual. */
  const manual = data.manual === true || data.baseSalary !== undefined;

  if (manual) {
    if (data.baseSalary === undefined) throw new ApiError(400, 'baseSalary is required for manual payroll');
    const built = buildManual(data);
    const payroll = await Payroll.create({
      companyId,
      employeeId: data.employeeId,
      month: data.month,
      baseSalary: built.baseSalary,
      bonus: built.bonus,
      deductions: built.deductions,
      netSalary: built.netSalary,
      grossSalary: built.grossSalary,
      allowanceLines: built.allowanceLines,
      deductionLines: built.deductionLines,
      commission: built.commission,
      calculationMode: 'manual',
      dailyAllowance: built.dailyAllowance,
      presentDays: built.presentDays,
      absentDays: built.absentDays,
      halfDays: built.halfDays,
      leaveDays: built.leaveDays,
      totalDaysInMonth: built.totalDaysInMonth,
      dailyAllowanceTotal: built.dailyAllowanceTotal,
      attendanceDeduction: built.attendanceDeduction,
      createdBy: reqUser.userId
    });
    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'payroll.create',
      entityType: 'Payroll',
      entityId: payroll._id,
      changes: { after: payroll.toObject() }
    });
    return payroll.populate('employeeId', 'name email role');
  }

  const structure = await salaryStructureService.getStructureForEmployee(companyId, data.employeeId);
  if (!structure) {
    throw new ApiError(
      400,
      'No active salary structure. Use manual mode (manual: true with baseSalary, bonus, deductions) or assign a salary structure template.'
    );
  }

  const salesTotal = await sumMedicalRepSalesForMonth(companyId, data.employeeId, data.month, tz);
  const attendanceStats = await attendanceService.getMonthStatsForPayroll(
    companyId,
    data.employeeId,
    data.month,
    businessTime.utcNow(),
    tz
  );
  const productIncentiveResult = await computeProductIncentivesForStructure(
    companyId,
    data.employeeId,
    structure,
    data.month,
    tz
  );
  const { periodFrom, periodTo } = resolvePayrollPeriod(data.month, tz);
  const built = buildFromStructure(structure, salesTotal, attendanceStats, productIncentiveResult);

  const payroll = await Payroll.create({
    companyId,
    employeeId: data.employeeId,
    month: data.month,
    periodFrom,
    periodTo,
    baseSalary: built.baseSalary,
    bonus: built.bonus,
    deductions: built.deductions,
    netSalary: built.netSalary,
    grossSalary: built.grossSalary,
    allowanceLines: built.allowanceLines,
    deductionLines: built.deductionLines,
    commission: built.commission,
    productIncentiveTotal: built.productIncentiveTotal,
    productIncentiveLines: built.productIncentiveLines,
    productIncentiveRulesSnapshot: built.productIncentiveRulesSnapshot,
    calculationMode: 'structure',
    salaryStructureId: structure._id,
    salaryStructureNameSnapshot: structure.name || undefined,
    dailyAllowance: built.dailyAllowance,
    presentDays: built.presentDays,
    absentDays: built.absentDays,
    halfDays: built.halfDays,
    leaveDays: built.leaveDays,
    totalDaysInMonth: built.totalDaysInMonth,
    dailyAllowanceTotal: built.dailyAllowanceTotal,
    attendanceDeduction: built.attendanceDeduction,
    createdBy: reqUser.userId
  });

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'payroll.create',
    entityType: 'Payroll',
    entityId: payroll._id,
    changes: { after: payroll.toObject() }
  });
  return payroll.populate('employeeId', 'name email role');
};

const update = async (companyId, id, data, reqUser) => {
  const payroll = await Payroll.findOne({ _id: id, companyId });
  if (!payroll) throw new ApiError(404, 'Payroll not found');
  if (payroll.status === PAYROLL_STATUS.PAID) throw new ApiError(400, 'Cannot edit paid payroll');

  const before = payroll.toObject();

  if (payroll.calculationMode === 'structure' && !data.manualOverride) {
    throw new ApiError(400, 'This payroll was generated from a salary structure. Re-submit with manualOverride: true to replace amounts using baseSalary, bonus, and deductions (legacy totals).');
  }

  if (data.manualOverride === true) {
    payroll.calculationMode = 'manual';
    payroll.salaryStructureId = undefined;
    payroll.allowanceLines = [];
    payroll.deductionLines = [];
    payroll.commission = { type: 'percentage', value: 0, salesTotal: 0, amount: 0 };
    payroll.productIncentiveTotal = 0;
    payroll.productIncentiveLines = [];
    payroll.productIncentiveRulesSnapshot = [];
    payroll.grossSalary = undefined;
    payroll.dailyAllowance = 0;
    payroll.presentDays = 0;
    payroll.absentDays = 0;
    payroll.halfDays = 0;
    payroll.leaveDays = 0;
    payroll.totalDaysInMonth = 0;
    payroll.dailyAllowanceTotal = 0;
    payroll.attendanceDeduction = 0;
  }

  if (data.baseSalary !== undefined) payroll.baseSalary = data.baseSalary;
  if (data.bonus !== undefined) payroll.bonus = data.bonus;
  if (data.deductions !== undefined) payroll.deductions = data.deductions;

  const built = buildManual({
    baseSalary: payroll.baseSalary,
    bonus: payroll.bonus,
    deductions: payroll.deductions
  });
  payroll.netSalary = built.netSalary;
  payroll.grossSalary = built.grossSalary;

  payroll.updatedBy = reqUser.userId;
  await payroll.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'payroll.update',
    entityType: 'Payroll',
    entityId: payroll._id,
    changes: { before, after: payroll.toObject() }
  });
  return payroll.populate('employeeId', 'name email role');
};

const pay = async (companyId, id, reqUser, body = {}) => {
  const payroll = await Payroll.findOne({ _id: id, companyId });
  if (!payroll) throw new ApiError(404, 'Payroll not found');
  if (payroll.status === PAYROLL_STATUS.PAID) throw new ApiError(400, 'Already paid');

  const glPosting = require('./glPosting.service');
  const moneyAccountService = require('./moneyAccount.service');
  const { ACCOUNT_CODES } = require('../constants/coaTemplate');
  const coaSeed = require('./coaSeed.service');
  const glBridge = require('./glBridge.service');

  // Setup reads/writes that touch many accounts must run outside an active transaction.
  await coaSeed.ensureCoaForCompany(companyId);
  const salaryAcc = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.SALARY_EXPENSE);
  if (!salaryAcc) throw new ApiError(400, 'Salary expense account not found in Chart of Accounts');

  const moneyAcc = await moneyAccountService.assertMoneyAccount(companyId, body.moneyAccountId);

  const amount = roundPKR(payroll.netSalary);
  const narration = `Salary for ${payroll.month}`;
  let expense;

  const isRetryableTxnError = (err) =>
    err?.code === 112 ||
    err?.errorLabels?.includes('TransientTransactionError') ||
    /Write conflict/i.test(String(err?.message || ''));

  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const payrollDoc = await Payroll.findOne({
          _id: id,
          companyId,
          status: { $ne: PAYROLL_STATUS.PAID }
        }).session(session);
        if (!payrollDoc) throw new ApiError(400, 'Already paid');

        const paidOn = new Date();
        payrollDoc.status = PAYROLL_STATUS.PAID;
        payrollDoc.paidOn = paidOn;
        payrollDoc.updatedBy = reqUser.userId;
        await payrollDoc.save({ session });

        const salaryAccInTxn = await glPosting.getAccountByCode(
          companyId,
          ACCOUNT_CODES.SALARY_EXPENSE,
          session
        );
        if (!salaryAccInTxn) {
          throw new ApiError(400, 'Salary expense account not found in Chart of Accounts');
        }
        const moneyAccInTxn = await moneyAccountService.assertMoneyAccount(
          companyId,
          moneyAcc._id,
          session
        );

        [expense] = await Expense.create(
          [
            {
              companyId,
              category: EXPENSE_CATEGORY.SALARY,
              expenseAccountId: salaryAccInTxn._id,
              moneyAccountId: moneyAccInTxn._id,
              amount,
              description: narration,
              date: paidOn,
              employeeId: payrollDoc.employeeId,
              approvedBy: reqUser.userId,
              createdBy: reqUser.userId
            }
          ],
          { session }
        );

        const voucher = await glBridge.postExpenseGl(
          session,
          companyId,
          {
            expenseId: expense._id,
            expenseAccountId: salaryAccInTxn._id,
            moneyAccountId: moneyAccInTxn._id,
            amount,
            date: paidOn,
            narration
          },
          reqUser
        );
        if (!voucher) throw new ApiError(500, 'Failed to post payroll expense voucher');

        await Expense.updateOne(
          { _id: expense._id },
          { $set: { voucherId: voucher._id } },
          { session }
        );

        await Transaction.create(
          [
            {
              companyId,
              type: TRANSACTION_TYPE.EXPENSE,
              referenceType: 'PAYROLL',
              referenceId: payrollDoc._id,
              revenue: 0,
              cost: amount,
              profit: roundPKR(-amount),
              date: paidOn,
              description: `Salary payment - ${payrollDoc.month}`,
              createdBy: reqUser.userId
            }
          ],
          { session }
        );

        payroll.status = payrollDoc.status;
        payroll.paidOn = payrollDoc.paidOn;
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (!isRetryableTxnError(err) || attempt === maxAttempts) throw err;
    } finally {
      await session.endSession();
    }
  }
  if (lastError) throw lastError;

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'payroll.pay',
    entityType: 'Payroll',
    entityId: payroll._id,
    changes: { after: { status: 'PAID', paidOn: payroll.paidOn, expenseId: expense._id } }
  });

  return payroll;
};

const remove = async (companyId, id, reqUser) => {
  const payroll = await Payroll.findOne({ _id: id, companyId });
  if (!payroll) throw new ApiError(404, 'Payroll not found');
  if (payroll.status === PAYROLL_STATUS.PAID) throw new ApiError(400, 'Cannot delete paid payroll');
  const before = payroll.toObject();
  await payroll.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'payroll.delete',
    entityType: 'Payroll',
    entityId: payroll._id,
    changes: { before }
  });
  return { deleted: true };
};

const streamPayslipPdf = async (companyId, id, res) => {
  const payroll = await Payroll.findOne({ _id: id, companyId }).populate('employeeId', 'name email role');
  if (!payroll) throw new ApiError(404, 'Payroll not found');

  const company = await Company.findById(companyId).select('name');
  const employee = payroll.employeeId;
  const filename = `payslip-${payroll.month}-${(employee?.name || 'employee').replace(/\s+/g, '-')}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  generatePayslipPdf({
    stream: res,
    companyName: company?.name || 'Company',
    payroll: payroll.toObject(),
    employee: { name: employee?.name, role: employee?.role }
  });
};

module.exports = { list, create, update, pay, remove, preview: previewPayroll, streamPayslipPdf, pendingSummary };
