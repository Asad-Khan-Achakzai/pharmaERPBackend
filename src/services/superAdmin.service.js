const mongoose = require('mongoose');
const Company = require('../models/Company');
const User = require('../models/User');
const UserCompanyAccess = require('../models/UserCompanyAccess');
const { ROLES: USER_ROLES, USER_TYPES } = require('../constants/enums');
const { seedDefaultRolesForCompany } = require('./role.service');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const Payroll = require('../models/Payroll');
const Expense = require('../models/Expense');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { generateTokens } = require('./auth.tokens');
const { formatUserForClient } = require('../utils/authUserPayload');

const { resolveCompanyTimeZone } = require('../utils/countryTimeZone');
const { Info } = require('luxon');

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
  const tz = resolveCompanyTimeZone({ timeZone: data.timeZone, country: data.country });
  data.timeZone = tz;
  const company = await Company.create(data);
  await seedDefaultRolesForCompany(company._id, {});
  return company;
};

const updateCompany = async (id, payload) => {
  const company = await Company.findById(id);
  if (!company) throw new ApiError(404, 'Company not found');
  const patch = { ...payload };
  if (Object.prototype.hasOwnProperty.call(patch, 'timeZone')) {
    const mergedCountry = patch.country != null ? patch.country : company.country;
    company.timeZone = resolveCompanyTimeZone({ timeZone: patch.timeZone, country: mergedCountry });
    delete patch.timeZone;
  }
  Object.assign(company, patch);
  const tzCheck = company.timeZone != null ? String(company.timeZone).trim() : '';
  if (!tzCheck || !Info.isValidIANAZone(tzCheck)) {
    throw new ApiError(422, 'Company timezone is not configured. Onboarding incomplete.');
  }
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
  const tokens = generateTokens({
    userId: user._id,
    userType: USER_TYPES.PLATFORM,
    tenantCompanyId: String(company._id),
    homeCompanyId: user.companyId
  });
  user.refreshToken = tokens.refreshToken;
  await user.save();

  const u = await formatUserForClient(userId, { resolvedTenantCompanyId: String(company._id) });
  return {
    tokens,
    user: u,
    company: { _id: company._id, name: company.name, city: company.city, currency: company.currency }
  };
};

const toOid = (id) => {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
};

const assertCompaniesExist = async (companyIds) => {
  const oids = companyIds.map(toOid).filter(Boolean);
  if (oids.length !== companyIds.length) {
    throw new ApiError(400, 'Invalid company id');
  }
  const found = await Company.find({ _id: { $in: oids }, isDeleted: { $ne: true } })
    .select('_id isActive')
    .lean();
  if (found.length !== oids.length) {
    throw new ApiError(400, 'One or more companies not found');
  }
  const inactive = found.filter((c) => c.isActive === false);
  if (inactive.length) {
    throw new ApiError(400, 'All assigned companies must be active');
  }
  return oids;
};

const syncUserCompanyAccess = async (userId, companyObjectIds) => {
  const uid = toOid(userId);
  const cids = companyObjectIds;
  if (!uid || !cids.length) {
    throw new ApiError(400, 'At least one company is required for platform access');
  }
  await UserCompanyAccess.updateMany(
    { userId: uid, companyId: { $nin: cids } },
    { $set: { status: 'revoked' } }
  );
  for (const cid of cids) {
    await UserCompanyAccess.findOneAndUpdate(
      { userId: uid, companyId: cid },
      { $set: { status: 'active' } },
      { upsert: true }
    );
  }
};

const getActiveCompanyIdsForUser = async (userId) => {
  const rows = await UserCompanyAccess.find({
    userId: toOid(userId),
    status: 'active'
  })
    .select('companyId')
    .lean();
  return rows.map((r) => String(r.companyId));
};

const listPlatformUsers = async (query) => {
  const { page, limit, skip, search } = parsePagination(query);
  const isActiveQ = query.isActive;
  const match = { userType: USER_TYPES.PLATFORM, isDeleted: { $ne: true } };
  if (search) {
    match.email = { $regex: String(search), $options: 'i' };
  }
  if (isActiveQ === 'true' || isActiveQ === 'false') {
    match.isActive = isActiveQ === 'true';
  }

  const ucaColl = UserCompanyAccess.collection.name;

  const [agg] = await User.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    {
      $lookup: {
        from: ucaColl,
        let: { uid: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$userId', '$$uid'] },
                  { $eq: ['$status', 'active'] }
                ]
              }
            }
          }
        ],
        as: 'activeAccess'
      }
    },
    { $addFields: { companyCount: { $size: '$activeAccess' } } },
    { $project: { password: 0, refreshToken: 0, activeAccess: 0 } },
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: limit }],
        count: [{ $count: 'n' }]
      }
    }
  ]);
  const docs = agg.data || [];
  const total = agg.count?.[0]?.n || 0;
  return { docs, total, page, limit };
};

const getPlatformUserById = async (id) => {
  const user = await User.findById(id).lean();
  if (!user || user.isDeleted) {
    throw new ApiError(404, 'User not found');
  }
  if (user.userType !== USER_TYPES.PLATFORM) {
    throw new ApiError(400, 'User is not a platform user');
  }
  const companyIds = await getActiveCompanyIdsForUser(id);
  const { password, refreshToken, ...rest } = user;
  return { ...rest, companyIds };
};

const createPlatformUser = async (body) => {
  const { name, email, password, isActive, companyIds, homeCompanyId: homeFromBody } = body;
  const emailNorm = String(email).toLowerCase().trim();
  const dupe = await User.findOne({ email: emailNorm });
  if (dupe) {
    throw new ApiError(409, 'User with this email already exists');
  }

  const oids = await assertCompaniesExist(companyIds);
  const idStrs = oids.map((x) => String(x));
  const homeStr = homeFromBody && idStrs.includes(homeFromBody) ? homeFromBody : idStrs[0];
  const home = toOid(homeStr);
  const { adminRole } = await seedDefaultRolesForCompany(home, {});

  const firstActive = oids[0];
  const user = await User.create({
    companyId: home,
    userType: USER_TYPES.PLATFORM,
    name: name.trim(),
    email: emailNorm,
    password,
    role: USER_ROLES.ADMIN,
    roleId: adminRole._id,
    isActive: isActive !== false,
    activeCompanyId: firstActive,
    permissions: []
  });

  await syncUserCompanyAccess(user._id, oids);
  return getPlatformUserById(user._id);
};

const updatePlatformUser = async (id, body) => {
  const user = await User.findById(id);
  if (!user || user.isDeleted) {
    throw new ApiError(404, 'User not found');
  }
  if (user.userType !== USER_TYPES.PLATFORM) {
    throw new ApiError(400, 'User is not a platform user');
  }

  if (body.name) user.name = body.name.trim();
  if (body.email) {
    const emailNorm = String(body.email).toLowerCase().trim();
    const other = await User.findOne({ email: emailNorm, _id: { $ne: user._id } });
    if (other) {
      throw new ApiError(409, 'User with this email already exists');
    }
    user.email = emailNorm;
  }
  if (body.isActive !== undefined) user.isActive = body.isActive;
  if (body.password) user.password = body.password;

  let oids;
  if (body.companyIds && body.companyIds.length) {
    oids = await assertCompaniesExist(body.companyIds);
  }

  if (oids) {
    const idStrs = oids.map((x) => String(x));
    let home = user.companyId;
    if (body.homeCompanyId && idStrs.includes(body.homeCompanyId)) {
      home = toOid(body.homeCompanyId);
    } else if (!idStrs.includes(String(user.companyId))) {
      [home] = oids;
    } else {
      home = user.companyId;
    }
    const { adminRole } = await seedDefaultRolesForCompany(home, {});
    user.companyId = home;
    user.roleId = adminRole._id;
    if (user.activeCompanyId) {
      const a = String(user.activeCompanyId);
      if (!idStrs.includes(a)) {
        user.activeCompanyId = oids[0];
      }
    }
    await user.save();
    await syncUserCompanyAccess(user._id, oids);
  } else {
    await user.save();
  }

  return getPlatformUserById(user._id);
};

const deletePlatformUser = async (id, deletedBy) => {
  const user = await User.findById(id);
  if (!user || user.isDeleted) {
    throw new ApiError(404, 'User not found');
  }
  if (user.userType !== USER_TYPES.PLATFORM) {
    throw new ApiError(400, 'User is not a platform user');
  }
  await UserCompanyAccess.updateMany(
    { userId: user._id },
    { $set: { status: 'revoked' } }
  );
  await user.softDelete(deletedBy);
  return { deleted: true };
};

module.exports = {
  listCompanies,
  createCompany,
  updateCompany,
  getCompanySummary,
  switchCompany,
  listPlatformUsers,
  getPlatformUserById,
  createPlatformUser,
  updatePlatformUser,
  deletePlatformUser
};
