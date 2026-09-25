const targets = await (await fetch('http://127.0.0.1:9233/json')).json();
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
await send('Page.navigate', { url:'http://127.0.0.1:8772/index.html?test=manual-load-structure' });
await new Promise((resolve) => setTimeout(resolve, 1300));
await evaluate(`new Promise((resolve,reject)=>{
  if (typeof calculate === 'function') return resolve(true);
  const script=document.createElement('script'); script.src='app.js?v=manual-load-structure-direct';
  script.onload=()=>resolve(true); script.onerror=()=>reject(new Error('app.js failed')); document.body.appendChild(script);
})`);
const result = await evaluate(`(() => {
  document.querySelectorAll('#inventory tr').forEach((row) => {
    const length=Number(row.querySelector('.len').value);
    row.querySelector('.qty').value=length===8 || length===10 ? 56 : 0;
  });
  document.getElementById('planningMode').value='manual';
  document.getElementById('batchProfile').value='manual';
  document.getElementById('actualT').value='1';
  document.getElementById('actualW').value='5.5';
  document.getElementById('acrossMode').value='manual';
  document.getElementById('across').value='8';
  writeCompletedCycles([]);
  activeOrder.completedCycles=[];
  delete activeOrder.activeCycleNumber;
  globalOrderPlans=[]; globalOrderSignature=''; currentLoadNumber=1;
  calculate(true);
  addManualLift(1,8);
  addBulkRowsToCycle(1,{rows:1,length:8});
  addManualCycle();
  addManualLift(2,10);
  addBulkRowsToCycle(2,{rows:1,length:10});
  currentLoadNumber=1; calculate(false);
  const moveVisible=Boolean(document.querySelector('.inline-lift-move-button'));
  const addLiftVisible=Boolean(document.querySelector('.manual-lift-form'));
  const beforeBoards=globalOrderPlans.reduce((sum,plan)=>sum+planBoardTotal(plan),0);
  moveLiftBetweenLoads(1,0,2);
  const afterMoveBoards=globalOrderPlans.reduce((sum,plan)=>sum+planBoardTotal(plan),0);
  const moved=globalOrderPlans[0].activeStates.length===0 && globalOrderPlans[1].activeStates.length===2;
  dryingPrograms.set('1',{loadNumber:1,rows:[{phase:'OLD-1'}]});
  dryingPrograms.set('2',{loadNumber:2,rows:[{phase:'KEEP-2'}]});
  thermoPrograms.set('2',{loadNumber:2,rows:[{stage:'KEEP-TM-2'}]});
  deletePlannedLoad(1);
  const renumbered=globalOrderPlans.length===1 && dryingPrograms.get('1')?.rows?.[0]?.phase==='KEEP-2' && thermoPrograms.get('1')?.rows?.[0]?.stage==='KEEP-TM-2';
  document.getElementById('saveOrder').click();
  const savedPlans=deserializeCalculatedPlans(activeOrder.viewCache?.plans);
  document.getElementById('planningMode').value='automatic';
  globalOrderPlans.push(blankManualPlan(readInventory(),computeGeometry(),33,0));
  compactEmptyAutomaticPlans();
  const emptyCompacted=globalOrderPlans.length===1;
  return {
    moveVisible, addLiftVisible, beforeBoards, afterMoveBoards, moved, renumbered,
    plans:globalOrderPlans.length, savedPlans:savedPlans.length,
    savedLifts:savedPlans[0]?.activeStates?.length, emptyCompacted,
    remaining:[...globalOrderPlans.at(-1).stock.values()].reduce((sum,value)=>sum+value,0),
    saveText:document.getElementById('orderSaveState').textContent,
  };
})()`);
if (!result.moveVisible || !result.addLiftVisible || result.beforeBoards !== result.afterMoveBoards || !result.moved || !result.renumbered
  || result.plans !== 1 || result.savedPlans !== 1 || result.savedLifts !== 2 || !result.emptyCompacted || !result.saveText.includes('complete manual layout')) {
  throw new Error('Manual load structure failed: '+JSON.stringify(result));
}
console.log(JSON.stringify(result));
ws.close();
