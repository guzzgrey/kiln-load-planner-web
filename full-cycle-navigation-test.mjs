const targets = await (await fetch('http://127.0.0.1:9235/json')).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('Browser page not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === 'Fetch.requestPaused') {
    const body = Buffer.from('/* Supabase replaced by the full-cycle test mock. */').toString('base64');
    send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }], body });
    return;
  }
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
const mock = `(() => {
  const readRemote=()=>{try{return JSON.parse(localStorage.getItem('__full_cycle_cloud__')||'{}')}catch(_){return {}}};
  const writeRemote=(value)=>localStorage.setItem('__full_cycle_cloud__',JSON.stringify(value));
  window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:{user:{id:'full-cycle-user'}}}}),signOut:async()=>({})},
    from:()=>({
      select:async()=>({data:Object.entries(readRemote()).map(([key,row])=>({key,value:row.value,updated_at:row.updated_at})),error:null}),
      upsert:async(payload)=>{
        const failures=Number(localStorage.getItem('__full_cycle_failures__')||0);
        if(failures>0){localStorage.setItem('__full_cycle_failures__',String(failures-1));return {error:{message:'intentional full-cycle failure'}}}
        const remote=readRemote();
        (Array.isArray(payload)?payload:[payload]).forEach((row)=>{remote[row.key]={value:row.value,updated_at:row.updated_at}});
        writeRemote(remote);return {error:null};
      },
      delete:()=>({eq:async(_field,key)=>{const remote=readRemote();delete remote[key];writeRemote(remote);return {error:null}}}),
    }),
    channel:()=>({on(){return this},subscribe(){return this}}),
  })};
})();`;
async function bootstrapApp(app) {
  await evaluate(mock);
  await evaluate(`new Promise((resolve,reject)=>{
    document.querySelector('.cloud-login')?.remove();
    const script=document.createElement('script');
    script.src='cloud-sync.js?v=full-cycle-reload';
    script.dataset.app=${JSON.stringify(app)};
    script.onload=resolve;script.onerror=()=>reject(new Error('cloud-sync test bootstrap failed'));
    document.body.appendChild(script);
  })`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: mock });
await send('Fetch.enable', { patterns: [{ urlPattern: '*cdn.jsdelivr.net/npm/@supabase/supabase-js*', requestStage: 'Request' }] });
await send('Page.navigate', { url: 'https://guzzgrey.github.io/kiln-load-planner-web/index.html?test=full-cycle-navigation' });
await new Promise((resolve) => setTimeout(resolve, 1400));
// The CDN is intentionally replaced in this test, so install the mock and
// restart only the bootstrap loader after the first empty CDN script runs.
await bootstrapApp('app.js?v=full-cycle-app');
const completed = await evaluate(`(async()=>{
  localStorage.removeItem('__full_cycle_cloud__');
  localStorage.removeItem('kiln-planner-cloud-outbox-v1');
  activeOrder={id:'full-cycle-order',number:'ORD-FULL-CYCLE',status:'active',inventory:{8:32}};
  document.getElementById('orderNumber').value=activeOrder.number;
  document.querySelectorAll('#inventory tr').forEach((row)=>{const length=Number(row.querySelector('.len').value);row.querySelector('.qty').value=length===8?32:0});
  document.getElementById('planningMode').value='automatic';
  document.getElementById('actualT').value='1';document.getElementById('actualW').value='6';document.getElementById('liftWidth').value='48';
  document.getElementById('height').value='8';document.getElementById('sticker').value='1';document.getElementById('kiln').value='16';
  document.getElementById('maxStack').value='8';document.getElementById('metalBox').value='0';
  globalOrderPlans=[];globalOrderSignature='';currentLoadNumber=1;loadRecords.clear();writeCompletedCycles([]);
  calculate(true);persistActiveOrder(true);startKilnCycle(1);completingLoadNumber=1;
  document.getElementById('completeSupplier').value='Full Cycle Supplier';
  document.getElementById('completeDate').value='2026-09-25';document.getElementById('completeMarking').value='FULL CYCLE';document.getElementById('finalProcessDate').value='2026-09-25';
  localStorage.setItem('__full_cycle_failures__','1');
  let firstSaveFailed=false;try{await saveCompletedCycle({preventDefault(){}})}catch(_){firstSaveFailed=true}
  return {firstSaveFailed,localCompleted:isLoadCompleted(1),records:readCompletedCycles().length,embedded:activeOrder.completedCycles?.length||0,outbox:Boolean(localStorage.getItem('kiln-planner-cloud-outbox-v1'))};
})()`);
await evaluate(`document.querySelector('a[href="warehouse.html"]').click()`);
await new Promise((resolve) => setTimeout(resolve, 1600));
await bootstrapApp('warehouse.js?v=full-cycle-warehouse');
const warehouseBeforeRefresh = await evaluate(`({path:location.pathname,completed:completed().length,ready:productionLots().filter((lot)=>lot.status==='ready').reduce((sum,lot)=>sum+lot.quantity,0),outbox:Boolean(localStorage.getItem('kiln-planner-cloud-outbox-v1')),remoteCompleted:(JSON.parse(localStorage.getItem('__full_cycle_cloud__')||'{}')['kiln-planner-completed-cycles-v1']?.value||[]).length})`);
await send('Page.reload');
await new Promise((resolve) => setTimeout(resolve, 1400));
await bootstrapApp('warehouse.js?v=full-cycle-warehouse-refresh');
const warehouseAfterRefresh = await evaluate(`({completed:completed().length,ready:productionLots().filter((lot)=>lot.status==='ready').reduce((sum,lot)=>sum+lot.quantity,0)})`);
await evaluate(`document.querySelector('a[href="index.html"]').click()`);
await new Promise((resolve) => setTimeout(resolve, 1600));
await bootstrapApp('app.js?v=full-cycle-app-return');
const plannerBeforeRefresh = await evaluate(`({path:location.pathname,completed:isLoadCompleted(1),dashboard:document.getElementById('managementCycles').textContent,records:completionRecordsForActiveOrder().length})`);
await send('Page.reload');
await new Promise((resolve) => setTimeout(resolve, 1400));
await bootstrapApp('app.js?v=full-cycle-app-refresh');
const plannerAfterRefresh = await evaluate(`({completed:isLoadCompleted(1),dashboard:document.getElementById('managementCycles').textContent,records:completionRecordsForActiveOrder().length})`);
const result={completed,warehouseBeforeRefresh,warehouseAfterRefresh,plannerBeforeRefresh,plannerAfterRefresh};
console.log(JSON.stringify(result,null,2));
if (!completed.firstSaveFailed || !completed.localCompleted || completed.records!==1 || completed.embedded!==1 || !completed.outbox
  || !warehouseBeforeRefresh.path.endsWith('/warehouse.html') || warehouseBeforeRefresh.completed!==1 || warehouseBeforeRefresh.ready!==32 || warehouseBeforeRefresh.outbox || warehouseBeforeRefresh.remoteCompleted!==1
  || warehouseAfterRefresh.completed!==1 || warehouseAfterRefresh.ready!==32
  || !plannerBeforeRefresh.path.endsWith('/index.html') || !plannerBeforeRefresh.completed || plannerBeforeRefresh.records!==1 || !plannerBeforeRefresh.dashboard.startsWith('1 /')
  || !plannerAfterRefresh.completed || plannerAfterRefresh.records!==1 || !plannerAfterRefresh.dashboard.startsWith('1 /')) {
  throw new Error(`Full cycle navigation failed: ${JSON.stringify(result)}`);
}
ws.close();
