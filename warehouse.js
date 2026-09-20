const LENGTHS = Array.from({ length: 18 }, (_, index) => index + 3);
const COMPLETED_KEY = 'kiln-planner-completed-cycles-v1';
const TAGS_KEY = 'kiln-planner-shipping-tags-v1';
const SHIPMENTS_KEY = 'kiln-planner-shipments-v1';
const RECOVERY_KEY = 'kiln-planner-recovery-operations-v1';
const TEST_BOARDS_KEY = 'kiln-planner-test-boards-v1';
const PREORDERS_KEY = 'kiln-planner-preliminary-orders-v1';
const FINAL_DATE_KEY = 'kiln-planner-final-process-date-v1';
const ACTIVE_ORDER_KEY = 'kiln-planner-active-order-v1';
const ORDER_ARCHIVE_KEY = 'kiln-planner-order-archive-v1';
const REMAINDER_INVENTORY_KEY = 'kiln-planner-remainder-inventory-v1';
const ORDER_INDEX_KEY = 'kiln-planner-order-index-v1';
const ORDER_PREFIX = 'kiln-planner-order-v1:';
const $ = (id) => document.getElementById(id);

function read(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; }
  catch (_) { return []; }
}
function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function fmt(value, digits = 0) { return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function esc(value) { return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function activeOrder() {
  try {
    const value = JSON.parse(localStorage.getItem(ACTIVE_ORDER_KEY) || 'null');
    if (!value?.orderRef) return value;
    return JSON.parse(localStorage.getItem(`kiln-planner-order-v1:${value.orderRef}`) || 'null');
  } catch (_) { return null; }
}
function allCompleted() { return read(COMPLETED_KEY); }
function belongsToOrder(item, order) { return !order || item.orderId === order.id || item.orderId === order.planSignature || item.productionOrderNumber === order.number || item.orderNumber === order.number; }
function completed() { const order = activeOrder(); return allCompleted().filter((item) => belongsToOrder(item, order)).sort((a, b) => String(a.completedDate).localeCompare(String(b.completedDate)) || a.loadNumber - b.loadNumber); }
function reconcileGormanCompletedInventory() {
  const order = activeOrder();
  if (!order || order.gormanWarehouseBalanceVersion === 'actual-231-v1') return false;
  if (String(order.number || '').trim().toUpperCase() !== 'ORD-508271240') return false;
  if (Number(order.inventory?.[8] || 0) !== 206 || Number(order.inventory?.[10] || 0) !== 28) return false;

  const all = allCompleted();
  const existing = all.filter((record) => belongsToOrder(record, order));
  const unrelated = all.filter((record) => !belongsToOrder(record, order));
  const cached = order.viewCache?.records || [];
  const dimensions = orderedBoardDimensions(order);
  const makeRecord = (loadNumber, quantities, materials, fallbackLots) => {
    const prior = existing.find((record) => Number(record.loadNumber) === loadNumber);
    const snapshot = cached.find((record) => Number(record.number) === loadNumber);
    const boards = totalBoards(quantities);
    const boardFeet = Object.entries(quantities).reduce((sum, [length, quantity]) => sum + dimensions.thickness * dimensions.width * Number(length) * Number(quantity) / 12, 0);
    return {
      ...(prior || {}),
      id: prior?.id || `${order.id}::gorman-actual-load-${loadNumber}`,
      orderId: order.id,
      orderNumber: order.number,
      productionOrderNumber: order.number,
      loadNumber,
      supplier: prior?.supplier || order.inputs?.supplier || 'Gordon Elit',
      marking: prior?.marking || 'Actual production reconciliation',
      completedDate: prior?.completedDate || '',
      species: prior?.species || order.inputs?.species || 'SPF / Hemlock',
      size: prior?.size || String(order.inputs?.size || '').replace(',', '×') || '1×6',
      quantities,
      materials: snapshot?.materials || materials,
      qualityLots: Array.isArray(snapshot?.qualityLots) && snapshot.qualityLots.length ? snapshot.qualityLots : fallbackLots,
      boards,
      bf: boardFeet,
      reconciledAt: new Date().toISOString(),
      createdAt: prior?.createdAt || order.calculatedAt || order.updatedAt || new Date().toISOString(),
    };
  };
  const reconciled = [
    makeRecord(1, { 8: 112 }, { SPF: 88, Hemlock: 24 }, [
      { length: 8, material: 'SPF', quality: 'unclassified', qualityLabel: 'Unclassified', quantity: 88 },
      { length: 8, material: 'Hemlock', quality: 'unclassified', qualityLabel: 'Unclassified', quantity: 24 },
    ]),
    makeRecord(2, { 8: 91, 10: 28 }, { SPF: 91, Hemlock: 28 }, [
      { length: 8, material: 'SPF', quality: 'unclassified', qualityLabel: 'Unclassified', quantity: 91 },
      { length: 10, material: 'Hemlock', quality: 'unclassified', qualityLabel: 'Unclassified', quantity: 28 },
    ]),
  ];
  write(COMPLETED_KEY, [...unrelated, ...reconciled]);
  order.gormanWarehouseBalanceVersion = 'actual-231-v1';
  order.plannedCycles = 2;
  order.plannedBoards = 231;
  order.plannedBf = reconciled.reduce((sum, record) => sum + Number(record.bf || 0), 0);
  delete order.activeCycleNumber;
  delete order.activeCycleStartedAt;
  order.updatedAt = new Date().toISOString();
  localStorage.setItem(`${ORDER_PREFIX}${order.id}`, JSON.stringify(order));
  try {
    const pointer = JSON.parse(localStorage.getItem(ACTIVE_ORDER_KEY) || 'null');
    if (pointer && !pointer.orderRef) localStorage.setItem(ACTIVE_ORDER_KEY, JSON.stringify(order));
  } catch (_) {
    // The referenced order record above remains the authoritative copy.
  }
  return true;
}
function warehouseTags() {
  const tags = read(TAGS_KEY);
  let changed = false;
  tags.forEach((tag, index) => {
    if (tag.id) return;
    tag.id = `tag-migrated-${index}-${Date.now()}`;
    changed = true;
  });
  if (changed) write(TAGS_KEY, tags);
  return tags;
}
function shipments() { return read(SHIPMENTS_KEY); }
function recoveryOperations() { return read(RECOVERY_KEY); }
function currentRecoveries() { const order = activeOrder(); return recoveryOperations().filter((item) => belongsToOrder(item, order)); }
function testBoardRecords() { return read(TEST_BOARDS_KEY); }
function currentTests() { const order = activeOrder(); return testBoardRecords().filter((item) => belongsToOrder(item, order)); }
function currentTags() { const order = activeOrder(); const sourceIds = new Set(completed().map((item) => item.id)); return warehouseTags().filter((tag) => belongsToOrder(tag, order) || (tag.sourceLoads || []).some((source) => sourceIds.has(source.id))); }
function currentShipments() { const order = activeOrder(); const tagIds = new Set(currentTags().map((tag) => tag.id)); return shipments().filter((item) => belongsToOrder(item, order) || (item.tagIds || []).some((id) => tagIds.has(id))); }
function sumQuantities(records) {
  const totals = Object.fromEntries(LENGTHS.map((length) => [length, 0]));
  records.forEach((record) => LENGTHS.forEach((length) => { totals[length] += Number(record.quantities?.[length] || 0); }));
  return totals;
}
function totalBoards(quantities) { return Object.values(quantities || {}).reduce((sum, value) => sum + Number(value || 0), 0); }
function totalLinearFeet(quantities) { return LENGTHS.reduce((sum, length) => sum + length * Number(quantities?.[length] || 0), 0); }
function sourceQuantities(tag) { return tag.sourceQuantities || tag.quantities || {}; }
function qualityLabel(value) {
  return ({
    good: 'No.1 / good',
    'grade-1': 'No.1 / good',
    crooked: 'Crooked / bowed',
    cracked: 'Cracked',
    knots: 'Large or damaged knots',
    'recovered-grade-1': 'Recovered Grade #1',
    downgraded: 'Downgraded / defects',
    unclassified: 'Unclassified',
  })[value] || 'Unclassified';
}
function completedQualityLots() {
  return completed().flatMap((record) => {
    if (Array.isArray(record.qualityLots) && record.qualityLots.length) return record.qualityLots.map((lot) => ({ ...lot, loadNumber: record.loadNumber }));
    return Object.entries(record.quantities || {}).filter(([, quantity]) => Number(quantity) > 0).map(([length, quantity]) => ({
      length: Number(length),
      material: record.species || record.marking || 'Unclassified material',
      quality: 'unclassified',
      qualityLabel: 'Unclassified',
      quantity: Number(quantity),
      loadNumber: record.loadNumber,
    }));
  });
}
function recordQualitySummary(record) {
  const grouped = new Map();
  (record.qualityLots || []).forEach((lot) => {
    const key = `${lot.material || record.species || 'Material'}\u0000${qualityLabel(lot.quality)}`;
    grouped.set(key, Number(grouped.get(key) || 0) + Number(lot.quantity || 0));
  });
  if (!grouped.size) return esc(record.species || 'Unclassified');
  return [...grouped.entries()].map(([key, quantity]) => {
    const [material, quality] = key.split('\u0000');
    return `<span><b>${fmt(quantity)} ${esc(material)}</b><small>${esc(quality)}</small></span>`;
  }).join('');
}
function recoveryLabel(tag) {
  return (tag.recoveryCuts || []).map((cut) => `${fmt(cut.quantity)}× ${cut.sourceLength} ft → ${cut.outputs.join(' + ')} ft`).join('; ');
}
function dimensions(size) { const values = String(size || '').match(/[\d.]+/g)?.map(Number) || []; return { thickness: values[0] || 0, width: values[1] || 0 }; }
function tagBf(tag) {
  const { thickness, width } = dimensions(tag.size);
  return LENGTHS.reduce((sum, length) => sum + thickness * width * length * Number(tag.quantities?.[length] || 0) / 12, 0);
}

let activePreorderId = '';
let draggedPreorderItemId = '';

function preorderRecords() { return read(PREORDERS_KEY); }
function preorderPurpose(draft) {
  if (draft?.purpose === 'customer' || draft?.purpose === 'stock') return draft.purpose;
  return String(draft?.customer || '').trim() || String(draft?.number || '').trim() ? 'customer' : 'stock';
}
function migratePreorderPurposes() {
  const records = preorderRecords();
  const order = activeOrder();
  const orderNumber = String(order?.number || '').trim().toUpperCase();
  const isWestminster334605 = orderNumber === 'ORD-334605' || orderNumber === '334605';
  const isGorman508271240 = orderNumber === 'ORD-508271240';
  let changed = false;
  const migrated = records.map((draft) => {
    const purpose = preorderPurpose(draft);
    const next = { ...draft, purpose };
    if (draft.purpose !== purpose) changed = true;
    const hasAllocations = (draft.stacks || []).some((stack) => (stack.items || []).length > 0);
    if (purpose === 'stock' && !hasAllocations && !String(draft.customer || '').trim() && !String(draft.number || '').trim()
      && Number(draft.targetBf || 0) === 4200 && draft.purpose === undefined) {
      next.targetBf = 0;
      changed = true;
    }
    if (draft.orderId === order?.id && isWestminster334605 && draft.orderPurposeVersion !== 'order-specific-v2') {
      next.purpose = 'customer';
      if (!Number(next.targetBf || 0)) next.targetBf = 4200;
      next.orderPurposeVersion = 'order-specific-v2';
      changed = true;
    } else if (draft.orderId === order?.id && isGorman508271240 && draft.orderPurposeVersion !== 'order-specific-v2') {
      next.purpose = 'stock';
      next.orderPurposeVersion = 'order-specific-v2';
      changed = true;
    }
    return next;
  });
  if (changed) write(PREORDERS_KEY, migrated);
}
function currentPreorders() {
  const order = activeOrder();
  return preorderRecords().filter((draft) => draft.orderId === order?.id);
}
function orderedBoardDimensions(order = activeOrder()) {
  const raw = String(order?.inputs?.size || '');
  if (raw === 'custom') return { thickness: Number(order?.inputs?.customT || 0), width: Number(order?.inputs?.customW || 0) };
  const values = raw.match(/[\d.]+/g)?.map(Number) || [];
  return { thickness: values[0] || Number(order?.inputs?.customT || 0), width: values[1] || Number(order?.inputs?.customW || 0) };
}
function preorderBf(length, quantity) {
  const { thickness, width } = orderedBoardDimensions();
  return thickness * width * Number(length || 0) * Number(quantity || 0) / 12;
}
function makePreorder() {
  const order = activeOrder();
  return {
    id: `preorder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    orderId: order?.id || '', purpose: 'stock', customer: '', number: '', targetBf: 0,
    stacks: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}
function savePreorder(draft) {
  const records = preorderRecords();
  const next = { ...draft, updatedAt: new Date().toISOString() };
  const position = records.findIndex((item) => item.id === next.id);
  if (position >= 0) records[position] = next; else records.push(next);
  write(PREORDERS_KEY, records);
  return next;
}
function activePreorder() {
  const records = currentPreorders();
  let draft = records.find((item) => item.id === activePreorderId) || records[0];
  if (!draft && activeOrder()) draft = savePreorder(makePreorder());
  activePreorderId = draft?.id || '';
  return draft || null;
}
function lotKey(loadNumber, length, material, quality) {
  return `load-${Number(loadNumber)}|${Number(length)}|${material || 'Material'}|${quality || 'unclassified'}`;
}
function lotsForCycle(record, status) {
  const result = [];
  const sourceLots = Array.isArray(record?.qualityLots) && record.qualityLots.length
    ? record.qualityLots
    : Object.entries(record?.quantities || {}).map(([length, quantity]) => ({ length: Number(length), quantity, material: record?.species || record?.marking || 'Material', quality: 'unclassified' }));
  sourceLots.forEach((lot) => {
    const quantity = Math.max(0, Number(lot.quantity || 0));
    if (!quantity) return;
    const material = lot.material || record?.species || record?.marking || 'Material';
    const quality = lot.quality || 'unclassified';
    result.push({
      id: lotKey(record.loadNumber, lot.length, material, quality), loadNumber: Number(record.loadNumber),
      length: Number(lot.length), material, quality, quantity, status,
    });
  });
  return result;
}
function productionLots() {
  const readyCap = availableForYard();
  const ready = [];
  const usedByLength = Object.fromEntries(LENGTHS.map((length) => [length, 0]));
  completed().forEach((record) => lotsForCycle(record, 'ready').forEach((lot) => {
    const remaining = Math.max(0, Number(readyCap[lot.length] || 0) - usedByLength[lot.length]);
    const quantity = Math.min(lot.quantity, remaining);
    if (quantity > 0) {
      ready.push({ ...lot, quantity });
      usedByLength[lot.length] += quantity;
    }
  }));
  LENGTHS.forEach((length) => {
    const missing = Math.max(0, Number(readyCap[length] || 0) - usedByLength[length]);
    if (missing) ready.push({ id: `recovered|${length}`, loadNumber: 0, length, material: 'Recovered material', quality: 'recovered-grade-1', quantity: missing, status: 'ready' });
  });

  const order = activeOrder();
  const activeNumber = Number(order?.activeCycleNumber || 0);
  const alreadyCompleted = completed().some((record) => Number(record.loadNumber) === activeNumber);
  if (!activeNumber || alreadyCompleted) return ready;
  const record = order?.viewCache?.records?.find((item) => Number(item.number) === activeNumber);
  if (!record) return ready;
  return [...ready, ...lotsForCycle({ ...record, loadNumber: activeNumber, quantities: record.used || {} }, 'expected')];
}
function allPreorderItems(drafts = currentPreorders()) {
  return drafts.flatMap((draft) => (draft.stacks || []).flatMap((stack) => stack.items || []));
}
function preorderReserved(lotId, exceptId = '') {
  return allPreorderItems().filter((item) => item.lotId === lotId && item.id !== exceptId).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}
function findPreorderItem(draft, id) {
  for (const stack of draft?.stacks || []) {
    const item = (stack.items || []).find((entry) => entry.id === id);
    if (item) return { stack, item };
  }
  return null;
}
function updatePreorderHeader(draft) {
  draft.purpose = $('preorderPurpose').value === 'customer' ? 'customer' : 'stock';
  draft.customer = $('preorderCustomer').value.trim();
  draft.number = $('preorderNumber').value.trim();
  draft.targetBf = Math.max(0, Number($('preorderTarget').value || 0));
  return savePreorder(draft);
}
function updatePreorderPurposeUi(draft) {
  const purpose = preorderPurpose(draft);
  const customerOrder = purpose === 'customer';
  $('preorderPurpose').value = purpose;
  document.querySelectorAll('.preorder-customer-field').forEach((field) => field.classList.toggle('is-disabled', !customerOrder));
  $('preorderCustomer').disabled = !customerOrder;
  $('preorderNumber').disabled = !customerOrder;
  $('preorderCustomer').required = customerOrder;
  $('preorderEyebrow').textContent = customerOrder ? 'PRELIMINARY CUSTOMER ORDER' : 'UNASSIGNED FINISHED MATERIAL';
  $('preorderHeading').textContent = customerOrder ? 'Plan finished material into future customer TAG stacks' : 'Stage finished material without a customer assignment';
  $('preorderTargetHint').textContent = customerOrder ? 'Customer quantity goal' : 'Optional until a customer agreement exists';
}
function addPreorderStack() {
  const draft = activePreorder();
  if (!draft) return;
  draft.stacks ||= [];
  draft.stacks.push({ id: `future-tag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: `Future TAG ${draft.stacks.length + 1}`, items: [] });
  savePreorder(draft);
  renderPreorderPlanner();
}
function addPreorderAllocation(lotId, quantity, stackId) {
  const draft = activePreorder();
  const lot = productionLots().find((item) => item.id === lotId);
  const stack = draft?.stacks?.find((item) => item.id === stackId);
  const available = Math.max(0, Number(lot?.quantity || 0) - preorderReserved(lotId));
  const requested = Math.max(0, Math.floor(Number(quantity || 0)));
  if (!lot || !stack || !requested || requested > available) {
    $('preorderStatus').className = 'calculation-status pending';
    $('preorderStatus').textContent = `Enter a quantity no greater than ${fmt(available)} available boards.`;
    return false;
  }
  stack.items ||= [];
  stack.items.push({ id: `allocation-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, lotId, loadNumber: lot.loadNumber, length: lot.length, material: lot.material, quality: lot.quality, sourceStatus: lot.status, quantity: requested });
  savePreorder(draft);
  renderPreorderPlanner();
  return true;
}
function renderPreorderPlanner() {
  const order = activeOrder();
  const draft = activePreorder();
  if (!order || !draft) {
    $('preorderSources').innerHTML = '<div class="empty-state">Open a production order first.</div>';
    $('preorderStacks').innerHTML = '';
    return;
  }
  const drafts = currentPreorders();
  $('preorderSelect').innerHTML = drafts.map((item) => {
    const label = preorderPurpose(item) === 'customer' ? (item.number || item.customer || 'Customer draft') : 'Unassigned stock plan';
    return `<option value="${esc(item.id)}" ${item.id === draft.id ? 'selected' : ''}>${esc(label)} · ${fmt(item.targetBf || 0)} BF</option>`;
  }).join('');
  updatePreorderPurposeUi(draft);
  $('preorderCustomer').value = draft.customer || '';
  $('preorderNumber').value = draft.number || '';
  $('preorderTarget').value = Number(draft.targetBf || 0);
  const lots = productionLots();
  const selectedItems = (draft.stacks || []).flatMap((stack) => stack.items || []);
  const selectedBf = selectedItems.reduce((sum, item) => sum + preorderBf(item.length, item.quantity), 0);
  const target = Number(draft.targetBf || 0);
  const delta = target - selectedBf;
  const customerOrder = preorderPurpose(draft) === 'customer';
  const readyBoards = selectedItems.filter((item) => (lots.find((lot) => lot.id === item.lotId)?.status || item.sourceStatus) === 'ready').reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const expectedBoards = selectedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0) - readyBoards;
  $('preorderMetrics').innerHTML = `
    <div><b>${target > 0 ? fmt(target, 1) : '—'}</b><span>${customerOrder ? 'customer target BF' : 'optional target BF'}</span></div>
    <div><b>${fmt(selectedBf, 1)}</b><span>selected BF</span></div>
    <div class="${target > 0 && delta < 0 ? 'over' : ''}"><b>${target > 0 ? `${delta < 0 ? '+' : ''}${fmt(Math.abs(delta), 1)}` : '—'}</b><span>${target > 0 ? (delta < 0 ? 'BF over target' : 'BF still needed') : 'no target set yet'}</span></div>
    <div><b>${fmt(readyBoards)} / ${fmt(expectedBoards)}</b><span>ready / expected boards</span></div>`;
  const materialTotals = new Map();
  lots.forEach((lot) => {
    const values = materialTotals.get(lot.material) || { readyQty: 0, readyBf: 0, readyFreeQty: 0, readyFreeBf: 0, expectedQty: 0, expectedBf: 0, expectedFreeQty: 0, expectedFreeBf: 0 };
    const free = Math.max(0, Number(lot.quantity || 0) - preorderReserved(lot.id));
    const prefix = lot.status === 'ready' ? 'ready' : 'expected';
    values[`${prefix}Qty`] += Number(lot.quantity || 0);
    values[`${prefix}Bf`] += preorderBf(lot.length, lot.quantity);
    values[`${prefix}FreeQty`] += free;
    values[`${prefix}FreeBf`] += preorderBf(lot.length, free);
    materialTotals.set(lot.material, values);
  });
  $('preorderMaterialTotals').innerHTML = materialTotals.size
    ? [...materialTotals.entries()].map(([material, values]) => `<article><h3>${esc(material)}</h3><div class="material-stock-line ready"><span>READY in warehouse</span><b>${fmt(values.readyQty)} PCS · ${fmt(values.readyBf, 1)} BF</b><small>${fmt(values.readyFreeQty)} PCS · ${fmt(values.readyFreeBf, 1)} BF free for drafts</small></div><div class="material-stock-line expected"><span>EXPECTED from started cycle</span><b>${fmt(values.expectedQty)} PCS · ${fmt(values.expectedBf, 1)} BF</b><small>${fmt(values.expectedFreeQty)} PCS · ${fmt(values.expectedFreeBf, 1)} BF free for drafts</small></div></article>`).join('')
    : '<div class="empty-state">No material is available from completed or started cycles.</div>';
  const stackOptions = (draft.stacks || []).map((stack) => `<option value="${esc(stack.id)}">${esc(stack.name)}</option>`).join('');
  $('preorderSources').innerHTML = lots.length ? lots.map((lot) => {
    const available = Math.max(0, lot.quantity - preorderReserved(lot.id));
    return `<div class="preorder-source-row" data-lot-id="${esc(lot.id)}"><span><b>${fmt(lot.length)} ft · ${esc(lot.material)}</b><small class="source-${lot.status}">${lot.status === 'ready' ? 'READY' : 'EXPECTED'} · Kiln Load ${fmt(lot.loadNumber || 0)} · ${esc(qualityLabel(lot.quality))}</small></span><strong><b>${fmt(available)} PCS</b><small>${fmt(preorderBf(lot.length, available), 1)} BF</small></strong><input class="preorder-source-qty" type="number" min="1" max="${available}" value="${available ? 1 : 0}" ${available ? '' : 'disabled'} aria-label="Quantity"><select class="preorder-source-stack" ${stackOptions ? '' : 'disabled'}>${stackOptions || '<option>Add TAG first</option>'}</select><button class="preorder-add-source" type="button" ${available && stackOptions ? '' : 'disabled'}>Add</button></div>`;
  }).join('') : '<div class="empty-state">No material is available from a completed or currently started cycle.</div>';
  $('preorderStacks').innerHTML = (draft.stacks || []).length ? draft.stacks.map((stack) => {
    const stackBf = (stack.items || []).reduce((sum, item) => sum + preorderBf(item.length, item.quantity), 0);
    const stackBoards = (stack.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const stackMaterials = new Map();
    (stack.items || []).forEach((item) => {
      const value = stackMaterials.get(item.material) || { quantity: 0, bf: 0 };
      value.quantity += Number(item.quantity || 0);
      value.bf += preorderBf(item.length, item.quantity);
      stackMaterials.set(item.material, value);
    });
    const materialSummary = [...stackMaterials.entries()].map(([material, value]) => `<span><b>${esc(material)}</b>${fmt(value.quantity)} PCS · ${fmt(value.bf, 1)} BF</span>`).join('');
    const items = (stack.items || []).map((item) => {
      const liveLot = lots.find((lot) => lot.id === item.lotId);
      const status = liveLot?.status || item.sourceStatus || 'expected';
      return `<article class="preorder-allocation ${status}" draggable="true" data-item-id="${esc(item.id)}"><span><b>${fmt(item.length)} ft · ${esc(item.material)}</b><small>${status === 'ready' ? 'READY' : 'EXPECTED'} · Load ${fmt(item.loadNumber)} · ${fmt(preorderBf(item.length, item.quantity), 1)} BF</small></span><input class="preorder-item-qty" data-item-id="${esc(item.id)}" type="number" min="1" value="${fmt(item.quantity)}" aria-label="Board quantity"><button class="danger preorder-remove-item" data-item-id="${esc(item.id)}" type="button">×</button></article>`;
    }).join('');
    return `<article class="preorder-stack" data-stack-id="${esc(stack.id)}"><header><input class="preorder-stack-name" data-stack-id="${esc(stack.id)}" value="${esc(stack.name)}" aria-label="Future TAG name"><span><b>${fmt(stackBoards)} PCS</b> · ${fmt(stackBf, 1)} BF</span><button class="danger preorder-remove-stack" data-stack-id="${esc(stack.id)}" type="button">×</button></header>${materialSummary ? `<div class="preorder-stack-materials">${materialSummary}</div>` : ''}<div class="preorder-stack-items">${items || '<div class="preorder-empty">Drag planned material here</div>'}</div></article>`;
  }).join('') : '<div class="empty-state">Add a future TAG stack, then place lengths into it.</div>';
  const customerMissing = customerOrder && !String(draft.customer || '').trim();
  $('preorderStatus').className = `calculation-status ${customerMissing ? 'pending' : Math.abs(delta) < 0.05 && target > 0 ? 'ready' : 'idle'}`;
  $('preorderStatus').textContent = customerMissing
    ? 'Enter the customer or project before treating this draft as a customer order.'
    : !customerOrder
      ? `Unassigned stock plan — ${fmt(selectedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0))} boards / ${fmt(selectedBf, 1)} BF grouped without a customer commitment.`
      : Math.abs(delta) < 0.05 && target > 0
        ? `Customer target matched: ${fmt(selectedBf, 1)} BF in ${fmt((draft.stacks || []).length)} future TAG stack(s).`
        : `Customer draft only — no physical inventory was moved. ${fmt(Math.abs(delta), 1)} BF ${delta < 0 ? 'over' : 'remaining to target'}.`;
  bindPreorderDynamicEvents();
}

function bindPreorderDynamicEvents() {
  document.querySelectorAll('.preorder-add-source').forEach((button) => button.addEventListener('click', () => {
    const row = button.closest('.preorder-source-row');
    addPreorderAllocation(row.dataset.lotId, row.querySelector('.preorder-source-qty').value, row.querySelector('.preorder-source-stack').value);
  }));
  document.querySelectorAll('.preorder-item-qty').forEach((input) => input.addEventListener('change', () => {
    const draft = activePreorder(); const found = findPreorderItem(draft, input.dataset.itemId); if (!found) return;
    const lot = productionLots().find((item) => item.id === found.item.lotId);
    found.item.quantity = Math.max(1, Math.min(Math.floor(Number(input.value || 1)), Math.max(1, Number(lot?.quantity || found.item.quantity) - preorderReserved(found.item.lotId, found.item.id))));
    savePreorder(draft); renderPreorderPlanner();
  }));
  document.querySelectorAll('.preorder-remove-item').forEach((button) => button.addEventListener('click', () => {
    const draft = activePreorder(); const found = findPreorderItem(draft, button.dataset.itemId); if (!found) return;
    found.stack.items = found.stack.items.filter((item) => item.id !== button.dataset.itemId); savePreorder(draft); renderPreorderPlanner();
  }));
  document.querySelectorAll('.preorder-stack-name').forEach((input) => input.addEventListener('change', () => {
    const draft = activePreorder(); const stack = draft.stacks.find((item) => item.id === input.dataset.stackId); if (!stack) return;
    stack.name = input.value.trim() || 'Future TAG'; savePreorder(draft); renderPreorderPlanner();
  }));
  document.querySelectorAll('.preorder-remove-stack').forEach((button) => button.addEventListener('click', () => {
    const draft = activePreorder(); const stack = draft.stacks.find((item) => item.id === button.dataset.stackId); if (!stack) return;
    if ((stack.items || []).length && !window.confirm('Delete this future TAG and return all planned boards to availability?')) return;
    draft.stacks = draft.stacks.filter((item) => item.id !== stack.id); savePreorder(draft); renderPreorderPlanner();
  }));
  document.querySelectorAll('.preorder-allocation').forEach((item) => item.addEventListener('dragstart', () => { draggedPreorderItemId = item.dataset.itemId; }));
  document.querySelectorAll('.preorder-stack').forEach((stackElement) => {
    stackElement.addEventListener('dragover', (event) => { event.preventDefault(); stackElement.classList.add('drag-over'); });
    stackElement.addEventListener('dragleave', () => stackElement.classList.remove('drag-over'));
    stackElement.addEventListener('drop', (event) => {
      event.preventDefault(); stackElement.classList.remove('drag-over');
      const draft = activePreorder(); const found = findPreorderItem(draft, draggedPreorderItemId); const destination = draft?.stacks?.find((item) => item.id === stackElement.dataset.stackId);
      if (!found || !destination || found.stack.id === destination.id) return;
      found.stack.items = found.stack.items.filter((item) => item.id !== found.item.id); destination.items ||= []; destination.items.push(found.item); savePreorder(draft); renderPreorderPlanner();
    });
  });
}

function recoveryTotals(records = currentRecoveries()) {
  const source = Object.fromEntries(LENGTHS.map((length) => [length, 0]));
  const output = Object.fromEntries(LENGTHS.map((length) => [length, 0]));
  let inputLinearFt = 0;
  let outputLinearFt = 0;
  records.forEach((record) => {
    source[record.sourceLength] += Number(record.quantity || 0);
    (record.outputs || []).forEach((length) => { output[length] += Number(record.quantity || 0); });
    inputLinearFt += Number(record.sourceLength || 0) * Number(record.quantity || 0);
    outputLinearFt += (record.outputs || []).reduce((sum, length) => sum + Number(length || 0), 0) * Number(record.quantity || 0);
  });
  return { source, output, inputLinearFt, outputLinearFt, wasteLinearFt: inputLinearFt - outputLinearFt };
}

function migrateLegacyTagRecoveries() {
  const tags = warehouseTags();
  const recoveries = recoveryOperations();
  const migratedTagIds = new Set(recoveries.map((record) => record.legacyTagId).filter(Boolean));
  let tagsChanged = false;
  let recoveriesChanged = false;
  tags.forEach((tag) => {
    if (!Array.isArray(tag.recoveryCuts) || !tag.recoveryCuts.length) return;
    if (!migratedTagIds.has(tag.id)) {
      tag.recoveryCuts.forEach((cut, index) => {
        const quantity = Number(cut.quantity || 0);
        const outputs = (cut.outputs || []).map(Number).filter(Boolean);
        const outputPerBoard = outputs.reduce((sum, length) => sum + length, 0);
        recoveries.push({
          id: `recovery-migrated-${tag.id}-${index}`,
          legacyTagId: tag.id,
          orderId: tag.orderId || 'legacy',
          productionOrderNumber: tag.productionOrderNumber || tag.orderNumber || '',
          sourceLength: Number(cut.sourceLength || 0),
          quantity,
          outputs,
          inputLinearFt: Number(cut.sourceLength || 0) * quantity,
          outputLinearFt: outputPerBoard * quantity,
          wasteLinearFt: (Number(cut.sourceLength || 0) - outputPerBoard) * quantity,
          createdAt: tag.date ? `${tag.date}T00:00:00.000Z` : new Date().toISOString(),
        });
      });
      recoveriesChanged = true;
    }
    tag.recoveryCuts = [];
    tag.sourceQuantities = { ...(tag.quantities || {}) };
    tag.directQuantities = { ...(tag.quantities || {}) };
    tag.sourceLoads = [];
    tagsChanged = true;
  });
  if (recoveriesChanged) write(RECOVERY_KEY, recoveries);
  if (tagsChanged) write(TAGS_KEY, tags);
}

function adjustedProcessedInventory(records = currentRecoveries()) {
  const processed = sumQuantities(completed());
  const recovery = recoveryTotals(records);
  return Object.fromEntries(LENGTHS.map((length) => [length, processed[length] - recovery.source[length] + recovery.output[length]]));
}

function availableForYard() {
  const processed = adjustedProcessedInventory();
  const tagged = sumQuantities(currentTags());
  const tested = sumQuantities(currentTests());
  return Object.fromEntries(LENGTHS.map((length) => [length, Math.max(0, processed[length] - tagged[length] - tested[length])]));
}

function sumSourceQuantities(records) {
  const totals = Object.fromEntries(LENGTHS.map((length) => [length, 0]));
  records.forEach((record) => LENGTHS.forEach((length) => { totals[length] += Number(sourceQuantities(record)?.[length] || 0); }));
  return totals;
}

function allocateSourceLoads(requested) {
  const priorTagged = sumSourceQuantities([...currentTags(), ...currentTests()]);
  const remainingPrior = { ...priorTagged };
  const sourceLoads = [];
  completed().forEach((record) => {
    const available = {};
    LENGTHS.forEach((length) => {
      const produced = Number(record.quantities?.[length] || 0);
      const consumed = Math.min(produced, remainingPrior[length] || 0);
      remainingPrior[length] = Math.max(0, (remainingPrior[length] || 0) - consumed);
      available[length] = produced - consumed;
    });
    const allocated = {};
    LENGTHS.forEach((length) => {
      const quantity = Math.min(available[length], requested[length] || 0);
      if (quantity > 0) allocated[length] = quantity;
      requested[length] = Math.max(0, (requested[length] || 0) - quantity);
    });
    if (totalBoards(allocated)) sourceLoads.push({ id: record.id, loadNumber: record.loadNumber, completedDate: record.completedDate, quantities: allocated });
  });
  return sourceLoads;
}

function completedHeader() {
  return `<thead><tr><th>Completed</th><th>Supplier</th><th>Marking</th><th>Material / quality</th>${LENGTHS.map((l) => `<th>${l}</th>`).join('')}<th>PCS</th><th>BFM</th><th>Action</th></tr></thead>`;
}
function tagHeader() {
  return `<thead><tr><th>TAG</th><th>ORDER #</th><th>PRODUCT / MO #</th><th>DATE</th><th>MATERIAL / QUALITY</th>${LENGTHS.map((l) => `<th>${l}</th>`).join('')}<th>PCS</th><th>BFM</th><th>Action</th></tr></thead>`;
}

function renderCompleted() {
  const records = completed();
  $('emptyCompleted').hidden = records.length > 0;
  const totals = sumQuantities(records);
  const rows = records.map((record) => `<tr><td><b>${esc(record.completedDate)}</b><small>Kiln Load ${record.loadNumber}</small></td><td>${esc(record.supplier)}</td><td>${esc(record.marking)}</td><td class="quality-lot-summary">${recordQualitySummary(record)}</td>${LENGTHS.map((l) => `<td>${record.quantities?.[l] ? fmt(record.quantities[l]) : ''}</td>`).join('')}<td><b>${fmt(record.boards)}</b></td><td>${fmt(record.bf, 1)}</td><td><button class="danger small-action delete-completed" type="button" data-id="${esc(record.id)}">Delete</button></td></tr>`).join('');
  const footer = `<tfoot><tr><th colspan="4">TOTAL PROCESSED</th>${LENGTHS.map((l) => `<th>${totals[l] ? fmt(totals[l]) : ''}</th>`).join('')}<th>${fmt(totalBoards(totals))}</th><th>${fmt(records.reduce((sum, record) => sum + Number(record.bf || 0), 0), 1)}</th><th></th></tr></tfoot>`;
  $('completedTable').innerHTML = `${completedHeader()}<tbody>${rows}</tbody>${footer}`;
  const order = activeOrder();
  const received = totalBoards(order?.inventory || {});
  const plannedCycles = Number(order?.plannedCycles || 0);
  const plannedBoards = Number(order?.plannedBoards || Math.max(0, received));
  const processed = totalBoards(totals);
  const unprocessed = Math.max(0, received - plannedBoards);
  const completion = plannedBoards > 0 ? processed / plannedBoards * 100 : 0;
  $('cycleCount').textContent = `${fmt(records.length)} / ${fmt(plannedCycles)}`;
  $('processedBoards').textContent = `${fmt(processed)} / ${fmt(plannedBoards)}`;
  $('processedFormula').textContent = `${fmt(received)} received − ${fmt(unprocessed)} unprocessed outside thermal cycles`;
  $('completionPercent').textContent = `${fmt(completion, 1)}%`;
  document.querySelectorAll('.delete-completed').forEach((button) => button.addEventListener('click', () => deleteCompletedRecord(button.dataset.id)));
  return totals;
}

function renderWarehouseTags() {
  const tags = currentTags();
  const processedTotals = adjustedProcessedInventory();
  const consumedTotals = sumQuantities(tags);
  const testedTotals = sumQuantities(currentTests());
  const available = Object.fromEntries(LENGTHS.map((length) => [length, Math.max(0, processedTotals[length] - consumedTotals[length] - testedTotals[length])]));
  const rows = tags.map((tag, rowIndex) => `<tr>
    <td><input data-field="tag" data-row="${rowIndex}" value="${esc(tag.tag)}" placeholder="TAG #"></td>
    <td><input data-field="orderNumber" data-row="${rowIndex}" value="${esc(tag.orderNumber)}" placeholder="ORDER #"></td>
    <td><input data-field="productMo" data-row="${rowIndex}" value="${esc(tag.productMo)}" placeholder="PRODUCT / MO #"></td>
    <td><input type="date" data-field="date" data-row="${rowIndex}" value="${esc(tag.date)}"></td>
    <td><b>${esc(tag.material || 'Unclassified material')}</b><small>${esc(qualityLabel(tag.quality))}</small>${tag.defectNote ? `<small>${esc(tag.defectNote)}</small>` : ''}</td>
    ${LENGTHS.map((length) => `<td><input class="matrix-qty" type="number" readonly aria-label="${length} ft finished quantity" value="${Number(tag.quantities?.[length] || 0) || ''}"></td>`).join('')}
    <td><b>${fmt(totalBoards(tag.quantities))}</b></td><td>${fmt(tagBf(tag), 1)}</td><td><button class="danger small-action delete-yard-tag" type="button" data-id="${esc(tag.id)}">Delete</button></td></tr>`).join('');
  const availableRow = `<tfoot><tr><th colspan="5">UNTAGGED PROCESSED INVENTORY</th>${LENGTHS.map((length) => `<th>${available[length] ? fmt(available[length]) : ''}</th>`).join('')}<th>${fmt(totalBoards(available))}</th><th>—</th><th></th></tr></tfoot>`;
  $('warehouseTagTable').innerHTML = `${tagHeader()}<tbody>${rows}</tbody>${availableRow}`;
  $('availableBoards').textContent = fmt(totalBoards(available));
  document.querySelectorAll('#warehouseTagTable input').forEach((input) => input.addEventListener('change', updateWarehouseTag));
  document.querySelectorAll('.delete-yard-tag').forEach((button) => button.addEventListener('click', () => deleteYardTag(button.dataset.id)));
  renderRecoveryStage();
  renderTestRegister();
  renderShippingSelection();
  renderOrderLedger();
  renderPreorderPlanner();
}

function updateWarehouseTag(event) {
  const allTags = warehouseTags();
  const tags = currentTags();
  const row = Number(event.target.dataset.row);
  const field = event.target.dataset.field;
  if (!tags[row]) return;
  tags[row][field] = event.target.value;
  const requiredMissing = ['tag', 'orderNumber', 'productMo', 'date'].some((key) => !String(tags[row][key] || '').trim());
  const duplicateTag = tags.some((tag, index) => index !== row && String(tag.tag || '').trim().toLowerCase() === String(tags[row].tag || '').trim().toLowerCase());
  const processedTotals = adjustedProcessedInventory();
  const requested = sumQuantities(tags);
  const over = LENGTHS.filter((length) => requested[length] > processedTotals[length]);
  if (requiredMissing || duplicateTag || over.length) {
    $('warehouseMessage').className = 'calculation-status pending';
    $('warehouseMessage').textContent = requiredMissing
      ? 'TAG, ORDER #, PRODUCT / MO # and DATE are required.'
      : duplicateTag
        ? 'TAG must be unique. This TAG already exists.'
        : `Not enough completed inventory at: ${over.map((length) => `${length} ft`).join(', ')}.`;
    return;
  }
  const globalIndex = allTags.findIndex((tag) => tag.id === tags[row].id);
  if (globalIndex >= 0) allTags[globalIndex] = tags[row];
  write(TAGS_KEY, allTags);
  $('warehouseMessage').className = 'calculation-status ready';
  $('warehouseMessage').textContent = 'YARD TAG saved.';
  renderWarehouseTags();
}

function deleteCompletedRecord(id) {
  const linkedTest = currentTests().find((record) => record.sourceCompletedId === id);
  if (linkedTest) {
    $('completedMessage').className = 'calculation-status pending';
    $('completedMessage').textContent = 'Cannot delete this completed cycle: finished boards from it are recorded in TEST. Delete the TEST record first.';
    return;
  }
  const candidateCompleted = completed().filter((record) => record.id !== id);
  const candidateProduced = sumQuantities(candidateCompleted);
  const recovery = recoveryTotals();
  const candidateFinished = Object.fromEntries(LENGTHS.map((length) => [length, candidateProduced[length] - recovery.source[length] + recovery.output[length]]));
  const tagged = sumQuantities(currentTags());
  const recoveryBlocked = LENGTHS.filter((length) => recovery.source[length] > candidateProduced[length]);
  const tagBlocked = LENGTHS.filter((length) => tagged[length] > candidateFinished[length]);
  if (recoveryBlocked.length || tagBlocked.length) {
    $('completedMessage').className = 'calculation-status pending';
    $('completedMessage').textContent = recoveryBlocked.length
      ? `Cannot delete this completed cycle: its ${recoveryBlocked.map((length) => `${length} ft`).join(', ')} boards are used by confirmed recovery cuts. Undo those cuts first.`
      : `Cannot delete this completed cycle: its finished ${tagBlocked.map((length) => `${length} ft`).join(', ')} inventory is assigned to a YARD TAG. Delete that TAG first.`;
    return;
  }
  if (!window.confirm('Delete this Completed Kiln Load record? This action cannot be undone.')) return;
  write(COMPLETED_KEY, allCompleted().filter((record) => record.id !== id));
  $('completedMessage').className = 'calculation-status ready';
  $('completedMessage').textContent = 'Incorrect Completed Kiln Load row deleted.';
  renderCompleted();
  renderWarehouseTags();
}

function deleteYardTag(id) {
  const usedByShipment = shipments().some((shipment) => (shipment.tagIds || []).includes(id));
  if (usedByShipment) {
    $('warehouseMessage').className = 'calculation-status pending';
    $('warehouseMessage').textContent = 'Cannot delete this YARD TAG: it is registered in a Shipping order. Delete that Shipping order first.';
    return;
  }
  if (!window.confirm('Delete this YARD TAG? Its boards will return to untagged processed inventory.')) return;
  write(TAGS_KEY, warehouseTags().filter((tag) => tag.id !== id));
  $('warehouseMessage').className = 'calculation-status ready';
  $('warehouseMessage').textContent = 'Incorrect YARD TAG row deleted; its boards were returned to available processed inventory.';
  renderWarehouseTags();
}

function openYardBuilder() {
  const available = availableForYard();
  const source = completed().at(-1) || {};
  const order = activeOrder();
  const qualityLots = completedQualityLots();
  const materialNames = [...new Set(qualityLots.map((lot) => String(lot.material || '').trim()).filter(Boolean))];
  $('yardTag').value = '';
  $('yardOrder').value = order?.number || '';
  $('yardProduct').value = source.marking || '';
  $('yardDate').value = new Date().toISOString().slice(0, 10);
  $('yardMaterial').innerHTML = materialNames.length
    ? materialNames.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')
    : '<option value="Unclassified material">Unclassified material</option>';
  $('yardQuality').value = qualityLots[0]?.quality || 'unclassified';
  $('yardDefectNote').value = '';
  const lotReference = qualityLots.map((lot) => `<span><b>${fmt(lot.quantity)} × ${fmt(lot.length)} ft</b>${esc(lot.material || 'Unclassified material')} · ${esc(qualityLabel(lot.quality))}</span>`).join('');
  $('yardAvailableSource').innerHTML = `${LENGTHS.filter((length) => available[length]).map((length) => `<span><b>${length} ft</b>${fmt(available[length])} finished boards</span>`).join('')}${lotReference ? `<div class="yard-quality-reference"><strong>Planned material / quality lots</strong>${lotReference}</div>` : ''}`;
  $('yardBuilderRows').innerHTML = LENGTHS.map((length) => `<tr><td><b>${length} ft</b></td><td>${fmt(available[length])}</td><td><input class="yard-build-qty" type="number" min="0" max="${available[length]}" data-length="${length}" value=""></td></tr>`).join('');
  $('yardDialogStatus').className = 'calculation-status idle';
  $('yardDialogStatus').textContent = totalBoards(available) ? `${fmt(totalBoards(available))} processed boards are available for YARD allocation.` : 'No unallocated completed boards are available.';
  $('yardTagDialog').showModal();
}

function addRecoveryCutRow(values = {}) {
  const row = document.createElement('tr');
  row.className = 'recovery-cut-row';
  row.innerHTML = `<td><select class="recovery-source">${LENGTHS.map((length) => `<option value="${length}" ${Number(values.sourceLength) === length ? 'selected' : ''}>${length} ft</option>`).join('')}</select></td>
    <td><input class="recovery-qty" type="number" min="1" step="1" value="${Number(values.quantity) || 1}"></td>
    ${[0, 1, 2].map((index) => `<td><select class="recovery-output"><option value="">—</option>${LENGTHS.map((length) => `<option value="${length}" ${Number(values.outputs?.[index]) === length ? 'selected' : ''}>${length} ft</option>`).join('')}</select></td>`).join('')}
    <td><output class="recovery-loss">—</output></td><td><button class="danger small-action remove-recovery" type="button">Delete</button></td>`;
  row.querySelectorAll('input, select').forEach((input) => input.addEventListener('input', updateRecoveryBalance));
  row.querySelector('.remove-recovery').addEventListener('click', () => { row.remove(); updateRecoveryBalance(); });
  $('recoveryCutRows').appendChild(row);
  updateRecoveryBalance();
}

function readRecoveryCuts() {
  return [...document.querySelectorAll('.recovery-cut-row')].map((row) => ({
    sourceLength: Number(row.querySelector('.recovery-source').value),
    quantity: Math.max(0, Math.floor(Number(row.querySelector('.recovery-qty').value) || 0)),
    outputs: [...row.querySelectorAll('.recovery-output')].map((input) => Number(input.value)).filter(Boolean),
  }));
}

function recoveryMetrics(cuts) {
  const source = Object.fromEntries(LENGTHS.map((length) => [length, 0]));
  const output = Object.fromEntries(LENGTHS.map((length) => [length, 0]));
  let inputLinearFt = 0;
  let outputLinearFt = 0;
  const errors = [];
  cuts.forEach((cut, index) => {
    const outputPerBoard = cut.outputs.reduce((sum, length) => sum + length, 0);
    if (!cut.quantity || !cut.outputs.length) errors.push(`Recovery row ${index + 1} needs quantity and at least one output length.`);
    if (outputPerBoard > cut.sourceLength) errors.push(`Recovery row ${index + 1} outputs ${outputPerBoard} ft from a ${cut.sourceLength} ft board.`);
    if (cut.outputs.some((length) => length >= cut.sourceLength)) errors.push(`Recovery row ${index + 1} must produce only lengths shorter than the ${cut.sourceLength} ft source board.`);
    source[cut.sourceLength] += cut.quantity;
    cut.outputs.forEach((length) => { output[length] += cut.quantity; });
    inputLinearFt += cut.sourceLength * cut.quantity;
    outputLinearFt += outputPerBoard * cut.quantity;
  });
  return { source, output, inputLinearFt, outputLinearFt, wasteLinearFt: inputLinearFt - outputLinearFt, errors };
}

function updateRecoveryBalance() {
  const cuts = readRecoveryCuts();
  const metrics = recoveryMetrics(cuts);
  [...document.querySelectorAll('.recovery-cut-row')].forEach((row, index) => {
    const cut = cuts[index];
    const outputPerBoard = cut.outputs.reduce((sum, length) => sum + length, 0);
    const loss = cut.sourceLength - outputPerBoard;
    const target = row.querySelector('.recovery-loss');
    target.textContent = cut.outputs.length ? `${fmt(loss)} ft` : '—';
    target.className = `recovery-loss ${loss < 0 ? 'bad' : ''}`;
  });
  $('recoveryBalance').className = `recovery-balance ${metrics.errors.length ? 'bad' : ''}`;
  $('recoveryBalance').textContent = cuts.length
    ? `${fmt(totalBoards(metrics.source))} source boards · ${fmt(metrics.inputLinearFt)} input ft → ${fmt(totalBoards(metrics.output))} recovered pieces · ${fmt(metrics.outputLinearFt)} useful ft + ${fmt(metrics.wasteLinearFt)} removed ft.`
    : 'No pending recovery cuts.';
}

function applyRecoveryCuts() {
  const cuts = readRecoveryCuts();
  const metrics = recoveryMetrics(cuts);
  const available = availableForYard();
  const invalid = LENGTHS.filter((length) => metrics.source[length] > available[length]);
  if (!cuts.length || metrics.errors.length || invalid.length) {
    $('recoveryMessage').className = 'calculation-status pending';
    $('recoveryMessage').textContent = !cuts.length
      ? 'Add at least one recovery cut.'
      : metrics.errors[0] || `Not enough untagged source boards at: ${invalid.map((length) => `${length} ft`).join(', ')}.`;
    return;
  }
  const order = activeOrder();
  const records = recoveryOperations();
  const stamp = Date.now();
  cuts.forEach((cut, index) => records.push({
    id: `recovery-${stamp}-${index}`,
    orderId: order?.id || order?.planSignature || 'legacy',
    productionOrderNumber: order?.number || '',
    sourceLength: cut.sourceLength,
    quantity: cut.quantity,
    outputs: cut.outputs,
    inputLinearFt: cut.sourceLength * cut.quantity,
    outputLinearFt: cut.outputs.reduce((sum, length) => sum + length, 0) * cut.quantity,
    wasteLinearFt: (cut.sourceLength - cut.outputs.reduce((sum, length) => sum + length, 0)) * cut.quantity,
    createdAt: new Date().toISOString(),
  }));
  write(RECOVERY_KEY, records);
  $('recoveryCutRows').innerHTML = '';
  updateRecoveryBalance();
  $('recoveryMessage').className = 'calculation-status ready';
  $('recoveryMessage').textContent = 'Recovery applied. Finished inventory was recalculated before TAG creation.';
  renderWarehouseTags();
}

function deleteRecoveryOperation(id) {
  const remaining = currentRecoveries().filter((record) => record.id !== id);
  const candidate = adjustedProcessedInventory(remaining);
  const tagged = sumQuantities(currentTags());
  const tested = sumQuantities(currentTests());
  const blocked = LENGTHS.filter((length) => tagged[length] + tested[length] > candidate[length]);
  if (blocked.length) {
    $('recoveryMessage').className = 'calculation-status pending';
    $('recoveryMessage').textContent = `Cannot undo this cut: its finished ${blocked.map((length) => `${length} ft`).join(', ')} product is already assigned to a TAG or TEST record.`;
    return;
  }
  if (!window.confirm('Undo this recovery cut and restore its source boards?')) return;
  write(RECOVERY_KEY, recoveryOperations().filter((record) => record.id !== id));
  $('recoveryMessage').className = 'calculation-status ready';
  $('recoveryMessage').textContent = 'Recovery cut removed; source and finished inventory were recalculated.';
  renderWarehouseTags();
}

function renderRecoveryStage() {
  const records = currentRecoveries();
  const original = sumQuantities(completed());
  const recovery = recoveryTotals(records);
  const adjusted = adjustedProcessedInventory(records);
  const tagged = sumQuantities(currentTags());
  const tested = sumQuantities(currentTests());
  const available = Object.fromEntries(LENGTHS.map((length) => [length, Math.max(0, adjusted[length] - tagged[length] - tested[length])]));
  $('recoveryHistory').innerHTML = records.length ? records.map((record) => `<article><span><b>${fmt(record.quantity)} × ${record.sourceLength} ft</b><small>${esc(record.createdAt?.slice(0, 10) || '')}</small></span><strong>→ ${(record.outputs || []).join(' + ')} ft</strong><span>${fmt(record.outputLinearFt)} useful ft · ${fmt(record.wasteLinearFt)} removed ft</span><button class="danger small-action delete-recovery" type="button" data-id="${esc(record.id)}">Undo</button></article>`).join('') : '<div class="empty-state">No confirmed recovery cuts. Processed inventory still matches kiln output.</div>';
  const visible = LENGTHS.filter((length) => original[length] || recovery.source[length] || recovery.output[length] || tagged[length]);
  $('recoveryInventoryTable').innerHTML = `<thead><tr><th>Length</th><th>Kiln output</th><th>Cut out</th><th>Recovered</th><th>Actual finished</th><th>TEST</th><th>TAG assigned</th><th>Available</th></tr></thead><tbody>${visible.map((length) => `<tr><td><b>${length} ft</b></td><td>${fmt(original[length])}</td><td>${fmt(recovery.source[length])}</td><td>${fmt(recovery.output[length])}</td><td><b>${fmt(adjusted[length])}</b></td><td>${fmt(tested[length])}</td><td>${fmt(tagged[length])}</td><td><b>${fmt(available[length])}</b></td></tr>`).join('')}</tbody><tfoot><tr><th>TOTAL PIECES</th><th>${fmt(totalBoards(original))}</th><th>${fmt(totalBoards(recovery.source))}</th><th>${fmt(totalBoards(recovery.output))}</th><th>${fmt(totalBoards(adjusted))}</th><th>${fmt(totalBoards(tested))}</th><th>${fmt(totalBoards(tagged))}</th><th>${fmt(totalBoards(available))}</th></tr><tr><th>FOOTAGE BALANCE</th><th colspan="7">${fmt(recovery.inputLinearFt)} input ft = ${fmt(recovery.outputLinearFt)} recovered ft + ${fmt(recovery.wasteLinearFt)} removed ft</th></tr></tfoot>`;
  document.querySelectorAll('.delete-recovery').forEach((button) => button.addEventListener('click', () => deleteRecoveryOperation(button.dataset.id)));
}

function testAvailableForCompleted(record) {
  const available = Object.fromEntries(LENGTHS.map((length) => [length, Number(record?.quantities?.[length] || 0)]));
  [...currentTags(), ...currentTests()].forEach((item) => {
    (item.sourceLoads || []).filter((source) => source.id === record?.id).forEach((source) => {
      LENGTHS.forEach((length) => { available[length] = Math.max(0, available[length] - Number(source.quantities?.[length] || 0)); });
    });
    if (item.sourceCompletedId === record?.id && !(item.sourceLoads || []).length) {
      LENGTHS.forEach((length) => { available[length] = Math.max(0, available[length] - Number(item.quantities?.[length] || 0)); });
    }
  });
  return available;
}

function updateTestSourceFields({ resetProduct = false } = {}) {
  const source = completed().find((record) => record.id === $('testSourceLoad').value);
  const previousLength = Number($('testLength').value);
  const sourceAvailable = testAvailableForCompleted(source);
  const aggregateAvailable = availableForYard();
  const options = LENGTHS.filter((length) => Math.min(sourceAvailable[length], aggregateAvailable[length]) > 0)
    .map((length) => `<option value="${length}">${length} ft · ${fmt(Math.min(sourceAvailable[length], aggregateAvailable[length]))} available</option>`).join('');
  $('testLength').innerHTML = options || '<option value="">No unallocated boards in this cycle</option>';
  if ([...$('testLength').options].some((option) => Number(option.value) === previousLength)) $('testLength').value = String(previousLength);
  if (resetProduct && source) $('testProduct').value = source.marking || source.species || '';
  $('testQuantity').max = options ? Math.min(sourceAvailable[Number($('testLength').value)] || 0, aggregateAvailable[Number($('testLength').value)] || 0) : 0;
}

function renderTestRegister() {
  const records = currentTests();
  const sources = completed();
  const previousSource = $('testSourceLoad').value;
  $('testSourceLoad').innerHTML = sources.length
    ? sources.map((record) => `<option value="${esc(record.id)}">Kiln Load ${fmt(record.loadNumber)} · ${esc(record.completedDate || 'date unknown')} · ${esc(record.marking || record.species || 'product')}</option>`).join('')
    : '<option value="">No completed kiln cycles</option>';
  if (sources.some((record) => record.id === previousSource)) $('testSourceLoad').value = previousSource;
  updateTestSourceFields({ resetProduct: !$('testProduct').value });
  $('testBoardForm').querySelector('button[type="submit"]').disabled = !sources.length || !$('testLength').value;
  $('testBoardHistory').innerHTML = records.length ? records.slice().reverse().map((record) => {
    const drying = record.dryingProgram || activeOrder()?.dryingPrograms?.[record.loadNumber];
    const thermo = record.thermoProgram || activeOrder()?.thermoPrograms?.[record.loadNumber];
    return `<article class="test-board-record">
      <header><span><b>${fmt(record.quantity)} × ${fmt(record.length)} ft · ${esc(record.product || 'Test sample')}</b><small>Kiln Load ${fmt(record.loadNumber)} · produced ${esc(record.completedDate || '—')} · taken ${esc(record.date || '—')}</small><small>${esc(record.note || 'No research note')}</small></span><strong>TEST · ${esc(record.takenBy || '—')}</strong><button class="danger small-action delete-test-record" type="button" data-id="${esc(record.id)}">Delete</button></header>
      <details><summary>Production settings used for this test material</summary><div class="test-program-grid"><section><h4>Drying program</h4>${dryingProgramTable(drying)}</section><section><h4>Thermo Vacuum (TM)</h4>${thermoProgramTable(thermo)}</section></div></details>
    </article>`;
  }).join('') : '<div class="empty-state">No finished boards have been recorded as TEST samples.</div>';
  document.querySelectorAll('.delete-test-record').forEach((button) => button.addEventListener('click', () => deleteTestRecord(button.dataset.id)));
}

function saveTestRecord(event) {
  event.preventDefault();
  const order = activeOrder();
  const source = completed().find((record) => record.id === $('testSourceLoad').value);
  const length = Number($('testLength').value);
  const quantity = Math.floor(Number($('testQuantity').value));
  const sourceAvailable = testAvailableForCompleted(source);
  const aggregateAvailable = availableForYard();
  const maximum = Math.min(Number(sourceAvailable[length] || 0), Number(aggregateAvailable[length] || 0));
  const product = $('testProduct').value.trim();
  const takenBy = $('testTakenBy').value.trim();
  const date = $('testDate').value;
  if (!source || !length || quantity < 1 || quantity > maximum || !product || !takenBy || !date) {
    $('testBoardStatus').className = 'calculation-status pending';
    $('testBoardStatus').textContent = !source
      ? 'Select a completed production cycle.'
      : quantity > maximum
        ? `Only ${fmt(maximum)} unallocated ${fmt(length)} ft boards from this cycle are available.`
        : 'Complete the source cycle, length, quantity, date, person and product fields.';
    return;
  }
  const records = testBoardRecords();
  const quantities = { [length]: quantity };
  records.push({
    id: `test-${Date.now()}`,
    orderId: order?.id || source.orderId || 'legacy',
    productionOrderNumber: order?.number || source.orderNumber || '',
    sourceCompletedId: source.id,
    sourceLoads: [{ id: source.id, loadNumber: source.loadNumber, completedDate: source.completedDate, quantities }],
    sourceQuantities: quantities,
    quantities,
    loadNumber: Number(source.loadNumber),
    completedDate: source.completedDate || '',
    length,
    quantity,
    product,
    material: source.species || source.marking || '',
    takenBy,
    date,
    note: $('testNote').value.trim(),
    dryingProgram: cloneForArchive(source.dryingProgram || order?.dryingPrograms?.[source.loadNumber] || null),
    thermoProgram: cloneForArchive(source.thermoProgram || order?.thermoPrograms?.[source.loadNumber] || null),
    createdAt: new Date().toISOString(),
  });
  write(TEST_BOARDS_KEY, records);
  $('testQuantity').value = '1';
  $('testNote').value = '';
  $('testBoardStatus').className = 'calculation-status ready';
  $('testBoardStatus').textContent = `${fmt(quantity)} finished ${fmt(length)} ft board${quantity === 1 ? '' : 's'} recorded as TEST and removed from TAG availability.`;
  renderTestRegister();
  renderWarehouseTags();
}

function deleteTestRecord(id) {
  const record = currentTests().find((item) => item.id === id);
  if (!record || !window.confirm(`Delete this TEST record and return ${fmt(record.quantity)} boards to untagged finished inventory?`)) return;
  write(TEST_BOARDS_KEY, testBoardRecords().filter((item) => item.id !== id));
  $('testBoardStatus').className = 'calculation-status ready';
  $('testBoardStatus').textContent = 'TEST record deleted; its boards returned to untagged finished inventory.';
  renderTestRegister();
  renderWarehouseTags();
}

function createYardTag(event) {
  event.preventDefault();
  const order = activeOrder();
  const available = availableForYard();
  const directQuantities = {};
  document.querySelectorAll('.yard-build-qty').forEach((input) => { directQuantities[input.dataset.length] = Math.max(0, Math.floor(Number(input.value) || 0)); });
  const quantities = { ...directQuantities };
  const tagValue = $('yardTag').value.trim();
  const selectedMaterial = $('yardMaterial').value.trim();
  const missingFields = !tagValue || !$('yardOrder').value.trim() || !$('yardProduct').value.trim() || !$('yardDate').value || !selectedMaterial;
  const duplicateTag = warehouseTags().some((tag) => String(tag.tag || '').trim().toLowerCase() === tagValue.toLowerCase());
  const selectedLengths = LENGTHS.filter((length) => quantities[length] > 0);
  const invalid = LENGTHS.filter((length) => quantities[length] > available[length]);
  if (missingFields || duplicateTag || invalid.length || selectedLengths.length !== 1) {
    $('yardDialogStatus').className = 'calculation-status pending';
    $('yardDialogStatus').textContent = missingFields
      ? 'Complete TAG, ORDER #, PRODUCT / MO #, DATE and MATERIAL.'
      : duplicateTag
        ? 'This TAG already exists. Enter a unique TAG.'
        : invalid.length
          ? `Quantity exceeds completed inventory at ${invalid.map((length) => `${length} ft`).join(', ')}.`
          : 'Each YARD TAG must contain exactly one finished board length.';
    return;
  }
  const source = completed().at(-1) || {};
  const inputLinearFt = totalLinearFeet(quantities);
  const tags = warehouseTags();
  tags.push({
    id: `tag-${Date.now()}`,
    orderId: order?.id || source.orderId || 'legacy',
    productionOrderNumber: order?.number || source.orderNumber || '',
    tag: tagValue,
    orderNumber: $('yardOrder').value.trim(),
    productMo: $('yardProduct').value.trim(),
    date: $('yardDate').value,
    supplier: source.supplier || '',
    marking: source.marking || '',
    size: source.size || '',
    material: selectedMaterial,
    quality: $('yardQuality').value,
    defectNote: $('yardDefectNote').value.trim(),
    directQuantities: quantities,
    recoveryCuts: [],
    sourceQuantities: quantities,
    quantities,
    inputLinearFt,
    outputLinearFt: inputLinearFt,
    wasteLinearFt: 0,
    sourceLoads: allocateSourceLoads({ ...quantities }),
  });
  write(TAGS_KEY, tags);
  $('yardTagDialog').close();
  $('warehouseMessage').className = 'calculation-status ready';
  $('warehouseMessage').textContent = 'YARD lift assembled from completed inventory and TAG assigned.';
  renderWarehouseTags();
}

function renderShippingSelection() {
  const sentTagIds = new Set(currentShipments().flatMap((shipment) => shipment.tagIds || []));
  const tags = currentTags();
  $('shippingTagSelection').innerHTML = tags.length ? tags.map((tag, index) => `<label class="tag-option ${sentTagIds.has(tag.id) ? 'is-shipped' : ''}"><input type="checkbox" value="${esc(tag.id)}" ${sentTagIds.has(tag.id) ? 'disabled' : ''}><span><b>${esc(tag.tag || `Untagged row ${index + 1}`)}</b><small>${fmt(totalBoards(tag.quantities))} PCS · ${fmt(tagBf(tag), 1)} BFM · ${esc(tag.productMo || 'No product/MO')}</small><small>${esc(tag.material || 'Unclassified material')} · ${esc(qualityLabel(tag.quality))}</small></span></label>`).join('') : '<div class="empty-state">Create YARD TAGs before forming a shipping order.</div>';
  $('shipmentHistory').innerHTML = currentShipments().map((shipment) => {
    const tagNames = (shipment.tagIds || []).map((id) => tags.find((tag) => tag.id === id)?.tag || id);
    return `<article><b>${esc(shipment.orderNumber)}</b><span>${esc(shipment.date)}</span><span>${tagNames.map(esc).join(', ')}</span><span>${fmt(shipment.boards)} PCS · ${fmt(shipment.bf, 1)} BFM</span><button class="danger small-action delete-shipment" type="button" data-id="${esc(shipment.id)}">Delete</button></article>`;
  }).join('');
  document.querySelectorAll('.delete-shipment').forEach((button) => button.addEventListener('click', () => deleteShipment(button.dataset.id)));
}

function deleteShipment(id) {
  if (!window.confirm('Delete this Shipping order? Its YARD TAGs will become available for shipping again.')) return;
  write(SHIPMENTS_KEY, shipments().filter((shipment) => shipment.id !== id));
  $('shipmentMessage').className = 'calculation-status ready';
  $('shipmentMessage').textContent = 'Incorrect Shipping order deleted; its YARD TAGs are available again.';
  renderShippingSelection();
}

function orderLedger() {
  const order = activeOrder();
  if (!order) return null;
  const incoming = Object.fromEntries(LENGTHS.map((length) => [length, Number(order.inventory?.[length] || 0)]));
  const done = sumQuantities(completed());
  const recovery = recoveryTotals();
  const finished = adjustedProcessedInventory();
  const tags = currentTags();
  const tested = sumQuantities(currentTests());
  const allocated = sumQuantities(tags);
  const yard = sumQuantities(tags);
  const shippedIds = new Set(currentShipments().flatMap((shipment) => shipment.tagIds || []));
  const shipped = sumQuantities(tags.filter((tag) => shippedIds.has(tag.id)));
  const rows = LENGTHS.map((length) => ({
    length, incoming: incoming[length], processed: done[length],
    unprocessed: incoming[length] - done[length], recoveryOut: recovery.source[length], recoveryIn: recovery.output[length], finished: finished[length], tested: tested[length], allocated: allocated[length], yard: yard[length],
    awaitingTag: finished[length] - allocated[length] - tested[length], shipped: shipped[length],
    inYard: yard[length] - shipped[length],
  }));
  return { order, rows, incoming: totalBoards(incoming), processed: totalBoards(done), finished: totalBoards(finished), tested: totalBoards(tested), allocated: totalBoards(allocated), yard: totalBoards(yard), shipped: totalBoards(shipped), allocatedInputFt: recovery.inputLinearFt, yardOutputFt: recovery.outputLinearFt, removedFt: recovery.wasteLinearFt };
}

function renderOrderLedger() {
  const ledger = orderLedger();
  const button = $('completeOrder');
  if (!ledger) {
    $('activeOrderTitle').textContent = 'No active order';
    $('orderLedger').innerHTML = '';
    $('orderBalanceStatus').textContent = 'Create and calculate an order in the planner.';
    button.disabled = true;
    renderOrderArchive();
    return;
  }
  $('activeOrderTitle').textContent = `${ledger.order.number} · ${ledger.order.inputs?.supplier || 'Supplier not entered'}`;
  const negatives = ledger.rows.some((row) => row.unprocessed < 0 || row.finished < 0 || row.awaitingTag < 0 || row.inYard < 0);
  const footageBalanced = Math.abs(ledger.allocatedInputFt - ledger.yardOutputFt - ledger.removedFt) < 0.001;
  const finishedCycles = completed().length;
  const plannedCycles = Number(ledger.order.plannedCycles || 0);
  const allCyclesDone = plannedCycles > 0 && finishedCycles === plannedCycles;
  const allProcessedAllocated = ledger.rows.every((row) => row.awaitingTag === 0);
  const allTagsShipped = ledger.rows.every((row) => row.inYard === 0);
  const canComplete = !negatives && footageBalanced && allCyclesDone && allProcessedAllocated && allTagsShipped;
  button.disabled = !canComplete;
  $('orderBalanceStatus').className = `calculation-status ${negatives || !footageBalanced ? 'pending' : 'ready'}`;
  $('orderBalanceStatus').textContent = negatives || !footageBalanced
    ? 'BALANCE ERROR: source-board allocation or recovery footage does not reconcile.'
    : `Verified: ${ledger.incoming} received = ${ledger.processed} processed + ${ledger.incoming - ledger.processed} unprocessed. YARD recovery balance: ${fmt(ledger.allocatedInputFt)} input ft = ${fmt(ledger.yardOutputFt)} useful ft + ${fmt(ledger.removedFt)} removed ft. ${ledger.tested} finished pieces recorded as TEST; ${ledger.yard} assigned to YARD; ${ledger.shipped} shipped. Completed cycles: ${finishedCycles}/${plannedCycles || '—'}.`;
  const visible = ledger.rows.filter((row) => row.incoming || row.processed || row.recoveryOut || row.recoveryIn || row.tested || row.yard || row.shipped);
  $('orderLedger').innerHTML = `<thead><tr><th>Length</th><th>Received</th><th>Kiln processed</th><th>Unprocessed</th><th>Cut out</th><th>Recovered</th><th>Actual finished</th><th>TEST</th><th>Awaiting TAG</th><th>YARD</th><th>Shipped</th><th>In YARD</th><th>Check</th></tr></thead><tbody>${visible.map((row) => { const invalid = row.unprocessed < 0 || row.finished < 0 || row.awaitingTag < 0 || row.inYard < 0; return `<tr><td>${row.length} ft</td><td>${fmt(row.incoming)}</td><td>${fmt(row.processed)}</td><td>${fmt(row.unprocessed)}</td><td>${fmt(row.recoveryOut)}</td><td>${fmt(row.recoveryIn)}</td><td><b>${fmt(row.finished)}</b></td><td>${fmt(row.tested)}</td><td>${fmt(row.awaitingTag)}</td><td>${fmt(row.yard)}</td><td>${fmt(row.shipped)}</td><td>${fmt(row.inYard)}</td><td class="${invalid ? 'bad' : 'ok'}">${invalid ? 'ERROR' : '✓'}</td></tr>`; }).join('')}</tbody><tfoot><tr><th>TOTAL PIECES</th><th>${fmt(ledger.incoming)}</th><th>${fmt(ledger.processed)}</th><th>${fmt(ledger.incoming-ledger.processed)}</th><th>—</th><th>—</th><th>${fmt(ledger.finished)}</th><th>${fmt(ledger.tested)}</th><th>${fmt(ledger.finished-ledger.allocated-ledger.tested)}</th><th>${fmt(ledger.yard)}</th><th>${fmt(ledger.shipped)}</th><th>${fmt(ledger.yard-ledger.shipped)}</th><th>${negatives || !footageBalanced ? 'ERROR' : 'BALANCED'}</th></tr></tfoot>`;
  renderOrderArchive();
}

function renderOrderArchive() {
  const records = read(ORDER_ARCHIVE_KEY);
  $('orderArchive').innerHTML = records.length ? records.map((record) => {
    const rows = record.rows || [];
    const tags = record.tags || [];
    const tests = record.tests || [];
    const shipmentRows = record.shipments || [];
    const quantities = rows.filter((row) => row.incoming || row.processed || row.shipped).map((row) => `<tr><td>${fmt(row.length)} ft</td><td>${fmt(row.incoming)}</td><td>${fmt(row.processed)}</td><td>${fmt(row.finished)}</td><td>${fmt(row.shipped)}</td><td>${fmt(row.unprocessed)}</td></tr>`).join('');
    const tagRows = tags.map((tag) => `<tr><td>${esc(tag.tag)}</td><td>${esc(tag.productMo)}</td><td>${esc(tag.date)}</td><td><b>${esc(tag.material || 'Unclassified material')}</b><small>${esc(qualityLabel(tag.quality))}</small></td><td>${Object.entries(tag.quantities || {}).filter(([, quantity]) => Number(quantity) > 0).map(([length, quantity]) => `${fmt(quantity)} × ${esc(length)} ft`).join(', ')}</td><td>${fmt(totalBoards(tag.quantities))}</td><td>${fmt(tagBf(tag), 1)}</td></tr>`).join('');
    const testRows = tests.map((test) => `<tr><td>${esc(test.date)}</td><td>${esc(test.takenBy)}</td><td>${esc(test.product)}</td><td>Kiln Load ${fmt(test.loadNumber)} · ${esc(test.completedDate)}</td><td>${fmt(test.quantity)} × ${fmt(test.length)} ft</td><td>${esc(test.note || '—')}</td></tr>`).join('');
    const shipmentDetails = shipmentRows.map((shipment) => { const names = (shipment.tagIds || []).map((id) => tags.find((tag) => tag.id === id)?.tag || id); return `<tr><td>${esc(shipment.orderNumber)}</td><td>${esc(shipment.date)}</td><td>${names.map(esc).join(', ')}</td><td>${fmt(shipment.boards)}</td><td>${fmt(shipment.bf, 1)}</td></tr>`; }).join('');
    return `<details class="archived-order"><summary><b>${esc(record.number)}</b><span>${esc(record.completedAt.slice(0,10))}</span><span>${fmt(record.received)} received · ${fmt(record.shipped)} shipped</span><span>${fmt(tags.length)} TAGs · ${fmt(tests.length)} TEST · ${fmt(shipmentRows.length)} shipments</span></summary><div class="archive-content"><p><b>Supplier:</b> ${esc(record.supplier || '—')} · <b>Final process date:</b> ${esc(record.finalProcessDate || '—')} · <b>Removed footage:</b> ${fmt(record.removedFt)} ft</p><table class="archive-table"><thead><tr><th>Length</th><th>Received</th><th>Kiln processed</th><th>Finished</th><th>Shipped</th><th>Unprocessed</th></tr></thead><tbody>${quantities}</tbody></table><h4>TEST samples</h4><table class="archive-table"><thead><tr><th>Date</th><th>Taken by</th><th>Product</th><th>Production period</th><th>Contents</th><th>Purpose</th></tr></thead><tbody>${testRows || '<tr><td colspan="6">No TEST records</td></tr>'}</tbody></table><h4>YARD TAGs</h4><table class="archive-table"><thead><tr><th>TAG</th><th>Product / MO</th><th>Date</th><th>Material / quality</th><th>Contents</th><th>PCS</th><th>BFM</th></tr></thead><tbody>${tagRows || '<tr><td colspan="7">No TAG records</td></tr>'}</tbody></table><h4>Shipping orders</h4><table class="archive-table"><thead><tr><th>Shipping #</th><th>Date</th><th>TAGs</th><th>PCS</th><th>BFM</th></tr></thead><tbody>${shipmentDetails || '<tr><td colspan="5">No Shipping records</td></tr>'}</tbody></table><p><b>Saved kiln programs:</b> ${fmt(Object.keys(record.dryingPrograms || {}).length)} Drying · ${fmt(Object.keys(record.thermoPrograms || {}).length)} Thermo Vacuum.</p></div></details>`;
  }).join('') : '<div class="empty-state">No completed orders yet.</div>';
}

function dryingProgramTable(program) {
  const rows = program?.rows || [];
  if (!rows.length) return '<p class="program-empty">No saved Drying program.</p>';
  return `<table class="process-setting-table"><thead><tr><th>Phase</th><th>MC, %</th><th>mBar</th><th>Temp, °C</th><th>EMC, %</th><th>Gradient</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.phase)}</td><td>${fmt(row.mc, 1)}</td><td>${fmt(row.mbar, 1)}</td><td>${fmt(row.temp, 1)}</td><td>${Number.isFinite(Number(row.emc)) ? fmt(row.emc, 2) : '—'}</td><td>${Number.isFinite(Number(row.gradient)) ? fmt(row.gradient, 2) : '—'}</td></tr>`).join('')}</tbody></table>`;
}

function thermoProgramTable(program) {
  const rows = program?.rows || [];
  if (!rows.length) return '<p class="program-empty">No saved Thermo Vacuum program.</p>';
  return `<table class="process-setting-table"><thead><tr><th>Stage</th><th>Control setpoint</th><th>Target temp, °C</th><th>Duration, min</th><th>Operator note</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.stage)}</td><td>${fmt(row.setpoint)}</td><td>${fmt(row.temp)}</td><td>${fmt(row.duration)}</td><td>${esc(row.note)}</td></tr>`).join('')}</tbody></table>`;
}

function renderKilnSettingsReport() {
  const order = activeOrder();
  const drying = order?.dryingPrograms || {};
  const thermo = order?.thermoPrograms || {};
  const loadNumbers = [...new Set([...Object.keys(drying), ...Object.keys(thermo)])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  $('kilnSettingsReportBody').innerHTML = loadNumbers.length ? loadNumbers.map((loadNumber) => `<article class="process-program-card"><div class="process-program-heading"><h3>Kiln Load ${loadNumber}</h3><span>Order ${esc(order?.number || '—')} · ${esc(order?.inputs?.supplier || '—')}</span></div><div class="process-program-grid"><section><h4>Drying program</h4>${dryingProgramTable(drying[loadNumber])}</section><section><h4>Thermo Vacuum (TM)</h4>${thermoProgramTable(thermo[loadNumber])}</section></div></article>`).join('') : '<div class="empty-state">No saved Drying or Thermo Vacuum settings for this order.</div>';
}

function cloneForArchive(value) {
  return JSON.parse(JSON.stringify(value));
}

function saveOrderRemainder(ledger, completedAt) {
  const quantities = Object.fromEntries(
    ledger.rows
      .filter((row) => Number(row.unprocessed || 0) > 0)
      .map((row) => [row.length, Number(row.unprocessed)])
  );
  if (!Object.keys(quantities).length) return;
  const parsed = dimensions(ledger.order.inputs?.size);
  const thickness = parsed.thickness || Number(ledger.order.inputs?.actualT || 0);
  const width = parsed.width || Number(ledger.order.inputs?.actualW || 0);
  const boards = totalBoards(quantities);
  const bf = LENGTHS.reduce(
    (sum, length) => sum + thickness * width * length * Number(quantities[length] || 0) / 12,
    0
  );
  const records = read(REMAINDER_INVENTORY_KEY);
  const record = {
    id: ledger.order.id,
    orderNumber: ledger.order.number,
    supplier: ledger.order.inputs?.supplier || '',
    product: [ledger.order.inputs?.species, ledger.order.inputs?.size].filter(Boolean).join(' · '),
    species: ledger.order.inputs?.species || '',
    size: ledger.order.inputs?.size || '',
    actualT: Number(ledger.order.inputs?.actualT || 0),
    actualW: Number(ledger.order.inputs?.actualW || 0),
    quantities,
    boards,
    bf,
    completedAt,
  };
  const position = records.findIndex((item) => item.id === record.id);
  if (position >= 0) records[position] = record; else records.push(record);
  write(REMAINDER_INVENTORY_KEY, records);
}

function completeActiveOrder() {
  const ledger = orderLedger();
  if (!ledger || $('completeOrder').disabled) return;
  if (!window.confirm(`Before closing ${ledger.order.number}, save both “Kiln settings PDF” and “Full order PDF”. Continue only after both files have been saved. Complete and archive this order now?`)) return;
  const archive = read(ORDER_ARCHIVE_KEY);
  archive.push({ id: ledger.order.id, number: ledger.order.number, supplier: ledger.order.inputs?.supplier || '', received: ledger.incoming, processed: ledger.processed, shipped: ledger.shipped, tested: ledger.tested, unprocessed: ledger.incoming - ledger.processed, recoveryInputFt: ledger.allocatedInputFt, recoveryOutputFt: ledger.yardOutputFt, removedFt: ledger.removedFt, rows: cloneForArchive(ledger.rows), completedCycles: cloneForArchive(completed()), recoveries: cloneForArchive(currentRecoveries()), tests: cloneForArchive(currentTests()), tags: cloneForArchive(currentTags()), shipments: cloneForArchive(currentShipments()), dryingPrograms: cloneForArchive(ledger.order.dryingPrograms || {}), thermoPrograms: cloneForArchive(ledger.order.thermoPrograms || {}), finalProcessDate: $('warehouseFinalDate').value, completedAt: new Date().toISOString() });
  write(ORDER_ARCHIVE_KEY, archive);
  const completedAt = new Date().toISOString();
  saveOrderRemainder(ledger, completedAt);
  const completedOrder = { ...ledger.order, status: 'completed', completedAt, updatedAt: completedAt };
  localStorage.setItem(`${ORDER_PREFIX}${completedOrder.id}`, JSON.stringify(completedOrder));
  const index = read(ORDER_INDEX_KEY);
  const position = index.findIndex((item) => item.id === completedOrder.id);
  const metadata = { id: completedOrder.id, number: completedOrder.number, supplier: completedOrder.inputs?.supplier || '', status: 'completed', updatedAt: completedOrder.updatedAt, plannedCycles: completedOrder.plannedCycles || 0 };
  if (position >= 0) index[position] = metadata; else index.push(metadata);
  write(ORDER_INDEX_KEY, index);
  localStorage.removeItem(ACTIVE_ORDER_KEY);
  localStorage.removeItem(FINAL_DATE_KEY);
  renderOrderLedger();
}

$('addWarehouseTag').addEventListener('click', openYardBuilder);
$('addPreorderStack').addEventListener('click', addPreorderStack);
$('newPreorder').addEventListener('click', () => {
  const draft = savePreorder(makePreorder());
  activePreorderId = draft.id;
  renderPreorderPlanner();
});
$('deletePreorder').addEventListener('click', () => {
  const draft = activePreorder();
  if (!draft || !window.confirm(`Delete preliminary order ${draft.number || draft.customer || 'draft'}? Its planned boards will return to availability.`)) return;
  write(PREORDERS_KEY, preorderRecords().filter((item) => item.id !== draft.id));
  activePreorderId = '';
  renderPreorderPlanner();
});
$('preorderSelect').addEventListener('change', (event) => { activePreorderId = event.target.value; renderPreorderPlanner(); });
['preorderPurpose', 'preorderCustomer', 'preorderNumber', 'preorderTarget'].forEach((id) => $(id).addEventListener('change', () => {
  const draft = activePreorder();
  if (draft) { updatePreorderHeader(draft); renderPreorderPlanner(); }
}));
$('testBoardForm').addEventListener('submit', saveTestRecord);
$('testSourceLoad').addEventListener('change', () => updateTestSourceFields({ resetProduct: true }));
$('testLength').addEventListener('change', () => updateTestSourceFields());
$('addRecoveryCut').addEventListener('click', () => addRecoveryCutRow({ sourceLength: 20 }));
$('applyRecoveryCuts').addEventListener('click', applyRecoveryCuts);
$('yardTagForm').addEventListener('submit', (event) => {
  try {
    createYardTag(event);
  } catch (error) {
    event.preventDefault();
    console.error('YARD TAG creation failed:', error);
    $('yardDialogStatus').className = 'calculation-status pending';
    $('yardDialogStatus').textContent = 'The YARD TAG could not be saved. Your entered values are still available; please try again.';
  }
});
$('cancelYardTag').addEventListener('click', () => $('yardTagDialog').close());
$('createShipment').addEventListener('click', () => {
  const tagIds = [...document.querySelectorAll('#shippingTagSelection input:checked')].map((input) => input.value);
  const orderNumber = $('shipmentOrder').value.trim();
  const date = $('shipmentDate').value;
  const duplicateOrder = shipments().some((shipment) => String(shipment.orderNumber).trim().toLowerCase() === orderNumber.toLowerCase());
  if (!tagIds.length || !orderNumber || !date || duplicateOrder) {
    $('shipmentMessage').className = 'calculation-status pending';
    $('shipmentMessage').textContent = duplicateOrder
      ? 'Shipping order number must be unique.'
      : 'Select at least one YARD TAG and complete Shipping order # and date.';
    return;
  }
  const selected = warehouseTags().filter((tag) => tagIds.includes(tag.id));
  const records = shipments();
  records.push({ id: `shipment-${Date.now()}`, orderId: activeOrder()?.id || selected[0]?.orderId || 'legacy', orderNumber, date, tagIds, boards: selected.reduce((sum, tag) => sum + totalBoards(tag.quantities), 0), bf: selected.reduce((sum, tag) => sum + tagBf(tag), 0) });
  write(SHIPMENTS_KEY, records);
  $('shipmentOrder').value = '';
  $('shipmentMessage').className = 'calculation-status ready';
  $('shipmentMessage').textContent = 'Shipping order registered. Selected YARD TAGs are now protected.';
  renderShippingSelection();
  renderOrderLedger();
});
$('completeOrder').addEventListener('click', completeActiveOrder);
$('warehouseFinalDate').value = localStorage.getItem(FINAL_DATE_KEY) || completed().find((record) => record.finalProcessDate)?.finalProcessDate || '';
$('testDate').value = new Date().toISOString().slice(0, 10);
$('warehouseFinalDate').addEventListener('change', (event) => localStorage.setItem(FINAL_DATE_KEY, event.target.value));
function printReport(mode) {
  document.body.classList.toggle('print-kiln-settings', mode === 'settings');
  document.body.classList.toggle('print-full-order', mode === 'full');
  const order = activeOrder();
  const previousTitle = document.title;
  document.title = `${mode === 'settings' ? 'Kiln Settings' : 'Full Order Report'} - ${order?.number || 'Order'} - ${new Date().toISOString().slice(0, 10)}`;
  const cleanup = () => {
    document.body.classList.remove('print-kiln-settings', 'print-full-order');
    document.title = previousTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  window.setTimeout(cleanup, 1500);
}
$('printWarehouse').addEventListener('click', () => printReport('full'));
$('printKilnSettings').addEventListener('click', () => printReport('settings'));
migrateLegacyTagRecoveries();
migratePreorderPurposes();
reconcileGormanCompletedInventory();
renderCompleted();
renderTestRegister();
renderWarehouseTags();
renderOrderLedger();
renderKilnSettingsReport();
renderPreorderPlanner();
