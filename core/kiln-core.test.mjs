// Run: node --test core/kiln-core.test.mjs
// core/kiln-core.js is GENERATED from kiln-planner-to-be (npm run build:kiln-core). Do not edit it here.
import test from 'node:test';
import assert from 'node:assert/strict';
await import('./kiln-core.js');
const { tagPlanning, orderBalance, migrateLegacyDrafts } = globalThis.KilnCore;

// Real figures from 2026-09-29 (anonymized): 2 of 7 loads completed, 3 recovery cuts, 5 TAGs.
const L = (entries, material = 'Hemlock') => Object.entries(entries).map(([lengthFt, quantity]) => ({ lengthFt: Number(lengthFt), material, quantity }));
const load1 = { 12: 216, 13: 40, 20: 272 };
const load2 = { 6: 64, 7: 24, 8: 48, 9: 24, 10: 24, 11: 48, 12: 8, 13: 32, 14: 240, 19: 128 };
const tags = [
  { id: 't1', label: '10001', lines: L({ 20: 64 }) },
  { id: 't2', label: '10002', lines: L({ 12: 168 }) },
  { id: 't3', label: '10003', lines: L({ 14: 162 }) },
  { id: 't4', label: '10004', lines: L({ 6: 56, 7: 22, 8: 42, 9: 22, 10: 22 }) },
  { id: 't5', label: '10005', lines: L({ 11: 41, 12: 83, 13: 59 }) },
];
const recoveries = [
  { id: 'r1', sourceLengthFt: 19, quantity: 9, piecesFt: [12, 7] },
  { id: 'r2', sourceLengthFt: 20, quantity: 32, piecesFt: [12, 8] },
  { id: 'r3', sourceLengthFt: 20, quantity: 1, piecesFt: [13, 7] },
];
const legacyItems = (entries) => Object.entries(entries).map(([length, quantity], i) => ({ id: `i${length}-${i}`, lotId: `load-1|${length}|Hemlock|good`, length: Number(length), material: 'Hemlock', quality: 'good', sourceStatus: 'ready', quantity }));
const customer1 = { id: 'd1', purpose: 'customer', customer: 'Customer 1', targetBf: 4500, stacks: [
  { id: 's2', name: '10002', items: legacyItems({ 12: 168 }) },
  { id: 's1', name: '10001', items: legacyItems({ 20: 64 }) },
  { id: 's3', name: '10003', items: [...legacyItems({ 14: 132 }), ...legacyItems({ 14: 30 })] },
  { id: 's4', name: '10004', items: legacyItems({ 6: 56, 7: 22, 8: 42, 9: 22, 10: 22 }) },
  { id: 's5', name: '10005', items: [...legacyItems({ 11: 41, 12: 48 }), ...legacyItems({ 12: 35, 13: 32 }), ...legacyItems({ 13: 27 })] },
] };
const customer2 = { id: 'd2', purpose: 'customer', customer: 'Customer #2', targetBf: 5000, stacks: [] };
const base = () => ({ orderId: 'o', species: 'Hemlock', nominal: { thicknessIn: 1, widthIn: 6 },
  kilnOutput: [{ cycleId: 'c1', loadNumber: 1, lots: L(load1) }, { cycleId: 'c2', loadNumber: 2, lots: L(load2) }],
  plannedLoads: [{ loadNumber: 3, lots: L({ 10: 752, 9: 16 }) }],
  recoveries, tags, tests: [], drafts: [structuredClone(customer1), structuredClone(customer2)] });
const free = (plan) => Object.fromEntries(plan.rows.filter((r) => r.freeReady).map((r) => [r.lengthFt, r.freeReady]));

test('legacy drafts double-count TAGged boards until stacks are linked to their TAGs', () => {
  const before = tagPlanning(base());
  assert.equal(before.totals.freeReady, 469 - 741);
  assert.ok(before.blocking.length > 0);
});

test('migration links stacks to TAGs only on exact number and content match', () => {
  const input = base();
  const { drafts, changed } = migrateLegacyDrafts(input.drafts, input.tags);
  assert.equal(changed, true);
  assert.deepEqual(drafts[0].stacks.map((s) => s.tagId), ['t2', 't1', 't3', 't4', 't5']);
  const again = migrateLegacyDrafts(drafts, input.tags);
  assert.equal(again.changed, false);
  const mismatch = structuredClone(input.drafts); mismatch[0].stacks[0].items[0].quantity = 167;
  assert.equal(migrateLegacyDrafts(mismatch, input.tags).drafts[0].stacks[0].tagId, undefined);
});

test('TAGs fulfil Customer 1; everyone else sees exactly the untagged warehouse balance', () => {
  const input = base(); input.drafts = migrateLegacyDrafts(input.drafts, input.tags).drafts;
  const plan = tagPlanning(input);
  assert.deepEqual(plan.blocking, []);
  assert.deepEqual(free(plan), { 6: 8, 7: 12, 8: 38, 9: 2, 10: 2, 11: 7, 12: 14, 13: 14, 14: 78, 19: 119, 20: 175 });
  assert.equal(plan.totals.freeReady, 469);
  const [c1, c2] = plan.drafts;
  assert.equal(c1.fulfilledBf, 4511); assert.equal(c1.plannedBf, 0); assert.equal(c1.remainingBf, -11);
  assert.equal(c2.remainingBf, 5000);
  assert.ok(plan.tags.every((tag) => tag.assignment && tag.assignment.draftId === 'd1'));
  assert.equal(plan.rows.find((r) => r.lengthFt === 10).forecast, 752);
});

test('planned reservations of every draft reduce what the next draft can use', () => {
  const input = base(); input.drafts = migrateLegacyDrafts(input.drafts, input.tags).drafts;
  input.drafts[1].stacks.push({ id: 'n1', name: 'Future 1', items: [{ id: 'x', lengthFt: 20, material: 'Hemlock', quantity: 175, source: 'ready' }] });
  const plan = tagPlanning(input);
  assert.equal(plan.rows.find((r) => r.lengthFt === 20).freeReady, 0);
  assert.equal(plan.drafts[1].plannedBf, 1750);
  input.drafts.push({ id: 'd3', customer: 'Customer 3', stacks: [{ id: 'n2', name: 'F', items: [{ id: 'y', lengthFt: 20, material: 'Hemlock', quantity: 1, source: 'ready' }] }] });
  const over = tagPlanning(input);
  assert.ok(over.blocking.some((issue) => issue.startsWith('READY_OVERBOOKED')));
});

test('a TAG cannot fulfil two stacks and a deleted TAG is reported', () => {
  const input = base(); input.drafts = migrateLegacyDrafts(input.drafts, input.tags).drafts;
  input.drafts[1].stacks.push({ id: 'dup', name: '10001', tagId: 't1', items: [] });
  assert.ok(tagPlanning(input).blocking.some((issue) => issue.startsWith('TAG_LINKED_TWICE')));
  const gone = base(); gone.drafts = migrateLegacyDrafts(gone.drafts, gone.tags).drafts; gone.tags = gone.tags.slice(1);
  assert.ok(tagPlanning(gone).blocking.some((issue) => issue.startsWith('LINKED_TAG_MISSING')));
});

test('order balance matches the warehouse and rejects duplicates', () => {
  const input = { orderId: 'o', nominal: { thicknessIn: 1, widthIn: 6 }, maxCycles: 7,
    receipts: [{ id: 'r', lines: L({ 6: 106, 7: 36, 8: 522, 9: 104, 10: 1077, 11: 88, 12: 320, 13: 78, 14: 240, 16: 226, 18: 264, 19: 184, 20: 328 }) }],
    cycles: [{ id: 'c1', number: 1, status: 'completed', lines: L(load1) }, { id: 'c2', number: 2, status: 'completed', lines: L(load2) }],
    recoveries, tags, tests: [] };
  const balance = orderBalance(input);
  assert.deepEqual(balance.totals.finished, { kilnOutput: 1168, finished: 1210, tagged: 741, tested: 0, untagged: 469 });
  assert.equal(balance.totals.raw.unplanned, 2405);
  assert.throws(() => orderBalance({ ...input, tags: [...tags, { ...tags[0], id: 'copy' }] }), { code: 'DUPLICATE_TAG_LABEL' });
  assert.throws(() => orderBalance({ ...input, cycles: [...input.cycles, { ...input.cycles[1], id: 'c2b' }] }), { code: 'DUPLICATE_CYCLE_NUMBER' });
});

test('kiln program phase codes survive browser translation', () => {
  const { phaseLabel, kilnProgram } = globalThis.KilnCore;
  assert.equal(phaseLabel('ПХ8'), 'PH8');
  assert.equal(phaseLabel('PH1.2'), 'PH1.2');
  assert.equal(phaseLabel('Cooling'), 'Cooling');
  assert.deepEqual(kilnProgram({ rows: [{ phase: 'ПХ8', mc: 5 }] }).rows, [{ phase: 'PH8', mc: 5 }]);
});
