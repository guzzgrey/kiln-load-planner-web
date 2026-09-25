const targets = await (await fetch('http://127.0.0.1:9235/json')).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('Browser page not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id || !pending.has(message.id)) return;
  const callback = pending.get(message.id); pending.delete(message.id);
  message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
};
function send(method, params = {}) {
  const requestId = ++id;
  ws.send(JSON.stringify({ id: requestId, method, params }));
  return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
await send('Runtime.enable');
await send('Page.navigate', { url: 'http://kiln.test:8782/cloud-sync-outbox-test.html' });
await new Promise((resolve) => setTimeout(resolve, 700));
const result = await evaluate(`(async () => {
  const key='kiln-planner-completed-cycles-v1';
  const value=[{id:'cycle-2',loadNumber:2,boards:640}];
  localStorage.setItem(key,JSON.stringify(value));
  const staged=JSON.parse(localStorage.getItem('kiln-planner-cloud-outbox-v1')||'{}');
  window.__failNextCloudWrite=true;
  let firstFailed=false;
  try { await window.kilnCloudFlush(); } catch (_) { firstFailed=true; }
  const protectedAfterFailure=JSON.parse(localStorage.getItem('kiln-planner-cloud-outbox-v1')||'{}');
  await window.kilnCloudFlush();
  return {
    appLoaded:Boolean(window.__outboxTestAppLoaded),
    staged:Boolean(staged[key]),
    firstFailed,
    protectedAfterFailure:Boolean(protectedAfterFailure[key]),
    outboxCleared:!localStorage.getItem('kiln-planner-cloud-outbox-v1'),
    remote:window.__remoteState.get(key),
  };
})()`);
console.log(JSON.stringify(result, null, 2));
if (!result.appLoaded || !result.staged || !result.firstFailed || !result.protectedAfterFailure || !result.outboxCleared || result.remote?.[0]?.loadNumber !== 2) {
  throw new Error(`Durable cloud outbox test failed: ${JSON.stringify(result)}`);
}
ws.close();
