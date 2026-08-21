const LENGTHS = Array.from({ length: 18 }, (_, index) => index + 3);
const COMPLETED_KEY = 'kiln-planner-completed-cycles-v1';
const TAGS_KEY = 'kiln-planner-shipping-tags-v1';
const SHIPMENTS_KEY = 'kiln-planner-shipments-v1';
const FINAL_DATE_KEY = 'kiln-planner-final-process-date-v1';
const ACTIVE_ORDER_KEY = 'kiln-planner-active-order-v1';
const ORDER_ARCHIVE_KEY = 'kiln-planner-order-archive-v1';
const $ = (id) => document.getElementById(id);

function read(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; }
  catch (_) { return []; }
}
function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function fmt(value, digits = 0) { return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function esc(value) { return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function activeOrder() { try { return JSON.parse(localStorage.getItem(ACTIVE_ORDER_KEY) || 'null'); } catch (_) { return null; } }
function allCompleted() { return read(COMPLETED_KEY); }
function belongsToOrder(item, order) { return !order || item.orderId === order.id || item.orderId === order.planSignature || item.productionOrderNumber === order.number || item.orderNumber === order.number; }
function completed() { const order = activeOrder(); return allCompleted().filter((item) => belongsToOrder(item, order)).sort((a, b) => String(a.completedDate).localeCompare(String(b.completedDate)) || a.loadNumber - b.loadNumber); }
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
function currentTags() { const order = activeOrder(); const sourceIds = new Set(completed().map((item) => item.id)); return warehouseTags().filter((tag) => belongsToOrder(tag, order) || (tag.sourceLoads || []).some((source) => sourceIds.has(source.id))); }
function currentShipments() { const order = activeOrder(); const tagIds = new Set(currentTags().map((tag) => tag.id)); return shipments().filter((item) => belongsToOrder(item, order) || (item.tagIds || []).some((id) => tagIds.has(id))); }
function sumQuantities(records) {
  const totals = Object.fromEntries(LENGTHS.map((length) => [length, 0]));
  records.forEach((record) => LENGTHS.forEach((length) => { totals[length] += Number(record.quantities?.[length] || 0); }));
  return totals;
}
function totalBoards(quantities) { return Object.values(quantities || {}).reduce((sum, value) => sum + Number(value || 0), 0); }
function dimensions(size) { const values = String(size || '').match(/[\d.]+/g)?.map(Number) || []; return { thickness: values[0] || 0, width: values[1] || 0 }; }
function tagBf(tag) {
  const { thickness, width } = dimensions(tag.size);
  return LENGTHS.reduce((sum, length) => sum + thickness * width * length * Number(tag.quantities?.[length] || 0) / 12, 0);
}

function availableForYard() {
  const processed = sumQuantities(completed());
  const tagged = sumQuantities(currentTags());
  return Object.fromEntries(LENGTHS.map((length) => [length, Math.max(0, processed[length] - tagged[length])]));
}

function allocateSourceLoads(requested) {
  const priorTagged = sumQuantities(currentTags());
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
  return `<thead><tr><th>Completed</th><th>Supplier</th><th>Marking</th>${LENGTHS.map((l) => `<th>${l}</th>`).join('')}<th>PCS</th><th>BFM</th><th>Action</th></tr></thead>`;
}
function tagHeader() {
  return `<thead><tr><th>TAG</th><th>ORDER #</th><th>PRODUCT / MO #</th><th>DATE</th>${LENGTHS.map((l) => `<th>${l}</th>`).join('')}<th>PCS</th><th>BFM</th><th>Action</th></tr></thead>`;
}

function renderCompleted() {
  const records = completed();
  $('emptyCompleted').hidden = records.length > 0;
  const totals = sumQuantities(records);
  const rows = records.map((record) => `<tr><td><b>${esc(record.completedDate)}</b><small>Kiln Load ${record.loadNumber}</small></td><td>${esc(record.supplier)}</td><td>${esc(record.marking)}</td>${LENGTHS.map((l) => `<td>${record.quantities?.[l] ? fmt(record.quantities[l]) : ''}</td>`).join('')}<td><b>${fmt(record.boards)}</b></td><td>${fmt(record.bf, 1)}</td><td><button class="danger small-action delete-completed" type="button" data-id="${esc(record.id)}">Delete</button></td></tr>`).join('');
  const footer = `<tfoot><tr><th colspan="3">TOTAL PROCESSED</th>${LENGTHS.map((l) => `<th>${totals[l] ? fmt(totals[l]) : ''}</th>`).join('')}<th>${fmt(totalBoards(totals))}</th><th>${fmt(records.reduce((sum, record) => sum + Number(record.bf || 0), 0), 1)}</th><th></th></tr></tfoot>`;
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
  const processedTotals = sumQuantities(completed());
  const taggedTotals = sumQuantities(tags);
  const available = Object.fromEntries(LENGTHS.map((length) => [length, Math.max(0, processedTotals[length] - taggedTotals[length])]));
  const rows = tags.map((tag, rowIndex) => `<tr>
    <td><input data-field="tag" data-row="${rowIndex}" value="${esc(tag.tag)}" placeholder="TAG #"></td>
    <td><input data-field="orderNumber" data-row="${rowIndex}" value="${esc(tag.orderNumber)}" placeholder="ORDER #"></td>
    <td><input data-field="productMo" data-row="${rowIndex}" value="${esc(tag.productMo)}" placeholder="PRODUCT / MO #"></td>
    <td><input type="date" data-field="date" data-row="${rowIndex}" value="${esc(tag.date)}"></td>
    ${LENGTHS.map((length) => `<td><input class="matrix-qty" type="number" min="0" data-field="quantity" data-length="${length}" data-row="${rowIndex}" value="${Number(tag.quantities?.[length] || 0) || ''}"></td>`).join('')}
    <td><b>${fmt(totalBoards(tag.quantities))}</b></td><td>${fmt(tagBf(tag), 1)}</td><td><button class="danger small-action delete-yard-tag" type="button" data-id="${esc(tag.id)}">Delete</button></td></tr>`).join('');
  const availableRow = `<tfoot><tr><th colspan="4">UNTAGGED PROCESSED INVENTORY</th>${LENGTHS.map((length) => `<th>${available[length] ? fmt(available[length]) : ''}</th>`).join('')}<th>${fmt(totalBoards(available))}</th><th>—</th><th></th></tr></tfoot>`;
  $('warehouseTagTable').innerHTML = `${tagHeader()}<tbody>${rows}</tbody>${availableRow}`;
  $('availableBoards').textContent = fmt(totalBoards(available));
  document.querySelectorAll('#warehouseTagTable input').forEach((input) => input.addEventListener('change', updateWarehouseTag));
  document.querySelectorAll('.delete-yard-tag').forEach((button) => button.addEventListener('click', () => deleteYardTag(button.dataset.id)));
  renderShippingSelection();
  renderOrderLedger();
}

function updateWarehouseTag(event) {
  const allTags = warehouseTags();
  const tags = currentTags();
  const row = Number(event.target.dataset.row);
  const field = event.target.dataset.field;
  if (!tags[row]) return;
  if (field === 'quantity') tags[row].quantities[event.target.dataset.length] = Math.max(0, Math.floor(Number(event.target.value) || 0));
  else tags[row][field] = event.target.value;
  const requiredMissing = ['tag', 'orderNumber', 'productMo', 'date'].some((key) => !String(tags[row][key] || '').trim());
  const duplicateTag = tags.some((tag, index) => index !== row && String(tag.tag || '').trim().toLowerCase() === String(tags[row].tag || '').trim().toLowerCase());
  const processedTotals = sumQuantities(completed());
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
  const usedByTag = warehouseTags().some((tag) => Array.isArray(tag.sourceLoads)
    ? tag.sourceLoads.some((source) => source.id === id)
    : totalBoards(tag.quantities) > 0);
  if (usedByTag) {
    $('completedMessage').className = 'calculation-status pending';
    $('completedMessage').textContent = 'Cannot delete this completed cycle: its boards are already registered in a YARD TAG. Delete that YARD TAG first.';
    return;
  }
  if (!window.confirm('Delete this Completed Kiln Load record? This action cannot be undone.')) return;
  write(COMPLETED_KEY, completed().filter((record) => record.id !== id));
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
  $('yardTag').value = '';
  $('yardOrder').value = '';
  $('yardProduct').value = source.marking || '';
  $('yardDate').value = new Date().toISOString().slice(0, 10);
  $('yardAvailableSource').innerHTML = completed().map((record) => `<span><b>Kiln Load ${record.loadNumber}</b>${esc(record.completedDate)} · ${fmt(record.boards)} PCS</span>`).join('');
  $('yardBuilderRows').innerHTML = LENGTHS.map((length) => `<tr><td><b>${length} ft</b></td><td>${fmt(available[length])}</td><td><input class="yard-build-qty" type="number" min="0" max="${available[length]}" data-length="${length}" value=""></td></tr>`).join('');
  $('yardDialogStatus').className = 'calculation-status idle';
  $('yardDialogStatus').textContent = totalBoards(available) ? `${fmt(totalBoards(available))} processed boards are available for YARD allocation.` : 'No unallocated completed boards are available.';
  $('yardTagDialog').showModal();
}

function createYardTag(event) {
  event.preventDefault();
  const order = activeOrder();
  const available = availableForYard();
  const quantities = {};
  document.querySelectorAll('.yard-build-qty').forEach((input) => { quantities[input.dataset.length] = Math.max(0, Math.floor(Number(input.value) || 0)); });
  const tagValue = $('yardTag').value.trim();
  const missingFields = !tagValue || !$('yardOrder').value.trim() || !$('yardProduct').value.trim() || !$('yardDate').value;
  const duplicateTag = warehouseTags().some((tag) => String(tag.tag || '').trim().toLowerCase() === tagValue.toLowerCase());
  const invalid = LENGTHS.filter((length) => quantities[length] > available[length]);
  if (missingFields || duplicateTag || invalid.length || !totalBoards(quantities)) {
    $('yardDialogStatus').className = 'calculation-status pending';
    $('yardDialogStatus').textContent = missingFields
      ? 'Complete TAG, ORDER #, PRODUCT / MO # and DATE.'
      : duplicateTag
        ? 'This TAG already exists. Enter a unique TAG.'
        : invalid.length
          ? `Quantity exceeds completed inventory at ${invalid.map((length) => `${length} ft`).join(', ')}.`
          : 'Select at least one completed board.';
    return;
  }
  const source = completed().at(-1) || {};
  const allocationRequest = { ...quantities };
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
    quantities,
    sourceLoads: allocateSourceLoads(allocationRequest),
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
  $('shippingTagSelection').innerHTML = tags.length ? tags.map((tag, index) => `<label class="tag-option ${sentTagIds.has(tag.id) ? 'is-shipped' : ''}"><input type="checkbox" value="${esc(tag.id)}" ${sentTagIds.has(tag.id) ? 'disabled' : ''}><span><b>${esc(tag.tag || `Untagged row ${index + 1}`)}</b><small>${fmt(totalBoards(tag.quantities))} PCS · ${fmt(tagBf(tag), 1)} BFM · ${esc(tag.productMo || 'No product/MO')}</small></span></label>`).join('') : '<div class="empty-state">Create YARD TAGs before forming a shipping order.</div>';
  $('shipmentHistory').innerHTML = currentShipments().map((shipment) => `<article><b>${esc(shipment.orderNumber)}</b><span>${esc(shipment.date)}</span><span>${shipment.tagIds.length} TAG${shipment.tagIds.length === 1 ? '' : 's'}</span><span>${fmt(shipment.boards)} PCS · ${fmt(shipment.bf, 1)} BFM</span><button class="danger small-action delete-shipment" type="button" data-id="${esc(shipment.id)}">Delete</button></article>`).join('');
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
  const tags = currentTags();
  const yard = sumQuantities(tags);
  const shippedIds = new Set(currentShipments().flatMap((shipment) => shipment.tagIds || []));
  const shipped = sumQuantities(tags.filter((tag) => shippedIds.has(tag.id)));
  const rows = LENGTHS.map((length) => ({
    length, incoming: incoming[length], processed: done[length],
    unprocessed: incoming[length] - done[length], yard: yard[length],
    awaitingTag: done[length] - yard[length], shipped: shipped[length],
    inYard: yard[length] - shipped[length],
  }));
  return { order, rows, incoming: totalBoards(incoming), processed: totalBoards(done), yard: totalBoards(yard), shipped: totalBoards(shipped) };
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
  const negatives = ledger.rows.some((row) => row.unprocessed < 0 || row.awaitingTag < 0 || row.inYard < 0);
  const finishedCycles = completed().length;
  const plannedCycles = Number(ledger.order.plannedCycles || 0);
  const allCyclesDone = plannedCycles > 0 && finishedCycles === plannedCycles;
  const allProcessedAllocated = ledger.rows.every((row) => row.awaitingTag === 0);
  const allTagsShipped = ledger.rows.every((row) => row.inYard === 0);
  const canComplete = !negatives && allCyclesDone && allProcessedAllocated && allTagsShipped;
  button.disabled = !canComplete;
  $('orderBalanceStatus').className = `calculation-status ${negatives ? 'pending' : 'ready'}`;
  $('orderBalanceStatus').textContent = negatives
    ? 'BALANCE ERROR: a later stage contains more boards than the previous stage.'
    : `Verified: ${ledger.incoming} received = ${ledger.processed} processed + ${ledger.incoming - ledger.processed} unprocessed. ${ledger.yard} assigned to YARD; ${ledger.shipped} shipped. Completed cycles: ${finishedCycles}/${plannedCycles || '—'}.`;
  const visible = ledger.rows.filter((row) => row.incoming || row.processed || row.yard || row.shipped);
  $('orderLedger').innerHTML = `<thead><tr><th>Length</th><th>Received</th><th>Processed</th><th>Unprocessed</th><th>YARD tagged</th><th>Awaiting TAG</th><th>Shipped</th><th>In YARD</th><th>Check</th></tr></thead><tbody>${visible.map((row) => `<tr><td>${row.length} ft</td><td>${fmt(row.incoming)}</td><td>${fmt(row.processed)}</td><td>${fmt(row.unprocessed)}</td><td>${fmt(row.yard)}</td><td>${fmt(row.awaitingTag)}</td><td>${fmt(row.shipped)}</td><td>${fmt(row.inYard)}</td><td class="${row.unprocessed < 0 || row.awaitingTag < 0 || row.inYard < 0 ? 'bad' : 'ok'}">${row.unprocessed < 0 || row.awaitingTag < 0 || row.inYard < 0 ? 'ERROR' : '✓'}</td></tr>`).join('')}</tbody><tfoot><tr><th>TOTAL</th><th>${fmt(ledger.incoming)}</th><th>${fmt(ledger.processed)}</th><th>${fmt(ledger.incoming-ledger.processed)}</th><th>${fmt(ledger.yard)}</th><th>${fmt(ledger.processed-ledger.yard)}</th><th>${fmt(ledger.shipped)}</th><th>${fmt(ledger.yard-ledger.shipped)}</th><th>${negatives ? 'ERROR' : 'BALANCED'}</th></tr></tfoot>`;
  renderOrderArchive();
}

function renderOrderArchive() {
  const records = read(ORDER_ARCHIVE_KEY);
  $('orderArchive').innerHTML = records.length ? records.map((record) => `<article><b>${esc(record.number)}</b><span>${esc(record.completedAt.slice(0,10))}</span><span>${fmt(record.received)} received · ${fmt(record.shipped)} shipped</span><span>${fmt(record.unprocessed)} unprocessed remainder</span></article>`).join('') : '<div class="empty-state">No completed orders yet.</div>';
}

function completeActiveOrder() {
  const ledger = orderLedger();
  if (!ledger || $('completeOrder').disabled) return;
  if (!window.confirm(`Complete and archive order ${ledger.order.number}? The planner will be cleared for a new order.`)) return;
  const archive = read(ORDER_ARCHIVE_KEY);
  archive.push({ id: ledger.order.id, number: ledger.order.number, supplier: ledger.order.inputs?.supplier || '', received: ledger.incoming, processed: ledger.processed, shipped: ledger.shipped, unprocessed: ledger.incoming - ledger.processed, rows: ledger.rows, completedAt: new Date().toISOString() });
  write(ORDER_ARCHIVE_KEY, archive);
  localStorage.removeItem(ACTIVE_ORDER_KEY);
  localStorage.removeItem(FINAL_DATE_KEY);
  renderOrderLedger();
}

$('addWarehouseTag').addEventListener('click', openYardBuilder);
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
$('warehouseFinalDate').addEventListener('change', (event) => localStorage.setItem(FINAL_DATE_KEY, event.target.value));
$('printWarehouse').addEventListener('click', () => window.print());
renderCompleted();
renderWarehouseTags();
renderOrderLedger();
