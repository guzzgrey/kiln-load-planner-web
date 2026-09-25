const targets = await (await fetch('http://127.0.0.1:9232/json')).json();
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
await send('Page.navigate', { url: 'http://127.0.0.1:8771/warehouse.html?test=yard-tag-print' });
await new Promise((resolve) => setTimeout(resolve, 1200));
const result = await evaluate(`(() => {
  const backup = Object.fromEntries(Array.from({length:localStorage.length},(_,index)=>localStorage.key(index)).map((key)=>[key,localStorage.getItem(key)]));
  localStorage.clear();
  localStorage.setItem(ACTIVE_ORDER_KEY, JSON.stringify({id:'tag-print-order',number:'ORD-334605',inputs:{supplier:'Westminster'}}));
  localStorage.setItem(TAGS_KEY, JSON.stringify([{
    id:'tag-print-fixture',orderId:'tag-print-order',productionOrderNumber:'ORD-334605',tag:'10007',orderNumber:'ORD-334605',productMo:'TH HEM 1X6 85/15 CLR VG RGH',date:'2026-09-25',supplier:'Westminster',size:'1×6',material:'Hemlock',quality:'good',quantities:{20:64}
  }]));
  localStorage.setItem(TAG_SEQUENCE_KEY, '10005');
  renderWarehouseTags();
  const printButton = document.querySelector('#warehouseTagTable tbody td:first-child .print-yard-tag');
  const buttonVisible = Boolean(printButton && getComputedStyle(printButton).display !== 'none');
  const first = nextYardTagNumber();
  advanceYardTagSequence('10008');
  const second = nextYardTagNumber();
  let printed = false;
  window.print = () => { printed = true; };
  printYardTag('tag-print-fixture');
  const html = document.getElementById('yardTagPrint').textContent.replace(/\s+/g,' ').trim();
  const printClass = document.body.classList.contains('print-yard-tag');
  localStorage.clear();
  Object.entries(backup).forEach(([key,value])=>localStorage.setItem(key,value));
  document.body.classList.remove('print-yard-tag');
  document.getElementById('yardTagPrint').innerHTML='';
  return {first,second,printed,printClass,buttonVisible,html};
})()`);
console.log(JSON.stringify(result, null, 2));
if (result.first !== 10008 || result.second !== 10009 || !result.printed || !result.printClass || !result.buttonVisible || !result.html.includes('WESTMINSTER') || !result.html.includes('10007') || !result.html.includes('334605') || !result.html.includes('64 PCS') || !result.html.includes('640 BFM')) {
  throw new Error(`YARD TAG print test failed: ${JSON.stringify(result)}`);
}
ws.close();
