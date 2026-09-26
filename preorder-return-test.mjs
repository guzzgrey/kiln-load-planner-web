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
    {id:'return-cycle-1',orderId:order.id,orderNumber:order.number,loadNumber:1,species:'Hemlock',quantities:{12:240,20:272},qualityLots:[{length:12,quantity:168,material:'Hemlock',quality:'unclassified'},{length:20,quantity:208,material:'Hemlock',quality:'unclassified'}],boards:512,bf:4160},
    {id:'return-cycle-2',orderId:order.id,orderNumber:order.number,loadNumber:2,species:'Hemlock',quantities:{12:8},qualityLots:[{length:12,quantity:8,material:'Hemlock',quality:'good'}],boards:8,bf:48},
  ]);
  // A YARD TAG is a physical classification, not consumption. These 80
  // boards must remain available to the non-binding preliminary planner.
  write(TAGS_KEY,[{id:'yard-on-hand-12',orderId:order.id,productionOrderNumber:order.number,tag:'99999',quantities:{12:80},sourceQuantities:{12:80},sourceLoads:[{id:'return-cycle-1',loadNumber:1,quantities:{12:80}}]}]);
  write(SHIPMENTS_KEY,[]);
  write(TEST_BOARDS_KEY,[]);
  const lot12=lotKey(1,12,'Hemlock','unclassified');
  const lot20=lotKey(1,20,'Hemlock','unclassified');
  const draft={id:'return-draft',orderId:order.id,purpose:'stock',customer:'',number:'',targetBf:0,stacks:[
    {id:'tag-10002',name:'10002',items:[{id:'item-12',lotId:lot12,loadNumber:1,length:12,material:'Hemlock',quality:'unclassified',sourceStatus:'ready',quantity:168}]},
    {id:'tag-10001',name:'10001',items:[{id:'item-20',lotId:lot20,loadNumber:1,length:20,material:'Hemlock',quality:'unclassified',sourceStatus:'ready',quantity:64}]},
  ]};
  const alternative={id:'alternative-draft',orderId:order.id,purpose:'customer',customer:'Scenario B',number:'B',targetBf:0,stacks:[{id:'alternative-tag',name:'Alternative',items:[{id:'alternative-12',lotId:lot12,loadNumber:1,length:12,material:'Hemlock',quality:'unclassified',sourceStatus:'ready',quantity:200},{id:'alternative-20',lotId:lot20,loadNumber:1,length:20,material:'Hemlock',quality:'unclassified',sourceStatus:'ready',quantity:200}]}]};
  write(PREORDERS_KEY,[draft,alternative]);activePreorderId=draft.id;
  const free=(lotId)=>productionLots().find((lot)=>lot.id===lotId).quantity-preorderReserved(lotId);
  const freeByLength=(length)=>productionLots().filter((lot)=>lot.length===length).reduce((sum,lot)=>sum+lot.quantity-preorderReserved(lot.id),0);
  window.confirm=()=>true;
  renderPreorderPlanner();
  const overLimitAccepted=addPreorderAllocation(lot12,73,'tag-10002');
  activePreorderId=alternative.id;
  const alternativeRemaining=freeByLength(12);
  activePreorderId=draft.id;renderPreorderPlanner();
  const before={twelve:free(lot12),twelveAll:freeByLength(12),twenty:free(lot20),untaggedTwelve:availableForYard()[12],preorderTwelve:availableForPreorder()[12],overLimitAccepted,alternativeRemaining};
  document.querySelector('[data-item-id="item-12"].preorder-remove-item').click();
  const afterItem={twelve:free(lot12),twenty:free(lot20),status:document.getElementById('preorderStatus').textContent};
  document.querySelector('[data-stack-id="tag-10001"].preorder-remove-stack').click();
  const afterStack={twelve:free(lot12),twenty:free(lot20),status:document.getElementById('preorderStatus').textContent};
  localStorage.clear();Object.entries(backup).forEach(([key,value])=>localStorage.setItem(key,value));
  return {before,afterItem,afterStack};
})()`);
console.log(JSON.stringify(result,null,2));
if (result.before.twelve!==72 || result.before.twelveAll!==80 || result.before.twenty!==208 || result.before.untaggedTwelve!==168 || result.before.preorderTwelve!==248 || result.before.overLimitAccepted || result.before.alternativeRemaining!==48 || result.afterItem.twelve!==240 || result.afterItem.twenty!==208 || !result.afterItem.status.includes('168 boards at 12 ft returned') || result.afterStack.twelve!==240 || result.afterStack.twenty!==272 || !result.afterStack.status.includes('64 boards / 640.0 BF returned')) {
  throw new Error(`Preorder return failed: ${JSON.stringify(result)}`);
}
ws.close();
