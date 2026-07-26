const catalogSummaryTools = require('./catalog/catalogSummaryTools');
const doctorTools = require('./doctors/doctorTools');
const companyTools = require('./company/companyTools');
const visitTools = require('./visits/visitTools');
const attendanceTools = require('./attendance/attendanceTools');
const orderTools = require('./orders/orderTools');
const writeOrderTools = require('./orders/writeOrderTools');
const inventoryTools = require('./inventory/inventoryTools');
const salesTools = require('./sales/salesTools');
const coverageTools = require('./coverage/coverageTools');
const userTools = require('./users/userTools');

const ALL_TOOLS = [
  companyTools.companyProfile,
  catalogSummaryTools.doctorSummary,
  catalogSummaryTools.pharmacySummary,
  catalogSummaryTools.productSummary,
  catalogSummaryTools.distributorSummary,
  doctorTools.searchDoctors,
  doctorTools.doctorProfile,
  visitTools.todayVisits,
  visitTools.pendingVisits,
  visitTools.missedVisits,
  visitTools.teamVisitsToday,
  attendanceTools.attendanceToday,
  attendanceTools.attendanceHistory,
  orderTools.searchOrders,
  inventoryTools.stockLookup,
  inventoryTools.warehouseStock,
  salesTools.salesSummary,
  salesTools.salesTrend,
  coverageTools.coverageAnalysis,
  coverageTools.territoryAnalysis,
  userTools.userProfile,
  userTools.teamPerformance,
  userTools.employeeSummary,
  writeOrderTools.createOrder
];

const toolMap = new Map(ALL_TOOLS.map((t) => [t.name, t]));

function getAllTools() {
  return ALL_TOOLS.filter((t) => t.mutability !== 'write');
}

function getTool(name) {
  return toolMap.get(name) || null;
}

function joiToJsonSchema(joiSchema) {
  const desc = joiSchema.describe();
  const props = {};
  const required = [];
  for (const [key, val] of Object.entries(desc.keys || {})) {
    props[key] = { type: val.type === 'number' ? 'number' : 'string', description: val.description || key };
    if (val.flags?.presence === 'required') required.push(key);
  }
  return { type: 'object', properties: props, required };
}

function getToolSchemasForLlm() {
  return getAllTools().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: joiToJsonSchema(t.parameters)
  }));
}

module.exports = { getAllTools, getTool, getToolSchemasForLlm, ALL_TOOLS };
