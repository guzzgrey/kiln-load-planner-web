import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { projectPhysicalSources, snapshotProtectedOperations } = require('./physical-source-projection.js');
const lengths = Array.from({ length: 18 }, (_, index) => index + 3);
const order = {
  id: 'protected-westminster-order', number: 'ORD-334605', plannedCycles: 7, activeCycleNumber: 3,
  viewCache: { records: Array.from({ length: 7 }, (_, index) => ({ number: index + 1, used: { 12: 8 }, usedBoards: 8, lifts: [{ id: `lift-${index + 1}`, rows: 32 }] })) },
};
const completed = [
  { id: 'protected-load-1', orderId: order.id, loadNumber: 1, quantities: { 12: 216, 13: 40, 20: 272 }, boards: 528, bf: 4276, startedAt: '2026-08-18T11:00:00-07:00', completedAt: '2026-08-24T11:00:00-07:00', planSnapshot: { immutable: 'load-1' } },
  { id: 'protected-load-2', orderId: order.id, loadNumber: 2, quantities: { 6: 64, 7: 24, 8: 48, 9: 24, 10: 24, 11: 48, 12: 8, 13: 32, 14: 240, 19: 128 }, boards: 640, bf: 4112, startedAt: '2026-09-09T12:00:00-07:00', completedAt: '2026-09-25T12:00:00-07:00', planSnapshot: { immutable: 'load-2' } },
];
const tags = [{ id: 'yard-tag-still-on-hand', tag: '10001', quantities: { 20: 64 }, sourceLoads: [{ id: 'protected-load-1', loadNumber: 1, quantities: { 20: 64 } }] }];
const recoveries = [
  { id: 'physical-cut-19', orderId: order.id, sourceLength: 19, quantity: 9, outputs: [7, 12], inputLinearFt: 171, outputLinearFt: 171, wasteLinearFt: 0 },
  { id: 'physical-cut-20', orderId: order.id, sourceLength: 20, quantity: 33, outputs: [8, 12], inputLinearFt: 660, outputLinearFt: 660, wasteLinearFt: 0 },
];
const protectedBefore = snapshotProtectedOperations({ orders: [order], completed, tags });
const rawBefore = JSON.stringify({ order, completed, tags, recoveries });
const projection = projectPhysicalSources({ lengths, completed, recoveries, tests: [], tags, shipments: [], dimensions: { thickness: 1, width: 6 } });
const protectedAfter = snapshotProtectedOperations({ orders: [order], completed, tags });

assert.equal(projection.originalBf, 8388);
assert.equal(Object.values(projection.original).reduce((sum, quantity) => sum + quantity, 0), 1168);
assert.equal(projection.regularBf, 7972.5);
assert.equal(Object.values(projection.regular).reduce((sum, quantity) => sum + quantity, 0), 1126);
assert.equal(projection.recoveredBf, 415.5);
assert.equal(Object.values(projection.recoveredCurrent).reduce((sum, quantity) => sum + quantity, 0), 84);
assert.equal(projection.currentBf, 8388);
assert.equal(Object.values(projection.current).reduce((sum, quantity) => sum + quantity, 0), 1210);
assert.equal(projection.current[20], 239, '33 physically cut parent boards must not remain available');
assert.equal(projection.recoveredCurrent[12], 42);
assert.equal(projection.reconciliationDeltaBf, 0);
assert.equal(protectedAfter, protectedBefore, 'Protected load/cycle/TAG snapshot changed');
assert.equal(JSON.stringify({ order, completed, tags, recoveries }), rawBefore, 'Projection mutated canonical operational records');

const shippedProjection = projectPhysicalSources({ lengths, completed, recoveries, tests: [], tags, shipments: [{ id: 'shipment-1', tagIds: ['yard-tag-still-on-hand'] }], dimensions: { thickness: 1, width: 6 } });
assert.equal(shippedProjection.current[20], 175, 'Only shipment may remove an on-hand YARD TAG from physical inventory');
assert.equal(shippedProjection.shippedBf, 640);
assert.equal(shippedProjection.reconciliationDeltaBf, 0);

console.log(JSON.stringify({ originalPcs: 1168, originalBf: projection.originalBf, regularPcs: 1126, regularBf: projection.regularBf, recoveredPcs: 84, recoveredBf: projection.recoveredBf, currentPcs: 1210, currentBf: projection.currentBf, protectedRecordsUnchanged: true }));
