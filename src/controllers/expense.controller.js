const expenseService = require('../services/expense.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => { ApiResponse.paginated(res, await expenseService.list(req.companyId, req.query)); });
const create = asyncHandler(async (req, res) => { ApiResponse.created(res, await expenseService.create(req.companyId, req.body, req.user)); });
const update = asyncHandler(async (req, res) => { ApiResponse.success(res, await expenseService.update(req.companyId, req.params.id, req.body, req.user), 'Expense updated'); });
const remove = asyncHandler(async (req, res) => { await expenseService.remove(req.companyId, req.params.id, req.user); ApiResponse.success(res, null, 'Expense deleted'); });

module.exports = { list, create, update, remove };
