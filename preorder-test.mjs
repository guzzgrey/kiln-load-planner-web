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
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
await send('Runtime.enable');
await evaluate(`(() => {
  const order = {
    id:'preorder-test-order', number:'ORD-PREORDER', status:'active', plannedCycles:2, plannedBoards:176,
    inputs:{ supplier:'Westminster', species:'SPF', size:'1,6' }, inventory:{ 8:112, 10:64 },
    activeCycleNumber:2,
    viewCache:{ records:[
      { number:1, used:{8:56}, qualityLots:[{length:8,material:'SPF',quality:'good',quantity:56}] },
      { number:2, used:{8:56,10:64}, qualityLots:[{length:8,material:'Hemlock',quality:'good',quantity:24},{length:8,material:'SPF',quality:'good',quantity:32},{length:10,material:'SPF',quality:'good',quantity:64}] }
    ] }
  };
  localStorage.setItem('kiln-planner-order-v1:'+order.id, JSON.stringify(order));
  localStorage.setItem('kiln-planner-active-order-v1', JSON.stringify({orderRef:order.id}));
  localStorage.setItem('kiln-planner-completed-cycles-v1', JSON.stringify([{id:'done-1',orderId:order.id,loadNumber:1,completedDate:'2026-09-18',species:'SPF',size:'1x6',quantities:{8:56},qualityLots:[{length:8,material:'SPF',quality:'good',quantity:56}],boards:56,bf:224}]));
  ['kiln-planner-shipping-tags-v1','kiln-planner-test-boards-v1','kiln-planner-recovery-operations-v1','kiln-planner-shipments-v1','kiln-planner-preliminary-orders-v1'].forEach((key)=>localStorage.setItem(key,'[]'));
})()`);
await send('Page.navigate', { url:'http://127.0.0.1:8771/warehouse.html?test=preorder' });
await new Promise((resolve) => setTimeout(resolve, 1300));
const result = await evaluate(`(() => {
  const lots = productionLots();
  addPreorderStack();
  const draft = activePreorder();
  const ready = lots.find((lot)=>lot.status==='ready' && lot.length===8);
  const expectedHem = lots.find((lot)=>lot.status==='expected' && lot.material==='Hemlock');
  addPreorderAllocation(ready.id, 40, draft.stacks[0].id);
  addPreorderAllocation(expectedHem.id, 24, draft.stacks[0].id);
  const after = activePreorder();
  return {
    sources: lots.map(({status,length,material,quantity})=>({status,length,material,quantity})),
    items: after.stacks[0].items.length,
    selected: after.stacks[0].items.reduce((sum,item)=>sum+item.quantity,0),
    selectedBf: after.stacks[0].items.reduce((sum,item)=>sum+preorderBf(item.length,item.quantity),0),
    physicalAvailable: availableForYard()[8],
    readyLeft: productionLots().find((lot)=>lot.id===ready.id).quantity-preorderReserved(ready.id),
    sourceOverflow: [...document.querySelectorAll('.preorder-source-row')].some((row) => row.scrollWidth > row.clientWidth + 1 || [...row.children].some((child) => child.getBoundingClientRect().right > row.getBoundingClientRect().right + 1)),
    pageText: document.getElementById('preorderPlanner').textContent,
  };
})()`);
if (result.items !== 2 || result.selected !== 64 || result.selectedBf !== 256 || result.physicalAvailable !== 56 || result.readyLeft !== 16 || result.sourceOverflow
  || !result.pageText.includes('SPF') || !result.pageText.includes('Hemlock') || !result.pageText.includes('READY') || !result.pageText.includes('EXPECTED')) {
  throw new Error('Preliminary order planner failed: '+JSON.stringify(result));
}
console.log(JSON.stringify(result));
ws.close();
