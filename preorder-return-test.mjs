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
await send('Page.navigate', { url: 'http://127.0.0.1:8782/warehouse.html?test=preorder-return-v2' });
await new Promise((resolve) => setTimeout(resolve, 1300));
const result = await evaluate(`(() => {
  const backup=Object.fromEntries(Array.from({length:localStorage.length},(_,index)=>localStorage.key(index)).map((key)=>[key,localStorage.getItem(key)]));
  localStorage.clear();
  const order={id:'preorder-return-order',number:'ORD-PREORDER-RETURN',status:'active',inputs:{size:'1x6',actualT:'1',actualW:'6'}};
  localStorage.setItem(ACTIVE_ORDER_KEY,JSON.stringify({orderRef:order.id}));
  localStorage.setItem(ORDER_PREFIX+order.id,JSON.stringify(order));
  write(COMPLETED_KEY,[
    {id:'return-cycle-1',orderId:order.id,orderNumber:order.number,loadNumber:1,species:'Hemlock',quantities:{12:216,20:272},qualityLots:[{length:12,quantity:168,material:'Hemlock',quality:'unclassified'},{length:20,quantity:208,material:'Hemlock',quality:'unclassified'}],boards:488,bf:4016},
    {id:'return-cycle-2',orderId:order.id,orderNumber:order.number,loadNumber:2,species:'Hemlock',quantities:{12:8},qualityLots:[{length:12,quantity:8,material:'Hemlock',quality:'good'}],boards:8,bf:48},
  ]);
  const lot12=lotKey(1,12,'Hemlock','unclassified');
  const lot20=lotKey(1,20,'Hemlock','unclassified');
  const draft={id:'return-draft',orderId:order.id,purpose:'stock',customer:'',number:'',targetBf:0,stacks:[
    {id:'tag-10002',name:'10002',items:[{id:'item-12',lotId:lot12,loadNumber:1,length:12,material:'Hemlock',quality:'unclassified',sourceStatus:'ready',quantity:168}]},
    {id:'tag-10001',name:'10001',items:[{id:'item-20',lotId:lot20,loadNumber:1,length:20,material:'Hemlock',quality:'unclassified',sourceStatus:'ready',quantity:64}]},
  ]};
  write(PREORDERS_KEY,[draft]);activePreorderId=draft.id;
  const free=(lotId)=>productionLots().find((lot)=>lot.id===lotId).quantity-preorderReserved(lotId);
  const freeByLength=(length)=>productionLots().filter((lot)=>lot.length===length).reduce((sum,lot)=>sum+lot.quantity-preorderReserved(lot.id),0);
  window.confirm=()=>true;
  renderPreorderPlanner();
  const before={twelve:free(lot12),twelveAll:freeByLength(12),twenty:free(lot20)};
  document.querySelector('[data-item-id="item-12"].preorder-remove-item').click();
  const afterItem={twelve:free(lot12),twenty:free(lot20),status:document.getElementById('preorderStatus').textContent};
  document.querySelector('[data-stack-id="tag-10001"].preorder-remove-stack').click();
  const afterStack={twelve:free(lot12),twenty:free(lot20),status:document.getElementById('preorderStatus').textContent};
  localStorage.clear();Object.entries(backup).forEach(([key,value])=>localStorage.setItem(key,value));
  return {before,afterItem,afterStack};
})()`);
console.log(JSON.stringify(result,null,2));
if (result.before.twelve!==48 || result.before.twelveAll!==56 || result.before.twenty!==208 || result.afterItem.twelve!==216 || result.afterItem.twenty!==208 || !result.afterItem.status.includes('168 boards at 12 ft returned') || result.afterStack.twelve!==216 || result.afterStack.twenty!==272 || !result.afterStack.status.includes('64 boards / 640.0 BF returned')) {
  throw new Error(`Preorder return failed: ${JSON.stringify(result)}`);
}
ws.close();
