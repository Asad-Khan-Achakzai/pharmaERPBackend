const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getAllTools, getTool } = require('./tools/registry');
const { executeTool } = require('./services/toolEngine.service');

describe('AI tool registry', () => {
  it('registers summary tools for entity counts', () => {
    const tools = getAllTools();
    assert.ok(tools.some((t) => t.name === 'doctor_summary'));
    assert.ok(tools.some((t) => t.name === 'pharmacy_summary'));
    assert.ok(tools.some((t) => t.name === 'product_summary'));
    assert.ok(tools.some((t) => t.name === 'employee_summary'));
  });

  it('write tools exist but are excluded from agent loop', () => {
    const writeTool = getTool('create_order');
    assert.ok(writeTool);
    assert.equal(writeTool.mutability, 'write');
    assert.ok(!getAllTools().some((t) => t.name === 'create_order'));
  });

  it('blocks write tool execution via toolEngine', async () => {
    const ctx = {
      companyId: '507f1f77bcf86cd799439011',
      userId: '507f1f77bcf86cd799439012',
      user: { permissions: ['orders.create'], role: 'ADMIN' },
      permissions: ['orders.create'],
      timeZone: 'Asia/Karachi',
      company: { name: 'Test Co' },
      clientContext: {}
    };
    await assert.rejects(
      () => executeTool(ctx, 'create_order', { pharmacyId: '507f1f77bcf86cd799439013', distributorId: '507f1f77bcf86cd799439014', items: [{ productId: '507f1f77bcf86cd799439015', quantity: 1 }] }),
      /Write tools require explicit user confirmation/
    );
  });

  it('sanitizeToolResult does not throw for admin users with nested permission objects', () => {
    const { sanitizeToolResult } = require('./utils/sanitizeToolResult');
    const ctx = {
      user: { role: 'ADMIN', permissions: ['inventory.view', 'admin.access'] },
      permissions: ['inventory.view', 'admin.access']
    };
    const out = sanitizeToolResult({ totalItems: 5, rows: [{ name: 'Product A', tp: 100 }] }, ctx);
    assert.equal(out.totalItems, 5);
  });
});
