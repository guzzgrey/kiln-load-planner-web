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
  activeOrder={id:'westminster-recovery',number:'ORD-334605',status:'active',plannedCycles:7,inventory:{12:320,13:78,20:328,19:128,14:512},inputs:{supplier:'Westminster',species:'Hemlock',size:'1,6'},activeCycleNumber:2,activeCycleStartedAt:'2026-09-09T12:00:00-07:00'};
  document.getElementById('size').value='1,6';
  document.getElementById('actualT').value='1';document.getElementById('actualW').value='6';
  document.getElementById('acrossMode').value='manual';document.getElementById('across').value='8';
  loadRecords.clear();globalOrderSignature='westminster-recovery-plan';
  const badCycle1Rows=[];
  for(let index=0;index<2;index+=1) badCycle1Rows.push({type:'solid',pattern:[13]});
  for(let index=0;index<30;index+=1) badCycle1Rows.push({type:'solid',pattern:[12]});
  const joinedRows=[];
  for(let index=0;index<2;index+=1) joinedRows.push({type:'joined',pattern:[7,12]});
  for(let index=0;index<5;index+=1) joinedRows.push({type:'joined',pattern:[8,11]});
  globalOrderPlans=[
    {activeStates:[{length:13,rowCapacity:32,rowSequence:badCycle1Rows,manualRows:[],groups:new Map()}],states:[],usedMap:new Map([[12,240],[13,16],[20,272]]),completedUsedMap:new Map([[12,240],[13,16],[20,272]]),availableStock:new Map(),stock:new Map(),valid:true},
    {activeStates:[{length:19,rowCapacity:32,rowSequence:joinedRows,manualRows:[],groups:new Map()}],states:[],usedMap:new Map(),completedUsedMap:new Map(),availableStock:new Map(),stock:new Map(),valid:true},
  ];
  globalOrderPlans[0].states=globalOrderPlans[0].activeStates;
  globalOrderPlans[1].states=globalOrderPlans[1].activeStates;
  loadRecords.set(2,{number:2,available:new Map([[19,128],[14,512]]),used:new Map([[19,128],[14,512]]),remaining:new Map(),usedBoards:640,remainingBoards:0,usedBf:4112,materials:{Hemlock:640},qualityLots:[{length:19,material:'Hemlock',quality:'good',quantity:128},{length:14,material:'Hemlock',quality:'good',quantity:512}]});
  const badCycle1Snapshot=JSON.parse(serializeCalculatedPlans([globalOrderPlans[0]]))[0];
  writeCompletedCycles([{id:'cycle-1',orderId:activeOrder.id,orderNumber:activeOrder.number,loadNumber:1,boards:528,bf:4264,quantities:{12:240,13:16,20:272},qualityLots:[{length:12,material:'Hemlock',quality:'unclassified',quantity:240},{length:13,material:'Hemlock',quality:'unclassified',quantity:16},{length:20,material:'Hemlock',quality:'unclassified',quantity:272}],planSnapshot:badCycle1Snapshot,startedAt:'2026-08-18T12:00:00-07:00',completedAt:'2026-08-24T12:00:00-07:00',completedDate:'2026-08-24',historyCorrection:WESTMINSTER_TIMELINE_CORRECTION,physicalQuantityCorrection:'westminster-cycle-1-actual-20x272-12x240-13x16-v1'}]);
  const changed=repairWestminsterProductionTimeline();
  const records=readCompletedCycles();
  const recovered=records.find((record)=>Number(record.loadNumber)===2);
  const first=records.find((record)=>Number(record.loadNumber)===1);
  const correctedRows=globalOrderPlans[1].activeStates[0].rowSequence;
  const patternCount=(pattern)=>correctedRows.filter((row)=>row.pattern.join('+')===pattern).length;
  const secondPassChanged=repairWestminsterProductionTimeline();
  const remaining13=Number(activeOrder.inventory[13])-records.reduce((sum,record)=>sum+Number(record.quantities?.[13]||0),0);
  const correctedCycle1Rows=restorePlanTypes(first.planSnapshot).activeStates[0].rowSequence;
  const cycle1Rows13=correctedCycle1Rows.filter((row)=>row.pattern.join('+')==='13').length;
  const cycle1Rows12=correctedCycle1Rows.filter((row)=>row.pattern.join('+')==='12').length;
  const future13Plans=buildOptimizedPlanSet(new Map([[13,remaining13]]),computeGeometry(),24,20,0,false);
  const future13Used=future13Plans.reduce((sum,plan)=>sum+Number(plan.usedMap?.get(13)||0),0);
  const output={changed,secondPassChanged,records:records.length,completed:isLoadCompleted(2),boards:recovered?.boards,bf:recovered?.bf,date:recovered?.completedDate,startedAt:recovered?.startedAt,activeCycle:activeOrder.activeCycleNumber||null,embedded:activeOrder.completedCycles?.length||0,marker:activeOrder.cycle2RecoveryVersion,layoutMarker:activeOrder.cycle2LayoutCorrectionVersion,cycle1Marker:activeOrder.cycle1ActualCorrectionVersion,cycle1Twelve:first?.quantities?.[12],cycle1Thirteen:first?.quantities?.[13],cycle1Boards:first?.boards,cycle1Bf:first?.bf,cycle1Rows13,cycle1Rows12,remaining13,future13Used,quantities:recovered?.quantities,rows8x11:patternCount('8+11'),rows7x12:patternCount('7+12')};
  localStorage.clear();Object.entries(backup).forEach(([key,value])=>localStorage.setItem(key,value));
  return output;
})()`);
console.log(JSON.stringify(result,null,2));
if (!result.changed || result.secondPassChanged || result.records!==2 || !result.completed || result.boards!==640 || result.bf!==4112 || result.date!=='2026-09-25' || !result.startedAt.startsWith('2026-09-09') || result.activeCycle!==null || result.embedded!==2 || !result.marker || !result.layoutMarker || !result.cycle1Marker || result.cycle1Twelve!==216 || result.cycle1Thirteen!==40 || result.cycle1Boards!==528 || result.cycle1Bf!==4276 || result.cycle1Rows13!==5 || result.cycle1Rows12!==27 || result.remaining13!==6 || result.future13Used!==0 || result.rows8x11!==6 || result.rows7x12!==1 || result.quantities['7']!==24 || result.quantities['8']!==48 || result.quantities['11']!==48 || result.quantities['12']!==8) {
  throw new Error(`Westminster Cycle 2 recovery failed: ${JSON.stringify(result)}`);
}
ws.close();
