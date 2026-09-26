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
await send('Page.navigate', { url: 'http://127.0.0.1:8782/index.html?test=westminster-cycle2-recovery' });
await new Promise((resolve) => setTimeout(resolve, 1300));
const result = await evaluate(`(() => {
  const backup=Object.fromEntries(Array.from({length:localStorage.length},(_,index)=>localStorage.key(index)).map((key)=>[key,localStorage.getItem(key)]));
  localStorage.clear();
  activeOrder={id:'westminster-recovery',number:'ORD-334605',status:'active',plannedCycles:7,inventory:{19:128,14:512},inputs:{supplier:'Westminster',species:'Hemlock',size:'1,6'},activeCycleNumber:2,activeCycleStartedAt:'2026-09-09T12:00:00-07:00'};
  loadRecords.clear();globalOrderSignature='westminster-recovery-plan';
  const joinedRows=[];
  for(let index=0;index<2;index+=1) joinedRows.push({type:'joined',pattern:[7,12]});
  for(let index=0;index<5;index+=1) joinedRows.push({type:'joined',pattern:[8,11]});
  globalOrderPlans=[
    {activeStates:[],states:[],usedMap:new Map(),completedUsedMap:new Map(),availableStock:new Map(),stock:new Map(),valid:true},
    {activeStates:[{length:19,rowCapacity:32,rowSequence:joinedRows,manualRows:[],groups:new Map()}],states:[],usedMap:new Map(),completedUsedMap:new Map(),availableStock:new Map(),stock:new Map(),valid:true},
  ];
  globalOrderPlans[1].states=globalOrderPlans[1].activeStates;
  loadRecords.set(2,{number:2,available:new Map([[19,128],[14,512]]),used:new Map([[19,128],[14,512]]),remaining:new Map(),usedBoards:640,remainingBoards:0,usedBf:4112,materials:{Hemlock:640},qualityLots:[{length:19,material:'Hemlock',quality:'good',quantity:128},{length:14,material:'Hemlock',quality:'good',quantity:512}]});
  writeCompletedCycles([{id:'cycle-1',orderId:activeOrder.id,orderNumber:activeOrder.number,loadNumber:1,boards:528,bf:4276,quantities:{20:272,13:256},startedAt:'2026-08-18T12:00:00-07:00',completedAt:'2026-08-24T12:00:00-07:00',completedDate:'2026-08-24',historyCorrection:WESTMINSTER_TIMELINE_CORRECTION}]);
  const changed=repairWestminsterProductionTimeline();
  const records=readCompletedCycles();
  const recovered=records.find((record)=>Number(record.loadNumber)===2);
  const correctedRows=globalOrderPlans[1].activeStates[0].rowSequence;
  const patternCount=(pattern)=>correctedRows.filter((row)=>row.pattern.join('+')===pattern).length;
  const secondPassChanged=repairWestminsterProductionTimeline();
  const output={changed,secondPassChanged,records:records.length,completed:isLoadCompleted(2),boards:recovered?.boards,bf:recovered?.bf,date:recovered?.completedDate,startedAt:recovered?.startedAt,activeCycle:activeOrder.activeCycleNumber||null,embedded:activeOrder.completedCycles?.length||0,marker:activeOrder.cycle2RecoveryVersion,layoutMarker:activeOrder.cycle2LayoutCorrectionVersion,quantities:recovered?.quantities,rows8x11:patternCount('8+11'),rows7x12:patternCount('7+12')};
  localStorage.clear();Object.entries(backup).forEach(([key,value])=>localStorage.setItem(key,value));
  return output;
})()`);
console.log(JSON.stringify(result,null,2));
if (!result.changed || result.secondPassChanged || result.records!==2 || !result.completed || result.boards!==640 || result.bf!==4112 || result.date!=='2026-09-25' || !result.startedAt.startsWith('2026-09-09') || result.activeCycle!==null || result.embedded!==1 || !result.marker || !result.layoutMarker || result.rows8x11!==6 || result.rows7x12!==1 || result.quantities['7']!==24 || result.quantities['8']!==48 || result.quantities['11']!==48 || result.quantities['12']!==8) {
  throw new Error(`Westminster Cycle 2 recovery failed: ${JSON.stringify(result)}`);
}
ws.close();
