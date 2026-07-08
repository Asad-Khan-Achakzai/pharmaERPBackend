/**
 * Run: node --test src/utils/userTerritoryAssignment.util.test.js src/utils/userTerritoryAnchor.util.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const ApiError = require('./ApiError');
const { TERRITORY_KIND } = require('../constants/enums');
const { inferTerritoryAssignmentLabel } = require('./userTerritoryAssignment.util');
const { validateCoverageTerritoryKindsForRole } = require('./userTerritoryAnchor.util');

describe('userTerritoryAssignment.util', () => {
  test('inferTerritoryAssignmentLabel — single area', () => {
    const r = inferTerritoryAssignmentLabel({ kind: TERRITORY_KIND.AREA, name: 'North' }, []);
    assert.equal(r.key, 'ENTIRE_AREA');
  });

  test('inferTerritoryAssignmentLabel — multi area', () => {
    const r = inferTerritoryAssignmentLabel(
      { kind: TERRITORY_KIND.AREA, name: 'A1' },
      [{ kind: TERRITORY_KIND.AREA, name: 'A2' }]
    );
    assert.equal(r.key, 'MULTI_AREA');
    assert.match(r.label, /2/);
  });

  test('inferTerritoryAssignmentLabel — multi zone', () => {
    const r = inferTerritoryAssignmentLabel(
      { kind: TERRITORY_KIND.ZONE, name: 'Z1' },
      [{ kind: TERRITORY_KIND.ZONE, name: 'Z2' }, { kind: TERRITORY_KIND.ZONE, name: 'Z3' }]
    );
    assert.equal(r.key, 'MULTI_ZONE');
    assert.match(r.label, /3/);
  });

  test('inferTerritoryAssignmentLabel — area plus brick extras', () => {
    const r = inferTerritoryAssignmentLabel(
      { kind: TERRITORY_KIND.AREA, name: 'A1' },
      [{ kind: TERRITORY_KIND.BRICK, name: 'B1' }]
    );
    assert.equal(r.key, 'HIERARCHICAL_PLUS_EXTRA');
  });
});

describe('userTerritoryAnchor.util validateCoverageTerritoryKindsForRole', () => {
  const asmRoleId = new mongoose.Types.ObjectId();

  const Role = {
    findById: (id) => ({
      select: () => ({
        lean: async () => {
          if (String(id) === String(asmRoleId)) {
            return { code: 'DEFAULT_ASM', permissions: [] };
          }
          return null;
        }
      })
    })
  };

  test('allows multiple AREA extras when primary is AREA', async () => {
    await validateCoverageTerritoryKindsForRole(Role, asmRoleId, TERRITORY_KIND.AREA, [
      { kind: TERRITORY_KIND.AREA },
      { kind: TERRITORY_KIND.BRICK }
    ]);
  });

  test('rejects ZONE extras when primary is AREA', async () => {
    await assert.rejects(
      () =>
        validateCoverageTerritoryKindsForRole(Role, asmRoleId, TERRITORY_KIND.AREA, [
          { kind: TERRITORY_KIND.ZONE }
        ]),
      (err) => err instanceof ApiError && /zone nodes/.test(err.message)
    );
  });

  test('allows multiple ZONE extras when primary is ZONE', async () => {
    const rmRoleId = new mongoose.Types.ObjectId();
    const RoleRm = {
      findById: (id) => ({
        select: () => ({
          lean: async () => {
            if (String(id) === String(rmRoleId)) {
              return { code: 'DEFAULT_RM', permissions: [] };
            }
            return null;
          }
        })
      })
    };
    await validateCoverageTerritoryKindsForRole(RoleRm, rmRoleId, TERRITORY_KIND.ZONE, [
      { kind: TERRITORY_KIND.ZONE },
      { kind: TERRITORY_KIND.BRICK }
    ]);
  });
});
