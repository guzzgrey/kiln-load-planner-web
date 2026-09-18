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
  const item = pending.get(message.id); pending.delete(message.id);
  if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
};
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
await send('Runtime.enable');
await send('Page.navigate', { url:'http://127.0.0.1:8771/index.html?test=dirty-navigation' });
await new Promise((resolve) => setTimeout(resolve, 1400));
await evaluate(`new Promise((resolve,reject)=>{
  if (typeof selectSavedLoad === 'function') return resolve(true);
  const script=document.createElement('script'); script.src='app.js?v=dirty-navigation-direct';
  script.onload=()=>resolve(true); script.onerror=()=>reject(new Error('app.js failed')); document.body.appendChild(script);
})`);
const result = await evaluate(`(async () => {
  const quantities={6:36,7:106,8:522,9:104,10:1079,11:88,12:320,13:78,14:240,16:226,18:264,19:184,20:328};
  document.querySelectorAll('#inventory tr').forEach((row)=>{ const length=Number(row.querySelector('.len').value); row.querySelector('.qty').value=quantities[length]||0; });
  document.getElementById('actualT').value='1'; document.getElementById('actualW').value='5.5';
  document.getElementById('batchProfile').value='manual'; document.getElementById('sticker').value='0.75';
  document.getElementById('height').value='57'; document.getElementById('supplierClearance').value='1';
  activeOrder.activeCycleNumber=null; globalOrderPlans=[]; globalOrderSignature=''; currentLoadNumber=1;
  writeCompletedCycles([]); calculate(true); persistActiveOrder(true); calculationDirty=false;
  const cycles=globalOrderPlans.length;
  const field=document.getElementById('actualW'); field.value='6'; field.dispatchEvent(new Event('input',{bubbles:true}));
  const opened2=selectSavedLoad(2);
  await new Promise((resolve)=>setTimeout(resolve,650));
  const cacheKept=Boolean(activeOrder.viewCache && activeOrder.calculated && activeOrder.planStale);
  const opened3=selectSavedLoad(3);
  return { cycles, opened2, opened3, currentLoadNumber, draftWidth:field.value, dirty:calculationDirty, cacheKept, status:document.getElementById('calculationStatus').textContent };
})()`);
if (result.cycles < 3 || !result.opened2 || !result.opened3 || result.currentLoadNumber !== 3 || result.draftWidth !== '6' || !result.dirty || !result.cacheKept || !result.status.includes('Viewing saved Kiln Load 3')) {
  throw new Error('Dirty saved-load navigation failed: '+JSON.stringify(result));
}
console.log(JSON.stringify(result));
ws.close();
