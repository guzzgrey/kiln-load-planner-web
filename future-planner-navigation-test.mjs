const targets = await (await fetch('http://127.0.0.1:9240/json')).json();
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
async function navigate(path) {
  await send('Page.navigate', { url: `http://127.0.0.1:8790/${path}` });
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

await send('Runtime.enable');
await send('Page.enable');
await navigate('future-planner.html?test=separation-setup');
const backup = await evaluate(`Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).map((key)=>[key,localStorage.getItem(key)]))`);
const operationalKeys = [
  'kiln-planner-completed-cycles-v1', 'kiln-planner-shipping-tags-v1',
  'kiln-planner-shipments-v1', 'kiln-planner-recovery-operations-v1',
  'kiln-planner-test-boards-v1', 'kiln-planner-order-v1:separation-order',
  'kiln-planner-active-order-v1',
];
await evaluate(`(() => {
  localStorage.clear();
  const order={id:'separation-order',number:'ORD-SEPARATION',status:'active',inputs:{supplier:'Test',species:'Hemlock',size:'1x6'},completedCycles:[]};
  localStorage.setItem('kiln-planner-order-v1:'+order.id,JSON.stringify(order));
  localStorage.setItem('kiln-planner-active-order-v1',JSON.stringify({orderRef:order.id}));
  localStorage.setItem('kiln-planner-completed-cycles-v1',JSON.stringify([{id:'separation-load',orderId:order.id,orderNumber:order.number,loadNumber:1,species:'Hemlock',quantities:{12:16},qualityLots:[{length:12,quantity:16,material:'Hemlock',quality:'good'}]}]));
  localStorage.setItem('kiln-planner-recovery-operations-v1',JSON.stringify([{id:'recovery-1',orderId:order.id,sourceLength:12,quantity:2,outputs:[8],createdAt:'2026-09-28T00:00:00.000Z'}]));
  localStorage.setItem('kiln-planner-shipping-tags-v1','[]');
  localStorage.setItem('kiln-planner-shipments-v1','[]');
  localStorage.setItem('kiln-planner-test-boards-v1','[]');
  localStorage.setItem('kiln-planner-preliminary-orders-v1',JSON.stringify([{id:'saved-draft',orderId:order.id,purpose:'stock',customer:'',number:'',targetBf:0,stacks:[{id:'saved-stack',name:'Saved TAG',items:[]}]}]));
})()`);
const initialOperational = await evaluate(`JSON.stringify(Object.fromEntries(${JSON.stringify(operationalKeys)}.map((key)=>[key,localStorage.getItem(key)])))`);

await navigate('warehouse.html?test=separation');
const warehouse = await evaluate(`({
  plannerPresent:!!document.getElementById('preorderPlanner'),
  link:document.querySelector('a[href="future-planner.html"]')?.textContent.trim()||'',
  completedVisible:document.getElementById('completedTable')?.textContent.includes('Kiln Load 1')||false
})`);

await navigate('future-planner.html?test=separation');
const planner = await evaluate(`({
  present:!!document.getElementById('preorderPlanner'),
  back:document.querySelector('a[href="warehouse.html"]')?.textContent.trim()||'',
  saved:document.getElementById('preorderSelect')?.textContent.includes('Unassigned stock plan')||false,
  stack:document.querySelector('.preorder-stack-name')?.value==='Saved TAG',
  stacksText:document.getElementById('preorderStacks')?.textContent||'',
  ready:document.getElementById('preorderSources')?.textContent.includes('READY')||false,
  recovered:document.getElementById('preorderSources')?.textContent.includes('Recovered material')||false
})`);
await evaluate(`(() => {
  const draft=activePreorder();
  draft.customer='Reload proof';
  savePreorder(draft);
})()`);
await navigate('future-planner.html?test=separation-reload');
const afterReload = await evaluate(`({customer:activePreorder()?.customer||'', operational:JSON.stringify(Object.fromEntries(${JSON.stringify(operationalKeys)}.map((key)=>[key,localStorage.getItem(key)])))})`);
await navigate('warehouse.html?test=separation-back');
const returned = await evaluate(`!!document.getElementById('completedTable') && !document.getElementById('preorderPlanner')`);

await evaluate(`(() => { localStorage.clear(); Object.entries(${JSON.stringify(backup)}).forEach(([key,value])=>localStorage.setItem(key,value)); })()`);
ws.close();

if (warehouse.plannerPresent || !warehouse.link.includes('Future Material Planner') || !warehouse.completedVisible
  || !planner.present || !planner.back.includes('Operational Warehouse') || !planner.saved || !planner.stack || !planner.ready || !planner.recovered
  || afterReload.customer !== 'Reload proof' || afterReload.operational !== initialOperational || !returned) {
  throw new Error(`Future planner separation failed: ${JSON.stringify({warehouse,planner,afterReload,initialOperational,returned})}`);
}
console.log(JSON.stringify({ warehouse, planner, persisted: afterReload.customer, operationalUnchanged: true, returned }));
