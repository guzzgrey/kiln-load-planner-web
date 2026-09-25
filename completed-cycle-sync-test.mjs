const targets = await (await fetch('http://127.0.0.1:9233/json')).json();
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
await send('Page.navigate', { url: 'http://127.0.0.1:8772/index.html?test=completed-cycle-sync' });
await new Promise((resolve) => setTimeout(resolve, 1200));
const result = await evaluate(`(async () => {
  const backup = Object.fromEntries(Array.from({length:localStorage.length},(_,index)=>localStorage.key(index)).map((key)=>[key,localStorage.getItem(key)]));
  localStorage.clear();
  activeOrder = {id:'cycle-sync-test',number:'ORD-CYCLE-SYNC',status:'active',inventory:{8:32}};
  document.querySelectorAll('#inventory tr').forEach((row)=>{
    const length=Number(row.querySelector('.len').value);
    row.querySelector('.qty').value=length===8?32:0;
  });
  document.getElementById('planningMode').value='automatic';
  document.getElementById('actualT').value='1';
  document.getElementById('actualW').value='6';
  document.getElementById('liftWidth').value='48';
  document.getElementById('height').value='8';
  document.getElementById('sticker').value='1';
  document.getElementById('kiln').value='16';
  document.getElementById('maxStack').value='8';
  document.getElementById('metalBox').value='0';
  globalOrderPlans=[]; globalOrderSignature=''; currentLoadNumber=1; loadRecords.clear();
  writeCompletedCycles([]);
  calculate(true);
  persistActiveOrder(true);
  startKilnCycle(1);
  completingLoadNumber=1;
  document.getElementById('completeSupplier').value='Test Supplier';
  document.getElementById('completeDate').value='2026-09-25';
  document.getElementById('completeMarking').value='SYNC TEST';
  document.getElementById('finalProcessDate').value='2026-09-25';
  let flushCalls=0;
  window.kilnCloudFlush=async()=>{flushCalls+=1; await new Promise((resolve)=>setTimeout(resolve,25));};
  await saveCompletedCycle({preventDefault(){}});
  const records=readCompletedCycles();
  const output={flushCalls,records:records.length,completed:isLoadCompleted(1),activeCycle:activeOrder.activeCycleNumber||null,loadNumber:records[0]?.loadNumber,boards:records[0]?.boards};
  localStorage.clear();
  Object.entries(backup).forEach(([key,value])=>localStorage.setItem(key,value));
  return output;
})()`);
console.log(JSON.stringify(result, null, 2));
if (result.flushCalls !== 1 || result.records !== 1 || !result.completed || result.activeCycle !== null || result.loadNumber !== 1 || result.boards <= 0) {
  throw new Error(`Completed-cycle synchronization test failed: ${JSON.stringify(result)}`);
}
ws.close();
