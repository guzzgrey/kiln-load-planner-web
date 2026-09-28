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
await send('Page.navigate', { url: 'http://127.0.0.1:8782/warehouse.html?test=mixed-yard-tag-v15' });
await new Promise((resolve) => setTimeout(resolve, 1300));
const result = await evaluate(`(() => {
  const backup=Object.fromEntries(Array.from({length:localStorage.length},(_,index)=>localStorage.key(index)).map((key)=>[key,localStorage.getItem(key)]));
  localStorage.clear();
  const order={id:'mixed-yard-order',number:'ORD-MIXED-YARD',status:'active',inputs:{supplier:'Westminster',species:'Hemlock',size:'1x6'}};
  localStorage.setItem(ACTIVE_ORDER_KEY,JSON.stringify({orderRef:order.id}));
  localStorage.setItem(ORDER_PREFIX+order.id,JSON.stringify(order));
  write(COMPLETED_KEY,[{id:'mixed-load-1',orderId:order.id,orderNumber:order.number,loadNumber:1,supplier:'Westminster',marking:'HEMLOCK 1X6',species:'Hemlock',size:'1x6',quantities:{20:2},qualityLots:[{length:20,quantity:2,material:'Hemlock',quality:'good'}],boards:2,bf:20}]);
  write(RECOVERY_KEY,[{id:'mixed-cut',orderId:order.id,productionOrderNumber:order.number,sourceLength:20,quantity:1,outputs:[6,7,7],inputLinearFt:20,outputLinearFt:20,wasteLinearFt:0,createdAt:'2026-09-28T12:00:00.000Z'}]);
  write(TAGS_KEY,[]);write(TEST_BOARDS_KEY,[]);write(SHIPMENTS_KEY,[]);
  renderWarehouseTags();
  const before=availableForYard();
  openYardBuilder();
  $('yardTag').value='10004';$('yardProduct').value='HEMLOCK 1X6';
  document.querySelector('.yard-build-qty[data-length="6"]').value='1';
  document.querySelector('.yard-build-qty[data-length="7"]').value='2';
  document.querySelector('.yard-build-qty[data-length="20"]').value='1';
  createYardTag({preventDefault(){}});
  const tag=currentTags()[0];
  const after=availableForYard();
  let printed=false;window.print=()=>{printed=true;};printYardTag(tag.id);
  const printText=$('yardTagPrint').textContent.replace(/\s+/g,' ').trim();
  const output={before:{six:before[6],seven:before[7],twenty:before[20]},tagCount:currentTags().length,quantities:tag.quantities,boards:totalBoards(tag.quantities),bf:tagBf(tag),after:{six:after[6],seven:after[7],twenty:after[20]},printed,printText,status:$('warehouseMessage').textContent};
  localStorage.clear();Object.entries(backup).forEach(([key,value])=>localStorage.setItem(key,value));
  document.body.classList.remove('print-yard-tag');$('yardTagPrint').innerHTML='';
  return output;
})()`);
console.log(JSON.stringify(result,null,2));
if (result.before.six!==1 || result.before.seven!==2 || result.before.twenty!==1 || result.tagCount!==1 || result.quantities['6']!==1 || result.quantities['7']!==2 || result.quantities['20']!==1 || result.boards!==4 || result.bf!==20 || result.after.six!==0 || result.after.seven!==0 || result.after.twenty!==0 || !result.printed || !result.printText.includes('1×6′ + 2×7′ + 1×20′') || !result.printText.includes('4 PCS') || !result.status.includes('YARD lift assembled')) {
  throw new Error(`Mixed YARD TAG failed: ${JSON.stringify(result)}`);
}
ws.close();
