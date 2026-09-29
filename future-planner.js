const LENGTHS = Array.from({ length: 18 }, (_, index) => index + 3);
const COMPLETED_KEY = 'kiln-planner-completed-cycles-v1';
const TAGS_KEY = 'kiln-planner-shipping-tags-v1';
const SHIPMENTS_KEY = 'kiln-planner-shipments-v1';
const RECOVERY_KEY = 'kiln-planner-recovery-operations-v1';
const TEST_BOARDS_KEY = 'kiln-planner-test-boards-v1';
const PREORDERS_KEY = 'kiln-planner-preliminary-orders-v1';
const ACTIVE_ORDER_KEY = 'kiln-planner-active-order-v1';
const ORDER_PREFIX = 'kiln-planner-order-v1:';
const $ = (id) => document.getElementById(id);

function read(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; }
  catch (_) { return []; }
}
function writePlanning(value) { localStorage.setItem(PREORDERS_KEY, JSON.stringify(value)); }
function write(key, value) {
  if (key !== PREORDERS_KEY) throw new Error('Future Material Planner may only write planning drafts.');
  writePlanning(value);
}
function fmt(value, digits = 0) { return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function esc(value) { return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/**
 * Read-only boundary over operational production data.
 * This page owns PREORDERS_KEY only; the methods below never write inventory.
 */
const FuturePlannerOperationalReader = Object.freeze({
  activeOrder() {
    try {
      const pointer = JSON.parse(localStorage.getItem(ACTIVE_ORDER_KEY) || 'null');
      if (!pointer?.orderRef) return pointer;
      return JSON.parse(localStorage.getItem(ORDER_PREFIX + pointer.orderRef) || 'null');
    } catch (_) { return null; }
  },
  completedRecords() { return read(COMPLETED_KEY); },
  yardTags() { return read(TAGS_KEY); },
  shipments() { return read(SHIPMENTS_KEY); },
  recoveries() { return read(RECOVERY_KEY); },
  testBoards() { return read(TEST_BOARDS_KEY); },
});

function activeOrder() { return FuturePlannerOperationalReader.activeOrder(); }
function belongsToOrder(item, order) { return !order || item.orderId === order.id || item.orderId === order.planSignature || item.productionOrderNumber === order.number || item.orderNumber === order.number; }
function completed() {
  const order = activeOrder();
  const merged = new Map();
  const ledger = FuturePlannerOperationalReader.completedRecords().filter((item) => belongsToOrder(item, order));
  const embedded = Array.isArray(order?.completedCycles) ? order.completedCycles : [];
  [...embedded, ...ledger].forEach((record, index) => {
    const key = record?.id || `${record?.orderId || record?.orderNumber || 'order'}::load-${record?.loadNumber || index}`;
    merged.set(key, record);
  });
  return [...merged.values()].sort((a, b) => String(a.completedDate).localeCompare(String(b.completedDate)) || a.loadNumber - b.loadNumber);
}
function warehouseTags() { return FuturePlannerOperationalReader.yardTags(); }
function shipments() { return FuturePlannerOperationalReader.shipments(); }
function recoveryOperations() { return FuturePlannerOperationalReader.recoveries(); }
function currentRecoveries() { const order = activeOrder(); return recoveryOperations().filter((item) => belongsToOrder(item, order)); }
function testBoardRecords() { return FuturePlannerOperationalReader.testBoards(); }
function currentTests() { const order = activeOrder(); return testBoardRecords().filter((item) => belongsToOrder(item, order)); }
function currentTags() {
  const order = activeOrder();
  const sourceIds = new Set(completed().map((item) => item.id));
  return warehouseTags().filter((tag) => belongsToOrder(tag, order) || (tag.sourceLoads || []).some((source) => sourceIds.has(source.id)));
}
function currentShipments() {
  const order = activeOrder();
  const tagIds = new Set(currentTags().map((tag) => tag.id));
  return shipments().filter((item) => belongsToOrder(item, order) || (item.tagIds || []).some((id) => tagIds.has(id)));
}
function sumQuantities(records) {
  const totals = Object.fromEntries(LENGTHS.map((length) => [length, 0]));
  records.forEach((record) => LENGTHS.forEach((length) => { totals[length] += Number(record.quantities?.[length] || 0); }));
  return totals;
}
function qualityLabel(value) {
  return ({
    good: 'No.1 / good', 'grade-1': 'No.1 / good', crooked: 'Crooked / bowed',
    cracked: 'Cracked', knots: 'Large or damaged knots',
    'recovered-grade-1': 'Recovered Grade #1', downgraded: 'Downgraded / defects',
    unclassified: 'Unclassified',
  })[value] || 'Unclassified';
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
function reconciledCycleLots(record) {
  const quantities = record?.quantities || {};
  const savedLots = Array.isArray(record?.qualityLots) ? record.qualityLots : [];
  return Object.entries(quantities).flatMap(([rawLength, rawQuantity]) => {
    const length = Number(rawLength);
    let remaining = Math.max(0, Number(rawQuantity || 0));
    if (!remaining) return [];
    const result = [];
    savedLots.filter((lot) => Number(lot.length) === length && Number(lot.quantity || 0) > 0).forEach((lot) => {
      const quantity = Math.min(remaining, Number(lot.quantity || 0));
      if (quantity > 0) result.push({ ...lot, length, quantity });
      remaining -= quantity;
    });
    if (remaining > 0) result.push({
      length,
      material: record?.species || record?.marking || 'Material',
      quality: 'unclassified',
      qualityLabel: 'Unclassified',
      quantity: remaining,
      recoveredFromCycleTotal: true,
    });
    return result;
  });
}
function lotsForCycle(record, status) {
  const result = new Map();
  const sourceLots = reconciledCycleLots(record);
  sourceLots.forEach((lot) => {
    const quantity = Math.max(0, Number(lot.quantity || 0));
    if (!quantity) return;
    const material = lot.material || record?.species || record?.marking || 'Material';
    const quality = lot.quality || 'unclassified';
    const id = lotKey(record.loadNumber, lot.length, material, quality);
    const existing = result.get(id);
    if (existing) existing.quantity += quantity;
    else result.set(id, {
      id, loadNumber: Number(record.loadNumber), length: Number(lot.length), material, quality, quantity, status,
    });
  });
  return [...result.values()];
}
function productionLots() {
  // Preliminary customer/TAG planning is a non-binding view of all finished
  // material that is still physically on hand. A warehouse TAG classifies a
  // board, but does not consume it; only TEST or a shipment removes it from
  // the pool available to a draft order.
  const projection = physicalProjection();
  const readyCap = projection.regular;
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
    const recovered = Math.max(0, Number(projection.recoveredCurrent[length] || 0));
    if (recovered) ready.push({ id: `recovered|${length}`, loadNumber: 0, length, material: 'Recovered material', quality: 'recovered-grade-1', quantity: recovered, status: 'ready' });
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
function preorderReserved(lotId, exceptId = '', draft = activePreorder()) {
  return allPreorderItems(draft ? [draft] : []).filter((item) => item.lotId === lotId && item.id !== exceptId).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
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
  const available = Math.max(0, Number(lot?.quantity || 0) - preorderReserved(lotId, '', draft));
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
    const free = Math.max(0, Number(lot.quantity || 0) - preorderReserved(lot.id, '', draft));
    const prefix = lot.status === 'ready' ? 'ready' : 'expected';
    values[`${prefix}Qty`] += Number(lot.quantity || 0);
    values[`${prefix}Bf`] += preorderBf(lot.length, lot.quantity);
    values[`${prefix}FreeQty`] += free;
    values[`${prefix}FreeBf`] += preorderBf(lot.length, free);
    materialTotals.set(lot.material, values);
  });
  $('preorderMaterialTotals').innerHTML = materialTotals.size
    ? [...materialTotals.entries()].map(([material, values]) => `<article><h3>${esc(material)}</h3><div class="material-stock-line ready"><span>READY in warehouse</span><b>${fmt(values.readyQty)} PCS · ${fmt(values.readyBf, 1)} BF</b><small>${fmt(values.readyFreeQty)} PCS · ${fmt(values.readyFreeBf, 1)} BF remaining in this draft</small></div><div class="material-stock-line expected"><span>EXPECTED from started cycle</span><b>${fmt(values.expectedQty)} PCS · ${fmt(values.expectedBf, 1)} BF</b><small>${fmt(values.expectedFreeQty)} PCS · ${fmt(values.expectedFreeBf, 1)} BF remaining in this draft</small></div></article>`).join('')
    : '<div class="empty-state">No material is available from completed or started cycles.</div>';
  const stackOptions = (draft.stacks || []).map((stack) => `<option value="${esc(stack.id)}">${esc(stack.name)}</option>`).join('');
  $('preorderSources').innerHTML = lots.length ? lots.map((lot) => {
    const reserved = preorderReserved(lot.id, '', draft);
    const available = Math.max(0, lot.quantity - reserved);
    return `<div class="preorder-source-row" data-lot-id="${esc(lot.id)}"><span><b>${fmt(lot.length)} ft · ${esc(lot.material)}</b><small class="source-${lot.status}">${lot.status === 'ready' ? 'READY' : 'EXPECTED'} · Kiln Load ${fmt(lot.loadNumber || 0)} · ${esc(qualityLabel(lot.quality))}</small><small>${fmt(lot.quantity)} on hand · ${fmt(reserved)} selected in this draft</small></span><strong><b>${fmt(available)} PCS</b><small>${fmt(preorderBf(lot.length, available), 1)} BF available</small></strong><input class="preorder-source-qty" type="number" min="1" max="${available}" value="${available ? 1 : 0}" ${available ? '' : 'disabled'} aria-label="Quantity"><select class="preorder-source-stack" ${stackOptions ? '' : 'disabled'}>${stackOptions || '<option>Add TAG first</option>'}</select><button class="preorder-add-source" type="button" ${available && stackOptions ? '' : 'disabled'}>Add</button></div>`;
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
    found.item.quantity = Math.max(1, Math.min(Math.floor(Number(input.value || 1)), Math.max(1, Number(lot?.quantity || found.item.quantity) - preorderReserved(found.item.lotId, found.item.id, draft))));
    savePreorder(draft); renderPreorderPlanner();
  }));
  document.querySelectorAll('.preorder-remove-item').forEach((button) => button.addEventListener('click', () => {
    const draft = activePreorder(); const found = findPreorderItem(draft, button.dataset.itemId); if (!found) return;
    const returnedQuantity = Number(found.item.quantity || 0);
    const returnedLength = Number(found.item.length || 0);
    found.stack.items = found.stack.items.filter((item) => item.id !== button.dataset.itemId); savePreorder(draft); renderPreorderPlanner();
    $('preorderStatus').className = 'calculation-status ready';
    $('preorderStatus').textContent = `${fmt(returnedQuantity)} boards at ${fmt(returnedLength)} ft returned to Available production.`;
  }));
  document.querySelectorAll('.preorder-stack-name').forEach((input) => input.addEventListener('change', () => {
    const draft = activePreorder(); const stack = draft.stacks.find((item) => item.id === input.dataset.stackId); if (!stack) return;
    stack.name = input.value.trim() || 'Future TAG'; savePreorder(draft); renderPreorderPlanner();
  }));
  document.querySelectorAll('.preorder-remove-stack').forEach((button) => button.addEventListener('click', () => {
    const draft = activePreorder(); const stack = draft.stacks.find((item) => item.id === button.dataset.stackId); if (!stack) return;
    if ((stack.items || []).length && !window.confirm('Delete this future TAG and return all planned boards to availability?')) return;
    const returnedBoards = (stack.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const returnedBf = (stack.items || []).reduce((sum, item) => sum + preorderBf(item.length, item.quantity), 0);
    draft.stacks = draft.stacks.filter((item) => item.id !== stack.id); savePreorder(draft); renderPreorderPlanner();
    $('preorderStatus').className = 'calculation-status ready';
    $('preorderStatus').textContent = `${fmt(returnedBoards)} boards / ${fmt(returnedBf, 1)} BF returned to Available production.`;
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

function physicalProjection() {
  const projector = globalThis.KilnPhysicalSourceProjection;
  if (!projector?.projectPhysicalSources) throw new Error('Physical source projection is unavailable.');
  return projector.projectPhysicalSources({
    lengths: LENGTHS,
    completed: completed(),
    recoveries: currentRecoveries(),
    tests: currentTests(),
    tags: currentTags(),
    shipments: currentShipments(),
    dimensions: orderedBoardDimensions(),
  });
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

function availableForPreorder() {
  return physicalProjection().current;
}


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

migratePreorderPurposes();
renderPreorderPlanner();
