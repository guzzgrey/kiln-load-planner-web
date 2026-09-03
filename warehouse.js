const LENGTHS = Array.from({ length: 18 }, (_, index) => index + 3);
const COMPLETED_KEY = 'kiln-planner-completed-cycles-v1';
const TAGS_KEY = 'kiln-planner-shipping-tags-v1';
const SHIPMENTS_KEY = 'kiln-planner-shipments-v1';
const RECOVERY_KEY = 'kiln-planner-recovery-operations-v1';
const FINAL_DATE_KEY = 'kiln-planner-final-process-date-v1';
const ACTIVE_ORDER_KEY = 'kiln-planner-active-order-v1';
const ORDER_ARCHIVE_KEY = 'kiln-planner-order-archive-v1';
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
function qualityLabel(value) { return ({ 'grade-1': 'Grade #1', 'recovered-grade-1': 'Recovered Grade #1', downgraded: 'Downgraded' })[value] || 'Grade #1'; }
function recoveryLabel(tag) {
  return (tag.recoveryCuts || []).map((cut) => `${fmt(cut.quantity)}× ${cut.sourceLength} ft → ${cut.outputs.join(' + ')} ft`).join('; ');
}
function dimensions(size) { const values = String(size || '').match(/[\d.]+/g)?.map(Number) || []; return { thickness: values[0] || 0, width: values[1] || 0 }; }
function tagBf(tag) {
  const { thickness, width } = dimensions(tag.size);
  return LENGTHS.reduce((sum, length) => sum + thickness * width * length * Number(tag.quantities?.[length] || 0) / 12, 0);
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
  const consumed = sumQuantities(currentTags());
  return Object.fromEntries(LENGTHS.map((length) => [length, Math.max(0, processed[length] - consumed[length])]));
}

function sumSourceQuantities(records) {
  const totals = Object.fromEntries(LENGTHS.map((length) => [length, 0]));
  records.forEach((record) => LENGTHS.forEach((length) => { totals[length] += Number(sourceQuantities(record)?.[length] || 0); }));
  return totals;
}

function allocateSourceLoads(requested) {
  const priorTagged = sumSourceQuantities(currentTags());
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
  return `<thead><tr><th>TAG</th><th>ORDER #</th><th>PRODUCT / MO #</th><th>DATE</th><th>QUALITY</th>${LENGTHS.map((l) => `<th>${l}</th>`).join('')}<th>PCS</th><th>BFM</th><th>Action</th></tr></thead>`;
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
  const processedTotals = adjustedProcessedInventory();
  const consumedTotals = sumQuantities(tags);
  const available = Object.fromEntries(LENGTHS.map((length) => [length, Math.max(0, processedTotals[length] - consumedTotals[length])]));
  const rows = tags.map((tag, rowIndex) => `<tr>
    <td><input data-field="tag" data-row="${rowIndex}" value="${esc(tag.tag)}" placeholder="TAG #"></td>
    <td><input data-field="orderNumber" data-row="${rowIndex}" value="${esc(tag.orderNumber)}" placeholder="ORDER #"></td>
    <td><input data-field="productMo" data-row="${rowIndex}" value="${esc(tag.productMo)}" placeholder="PRODUCT / MO #"></td>
    <td><input type="date" data-field="date" data-row="${rowIndex}" value="${esc(tag.date)}"></td>
    <td><b>${esc(qualityLabel(tag.quality))}</b>${tag.defectNote ? `<small>${esc(tag.defectNote)}</small>` : ''}</td>
    ${LENGTHS.map((length) => `<td><input class="matrix-qty" type="number" readonly aria-label="${length} ft finished quantity" value="${Number(tag.quantities?.[length] || 0) || ''}"></td>`).join('')}
    <td><b>${fmt(totalBoards(tag.quantities))}</b></td><td>${fmt(tagBf(tag), 1)}</td><td><button class="danger small-action delete-yard-tag" type="button" data-id="${esc(tag.id)}">Delete</button></td></tr>`).join('');
  const availableRow = `<tfoot><tr><th colspan="5">UNTAGGED PROCESSED INVENTORY</th>${LENGTHS.map((length) => `<th>${available[length] ? fmt(available[length]) : ''}</th>`).join('')}<th>${fmt(totalBoards(available))}</th><th>—</th><th></th></tr></tfoot>`;
  $('warehouseTagTable').innerHTML = `${tagHeader()}<tbody>${rows}</tbody>${availableRow}`;
  $('availableBoards').textContent = fmt(totalBoards(available));
  document.querySelectorAll('#warehouseTagTable input').forEach((input) => input.addEventListener('change', updateWarehouseTag));
  document.querySelectorAll('.delete-yard-tag').forEach((button) => button.addEventListener('click', () => deleteYardTag(button.dataset.id)));
  renderRecoveryStage();
  renderShippingSelection();
  renderOrderLedger();
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
  $('yardTag').value = '';
  $('yardOrder').value = order?.number || '';
  $('yardProduct').value = source.marking || '';
  $('yardDate').value = new Date().toISOString().slice(0, 10);
  $('yardQuality').value = 'grade-1';
  $('yardDefectNote').value = '';
  $('yardAvailableSource').innerHTML = LENGTHS.filter((length) => available[length]).map((length) => `<span><b>${length} ft</b>${fmt(available[length])} finished boards</span>`).join('');
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
  const blocked = LENGTHS.filter((length) => tagged[length] > candidate[length]);
  if (blocked.length) {
    $('recoveryMessage').className = 'calculation-status pending';
    $('recoveryMessage').textContent = `Cannot undo this cut: its finished ${blocked.map((length) => `${length} ft`).join(', ')} product is already assigned to a TAG.`;
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
  const available = Object.fromEntries(LENGTHS.map((length) => [length, Math.max(0, adjusted[length] - tagged[length])]));
  $('recoveryHistory').innerHTML = records.length ? records.map((record) => `<article><span><b>${fmt(record.quantity)} × ${record.sourceLength} ft</b><small>${esc(record.createdAt?.slice(0, 10) || '')}</small></span><strong>→ ${(record.outputs || []).join(' + ')} ft</strong><span>${fmt(record.outputLinearFt)} useful ft · ${fmt(record.wasteLinearFt)} removed ft</span><button class="danger small-action delete-recovery" type="button" data-id="${esc(record.id)}">Undo</button></article>`).join('') : '<div class="empty-state">No confirmed recovery cuts. Processed inventory still matches kiln output.</div>';
  const visible = LENGTHS.filter((length) => original[length] || recovery.source[length] || recovery.output[length] || tagged[length]);
  $('recoveryInventoryTable').innerHTML = `<thead><tr><th>Length</th><th>Kiln output</th><th>Cut out</th><th>Recovered</th><th>Actual finished</th><th>TAG assigned</th><th>Available</th></tr></thead><tbody>${visible.map((length) => `<tr><td><b>${length} ft</b></td><td>${fmt(original[length])}</td><td>${fmt(recovery.source[length])}</td><td>${fmt(recovery.output[length])}</td><td><b>${fmt(adjusted[length])}</b></td><td>${fmt(tagged[length])}</td><td><b>${fmt(available[length])}</b></td></tr>`).join('')}</tbody><tfoot><tr><th>TOTAL PIECES</th><th>${fmt(totalBoards(original))}</th><th>${fmt(totalBoards(recovery.source))}</th><th>${fmt(totalBoards(recovery.output))}</th><th>${fmt(totalBoards(adjusted))}</th><th>${fmt(totalBoards(tagged))}</th><th>${fmt(totalBoards(available))}</th></tr><tr><th>FOOTAGE BALANCE</th><th colspan="6">${fmt(recovery.inputLinearFt)} input ft = ${fmt(recovery.outputLinearFt)} recovered ft + ${fmt(recovery.wasteLinearFt)} removed ft</th></tr></tfoot>`;
  document.querySelectorAll('.delete-recovery').forEach((button) => button.addEventListener('click', () => deleteRecoveryOperation(button.dataset.id)));
}

function createYardTag(event) {
  event.preventDefault();
  const order = activeOrder();
  const available = availableForYard();
  const directQuantities = {};
  document.querySelectorAll('.yard-build-qty').forEach((input) => { directQuantities[input.dataset.length] = Math.max(0, Math.floor(Number(input.value) || 0)); });
  const quantities = { ...directQuantities };
  const tagValue = $('yardTag').value.trim();
  const missingFields = !tagValue || !$('yardOrder').value.trim() || !$('yardProduct').value.trim() || !$('yardDate').value;
  const duplicateTag = warehouseTags().some((tag) => String(tag.tag || '').trim().toLowerCase() === tagValue.toLowerCase());
  const selectedLengths = LENGTHS.filter((length) => quantities[length] > 0);
  const invalid = LENGTHS.filter((length) => quantities[length] > available[length]);
  if (missingFields || duplicateTag || invalid.length || selectedLengths.length !== 1) {
    $('yardDialogStatus').className = 'calculation-status pending';
    $('yardDialogStatus').textContent = missingFields
      ? 'Complete TAG, ORDER #, PRODUCT / MO # and DATE.'
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
    quality: $('yardQuality').value,
    defectNote: $('yardDefectNote').value.trim(),
    directQuantities: quantities,
    recoveryCuts: [],
    sourceQuantities: quantities,
    quantities,
    inputLinearFt,
    outputLinearFt: inputLinearFt,
    wasteLinearFt: 0,
    sourceLoads: [],
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
  const allocated = sumQuantities(tags);
  const yard = sumQuantities(tags);
  const shippedIds = new Set(currentShipments().flatMap((shipment) => shipment.tagIds || []));
  const shipped = sumQuantities(tags.filter((tag) => shippedIds.has(tag.id)));
  const rows = LENGTHS.map((length) => ({
    length, incoming: incoming[length], processed: done[length],
    unprocessed: incoming[length] - done[length], recoveryOut: recovery.source[length], recoveryIn: recovery.output[length], finished: finished[length], allocated: allocated[length], yard: yard[length],
    awaitingTag: finished[length] - allocated[length], shipped: shipped[length],
    inYard: yard[length] - shipped[length],
  }));
  return { order, rows, incoming: totalBoards(incoming), processed: totalBoards(done), finished: totalBoards(finished), allocated: totalBoards(allocated), yard: totalBoards(yard), shipped: totalBoards(shipped), allocatedInputFt: recovery.inputLinearFt, yardOutputFt: recovery.outputLinearFt, removedFt: recovery.wasteLinearFt };
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
    : `Verified: ${ledger.incoming} received = ${ledger.processed} processed + ${ledger.incoming - ledger.processed} unprocessed. YARD recovery balance: ${fmt(ledger.allocatedInputFt)} input ft = ${fmt(ledger.yardOutputFt)} useful ft + ${fmt(ledger.removedFt)} removed ft. ${ledger.yard} finished pieces assigned to YARD; ${ledger.shipped} shipped. Completed cycles: ${finishedCycles}/${plannedCycles || '—'}.`;
  const visible = ledger.rows.filter((row) => row.incoming || row.processed || row.recoveryOut || row.recoveryIn || row.yard || row.shipped);
  $('orderLedger').innerHTML = `<thead><tr><th>Length</th><th>Received</th><th>Kiln processed</th><th>Unprocessed</th><th>Cut out</th><th>Recovered</th><th>Actual finished</th><th>Awaiting TAG</th><th>YARD</th><th>Shipped</th><th>In YARD</th><th>Check</th></tr></thead><tbody>${visible.map((row) => { const invalid = row.unprocessed < 0 || row.finished < 0 || row.awaitingTag < 0 || row.inYard < 0; return `<tr><td>${row.length} ft</td><td>${fmt(row.incoming)}</td><td>${fmt(row.processed)}</td><td>${fmt(row.unprocessed)}</td><td>${fmt(row.recoveryOut)}</td><td>${fmt(row.recoveryIn)}</td><td><b>${fmt(row.finished)}</b></td><td>${fmt(row.awaitingTag)}</td><td>${fmt(row.yard)}</td><td>${fmt(row.shipped)}</td><td>${fmt(row.inYard)}</td><td class="${invalid ? 'bad' : 'ok'}">${invalid ? 'ERROR' : '✓'}</td></tr>`; }).join('')}</tbody><tfoot><tr><th>TOTAL PIECES</th><th>${fmt(ledger.incoming)}</th><th>${fmt(ledger.processed)}</th><th>${fmt(ledger.incoming-ledger.processed)}</th><th>—</th><th>—</th><th>${fmt(ledger.finished)}</th><th>${fmt(ledger.finished-ledger.allocated)}</th><th>${fmt(ledger.yard)}</th><th>${fmt(ledger.shipped)}</th><th>${fmt(ledger.yard-ledger.shipped)}</th><th>${negatives || !footageBalanced ? 'ERROR' : 'BALANCED'}</th></tr></tfoot>`;
  renderOrderArchive();
}

function renderOrderArchive() {
  const records = read(ORDER_ARCHIVE_KEY);
  $('orderArchive').innerHTML = records.length ? records.map((record) => {
    const rows = record.rows || [];
    const tags = record.tags || [];
    const shipmentRows = record.shipments || [];
    const quantities = rows.filter((row) => row.incoming || row.processed || row.shipped).map((row) => `<tr><td>${fmt(row.length)} ft</td><td>${fmt(row.incoming)}</td><td>${fmt(row.processed)}</td><td>${fmt(row.finished)}</td><td>${fmt(row.shipped)}</td><td>${fmt(row.unprocessed)}</td></tr>`).join('');
    const tagRows = tags.map((tag) => `<tr><td>${esc(tag.tag)}</td><td>${esc(tag.productMo)}</td><td>${esc(tag.date)}</td><td>${esc(qualityLabel(tag.quality))}</td><td>${Object.entries(tag.quantities || {}).filter(([, quantity]) => Number(quantity) > 0).map(([length, quantity]) => `${fmt(quantity)} × ${esc(length)} ft`).join(', ')}</td><td>${fmt(totalBoards(tag.quantities))}</td><td>${fmt(tagBf(tag), 1)}</td></tr>`).join('');
    const shipmentDetails = shipmentRows.map((shipment) => { const names = (shipment.tagIds || []).map((id) => tags.find((tag) => tag.id === id)?.tag || id); return `<tr><td>${esc(shipment.orderNumber)}</td><td>${esc(shipment.date)}</td><td>${names.map(esc).join(', ')}</td><td>${fmt(shipment.boards)}</td><td>${fmt(shipment.bf, 1)}</td></tr>`; }).join('');
    return `<details class="archived-order"><summary><b>${esc(record.number)}</b><span>${esc(record.completedAt.slice(0,10))}</span><span>${fmt(record.received)} received · ${fmt(record.shipped)} shipped</span><span>${fmt(tags.length)} TAGs · ${fmt(shipmentRows.length)} shipments</span></summary><div class="archive-content"><p><b>Supplier:</b> ${esc(record.supplier || '—')} · <b>Final process date:</b> ${esc(record.finalProcessDate || '—')} · <b>Removed footage:</b> ${fmt(record.removedFt)} ft</p><table class="archive-table"><thead><tr><th>Length</th><th>Received</th><th>Kiln processed</th><th>Finished</th><th>Shipped</th><th>Unprocessed</th></tr></thead><tbody>${quantities}</tbody></table><h4>YARD TAGs</h4><table class="archive-table"><thead><tr><th>TAG</th><th>Product / MO</th><th>Date</th><th>Quality</th><th>Contents</th><th>PCS</th><th>BFM</th></tr></thead><tbody>${tagRows || '<tr><td colspan="7">No TAG records</td></tr>'}</tbody></table><h4>Shipping orders</h4><table class="archive-table"><thead><tr><th>Shipping #</th><th>Date</th><th>TAGs</th><th>PCS</th><th>BFM</th></tr></thead><tbody>${shipmentDetails || '<tr><td colspan="5">No Shipping records</td></tr>'}</tbody></table><p><b>Saved kiln programs:</b> ${fmt(Object.keys(record.dryingPrograms || {}).length)} Drying · ${fmt(Object.keys(record.thermoPrograms || {}).length)} Thermo Vacuum.</p></div></details>`;
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

function completeActiveOrder() {
  const ledger = orderLedger();
  if (!ledger || $('completeOrder').disabled) return;
  if (!window.confirm(`Before closing ${ledger.order.number}, save both “Kiln settings PDF” and “Full order PDF”. Continue only after both files have been saved. Complete and archive this order now?`)) return;
  const archive = read(ORDER_ARCHIVE_KEY);
  archive.push({ id: ledger.order.id, number: ledger.order.number, supplier: ledger.order.inputs?.supplier || '', received: ledger.incoming, processed: ledger.processed, shipped: ledger.shipped, unprocessed: ledger.incoming - ledger.processed, recoveryInputFt: ledger.allocatedInputFt, recoveryOutputFt: ledger.yardOutputFt, removedFt: ledger.removedFt, rows: cloneForArchive(ledger.rows), completedCycles: cloneForArchive(completed()), recoveries: cloneForArchive(currentRecoveries()), tags: cloneForArchive(currentTags()), shipments: cloneForArchive(currentShipments()), dryingPrograms: cloneForArchive(ledger.order.dryingPrograms || {}), thermoPrograms: cloneForArchive(ledger.order.thermoPrograms || {}), finalProcessDate: $('warehouseFinalDate').value, completedAt: new Date().toISOString() });
  write(ORDER_ARCHIVE_KEY, archive);
  const completedOrder = { ...ledger.order, status: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
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
renderCompleted();
renderWarehouseTags();
renderOrderLedger();
renderKilnSettingsReport();
