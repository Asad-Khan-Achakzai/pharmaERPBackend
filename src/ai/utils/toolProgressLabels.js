const TOOL_STATUS_LABELS = {
  company_profile: 'Fetching company profile…',
  doctor_summary: 'Counting doctors…',
  pharmacy_summary: 'Counting pharmacies…',
  product_summary: 'Counting products…',
  distributor_summary: 'Counting distributors…',
  search_doctors: 'Searching doctors…',
  doctor_profile: 'Loading doctor profile…',
  today_visits: 'Loading today’s visits…',
  pending_visits: 'Loading pending visits…',
  missed_visits: 'Loading missed visits…',
  team_visits_today: 'Loading team visits…',
  attendance_today: 'Checking attendance…',
  attendance_history: 'Loading attendance history…',
  search_orders: 'Searching orders…',
  stock_lookup: 'Looking up stock levels…',
  warehouse_stock: 'Fetching inventory summary…',
  sales_summary: 'Calculating sales summary…',
  sales_trend: 'Analyzing sales trends…',
  coverage_analysis: 'Analyzing coverage…',
  territory_analysis: 'Analyzing territories…',
  user_profile: 'Loading user profile…',
  team_performance: 'Evaluating team performance…',
  employee_summary: 'Counting employees…',
  create_order: 'Preparing order draft…'
};

function getToolStatusLabel(toolName) {
  return TOOL_STATUS_LABELS[toolName] || 'Fetching live ERP data…';
}

module.exports = { TOOL_STATUS_LABELS, getToolStatusLabel };
