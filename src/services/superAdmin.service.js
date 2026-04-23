const mongoose = require('mongoose');
const Company = require('../models/Company');
const User = require('../models/User');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const Payroll = require('../models/Payroll');
const Expense = require('../models/Expense');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { generateTokens } = require('./auth.tokens');

const notDeleted = { isDeleted: { $ne: true } };

const listCompanies = async (query) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const filter = { ...notDeleted };
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { city: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } }
    ];
  }

  const [docs, total] = await Promise.all([
    Company.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Company.countDocuments(filter)
  ]);

  return { docs, total, page, limit };
};

const createCompany = async (payload) => {
  const data = { ...payload };
  if (data.email === '') data.email = undefined;
  return Company.create(data);
};

const updateCompany = async (id, payload) => {
  const company = await Company.findById(id);
  if (!company) throw new ApiError(404, 'Company not found');
  Object.assign(company, payload);
  await company.save();
  return company;
};

const getCompanySummary = async (companyId) => {
  const exists = await Company.findById(companyId);
  if (!exists) throw new ApiError(404, 'Company not found');

  const cid = new mongoose.Types.ObjectId(companyId);
  const base = { companyId: cid, ...notDeleted };

  const [
    totalUsers,
    totalOrders,
    revenueAgg,
    payrollAgg,
    expenseAgg
  ] = await Promise.all([
    User.countDocuments({ companyId: cid, ...notDeleted }),
    Order.countDocuments(base),
    Transaction.aggregate([
      { $match: base },
      { $group: { _id: null, total: { $sum: '$revenue' } } }
    ]),
    Payroll.aggregate([
      { $match: base },
      { $group: { _id: null, total: { $sum: '$netSalary' } } }
    ]),
    Expense.aggregate([
      { $match: base },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ])
  ]);

  return {
    companyId,
    totalUsers,
    totalOrders,
    totalRevenue: revenueAgg[0]?.total ?? 0,
    totalPayroll: payrollAgg[0]?.total ?? 0,
    totalExpenses: expenseAgg[0]?.total ?? 0
  };
};

const switchCompany = async (userId, companyId) => {
  const company = await Company.findById(companyId);
  if (!company) throw new ApiError(404, 'Company not found');
  if (!company.isActive) throw new ApiError(400, 'Company is inactive');

  const user = await User.findById(userId).select('+refreshToken');
  if (!user) throw new ApiError(404, 'User not found');

  user.activeCompanyId = company._id;
  const tokens = generateTokens(user._id, user.companyId);
  user.refreshToken = tokens.refreshToken;
  await user.save();

  return {
    tokens,
    user: user.toJSON(),
    company: { _id: company._id, name: company.name, city: company.city, currency: company.currency }
  };
};

module.exports = {
  listCompanies,
  createCompany,
  updateCompany,
  getCompanySummary,
  switchCompany
};
