import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('function productionManagementState');
const end = source.indexOf('\nfunction renderManagementDashboard', start);
assert.ok(start >= 0 && end > start, 'Production dashboard projection was not found');
const declaration = source.slice(start, end);
const productionManagementState = Function(`${declaration}; return productionManagementState;`)();

const order = {
  id: 'existing-westminster-order',
  number: 'ORD-334605',
  plannedCycles: 7,
  activeCycleNumber: 3,
  activeCycleStartedAt: '2026-09-27T12:00:00-07:00',
  inventory: { 6: 36, 7: 106, 8: 522, 9: 104, 10: 1079, 11: 88, 12: 320, 13: 78, 14: 240, 16: 226, 18: 264, 19: 184, 20: 328 },
};
const records = [
  { id: 'existing-load-1', orderId: order.id, loadNumber: 1, boards: 528, bf: 4264, startedAt: '2026-08-18T11:00:00-07:00', completedAt: '2026-08-24T11:00:00-07:00' },
  { id: 'existing-load-2', orderId: order.id, loadNumber: 2, boards: 640, bf: 4112, startedAt: '2026-09-09T12:00:00-07:00', completedAt: '2026-09-25T12:00:00-07:00' },
];
const before = productionManagementState(order, records, 0, Date.parse('2026-09-28T12:00:00-07:00'));
const afterPlannerNavigation = productionManagementState(order, records, 0, Date.parse('2026-09-28T12:00:00-07:00'));

assert.equal(before.readyBoards, 1168);
assert.equal(before.totalBoards, 3575);
assert.equal(before.completedCycles, 2);
assert.equal(before.plannedCycles, 7);
assert.equal(before.activeNumber, 3);
assert.equal(before.firstStart, Date.parse('2026-08-18T11:00:00-07:00'));
assert.deepEqual(afterPlannerNavigation, before);

const initStart = source.indexOf('function init()');
const initEnd = source.indexOf('\ninit();', initStart);
const initSource = source.slice(initStart, initEnd);
assert.match(initSource, /renderManagementDashboard\(\{ repair: false \}\);/, 'Initialization must render existing operational state without writing repairs');

const futurePlanner = fs.readFileSync(new URL('./future-planner.js', import.meta.url), 'utf8');
assert.match(futurePlanner, /if \(key !== PREORDERS_KEY\) throw new Error/, 'Future planner write boundary is missing');

console.log(JSON.stringify({ readyBoards: before.readyBoards, totalBoards: before.totalBoards, cycles: `${before.completedCycles} / ${before.plannedCycles}`, activeCycle: before.activeNumber, operationalProjectionUnchanged: true }));
