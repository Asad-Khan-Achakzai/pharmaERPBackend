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
const { generatePayslipPdf } = require('../utils/payslipPdf');
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

const sumMedicalRepSalesForMonth = async (companyId, employeeId, monthStr) => {
  const [Y, M] = monthStr.split('-').map(Number);
  if (!Y || !M || M < 1 || M > 12) return 0;
  const start = new Date(Date.UTC(Y, M - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(Y, M, 1) - 1);

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

const buildFromStructure = (structure, salesTotal, attendanceStats) => {
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

  const grossSalary = roundPKR(basic + allowancesSum + commissionAmount + dailyAllowanceTotal);

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

const previewPayroll = async (companyId, body) => {
  const { employeeId, month } = body;
  const employee = await User.findOne({ _id: employeeId, companyId });
  if (!employee) throw new ApiError(404, 'Employee not found');

  const manual = body.manual === true || body.baseSalary !== undefined;

  if (manual) {
    if (body.baseSalary === undefined) throw new ApiError(400, 'baseSalary required for manual preview');
    return { ...buildManual(body), employee };
  }

  const structure = await salaryStructureService.getActiveForEmployee(companyId, employeeId);
  if (!structure) {
    throw new ApiError(400, 'No active salary structure. Pass manual: true with baseSalary, bonus, deductions or create a salary structure.');
  }

  const salesTotal = await sumMedicalRepSalesForMonth(companyId, employeeId, month);
  const attendanceStats = await attendanceService.getMonthStatsForPayroll(companyId, employeeId, month, new Date());
  const calc = buildFromStructure(structure, salesTotal, attendanceStats);
  return { ...calc, salaryStructureId: structure._id, employee, structure };
};

const applyPayrollListFilters = (filter, query) => {
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

  applyCreatedAtRangeFromQuery(filter, query);
  applyCreatedByFromQuery(filter, query);

  if (query.paidOnFrom || query.paidOnTo) {
    filter.paidOn = {};
    if (query.paidOnFrom) filter.paidOn.$gte = new Date(query.paidOnFrom);
    if (query.paidOnTo) {
      const t = new Date(query.paidOnTo);
      t.setUTCHours(23, 59, 59, 999);
      filter.paidOn.$lte = t;
    }
  }
};

const list = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  applyPayrollListFilters(filter, query);

  const [docs, total] = await Promise.all([
    Payroll.find(filter).populate('employeeId', 'name email role').sort(sort).skip(skip).limit(limit),
    Payroll.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
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

  const structure = await salaryStructureService.getActiveForEmployee(companyId, data.employeeId);
  if (!structure) {
    throw new ApiError(
      400,
      'No active salary structure. Use manual mode (manual: true with baseSalary, bonus, deductions) or create an active salary structure.'
    );
  }

  const salesTotal = await sumMedicalRepSalesForMonth(companyId, data.employeeId, data.month);
  const attendanceStats = await attendanceService.getMonthStatsForPayroll(
    companyId,
    data.employeeId,
    data.month,
    new Date()
  );
  const built = buildFromStructure(structure, salesTotal, attendanceStats);

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
    calculationMode: 'structure',
    salaryStructureId: structure._id,
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

const pay = async (companyId, id, reqUser) => {
  const payroll = await Payroll.findOne({ _id: id, companyId });
  if (!payroll) throw new ApiError(404, 'Payroll not found');
  if (payroll.status === PAYROLL_STATUS.PAID) throw new ApiError(400, 'Already paid');

  payroll.status = PAYROLL_STATUS.PAID;
  payroll.paidOn = new Date();
  payroll.updatedBy = reqUser.userId;
  await payroll.save();

  const expense = await Expense.create({
    companyId,
    category: EXPENSE_CATEGORY.SALARY,
    amount: payroll.netSalary,
    description: `Salary for ${payroll.month}`,
    date: new Date(),
    employeeId: payroll.employeeId,
    approvedBy: reqUser.userId,
    createdBy: reqUser.userId
  });

  await Transaction.create({
    companyId,
    type: TRANSACTION_TYPE.EXPENSE,
    referenceType: 'PAYROLL',
    referenceId: payroll._id,
    revenue: 0,
    cost: payroll.netSalary,
    profit: roundPKR(-payroll.netSalary),
    date: new Date(),
    description: `Salary payment - ${payroll.month}`,
    createdBy: reqUser.userId
  });

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

module.exports = { list, create, update, pay, preview: previewPayroll, streamPayslipPdf };
