import assert from 'node:assert/strict';

const targets = await (await fetch('http://127.0.0.1:9232/json')).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('Browser page not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const item = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) item.reject(new Error(message.error.message));
  else item.resolve(message.result);
};
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

await send('Runtime.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8791/index.html?test=saved-load-restore-setup' });
await new Promise((resolve) => setTimeout(resolve, 1200));
const before = await evaluate(`(() => {
  document.querySelectorAll('#inventory tr').forEach((row) => {
    const length = Number(row.querySelector('.len').value);
    row.querySelector('.qty').value = DEFAULT_QUANTITIES.get(length) || 0;
  });
  calculate(true);
  const savedPlan = serializeCalculatedPlans([globalOrderPlans[0]]);
  globalOrderPlans = Array.from({ length: 7 }, () => deserializeCalculatedPlans(savedPlan)[0]);
  restoreLoadRecordsFromPlans(globalOrderPlans);
  persistActiveOrder(true);
  const key = 'kiln-planner-order-v1:' + activeOrder.id;
  const order = JSON.parse(localStorage.getItem(key));
  const backup = JSON.parse(JSON.stringify(order));
  backup.viewCache.signature = 'saved-signature-that-does-not-match-current-inputs';
  localStorage.setItem('kiln-planner-order-v1:saved-copy-of-' + order.id, JSON.stringify(backup));
  order.calculated = false;
  delete order.viewCache;
  const activeRaw = JSON.stringify(order);
  localStorage.setItem(key, activeRaw);
  return { key, activeRaw, plans: deserializeCalculatedPlans(backup.viewCache.plans).length, records: backup.viewCache.records.length };
})()`);
assert.equal(before.plans, 7);
assert.equal(before.records, 7);

await send('Page.reload', { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 1200));
const after = await evaluate(`(() => {
  const stored = JSON.parse(localStorage.getItem('${before.key}'));
  return {
    plans: globalOrderPlans.length,
    records: loadRecords.size,
    storedCalculated: stored.calculated,
    activeStillHasNoCache: !stored.viewCache,
    storedRaw: JSON.stringify(stored),
    selectedBoards: Number(document.getElementById('loadBF').textContent.replaceAll(',', '')),
    status: document.getElementById('calculationStatus').textContent,
    cycleRows: document.querySelectorAll('#loadHistory > article').length,
  };
})()`);

assert.equal(after.plans, 7);
assert.equal(after.records, 7);
assert.equal(after.storedCalculated, false, 'Opening the page must not rewrite the stored calculated flag');
assert.equal(after.activeStillHasNoCache, true, 'Opening the page must not copy the recovered snapshot into production data');
assert.equal(after.storedRaw, before.activeRaw, 'Opening the recovered snapshot mutated the active order');
assert.ok(after.selectedBoards > 0, 'Saved selected load was not rendered');
assert.equal(after.cycleRows, 7);
assert.match(after.status, /restored without recalculation/i);
const { storedRaw: _storedRaw, ...reported } = after;
console.log(JSON.stringify(reported));
ws.close();
