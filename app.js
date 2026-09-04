const MIN_BOARD_LENGTH = 3;
const MAX_BOARD_LENGTH = 20;
const DEFAULT_LENGTHS = Array.from(
  { length: MAX_BOARD_LENGTH - MIN_BOARD_LENGTH + 1 },
  (_, index) => MIN_BOARD_LENGTH + index
);
const DEFAULT_QUANTITIES = new Map([
  [6, 36], [7, 106], [8, 522], [9, 104], [10, 1079], [11, 88],
  [12, 320], [13, 78], [14, 240], [16, 226], [18, 264], [19, 184], [20, 328],
]);
const $ = (id) => document.getElementById(id);
let currentLoadNumber = 1;
let currentLoadSnapshot = null;
const manualLiftTargets = new Map();
const manualLiftStickers = new Map();
const dryingPrograms = new Map();
const thermoPrograms = new Map();
const loadRecords = new Map();
let globalOrderSignature = '';
let globalOrderPlans = [];
let highsEngine = null;
let highsPromise = null;
let calculationRunning = false;
let calculationDirty = false;
const SUPPLIER_PROFILE_STORAGE = 'kiln-planner-supplier-profiles-v1';
const LAST_SUPPLIER_STORAGE = 'kiln-planner-last-supplier-v1';
const COMPLETED_CYCLES_STORAGE = 'kiln-planner-completed-cycles-v1';
const REMAINDER_INVENTORY_STORAGE = 'kiln-planner-remainder-inventory-v1';
const ACTIVE_ORDER_STORAGE = 'kiln-planner-active-order-v1';
const ORDER_INDEX_STORAGE = 'kiln-planner-order-index-v1';
const ORDER_STORAGE_PREFIX = 'kiln-planner-order-v1:';
let completingLoadNumber = null;
let editingDryingLoadNumber = null;
let editingThermoLoadNumber = null;
let editingManualLoadNumber = null;
let dryingBaselineRows = [];
let dryingCalculatedScenarioRows = null;
let activeOrder = null;
let draftSaveTimer = 0;

function newOrderNumber() {
  return `ORD-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(Date.now()).slice(-4)}`;
}
function readActiveOrder() {
  try {
    const value = JSON.parse(localStorage.getItem(ACTIVE_ORDER_STORAGE) || 'null');
    return value?.orderRef ? readStoredOrder(value.orderRef) : value;
  } catch (_) { return null; }
}
function orderStorageKey(id) { return `${ORDER_STORAGE_PREFIX}${id}`; }
function writeActiveOrderPointer(order) {
  localStorage.setItem(ACTIVE_ORDER_STORAGE, JSON.stringify({ orderRef: order.id }));
}
function readOrderIndex() {
  try {
    const value = JSON.parse(localStorage.getItem(ORDER_INDEX_STORAGE) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) { return []; }
}
function orderMetadata(order) {
  return { id: order.id, number: order.number, supplier: order.inputs?.supplier || '', status: order.status || 'active', updatedAt: order.updatedAt || order.createdAt || new Date().toISOString(), plannedCycles: order.plannedCycles || 0 };
}
function storeOrder(order) {
  if (!order?.id) return;
  localStorage.setItem(orderStorageKey(order.id), JSON.stringify(order));
  const index = readOrderIndex();
  const metadata = orderMetadata(order);
  const position = index.findIndex((item) => item.id === order.id);
  if (position >= 0) index[position] = metadata; else index.push(metadata);
  index.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  localStorage.setItem(ORDER_INDEX_STORAGE, JSON.stringify(index));
}
function readStoredOrder(id) {
  try { return JSON.parse(localStorage.getItem(orderStorageKey(id)) || 'null'); } catch (_) { return null; }
}
function recoverWestminster334605(order) {
  if (!order || order.recoveryVersion === 'ord-334605-v1') return order;
  const number = String(order.number || '').toUpperCase().replace(/\s+/g, '');
  const supplier = String(order.inputs?.supplier || '').toLowerCase();
  const inventoryTotal = Object.values(order.inventory || {}).reduce((sum, quantity) => sum + Math.max(0, Number(quantity) || 0), 0);
  const matchingOrder = number === 'ORD-334605' || number === '334605';
  const matchingSupplier = supplier.includes('westminster');
  if (!matchingOrder || inventoryTotal !== 0) return order;
  if (!matchingSupplier) order.inputs = { ...(order.inputs || {}), supplier: 'Westminster', supplierClearance: '1' };

  order.inventory = Object.fromEntries(DEFAULT_QUANTITIES);
  order.calculated = false;
  order.plannedCycles = 0;
  order.plannedBoards = 0;
  order.plannedBf = 0;
  order.updatedAt = new Date().toISOString();
  order.recoveryVersion = 'ord-334605-v1';
  delete order.planSignature;
  delete order.calculatedAt;
  delete order.viewCache;
  storeOrder(order);
  writeActiveOrderPointer(order);
  return order;
}
function renderOrderSelector() {
  const selector = $('orderSelector');
  if (!selector || !activeOrder) return;
  let index = readOrderIndex();
  if (!index.some((item) => item.id === activeOrder.id)) {
    storeOrder(activeOrder);
    index = readOrderIndex();
  }
  selector.innerHTML = index.filter((item) => item.status !== 'completed').map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === activeOrder.id ? 'selected' : ''}>${escapeHtml(item.number || 'Untitled order')} · ${escapeHtml(item.supplier || 'supplier not entered')} · ${item.plannedCycles || 0} loads</option>`).join('');
}
function scheduleDraftSave() {
  window.clearTimeout(draftSaveTimer);
  $('orderSaveState').textContent = 'Unsaved changes…';
  draftSaveTimer = window.setTimeout(() => {
    if (calculationDirty) {
      activeOrder.calculated = false;
      delete activeOrder.viewCache;
    }
    persistActiveOrder(false);
    $('orderSaveState').textContent = 'Draft saved and synchronized';
  }, 450);
}
async function switchOrder(id) {
  if (!id || id === activeOrder?.id) return;
  window.clearTimeout(draftSaveTimer);
  persistActiveOrder(false);
  const next = readStoredOrder(id);
  if (!next) return;
  writeActiveOrderPointer(next);
  $('orderSaveState').textContent = 'Opening order…';
  if (window.kilnCloudFlush) await window.kilnCloudFlush();
  window.location.reload();
}
async function createOrder() {
  window.clearTimeout(draftSaveTimer);
  persistActiveOrder(false);
  const suggested = newOrderNumber();
  const number = window.prompt('Enter the new order / batch number:', suggested)?.trim();
  if (!number) return;
  if (readOrderIndex().some((item) => String(item.number).toLowerCase() === number.toLowerCase() && item.status !== 'completed')) {
    window.alert('An active order with this number already exists. Open it from the list.');
    return;
  }
  const order = { id: `order-${Date.now()}`, number, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), inventory: {}, liftStickerOverrides: {} };
  storeOrder(order);
  writeActiveOrderPointer(order);
  $('orderSaveState').textContent = 'Creating and synchronizing order…';
  if (window.kilnCloudFlush) await window.kilnCloudFlush();
  window.location.reload();
}
function inputSnapshot() {
  const ids = ['supplier','supplierClearance','species','size','customT','customW','batchProfile','kiln','height','maxStack','metalBox','actualT','actualW','liftWidth','sticker','topSticker'];
  return Object.fromEntries(ids.map((id) => [id, $(id).value]));
}
function inventorySnapshot() { return Object.fromEntries([...readInventory()]); }
const CACHED_HTML_IDS = ['status','resultIntro','liftEditor','productionNeed','orderLoads','orderRemaining','plan','shortage','cycleYield','visualMeta','kilnVisual','finalInventoryVisual','residualsTableBody','optimizationAudit','manualFillSummary'];
const CACHED_TEXT_IDS = ['rows','lines','needPieces','capacity','capacityLabel','loadBF','fillPct','missingBF','unusedBF','visualTitle','qtyTotal','beforeTotal','usedTotal','remainTotal'];
function serializeLoadRecords() {
  return [...loadRecords.values()].map((record) => ({ ...record, available: Object.fromEntries(record.available), used: Object.fromEntries(record.used), remaining: Object.fromEntries(record.remaining) }));
}
function serializeCalculatedPlans() {
  const compactPlans = globalOrderPlans.map((plan) => ({
    stock: plan.stock,
    availableStock: plan.availableStock,
    usedMap: plan.usedMap,
    usedFt: plan.usedFt,
    complete: plan.complete,
    activeLength: plan.activeLength,
    minRows: plan.minRows,
    maxRows: plan.maxRows,
    fullLifts: plan.fullLifts,
    metal: plan.metal,
    target: plan.target,
    chamberGap: plan.chamberGap,
    completeLoad: plan.completeLoad,
    valid: plan.valid,
    heightSpread: plan.heightSpread,
    stability: plan.stability,
    activeStates: (plan.activeStates || []).map((state) => ({
      length: state.length,
      index: state.index,
      rowCapacity: state.rowCapacity,
      stickerThickness: state.stickerThickness,
      usedHeight: state.usedHeight,
      rowsLeft: state.rowsLeft,
      linesLeft: state.linesLeft,
      groups: state.groups,
      rowSequence: state.rowSequence,
      manualRows: state.manualRows || [],
    })),
  }));
  return JSON.stringify(compactPlans, (_, value) => value instanceof Map ? { __kilnMap: [...value] } : value);
}
function numericMap(value) {
  if (value instanceof Map) return new Map(value);
  if (value && Array.isArray(value.__kilnMap)) return new Map(value.__kilnMap.map(([key, item]) => [Number(key), item]));
  if (Array.isArray(value)) return new Map(value.map(([key, item]) => [Number(key), item]));
  if (value && typeof value === 'object') return new Map(Object.entries(value).map(([key, item]) => [Number(key), item]));
  return new Map();
}
function restorePlanTypes(plan) {
  const availableStock = numericMap(plan?.availableStock);
  const usedMap = numericMap(plan?.usedMap);
  let stock = numericMap(plan?.stock);
  if (!stock.size && availableStock.size) {
    stock = new Map([...availableStock].map(([length, quantity]) => [
      length,
      Math.max(0, Number(quantity || 0) - Number(usedMap.get(length) || 0)),
    ]));
  }
  const activeStates = (plan?.activeStates || plan?.states || []).map((state) => ({
    ...state,
    groups: state.groups instanceof Map
      ? new Map(state.groups)
      : state.groups?.__kilnMap
        ? new Map(state.groups.__kilnMap)
        : new Map(Object.entries(state.groups || {})),
  }));
  return { ...plan, stock, availableStock, usedMap, states: activeStates, activeStates };
}
function deserializeCalculatedPlans(value) {
  if (!value) return [];
  try {
    const plans = typeof value === 'string'
      ? JSON.parse(value, (_, item) => item && Array.isArray(item.__kilnMap) ? new Map(item.__kilnMap) : item)
      : value;
    return Array.isArray(plans) ? plans.map(restorePlanTypes) : [];
  } catch (_) {
    return [];
  }
}
function restoreLoadRecordsFromPlans(plans) {
  if (!plans.length) return false;
  loadRecords.clear();
  plans.forEach((plan, index) => {
    const number = index + 1;
    const available = plan.availableStock instanceof Map ? plan.availableStock : new Map();
    const used = plan.usedMap instanceof Map ? plan.usedMap : new Map();
    const remaining = plan.stock instanceof Map ? plan.stock : new Map();
    const usedBoards = [...used.values()].reduce((sum, quantity) => sum + quantity, 0);
    loadRecords.set(number, {
      number,
      available: new Map(available),
      used: new Map(used),
      remaining: new Map(remaining),
      usedBoards,
      remainingBoards: [...remaining.values()].reduce((sum, quantity) => sum + quantity, 0),
      usedBf: bf(1, Number(plan.usedFt) || 0),
      valid: plan.valid !== false,
      layout: (plan.activeStates || []).map((state) => `${state.length} ft`).join(' → ') || '—',
      global: true,
    });
  });
  return true;
}
function cacheRenderedCalculation() {
  return { currentLoadNumber, signature: globalOrderSignature, plans: serializeCalculatedPlans(), html: Object.fromEntries(CACHED_HTML_IDS.map((id) => [id, $(id)?.innerHTML || ''])), text: Object.fromEntries(CACHED_TEXT_IDS.map((id) => [id, $(id)?.textContent || ''])), inventoryCells: [...document.querySelectorAll('#inventory tr')].map((row) => ({ before: row.querySelector('.before')?.textContent || '0', used: row.querySelector('.used')?.textContent || '0', remain: row.querySelector('.remain')?.textContent || '0' })), records: serializeLoadRecords() };
}
function restoreRenderedCalculation() {
  const cache = activeOrder?.viewCache;
  if (!cache?.records?.length) return false;
  const restoredPlans = deserializeCalculatedPlans(cache.plans);
  if (!restoredPlans.length) return false;
  Object.entries(cache.html || {}).forEach(([id, value]) => { if ($(id)) $(id).innerHTML = value; });
  Object.entries(cache.text || {}).forEach(([id, value]) => { if ($(id)) $(id).textContent = value; });
  [...document.querySelectorAll('#inventory tr')].forEach((row, index) => { const cells = cache.inventoryCells?.[index]; if (!cells) return; row.querySelector('.before').textContent = cells.before; row.querySelector('.used').textContent = cells.used; row.querySelector('.remain').textContent = cells.remain; });
  loadRecords.clear();
  cache.records.forEach((record) => loadRecords.set(record.number, { ...record, available: new Map(Object.entries(record.available || {}).map(([k,v]) => [Number(k),v])), used: new Map(Object.entries(record.used || {}).map(([k,v]) => [Number(k),v])), remaining: new Map(Object.entries(record.remaining || {}).map(([k,v]) => [Number(k),v])) }));
  currentLoadNumber = Number(cache.currentLoadNumber || 1);
  globalOrderPlans = restoredPlans;
  globalOrderSignature = globalOrderPlans.length ? (cache.signature || activeOrder.planSignature || '') : '';
  restoreLoadRecordsFromPlans(globalOrderPlans);
  currentLoadNumber = loadRecords.has(currentLoadNumber) ? currentLoadNumber : 1;
  currentLoadSnapshot = loadRecords.get(currentLoadNumber) || loadRecords.get(1);
  $('loadNumber').textContent = currentLoadNumber;
  $('nextLoad').disabled = !loadRecords.has(currentLoadNumber + 1);
  renderLoadNavigation();
  calculationDirty = false;
  $('calculationStatus').className = 'calculation-status ready';
  $('calculationStatus').textContent = 'Saved calculation restored. Change an input and click Calculate Load to optimize again.';
  $('calc').textContent = 'Recalculate Load';
  return true;
}
function persistActiveOrder(calculated = false) {
  if (!activeOrder) activeOrder = { id: `order-${Date.now()}`, createdAt: new Date().toISOString() };
  activeOrder.number = $('orderNumber').value.trim() || activeOrder.number || newOrderNumber();
  $('orderNumber').value = activeOrder.number;
  activeOrder.status = 'active';
  activeOrder.updatedAt = new Date().toISOString();
  activeOrder.inputs = inputSnapshot();
  activeOrder.inventory = inventorySnapshot();
  activeOrder.liftStickerOverrides = Object.fromEntries(manualLiftStickers);
  activeOrder.liftTargetOverrides = Object.fromEntries(manualLiftTargets);
  activeOrder.dryingPrograms = Object.fromEntries(dryingPrograms);
  activeOrder.thermoPrograms = Object.fromEntries(thermoPrograms);
  if (calculated) {
    activeOrder.calculated = true;
    activeOrder.planSignature = globalOrderSignature;
    activeOrder.plannedCycles = loadRecords.size;
    activeOrder.plannedBoards = [...loadRecords.values()].reduce((sum, item) => sum + item.usedBoards, 0);
    activeOrder.plannedBf = [...loadRecords.values()].reduce((sum, item) => sum + item.usedBf, 0);
    activeOrder.calculatedAt = new Date().toISOString();
    activeOrder.optimizerVersion = 'frozen-cycles-global-rows-v5';
    activeOrder.viewCache = cacheRenderedCalculation();
  }
  storeOrder(activeOrder);
  writeActiveOrderPointer(activeOrder);
  $('orderState').textContent = activeOrder.calculated ? `ACTIVE · ${activeOrder.plannedCycles || 0} KILN LOADS` : 'ACTIVE DRAFT';
  renderOrderSelector();
}

function readCompletedCycles() {
  try {
    const value = JSON.parse(localStorage.getItem(COMPLETED_CYCLES_STORAGE) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function writeCompletedCycles(records) {
  localStorage.setItem(COMPLETED_CYCLES_STORAGE, JSON.stringify(records));
}

function completionRecordId(loadNumber) {
  return `${activeOrder?.id || globalOrderSignature || 'current-order'}::${loadNumber}`;
}

function isLoadCompleted(loadNumber) {
  const id = completionRecordId(loadNumber);
  return readCompletedCycles().some((record) => record.id === id);
}

function isLoadInProgress(loadNumber) {
  return Number(activeOrder?.activeCycleNumber || 0) === Number(loadNumber) && !isLoadCompleted(loadNumber);
}

function lockedLoadNumbers() {
  const locked = new Set();
  readCompletedCycles().forEach((record) => {
    if (record.orderId === activeOrder?.id && Number(record.loadNumber) > 0) locked.add(Number(record.loadNumber));
  });
  const active = Number(activeOrder?.activeCycleNumber || 0);
  if (active > 0) locked.add(active);
  globalOrderPlans.forEach((plan, index) => {
    if ((plan.activeStates || []).some((state) => (state.manualRows || []).length > 0)) locked.add(index + 1);
  });
  return locked;
}

function isLoadLocked(loadNumber) {
  return lockedLoadNumbers().has(Number(loadNumber));
}

function supplierStorageKey(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function isWestminsterSupplier(value) {
  const normalized = String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.includes('westminster')
    || normalized.includes('westminister')
    || normalized.includes('newwest');
}

function applySupplierClearanceRule() {
  const clearance = isWestminsterSupplier($('supplier').value) ? 1 : 0;
  $('supplierClearance').value = String(clearance);
  return clearance;
}

function readSupplierProfiles() {
  try {
    return JSON.parse(localStorage.getItem(SUPPLIER_PROFILE_STORAGE) || '{}');
  } catch (_) {
    return {};
  }
}

function saveSupplierProfile() {
  const supplier = $('supplier').value.trim();
  if (!supplier) return;
  const profiles = readSupplierProfiles();
  profiles[supplierStorageKey(supplier)] = {
    name: supplier,
    clearance: Math.max(0, Math.floor(Number($('supplierClearance').value) || 0)),
  };
  try {
    localStorage.setItem(SUPPLIER_PROFILE_STORAGE, JSON.stringify(profiles));
    localStorage.setItem(LAST_SUPPLIER_STORAGE, supplier);
  } catch (_) {
    // Storage can be unavailable in private browsing; calculation still works.
  }
}

function loadSupplierProfile() {
  const supplier = $('supplier').value.trim();
  if (!supplier) {
    $('supplierClearance').value = '0';
    return;
  }
  // Westminster's cutting allowance is a production rule, not an optional
  // preference. Every other supplier currently defaults to the full 34 ft.
  applySupplierClearanceRule();
}

function loadOptimizer() {
  if (highsEngine) return Promise.resolve(highsEngine);
  if (highsPromise) return highsPromise;
  highsPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'vendor/highs.js';
    script.onload = () => {
      if (typeof Module === 'undefined') {
        resolve(null);
        return;
      }
      Module({ locateFile: (file) => `vendor/${file}` })
        .then((engine) => {
          highsEngine = engine;
          globalOrderSignature = '';
          resolve(engine);
        })
        .catch((error) => {
          console.error('HiGHS optimizer failed to initialize; using local fallback:', error);
          resolve(null);
        });
    };
    script.onerror = () => {
      console.error('HiGHS optimizer could not be loaded; using local fallback.');
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return highsPromise;
}

function markCalculationPending() {
  if (calculationDirty) return;
  calculationDirty = true;
  const status = $('calculationStatus');
  if (!status) return;
  status.className = 'calculation-status pending';
  status.textContent = 'Inputs changed — click Calculate Load to optimize the order.';
  $('calc').textContent = 'Calculate Load';
}

function runCalculation() {
  if (calculationRunning) return;
  window.clearTimeout(draftSaveTimer);
  calculationRunning = true;
  const button = $('calc');
  const optimizeButton = $('optimizeRemaining');
  const status = $('calculationStatus');
  button.disabled = true;
  optimizeButton.disabled = true;
  button.classList.add('is-loading');
  status.className = 'calculation-status loading';
  status.innerHTML = '<i></i><span>Optimizing complete rows, lifts, and kiln cycles…</span>';

  requestAnimationFrame(() => window.setTimeout(async () => {
    try {
      calculate(true);
      persistActiveOrder(true);
      calculationDirty = false;
      status.className = 'calculation-status ready';
      const locked = [...lockedLoadNumbers()].sort((left, right) => left - right);
      status.textContent = locked.length
        ? `Unstarted cycles optimized. Locked cycles ${locked.map((number) => `#${number}`).join(', ')} were preserved exactly.`
        : 'Calculation complete. Change an input and calculate again to create a new plan.';
      button.textContent = 'Recalculate Load';
    } catch (error) {
      console.error('Kiln calculation failed:', error);
      status.className = 'calculation-status pending';
      status.textContent = error?.name === 'QuotaExceededError'
        ? 'The optimized plan was created, but browser storage is full. Remove obsolete saved orders and calculate again.'
        : `Calculation could not be completed: ${error?.message || 'check the entered dimensions and quantities, then try again.'}`;
    } finally {
      calculationRunning = false;
      button.disabled = false;
      optimizeButton.disabled = false;
      button.classList.remove('is-loading');
    }
  }, 30));
}

function applyManualLiftChanges() {
  if (calculationRunning) return;
  if (!globalOrderPlans.length) {
    runCalculation();
    return;
  }
  const lockedCycles = [...lockedLoadNumbers()].sort((left, right) => left - right);
  if (lockedCycles.length) {
    const status = $('calculationStatus');
    status.className = 'calculation-status pending';
    status.textContent = `Structural lift settings are locked to preserve cycle${lockedCycles.length === 1 ? '' : 's'} ${lockedCycles.map((number) => `#${number}`).join(', ')}. Operator boards can still be added with the manual-fill button.`;
    return;
  }
  window.clearTimeout(draftSaveTimer);
  calculationRunning = true;
  const button = $('applyLiftChanges');
  const status = $('calculationStatus');
  button.disabled = true;
  button.classList.add('is-loading');
  status.className = 'calculation-status loading';
  status.innerHTML = '<i></i><span>Applying manual lift configuration…</span>';

  requestAnimationFrame(() => window.setTimeout(() => {
    try {
      const physicalKilnLength = Math.floor(num('kiln'));
      const safetyClearance = Math.min(Math.max(0, physicalKilnLength - 1), Math.floor(num('supplierClearance')));
      const kilnLength = Math.max(1, physicalKilnLength - safetyClearance);
      const selectedMetal = Math.floor(Number($('metalBox').value));
      const maxStack = Math.floor(num('maxStack'));
      const geometry = computeGeometry();
      const originalStock = readInventory();
      const savedPlans = globalOrderPlans.map(restorePlanTypes);
      const adjustedPlans = applyLiftTargetOverrides(
        applyLiftStickerOverrides(savedPlans, originalStock, geometry),
        originalStock,
        geometry,
      ).map(restorePlanTypes);
      globalOrderPlans = rebuildPlanBalances(adjustedPlans, originalStock, geometry, kilnLength).map(restorePlanTypes);
      globalOrderSignature = orderSignature(originalStock, geometry, kilnLength, maxStack, selectedMetal);
      currentLoadNumber = Math.min(currentLoadNumber, Math.max(1, globalOrderPlans.length));
      calculate(false);
      persistActiveOrder(true);
      calculationDirty = false;
      status.className = 'calculation-status ready';
      status.textContent = 'Manual lift settings applied to calculation, inventory balance, and visualization.';
      $('calc').textContent = 'Recalculate Load';
    } catch (error) {
      console.error('Manual lift configuration failed:', error);
      status.className = 'calculation-status pending';
      status.textContent = `Manual changes could not be applied: ${error?.message || 'check the lift settings.'}`;
    } finally {
      calculationRunning = false;
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }, 30));
}

function num(id) {
  return Math.max(0, Number($(id).value) || 0);
}

function board() {
  if ($('size').value === 'custom') {
    return { thickness: num('customT'), width: num('customW') };
  }
  const [thickness, width] = $('size').value.split(',').map(Number);
  return { thickness, width };
}

function materialSizeLabel() {
  const { thickness, width } = board();
  return `${fmtMeasure(thickness)} × ${fmtMeasure(width)}`;
}

function physicalDimensionsForProfile() {
  const nominal = board();
  const profile = $('batchProfile').value;
  if (profile === 'manual' || $('size').value === 'custom') {
    return { thickness: num('actualT'), width: num('actualW') };
  }
  if (profile === 'dressed') {
    return {
      thickness: nominal.thickness === 1 ? 0.75 : nominal.thickness === 2 ? 1.5 : nominal.thickness,
      width: nominal.width === 4 ? 3.5 : nominal.width === 6 ? 5.5 : nominal.width,
    };
  }
  return nominal;
}

function applyPhysicalProfile() {
  const manual = $('batchProfile').value === 'manual';
  // Physical dimensions remain editable for every profile. Typing into either
  // field switches the batch to Manual automatically.
  $('actualT').disabled = false;
  $('actualW').disabled = false;
  if (manual) return;
  const dimensions = physicalDimensionsForProfile();
  $('actualT').value = String(dimensions.thickness);
  $('actualW').value = String(dimensions.width);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function bf(length, qty = 1) {
  const { thickness, width } = board();
  return (thickness * width * length * qty) / 12;
}

function fmt(value, digits = 0) {
  return Number(value).toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  });
}

function fmtMeasure(value, digits = 3) {
  return `${Number(value).toLocaleString('en-US', { maximumFractionDigits: digits })}″`;
}

function addRow(length, quantity = 0) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input class="len" type="number" min="${MIN_BOARD_LENGTH}" max="${MAX_BOARD_LENGTH}" step="1" value="${length}" /></td>
    <td><input class="qty" type="number" min="0" step="1" value="${quantity}" /></td>
    <td class="before">0</td>
    <td class="used">0</td>
    <td class="remain">0</td>
  `;

  $('inventory').appendChild(row);
  row.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      markCalculationPending();
      scheduleDraftSave();
    });
  });

  const quantityInput = row.querySelector('.qty');
  const selectPlaceholderZero = () => {
    if (Number(quantityInput.value) === 0) {
      requestAnimationFrame(() => quantityInput.select());
    }
  };
  quantityInput.addEventListener('focus', selectPlaceholderZero);
  quantityInput.addEventListener('click', selectPlaceholderZero);
  quantityInput.addEventListener('blur', () => {
    if (quantityInput.value.trim() === '') quantityInput.value = '0';
  });
}

function buildInventoryRows() {
  DEFAULT_LENGTHS.forEach((length) => {
    addRow(length, Number(activeOrder?.inventory?.[length] || 0));
  });
}

function readInventory() {
  const stock = new Map();

  document.querySelectorAll('#inventory tr').forEach((row) => {
    const length = Math.floor(Number(row.querySelector('.len').value) || 0);
    const quantity = Math.floor(Number(row.querySelector('.qty').value) || 0);

    if (length >= MIN_BOARD_LENGTH && length <= MAX_BOARD_LENGTH && quantity > 0) {
      stock.set(length, (stock.get(length) || 0) + quantity);
    }

  });

  return stock;
}

function readRemainderInventory() {
  try {
    const value = JSON.parse(localStorage.getItem(REMAINDER_INVENTORY_STORAGE) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function normalizedProductSize(value) {
  return String(value || '').toLowerCase().replace(/[×x]/g, ',').replace(/\s+/g, '');
}

function remainderSpecies(record) {
  return String(record.species || String(record.product || '').split('·')[0] || '').trim().toLowerCase();
}

function compatibleRemainder(record) {
  const sizeMatches = normalizedProductSize(record.size) === normalizedProductSize($('size').value);
  const sourceSpecies = remainderSpecies(record);
  const speciesMatches = !sourceSpecies || sourceSpecies === $('species').value.trim().toLowerCase();
  if (!sizeMatches || !speciesMatches) return false;
  if ($('size').value !== 'custom') return true;
  return Math.abs(Number(record.actualT || 0) - num('actualT')) < 0.0001
    && Math.abs(Number(record.actualW || 0) - num('actualW')) < 0.0001;
}

function orderHasProductionActivity() {
  if (Number(activeOrder?.activeCycleNumber || 0) > 0) return true;
  return readCompletedCycles().some((record) =>
    record.orderId === activeOrder?.id
    || record.orderId === activeOrder?.planSignature
    || record.orderNumber === activeOrder?.number
  );
}

function remainderBf(record) {
  const dimensions = String(record.size || '').match(/[\d.]+/g)?.map(Number) || [];
  const thickness = dimensions[0] || Number(record.actualT || 0);
  const width = dimensions[1] || Number(record.actualW || 0);
  return DEFAULT_LENGTHS.reduce(
    (sum, length) => sum + thickness * width * length * Number(record.quantities?.[length] || 0) / 12,
    0
  );
}

function openRemainderTransfer() {
  const status = $('remainderTransferStatus');
  if (orderHasProductionActivity()) {
    status.className = 'calculation-status pending';
    status.textContent = 'Boards cannot be added after a kiln cycle has started or been completed for this order.';
    $('remainderTransferRows').innerHTML = '';
    $('confirmRemainderTransfer').disabled = true;
    $('remainderTransferDialog').showModal();
    return;
  }
  const currentSpecies = $('species').value.trim() || 'Unspecified species';
  const currentSize = $('size').selectedOptions[0]?.textContent || $('size').value;
  $('remainderTransferProduct').innerHTML = `Current order accepts: <b>${escapeHtml(currentSpecies)} · ${escapeHtml(currentSize)}</b>. Only matching product is shown.`;
  const compatible = readRemainderInventory().filter((record) =>
    compatibleRemainder(record) && Object.values(record.quantities || {}).some((quantity) => Number(quantity) > 0)
  );
  const rows = compatible.flatMap((record) =>
    DEFAULT_LENGTHS
      .filter((length) => Number(record.quantities?.[length] || 0) > 0)
      .map((length) => `<tr><td><b>${escapeHtml(record.orderNumber || '—')}</b></td><td>${escapeHtml(record.supplier || '—')}</td><td>${escapeHtml(record.product || record.size || '—')}</td><td>${length} ft</td><td><b>${fmt(record.quantities[length])}</b></td><td><input class="remainder-transfer-qty" type="number" min="0" max="${Number(record.quantities[length])}" step="1" value="0" data-record-id="${escapeHtml(record.id)}" data-length="${length}" /></td></tr>`)
  );
  $('remainderTransferRows').innerHTML = rows.join('');
  $('confirmRemainderTransfer').disabled = !rows.length;
  status.className = `calculation-status ${rows.length ? 'idle' : 'pending'}`;
  status.textContent = rows.length
    ? 'Enter quantities and confirm. The transfer will invalidate any saved calculation, but recalculation starts only when you press Calculate Load.'
    : 'No compatible remainder is available for this species and board size.';
  $('remainderTransferDialog').showModal();
}

function addTransferredQuantity(length, quantity) {
  const rows = [...document.querySelectorAll('#inventory tr')];
  let row = rows.find((candidate) => Number(candidate.querySelector('.len')?.value) === Number(length));
  if (!row) {
    addRow(length, 0);
    row = [...document.querySelectorAll('#inventory tr')].at(-1);
  }
  const input = row.querySelector('.qty');
  input.value = Number(input.value || 0) + Number(quantity || 0);
}

function clearInvalidatedCalculationView() {
  loadRecords.clear();
  globalOrderPlans = [];
  globalOrderSignature = '';
  currentLoadSnapshot = null;
  currentLoadNumber = 1;
  $('loadNumber').textContent = '1';
  $('nextLoad').disabled = true;
  ['resultIntro', 'liftEditor', 'productionNeed', 'orderLoads', 'orderRemaining', 'plan', 'shortage', 'cycleYield', 'visualMeta', 'kilnVisual', 'finalInventoryVisual', 'residualsTableBody']
    .forEach((id) => { if ($(id)) $(id).innerHTML = ''; });
  ['rows', 'lines', 'needPieces', 'capacity', 'loadBF', 'fillPct', 'missingBF', 'unusedBF', 'beforeTotal', 'usedTotal', 'remainTotal']
    .forEach((id) => { if ($(id)) $(id).textContent = '0'; });
  $('qtyTotal').textContent = fmt([...readInventory().values()].reduce((sum, quantity) => sum + quantity, 0));
  document.querySelectorAll('#inventory tr').forEach((row) => {
    row.querySelector('.before').textContent = '0';
    row.querySelector('.used').textContent = '0';
    row.querySelector('.remain').textContent = '0';
  });
  renderLoadNavigation();
}

function applyRemainderTransfer(event) {
  event.preventDefault();
  if (orderHasProductionActivity()) {
    $('remainderTransferStatus').className = 'calculation-status pending';
    $('remainderTransferStatus').textContent = 'Transfer stopped because production activity already exists for this order.';
    return;
  }
  const requested = [...document.querySelectorAll('.remainder-transfer-qty')]
    .map((input) => ({
      id: input.dataset.recordId,
      length: Number(input.dataset.length),
      quantity: Math.floor(Number(input.value || 0)),
    }))
    .filter((item) => item.quantity > 0);
  if (!requested.length) {
    $('remainderTransferStatus').className = 'calculation-status pending';
    $('remainderTransferStatus').textContent = 'Enter at least one quantity to transfer.';
    return;
  }
  const records = readRemainderInventory();
  const grouped = new Map();
  for (const item of requested) {
    const record = records.find((candidate) => candidate.id === item.id);
    const available = Number(record?.quantities?.[item.length] || 0);
    if (!record || !compatibleRemainder(record) || item.quantity > available) {
      $('remainderTransferStatus').className = 'calculation-status pending';
      $('remainderTransferStatus').textContent = 'Available remainder changed or the product no longer matches. Close and reopen this window.';
      return;
    }
    if (!grouped.has(item.id)) grouped.set(item.id, {});
    grouped.get(item.id)[item.length] = item.quantity;
  }

  const previousRemainders = localStorage.getItem(REMAINDER_INVENTORY_STORAGE);
  const previousOrder = localStorage.getItem(orderStorageKey(activeOrder.id));
  try {
    records.forEach((record) => {
      const quantities = grouped.get(record.id);
      if (!quantities) return;
      if (!record.originalQuantities) record.originalQuantities = { ...(record.quantities || {}) };
      Object.entries(quantities).forEach(([length, quantity]) => {
        record.quantities[length] = Number(record.quantities[length] || 0) - Number(quantity);
        addTransferredQuantity(Number(length), Number(quantity));
      });
      record.transfers = [...(record.transfers || []), {
        destinationOrderId: activeOrder.id,
        destinationOrderNumber: $('orderNumber').value.trim() || activeOrder.number,
        quantities,
        movedAt: new Date().toISOString(),
      }];
      record.boards = Object.values(record.quantities || {}).reduce((sum, quantity) => sum + Number(quantity || 0), 0);
      record.bf = remainderBf(record);
      record.updatedAt = new Date().toISOString();
    });

    localStorage.setItem(REMAINDER_INVENTORY_STORAGE, JSON.stringify(records));
    activeOrder.remainderTransfers = [
      ...(activeOrder.remainderTransfers || []),
      ...[...grouped.entries()].map(([sourceRemainderId, quantities]) => ({
        sourceRemainderId,
        quantities,
        movedAt: new Date().toISOString(),
      })),
    ];
    activeOrder.calculated = false;
    activeOrder.plannedCycles = 0;
    activeOrder.plannedBoards = 0;
    activeOrder.plannedBf = 0;
    delete activeOrder.planSignature;
    delete activeOrder.calculatedAt;
    delete activeOrder.viewCache;
    clearInvalidatedCalculationView();
    markCalculationPending();
    persistActiveOrder(false);
  } catch (error) {
    if (previousRemainders === null) localStorage.removeItem(REMAINDER_INVENTORY_STORAGE);
    else localStorage.setItem(REMAINDER_INVENTORY_STORAGE, previousRemainders);
    if (previousOrder === null) localStorage.removeItem(orderStorageKey(activeOrder.id));
    else localStorage.setItem(orderStorageKey(activeOrder.id), previousOrder);
    window.location.reload();
    return;
  }
  $('remainderTransferDialog').close();
  $('orderSaveState').textContent = 'Remainder transferred, saved and synchronized';
}

function computeGeometry() {
  const height = num('height');
  const actualT = num('actualT');
  const actualW = num('actualW');
  const liftWidth = num('liftWidth');
  const sticker = num('sticker');
  const topSticker = Number($('topSticker').value);
  const across = actualW > 0 ? Math.floor(liftWidth / actualW) : 0;

  $('across').value = across;

  let rows = 0;
  let usedHeight = 0;

  for (let n = 1; n < 500; n += 1) {
    const nextHeight = n * actualT + (topSticker ? n * sticker : Math.max(0, n - 1) * sticker);
    if (nextHeight <= height + 1e-9) {
      rows = n;
      usedHeight = nextHeight;
    } else {
      break;
    }
  }

  return {
    rows,
    usedHeight,
    across,
    usedWidth: across * actualW,
    widthWaste: Math.max(0, liftWidth - across * actualW),
    lines: rows * across,
  };
}

function geometryForSticker(sticker, baseGeometry = computeGeometry()) {
  const height = num('height');
  const actualT = num('actualT');
  const topSticker = Number($('topSticker').value);
  let rows = 0;
  let usedHeight = 0;
  for (let n = 1; n < 500; n += 1) {
    const nextHeight = n * actualT + (topSticker ? n * sticker : Math.max(0, n - 1) * sticker);
    if (nextHeight > height + 1e-9) break;
    rows = n;
    usedHeight = nextHeight;
  }
  return { ...baseGeometry, rows, usedHeight, lines: rows * baseGeometry.across, sticker };
}

function physicalHeightForRows(rows, sticker) {
  const count = Math.max(0, Math.floor(Number(rows) || 0));
  if (!count) return 0;
  const boardThickness = num('actualT');
  const hasTopSticker = Number($('topSticker').value) > 0;
  return count * boardThickness + (hasTopSticker ? count : Math.max(0, count - 1)) * sticker;
}

function liftStickerKey(loadNumber, state, index) {
  return `${loadNumber}:${index}:${state.length}`;
}

function liftGeometry(state, index, geometry, loadNumber = currentLoadNumber) {
  const saved = manualLiftStickers.get(liftStickerKey(loadNumber, state, index));
  const sticker = Number.isFinite(saved) && saved > 0 ? saved : num('sticker');
  return geometryForSticker(sticker, geometry);
}

function rebuildGroups(state) {
  const groups = new Map();
  state.rowSequence.forEach((row) => {
    const usedLength = row.pattern.reduce((sum, length) => sum + length, 0);
    const key = `${patternKey(row.pattern)}|${Math.max(0, state.length - usedLength)}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  });
  return groups;
}

function canTakePattern(stock, pattern, across) {
  const needed = new Map();
  pattern.forEach((length) => needed.set(length, (needed.get(length) || 0) + across));
  return [...needed].every(([length, quantity]) => (stock.get(length) || 0) >= quantity);
}

function takePatternAcross(stock, pattern, across) {
  pattern.forEach((length) => stock.set(length, (stock.get(length) || 0) - across));
}

function applyLiftStickerOverrides(plans, sourceStock, geometry) {
  if (!manualLiftStickers.size) return plans;
  const stock = new Map(sourceStock);
  return plans.map((plan, planIndex) => {
    const availableStock = new Map(stock);
    const usedMap = new Map();
    const activeStates = (plan.activeStates || []).map((sourceState, stateIndex) => {
      const overrideKey = liftStickerKey(planIndex + 1, sourceState, stateIndex);
      const hasOverride = manualLiftStickers.has(overrideKey);
      const stateGeometry = liftGeometry(sourceState, stateIndex, geometry, planIndex + 1);
      const rowSequence = [];
      for (const row of sourceState.rowSequence.slice(0, stateGeometry.rows)) {
        if (!canTakePattern(stock, row.pattern, geometry.across)) break;
        takePatternAcross(stock, row.pattern, geometry.across);
        rowSequence.push({ ...row, pattern: [...row.pattern] });
      }
      while (hasOverride && rowSequence.length < stateGeometry.rows) {
        const pattern = [sourceState.length];
        if (!canTakePattern(stock, pattern, geometry.across)) break;
        takePatternAcross(stock, pattern, geometry.across);
        rowSequence.push({ type: 'solid', pattern });
      }
      rowSequence.forEach((row) => row.pattern.forEach((length) => {
        usedMap.set(length, (usedMap.get(length) || 0) + geometry.across);
      }));
      const state = { ...sourceState, rowSequence, rowCapacity: stateGeometry.rows, stickerThickness: stateGeometry.sticker, usedHeight: stateGeometry.usedHeight };
      state.rowsLeft = stateGeometry.rows - rowSequence.length;
      state.linesLeft = state.rowsLeft * geometry.across;
      state.groups = rebuildGroups(state);
      return state;
    }).filter((state) => state.rowSequence.length);
    const rowCounts = activeStates.map((state) => state.rowSequence.length);
    const complete = rowCounts.reduce((sum, rows) => sum + rows * geometry.across, 0);
    const usedFt = [...usedMap].reduce((sum, [length, quantity]) => sum + length * quantity, 0);
    return { ...plan, states: activeStates, activeStates, availableStock, usedMap, stock: new Map(stock), complete, usedFt,
      fullLifts: activeStates.filter((state) => state.rowSequence.length === state.rowCapacity).length,
      completeLoad: plan.chamberGap === 0 && activeStates.length > 0 && activeStates.every((state) => state.rowSequence.length === state.rowCapacity),
      minRows: rowCounts.length ? Math.min(...rowCounts) : 0,
      maxRows: rowCounts.length ? Math.max(...rowCounts) : 0 };
  }).filter((plan) => plan.usedFt > 0);
}

function applyLiftTargetOverrides(plans, sourceStock, geometry) {
  if (!manualLiftTargets.size) return plans;
  const stock = new Map(sourceStock);
  return plans.map((plan, planIndex) => {
    const availableStock = new Map(stock);
    const usedMap = new Map();
    const activeStates = (plan.activeStates || []).map((sourceState, stateIndex) => {
      const key = `${planIndex + 1}:${stateIndex}:${sourceState.length}`;
      const savedTarget = Number(manualLiftTargets.get(key));
      const rowCapacity = sourceState.rowCapacity || liftGeometry(sourceState, stateIndex, geometry, planIndex + 1).rows;
      const targetRows = Number.isFinite(savedTarget)
        ? Math.max(1, Math.min(rowCapacity, Math.floor(savedTarget)))
        : sourceState.rowSequence.length;
      const rowSequence = [];
      for (const row of sourceState.rowSequence.slice(0, targetRows)) {
        if (!canTakePattern(stock, row.pattern, geometry.across)) break;
        takePatternAcross(stock, row.pattern, geometry.across);
        rowSequence.push({ ...row, pattern: [...row.pattern] });
      }
      rowSequence.forEach((row) => row.pattern.forEach((length) => {
        usedMap.set(length, (usedMap.get(length) || 0) + geometry.across);
      }));
      const state = { ...sourceState, rowSequence, rowCapacity };
      state.rowsLeft = rowCapacity - rowSequence.length;
      state.linesLeft = state.rowsLeft * geometry.across;
      state.groups = rebuildGroups(state);
      return state;
    }).filter((state) => state.rowSequence.length);
    const rowCounts = activeStates.map((state) => state.rowSequence.length);
    const complete = rowCounts.reduce((sum, rows) => sum + rows * geometry.across, 0);
    const usedFt = [...usedMap].reduce((sum, [length, quantity]) => sum + length * quantity, 0);
    return {
      ...plan,
      states: activeStates,
      activeStates,
      availableStock,
      usedMap,
      stock: new Map(stock),
      complete,
      usedFt,
      fullLifts: activeStates.filter((state) => state.rowSequence.length === state.rowCapacity).length,
      completeLoad: plan.chamberGap === 0 && activeStates.length > 0
        && activeStates.every((state) => state.rowSequence.length === state.rowCapacity),
      minRows: rowCounts.length ? Math.min(...rowCounts) : 0,
      maxRows: rowCounts.length ? Math.max(...rowCounts) : 0,
    };
  }).filter((plan) => plan.usedFt > 0);
}

function makePatternLabel(parts) {
  if (!parts || parts.length === 0) {
    return '—';
  }

  const quantities = new Map();
  parts.forEach((length) => quantities.set(length, (quantities.get(length) || 0) + 1));
  return [...quantities.entries()].map(([length, quantity]) => quantity > 1 ? `${quantity} × ${length} ft` : `${length} ft`).join(' + ');
}

function isStableLiftPattern(values) {
  const arr = [...values].map(Number).filter((value) => value > 0);

  if (!arr.length) {
    return { valid: false, label: 'no stable structure' };
  }

  const long = Math.max(...arr);
  const support = arr.filter((value) => value < long);

  if (!support.length) {
    return { valid: true, label: `a = ${long} ft` };
  }

  const hasPair = support.some((value) => arr.includes(long - value));
  const alternating = arr.length >= 2 && arr.every((value, index) => index % 2 === 0 ? value >= 20 : value < 20);
  const valid = hasPair || alternating;

  return {
    valid,
    label: valid
      ? 'a = long board; b = combination c + d = a'
      : 'layout without a stable frame',
  };
}

function patternsForTarget(target, lengths) {
  const unique = [...new Set(lengths.filter((value) => value > 0 && value <= target))].sort((a, b) => b - a);
  const out = [];

  function rec(remaining, start, current) {
    if (remaining === 0) {
      out.push([...current]);
      return;
    }

    for (let index = start; index < unique.length; index += 1) {
      const piece = unique[index];
      if (piece <= remaining) {
        rec(remaining - piece, index, [...current, piece]);
      }
    }
  }

  rec(target, 0, []);
  return out.sort((a, b) => a.length - b.length);
}

function schemesForInventory(woodTarget, lengths) {
  const available = [...new Set(lengths)].filter((length) => length > 0);
  const minimumWoodTarget = Math.max(1, woodTarget - Math.min(6, woodTarget - 1));
  const schemes = [];

  if (available.length === 1) {
    const onlyLength = available[0];
    for (let occupiedLength = woodTarget; occupiedLength >= minimumWoodTarget; occupiedLength -= 1) {
      if (occupiedLength % onlyLength === 0) {
        schemes.push(Array(occupiedLength / onlyLength).fill(onlyLength));
      }
    }
    return schemes;
  }

  for (let occupiedLength = woodTarget; occupiedLength >= minimumWoodTarget; occupiedLength -= 1) {
    patternsForTarget(occupiedLength, available).forEach((scheme) => schemes.push(scheme));
  }
  return schemes;
}

function patternKey(parts) {
  return parts.join(' + ');
}

function statePatternParts(state) {
  if (!state || !state.groups.size) return [];

  let selectedKey = '';
  let largestGroup = -1;
  state.groups.forEach((count, key) => {
    if (count > largestGroup) {
      largestGroup = count;
      selectedKey = key;
    }
  });
  return selectedKey.split('|')[0].split(' + ').map(Number).filter(Boolean);
}

function stateMaterialLength(state) {
  return statePatternParts(state).reduce((sum, length) => sum + length, 0);
}

function canUsePattern(pattern, stock) {
  const need = {};

  pattern.forEach((length) => {
    need[length] = (need[length] || 0) + 1;
  });

  return Object.entries(need).every(([length, qty]) => (stock.get(Number(length)) || 0) >= qty);
}

function takePattern(pattern, stock) {
  pattern.forEach((length) => {
    stock.set(length, (stock.get(length) || 0) - 1);
  });
}

function linePatternsForStack(stackLength, lengths) {
  const direct = lengths.includes(stackLength) ? [[stackLength]] : [];
  const available = [...new Set(lengths)].sort((a, b) => a - b);
  const joined = [];
  for (let leftIndex = 0; leftIndex < available.length; leftIndex += 1) {
    for (let rightIndex = leftIndex; rightIndex < available.length; rightIndex += 1) {
      const left = available[leftIndex];
      const right = available[rightIndex];
      if (left < stackLength && right < stackLength && left + right === stackLength) {
        joined.push([left, right]);
      }
    }
  }
  for (let firstIndex = 0; firstIndex < available.length; firstIndex += 1) {
    for (let secondIndex = firstIndex; secondIndex < available.length; secondIndex += 1) {
      for (let thirdIndex = secondIndex; thirdIndex < available.length; thirdIndex += 1) {
        const first = available[firstIndex];
        const second = available[secondIndex];
        const third = available[thirdIndex];
        if (first < stackLength && second < stackLength && third < stackLength && first + second + third === stackLength) {
          joined.push([first, second, third]);
        }
      }
    }
  }
  return {
    direct: direct.map((pattern) => ({ pattern, type: 'solid' })),
    joined: joined.map((pattern) => ({ pattern, type: 'joined' })),
  };
}

function canUseRowPattern(pattern, stock, across) {
  const need = {};
  pattern.forEach((length) => { need[length] = (need[length] || 0) + across; });
  return Object.entries(need).every(([length, qty]) => (stock.get(Number(length)) || 0) >= qty);
}

function takeRowPattern(pattern, stock, across) {
  pattern.forEach((length) => stock.set(length, (stock.get(length) || 0) - across));
}

function availableFullRows(pattern, stock, across) {
  const perRow = {};
  pattern.forEach((length) => { perRow[length] = (perRow[length] || 0) + across; });
  return Math.min(...Object.entries(perRow).map(([length, quantity]) => Math.floor((stock.get(Number(length)) || 0) / quantity)));
}

function summarizeStock(stock) {
  const lines = [...stock.entries()]
    .filter(([, quantity]) => quantity > 0)
    .sort(([left], [right]) => right - left)
    .map(([length, quantity]) => `${quantity}×${length} ft`);
  return lines.length ? lines.join(', ') : 'no remaining inventory';
}

function renderResidualTable(originalStock, allocated) {
  const body = $('residualsTableBody');
  body.innerHTML = '';

  const rows = [...originalStock.entries()]
    .map(([length, qty]) => {
      const used = allocated.get(length) || 0;
      const remain = Math.max(0, qty - used);
      return { length, qty, used, remain };
    })
    .filter((entry) => entry.qty > 0);

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4">No remaining inventory</td></tr>';
    return;
  }

  rows.forEach((entry) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${entry.length} ft</td>
      <td>${entry.qty}</td>
      <td>${entry.used}</td>
      <td>${entry.remain}</td>
    `;
    body.appendChild(row);
  });
}

function runScheme(scheme, sourceStock, geometry, lengths, mode = 0) {
  const stock = new Map(sourceStock);
  const states = scheme.map((length, index) => ({
    length,
    index,
    rowsLeft: geometry.rows,
    linesLeft: geometry.lines,
    groups: new Map(),
    patterns: linePatternsForStack(length, lengths),
    rowSequence: [],
  }));

  let usedFt = 0;
  let complete = 0;
  let gaps = 0;

  const order = [...states];
  if (mode === 1) order.reverse();
  if (mode === 2) order.sort((a, b) => a.length - b.length);
  if (mode === 3) order.sort((a, b) => b.length - a.length);

  for (const state of order) {
    const hasSolid = state.patterns.direct.length > 0;
    const hasJoined = state.patterns.joined.length > 0;
    const mixed = hasSolid && hasJoined;

    for (let rowIndex = 0; rowIndex < geometry.rows; rowIndex += 1) {
      const wanted = mixed && rowIndex % 2 === 1 ? state.patterns.joined : state.patterns.direct;
      const option = wanted
        .filter((item) => canUseRowPattern(item.pattern, stock, geometry.across))
        .sort((left, right) => availableFullRows(right.pattern, stock, geometry.across) - availableFullRows(left.pattern, stock, geometry.across))[0];
      if (!option) break;

      takeRowPattern(option.pattern, stock, geometry.across);
      state.rowsLeft -= 1;
      state.linesLeft -= geometry.across;
      complete += geometry.across;
      usedFt += state.length * geometry.across;
      state.rowSequence.push({ type: option.type, pattern: [...option.pattern] });

      const key = `${patternKey(option.pattern)}|0`;
      state.groups.set(key, (state.groups.get(key) || 0) + 1);
    }
  }

  const fullLifts = states.filter((state) => state.linesLeft === 0).length;
  const stableRows = states.every((state) => {
    const types = new Set(state.rowSequence.map((row) => row.type));
    const usesJoinedRows = state.rowSequence.some((row) => row.type === 'joined');
    const solidRows = state.rowSequence.filter((row) => row.type === 'solid').length;
    const joinedRows = state.rowSequence.filter((row) => row.type === 'joined').length;
    const anchored = !usesJoinedRows || (
      state.patterns.direct.length > 0 &&
      state.rowSequence[0]?.type === 'solid' &&
      solidRows >= joinedRows &&
      state.rowSequence.every((row, index) => row.type === (index % 2 === 0 ? 'solid' : 'joined'))
    );
    return types.size <= 1 ? !usesJoinedRows : anchored;
  });
  const stability = { valid: stableRows, label: states.some((state) => state.rowSequence.some((row) => row.type === 'joined')) ? 'forklift-stable: full-length rows anchor alternating two- or three-board joined rows' : 'solid full-length rows' };
  const valid = stableRows;
  return {
    scheme,
    stock,
    states,
    usedFt,
    complete,
    gaps,
    fullLifts,
    stability,
    valid,
    score: (valid ? 1e15 : 0) + complete * 1e10 + fullLifts * 1e8 + usedFt * 1e5 - scheme.length * 1e3 - gaps,
  };
}

function liftRecipes(length, geometry, lengths, sourceStock) {
  const patterns = linePatternsForStack(length, lengths);
  const recipes = [];
  const recipeKeys = new Set();
  const addRecipe = (rowSequence) => {
    const need = new Map();
    const groups = new Map();
    rowSequence.forEach((row) => {
      row.pattern.forEach((boardLength) => need.set(boardLength, (need.get(boardLength) || 0) + geometry.across));
      const key = `${patternKey(row.pattern)}|0`;
      groups.set(key, (groups.get(key) || 0) + 1);
    });
    const recipeKey = [...need.entries()].sort(([left], [right]) => left - right).map(([boardLength, quantity]) => `${boardLength}:${quantity}`).join('|');
    if (recipeKeys.has(recipeKey)) return;
    recipeKeys.add(recipeKey);
    const joinedPatterns = new Set(rowSequence.filter((row) => row.type === 'joined').map((row) => patternKey(row.pattern)));
    recipes.push({ rowSequence, need, groups, rows: rowSequence.length, boards: [...need.values()].reduce((sum, value) => sum + value, 0), usedFt: length * geometry.across * rowSequence.length, diversity: joinedPatterns.size });
  };

  if (patterns.direct.length) {
    for (let height = 1; height <= geometry.rows; height += 1) {
      addRecipe(Array.from({ length: height }, () => ({ type: 'solid', pattern: [length] })));
    }
    patterns.joined.forEach((joined) => {
      // A uniform mixed recipe is valid only for two-part rows. A three-part
      // row needs the seven-row solid/pair foundation generated below.
      if (joined.pattern.length !== 2) return;
      for (let height = 2; height <= geometry.rows; height += 1) {
        addRecipe(Array.from({ length: height }, (_, index) => index % 2 === 0
          ? { type: 'solid', pattern: [length] }
          : { type: 'joined', pattern: [...joined.pattern] }));
      }
    });

    // A mixed lift may use a different combination on every joined level.
    // The first three mixed levels must be two-part rows. A three-part row is
    // allowed only on row 8 or later, after this seven-row stable foundation:
    // solid / pair / solid / pair / solid / pair / solid.
    for (let height = 2; height <= geometry.rows; height += 1) {
      const solidRows = Math.ceil(height / 2);
      const joinedRows = Math.floor(height / 2);
      const solidNeed = solidRows * geometry.across;
      if ((sourceStock.get(length) || 0) < solidNeed || joinedRows === 0) continue;

      const allowedJoined = patterns.joined;
      allowedJoined.forEach((_, seed) => {
        const remaining = new Map(sourceStock);
        remaining.set(length, (remaining.get(length) || 0) - solidNeed);
        const selectedJoined = [];

        for (let row = 0; row < joinedRows; row += 1) {
          const rotationStart = (seed + row) % allowedJoined.length;
          const viable = allowedJoined
            .filter((item) => item.pattern.length === 2 || row >= 3)
            .filter((item) => canUseRowPattern(item.pattern, remaining, geometry.across))
            .sort((left, right) => {
              const leftIndex = allowedJoined.indexOf(left);
              const rightIndex = allowedJoined.indexOf(right);
              const leftRotation = (leftIndex - rotationStart + allowedJoined.length) % allowedJoined.length;
              const rightRotation = (rightIndex - rotationStart + allowedJoined.length) % allowedJoined.length;
              return leftRotation - rightRotation;
            });
          if (!viable.length) break;
          const chosen = viable[0];
          takeRowPattern(chosen.pattern, remaining, geometry.across);
          selectedJoined.push(chosen.pattern);
        }

        if (selectedJoined.length !== joinedRows) return;
        let joinedIndex = 0;
        addRecipe(Array.from({ length: height }, (_, index) => index % 2 === 0
          ? { type: 'solid', pattern: [length] }
          : { type: 'joined', pattern: [...selectedJoined[joinedIndex++]] }));
      });
    }
  }
  // Prefer the highest-volume recipe first. For equal volume, a solid row uses
  // fewer individual boards and is preferred over a joined row.
  return recipes.sort((left, right) => right.usedFt - left.usedFt || left.boards - right.boards);
}

function runSchemeOptimal(scheme, sourceStock, geometry, lengths) {
  const recipeSets = scheme.map((length) => liftRecipes(length, geometry, lengths, sourceStock));
  const maxUsedFtFrom = Array(recipeSets.length + 1).fill(0);
  for (let index = recipeSets.length - 1; index >= 0; index -= 1) {
    maxUsedFtFrom[index] = maxUsedFtFrom[index + 1] + Math.max(0, ...recipeSets[index].map((recipe) => recipe.usedFt));
  }
  let best = null;

  function search(index, remaining, selected, boards, usedFt, diversity) {
    if (best && usedFt + maxUsedFtFrom[index] < best.usedFt) return;
    if (index === scheme.length) {
      const fullLifts = selected.filter((recipe) => recipe.rows === geometry.rows).length;
      const candidate = { selected: [...selected], remaining: new Map(remaining), boards, usedFt, fullLifts, diversity };
      if (!best || candidate.usedFt > best.usedFt ||
        (candidate.usedFt === best.usedFt && candidate.fullLifts > best.fullLifts) ||
        (candidate.usedFt === best.usedFt && candidate.fullLifts === best.fullLifts && candidate.boards < best.boards) ||
        (candidate.usedFt === best.usedFt && candidate.fullLifts === best.fullLifts && candidate.boards === best.boards && candidate.diversity > best.diversity)) best = candidate;
      return;
    }
    for (const recipe of recipeSets[index]) {
      if ([...recipe.need.entries()].some(([length, quantity]) => (remaining.get(length) || 0) < quantity)) continue;
      const next = new Map(remaining);
      recipe.need.forEach((quantity, length) => next.set(length, (next.get(length) || 0) - quantity));
      search(index + 1, next, [...selected, recipe], boards + recipe.boards, usedFt + recipe.usedFt, diversity + recipe.diversity);
    }
  }

  // Lifts are separate forklift units. Each one must contain complete stable
  // rows, but their heights may differ so inventory can produce maximum volume.
  search(0, new Map(sourceStock), [], 0, 0, 0);

  if (!best) return null;
  const states = scheme.map((length, index) => {
    const recipe = best.selected[index];
    return { length, index, rowsLeft: geometry.rows - recipe.rows, linesLeft: geometry.lines - recipe.rows * geometry.across, groups: recipe.groups, patterns: linePatternsForStack(length, lengths), rowSequence: recipe.rowSequence };
  });
  const fullLifts = states.filter((state) => state.rowsLeft === 0).length;
  const hasJoined = states.some((state) => state.rowSequence.some((row) => row.type === 'joined'));
  const rowCounts = states.map((state) => state.rowSequence.length);
  return { scheme, stock: best.remaining, states, usedFt: best.usedFt, complete: states.reduce((sum, state) => sum + state.rowSequence.length * geometry.across, 0), minRows: Math.min(...rowCounts), maxRows: Math.max(...rowCounts), gaps: 0, fullLifts, stability: { valid: true, label: hasJoined ? 'independent forklift-stable lifts with alternating full-width rows' : 'independent lifts with solid full-width rows' }, valid: true };
}

function isBetterKilnPlan(candidate, current) {
  if (!current) return true;

  // The business objective is maximum lumber volume (and therefore maximum
  // board feet). Metal, empty chamber length and recipe style are tie-breakers.
  const comparisons = [
    [candidate.completeLoad ? 1 : 0, current.completeLoad ? 1 : 0, 'max'],
    [candidate.orderUsableFt, current.orderUsableFt, 'max'],
    [candidate.strandedFt, current.strandedFt, 'min'],
    [candidate.usedFt, current.usedFt, 'max'],
    [candidate.heightSpread, current.heightSpread, 'min'],
    [candidate.fullLifts, current.fullLifts, 'max'],
    [candidate.chamberGap, current.chamberGap, 'min'],
    [candidate.metal, current.metal, 'min'],
    [candidate.activeStates.length, current.activeStates.length, 'min'],
  ];

  for (const [next, previous, direction] of comparisons) {
    if (next === previous) continue;
    return direction === 'max' ? next > previous : next < previous;
  }
  return false;
}

function liftPlacementClass(state) {
  const stepped = state.rowSequence.some((row) => row.pattern.reduce((sum, length) => sum + length, 0) < state.length);
  if (stepped) return 2;
  if (state.rowsLeft > 0) return 1;
  return 0;
}

function sortStatesByHeight(states) {
  // Physical loading order is a descending staircase: the tallest lift is
  // loaded first on the left, followed by progressively lower lifts.
  return [...states].sort((left, right) => effectiveLiftRows(right) - effectiveLiftRows(left)
    || liftPlacementClass(left) - liftPlacementClass(right)
    || right.length - left.length);
}

function compactDescendingStates(states, geometry) {
  const compacted = [...states]
    .sort((left, right) => right.length - left.length)
    .map((state) => ({ ...state, rowSequence: [...state.rowSequence] }));

  for (let targetIndex = 0; targetIndex < compacted.length; targetIndex += 1) {
    const target = compacted[targetIndex];
    for (let sourceIndex = targetIndex + 1; sourceIndex < compacted.length && target.rowSequence.length < geometry.rows; sourceIndex += 1) {
      const source = compacted[sourceIndex];
      // Stepped consolidation is permitted only with complete solid rows.
      // Moving joined rows would break their full-length anchoring sequence.
      if (source.rowSequence.some((row) => row.type !== 'solid')) continue;
      while (source.rowSequence.length && target.rowSequence.length < geometry.rows) {
        const row = source.rowSequence[0];
        const rowLength = row.pattern.reduce((sum, length) => sum + length, 0);
        const previousRow = target.rowSequence[target.rowSequence.length - 1];
        const previousLength = previousRow
          ? previousRow.pattern.reduce((sum, length) => sum + length, 0)
          : target.length;
        // A physical stepped lift may remain level or decrease exactly 1 ft
        // from one full-width layer to the next. Larger unsupported jumps are
        // not allowed (18 → 17 → 16 is valid; 18 → 16 is not).
        if (rowLength > previousLength || rowLength < previousLength - 1) break;
        target.rowSequence.push(source.rowSequence.shift());
      }
    }
  }

  return compacted.filter((state) => state.rowSequence.length).map((state, index) => {
    const groups = new Map();
    state.rowSequence.forEach((row) => {
      const key = `${patternKey(row.pattern)}|${Math.max(0, state.length - row.pattern.reduce((sum, length) => sum + length, 0))}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    });
    return {
      ...state,
      index,
      groups,
      rowsLeft: geometry.rows - state.rowSequence.length,
      linesLeft: geometry.lines - state.rowSequence.length * geometry.across,
    };
  });
}

function inventoryFeet(stock) {
  return [...stock.entries()].reduce((sum, [length, quantity]) => sum + length * quantity, 0);
}

function usableInventoryFeet(stock, across) {
  if (!across) return 0;
  return [...stock.entries()].reduce((sum, [length, quantity]) => sum + length * Math.floor(quantity / across) * across, 0);
}

function orderSignature(stock, geometry, kilnLength, maxStack, selectedMetal) {
  return JSON.stringify({ stock: [...stock.entries()], rows: geometry.rows, across: geometry.across, kilnLength, maxStack, selectedMetal, liftStickers: [...manualLiftStickers], liftTargets: [...manualLiftTargets] });
}

function linearModelToLp(constraints, variables, ints) {
  const expression = (field) => Object.entries(variables)
    .map(([name, coefficients]) => [name, coefficients[field] || 0])
    .filter(([, coefficient]) => coefficient !== 0)
    .map(([name, coefficient], index) => `${coefficient >= 0 && index ? '+ ' : coefficient < 0 ? '- ' : ''}${Math.abs(coefficient)} ${name}`)
    .join(' ') || '0';
  const rows = Object.entries(constraints).map(([name, bound]) => {
    if (bound.max !== undefined) return ` ${name}: ${expression(name)} <= ${bound.max}`;
    if (bound.min !== undefined) return ` ${name}: ${expression(name)} >= ${bound.min}`;
    return ` ${name}: ${expression(name)} = ${bound.equal}`;
  });
  return `Maximize\n objective: ${expression('score')}\nSubject To\n${rows.join('\n')}\nBounds\n${Object.keys(variables).map((name) => ` 0 <= ${name}`).join('\n')}\nGenerals\n ${Object.keys(ints).join(' ')}\nEnd`;
}

function distributeAlternatingRows(liftCount, solidCount, joinedPatterns, maxRows) {
  if (
    liftCount <= 0
    || solidCount < liftCount
    || joinedPatterns.length > solidCount
    || solidCount + joinedPatterns.length > liftCount * maxRows
  ) return [];

  const lifts = Array.from({ length: liftCount }, () => [{ type: 'solid' }]);
  let solidsLeft = solidCount - liftCount;
  const joinedPool = [...joinedPatterns];
  while (solidsLeft || joinedPool.length) {
    const candidates = lifts
      .map((rows, index) => ({ rows, index }))
      .filter(({ rows }) => rows.length < maxRows)
      .sort((left, right) => left.rows.length - right.rows.length || left.index - right.index);
    let placed = false;

    for (const candidate of candidates) {
      const last = candidate.rows[candidate.rows.length - 1];
      if (last.type === 'solid' && joinedPool.length) {
        candidate.rows.push({ type: 'joined', pattern: joinedPool.shift() });
        placed = true;
        break;
      }
      if (solidsLeft) {
        candidate.rows.push({ type: 'solid' });
        solidsLeft -= 1;
        placed = true;
        break;
      }
    }
    if (!placed) return [];
  }
  return lifts;
}

function solveOrderAcrossCycles(sourceStock, geometry, kilnLength, maxStack, selectedMetal) {
  if (!highsEngine || !geometry.rows || !geometry.across) return [];
  const lengths = [...sourceStock.keys()].filter((length) => length <= maxStack).sort((a, b) => a - b);
  const totalFeet = usableInventoryFeet(sourceStock, geometry.across);
  if (totalFeet <= 0) return [];
  const feetCapacity = kilnLength * geometry.lines;
  // This is a calculated production-cycle lower bound, never a fixed cycle
  // count. It changes with row count, boards across, kiln length and inventory.
  const cycleCount = Math.max(1, Math.ceil(totalFeet / Math.max(1, feetCapacity)));
  const fixedMetal = selectedMetal >= 0 ? selectedMetal : 0;
  const woodChamber = Math.max(0, kilnLength - fixedMetal);
  const constraints = {};
  const variables = {};
  const ints = {};

  lengths.forEach((length) => { constraints[`inv_${length}`] = { max: sourceStock.get(length) || 0 }; });
  for (let cycle = 0; cycle < cycleCount; cycle += 1) constraints[`chamber_${cycle}`] = { max: woodChamber };
  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    lengths.forEach((length) => {
      const suffix = `${cycle}_${length}`;
      constraints[`rows_${suffix}`] = { max: 0 };
      constraints[`joined_anchor_${suffix}`] = { max: 0 };
      constraints[`lift_presence_${suffix}`] = { max: 0 };
      constraints[`lift_count_${suffix}`] = { max: Math.floor(woodChamber / length) };

      const liftName = `lift_${suffix}`;
      variables[liftName] = {
        score: -1,
        [`chamber_${cycle}`]: length,
        [`rows_${suffix}`]: -geometry.rows,
        [`lift_presence_${suffix}`]: 1,
        [`lift_count_${suffix}`]: 1,
      };
      ints[liftName] = 1;

      const solidName = `solid_${suffix}`;
      const solidFeet = length * geometry.across;
      variables[solidName] = {
        // Optimize physical volume first, then fill earlier cycles, and use a
        // solid row instead of a joined row when both carry equal volume.
        score: solidFeet * 1000000000 + (cycleCount - cycle) * solidFeet * 10000 + geometry.across,
        materialFeet: solidFeet,
        [`inv_${length}`]: geometry.across,
        [`rows_${suffix}`]: 1,
        [`joined_anchor_${suffix}`]: -1,
        [`lift_presence_${suffix}`]: -1,
      };
      ints[solidName] = 1;

      for (let leftIndex = 0; leftIndex < lengths.length; leftIndex += 1) {
        const left = lengths[leftIndex];
        for (let rightIndex = leftIndex; rightIndex < lengths.length; rightIndex += 1) {
          const right = lengths[rightIndex];
          if (left + right !== length) continue;
          const joinedName = `joined_${cycle}_${length}_${left}_${right}`;
          const joinedFeet = length * geometry.across;
          variables[joinedName] = {
            score: joinedFeet * 1000000000 + (cycleCount - cycle) * joinedFeet * 10000,
            materialFeet: joinedFeet,
            [`inv_${left}`]: geometry.across * (left === right ? 2 : 1),
            [`rows_${suffix}`]: 1,
            [`joined_anchor_${suffix}`]: 1,
          };
          if (left !== right) variables[joinedName][`inv_${right}`] = geometry.across;
          ints[joinedName] = 1;
        }
      }
    });
  }

  const solution = highsEngine.solve(linearModelToLp(constraints, variables, ints), {
    presolve: 'on',
    time_limit: 15,
    mip_rel_gap: 0,
  });
  if (solution.Status !== 'Optimal') return [];
  const result = Object.fromEntries(Object.entries(solution.Columns).map(([name, column]) => [name, column.Primal]));

  const plans = [];
  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    const states = [];
    const used = new Map();
    lengths.forEach((length) => {
      const liftCount = Math.round(result[`lift_${cycle}_${length}`] || 0);
      if (!liftCount) return;
      const solidRows = Math.round(result[`solid_${cycle}_${length}`] || 0);
      const joinedPool = [];
      for (let leftIndex = 0; leftIndex < lengths.length; leftIndex += 1) {
        const left = lengths[leftIndex];
        for (let rightIndex = leftIndex; rightIndex < lengths.length; rightIndex += 1) {
          const right = lengths[rightIndex];
          if (left + right !== length) continue;
          const count = Math.round(result[`joined_${cycle}_${length}_${left}_${right}`] || 0);
          for (let index = 0; index < count; index += 1) joinedPool.push([left, right]);
        }
      }

      const liftRows = distributeAlternatingRows(liftCount, solidRows, joinedPool, geometry.rows);
      liftRows.forEach((rows) => rows.forEach((row) => {
        if (row.type === 'solid') row.pattern = [length];
      }));

      liftRows.filter((rows) => rows.length).forEach((rowSequence, liftIndex) => {
        const groups = new Map();
        rowSequence.forEach((row) => {
          row.pattern.forEach((boardLength) => used.set(boardLength, (used.get(boardLength) || 0) + geometry.across));
          const key = `${patternKey(row.pattern)}|0`;
          groups.set(key, (groups.get(key) || 0) + 1);
        });
        states.push({ length, index: liftIndex, rowsLeft: geometry.rows - rowSequence.length, linesLeft: geometry.lines - rowSequence.length * geometry.across, groups, patterns: linePatternsForStack(length, lengths), rowSequence });
      });
    });

    const activeStates = sortStatesByHeight(compactDescendingStates(states, geometry));
    const activeLength = activeStates.reduce((sum, state) => sum + state.length, 0);
    const autoGap = Math.max(0, kilnLength - activeLength - fixedMetal);
    const metal = selectedMetal < 0 && [4, 5, 6].includes(autoGap) ? autoGap : fixedMetal;
    const chamberGap = Math.max(0, kilnLength - activeLength - metal);
    const stock = new Map(sourceStock);
    used.forEach((quantity, length) => stock.set(length, Math.max(0, (stock.get(length) || 0) - quantity)));
    const usedFt = [...used.entries()].reduce((sum, [length, quantity]) => sum + length * quantity, 0);
    const rowCounts = activeStates.map((state) => state.rowSequence.length);
    plans.push({ scheme: activeStates.map((state) => state.length), stock, states: activeStates, activeStates, activeLength, usedMap: used, usedFt, complete: activeStates.reduce((sum, state) => sum + state.rowSequence.length * geometry.across, 0), minRows: rowCounts.length ? Math.min(...rowCounts) : 0, maxRows: rowCounts.length ? Math.max(...rowCounts) : 0, gaps: 0, fullLifts: activeStates.filter((state) => state.rowSequence.length === geometry.rows).length, metal, target: kilnLength - metal, chamberGap, inactiveLifts: 0, completeLoad: chamberGap === 0 && activeStates.every((state) => state.rowSequence.length === geometry.rows), stability: { valid: true, label: 'globally optimized alternating full-width rows' }, valid: activeStates.length > 0, heightSpread: rowCounts.length ? Math.max(...rowCounts) - Math.min(...rowCounts) : geometry.rows });
  }
  const nonEmptyPlans = plans
    .filter((plan) => plan.usedFt > 0)
    .sort((left, right) => right.maxRows - left.maxRows || right.usedFt - left.usedFt);
  let cumulativeStock = new Map(sourceStock);
  nonEmptyPlans.forEach((plan) => {
    plan.availableStock = new Map(cumulativeStock);
    plan.usedMap.forEach((quantity, length) => {
      cumulativeStock.set(length, Math.max(0, (cumulativeStock.get(length) || 0) - quantity));
    });
    plan.stock = new Map(cumulativeStock);
  });
  return nonEmptyPlans;
}

function fillResidualRowsIntoExistingLifts(plans, sourceStock, geometry, preserveManualTargets = false) {
  if (!plans.length || !geometry.across) return plans;
  const stock = new Map(sourceStock);
  const result = plans.map((plan) => {
    const activeStates = (plan.activeStates || []).map((state) => ({
      ...state,
      rowSequence: (state.rowSequence || []).map((row) => ({ ...row, pattern: [...row.pattern] })),
    }));
    activeStates.forEach((state) => state.rowSequence.forEach((row) => row.pattern.forEach((length) => {
      stock.set(length, Math.max(0, Number(stock.get(length) || 0) - geometry.across));
    })));
    return { ...plan, states: activeStates, activeStates };
  });
  const positions = result.flatMap((plan, planIndex) =>
    plan.activeStates.map((state, stateIndex) => ({ state, planIndex, stateIndex }))
  );
  const capacity = (state) => Number(state.rowCapacity || geometry.rows);
  const isManuallyLimited = (planIndex, stateIndex, state) => preserveManualTargets
    && manualLiftTargets.has(`${planIndex + 1}:${stateIndex}:${state.length}`);
  const span = (row) => row.pattern.reduce((sum, length) => sum + Number(length || 0), 0);
  const availableRows = (length) => Math.floor(Number(stock.get(length) || 0) / geometry.across);
  const takeSolidRow = (state, length, placement) => {
    const row = { type: 'solid', pattern: [length] };
    if (placement === 'bottom') state.rowSequence.unshift(row);
    else state.rowSequence.push(row);
    stock.set(length, Number(stock.get(length) || 0) - geometry.across);
  };

  // First rebuild the bottom of every stepped lift. A longer row may be
  // inserted below a shorter top section when the transition is at most 1 ft.
  [...positions]
    .sort((left, right) => right.state.length - left.state.length || left.planIndex - right.planIndex)
    .forEach(({ state, planIndex, stateIndex }) => {
      if (isManuallyLimited(planIndex, stateIndex, state)) return;
      const firstLength = state.rowSequence.length ? span(state.rowSequence[0]) : state.length;
      if (firstLength < state.length - 1) return;
      const rows = Math.min(
        Math.max(0, capacity(state) - state.rowSequence.length),
        availableRows(state.length),
      );
      for (let index = 0; index < rows; index += 1) takeSolidRow(state, state.length, 'bottom');
    });

  // Then fill the remaining height from the top. Rows may stay level or step
  // down exactly 1 ft; no new lift or kiln cycle is created.
  while (true) {
    const opportunities = positions.flatMap(({ state, planIndex, stateIndex }) => {
      if (isManuallyLimited(planIndex, stateIndex, state)) return [];
      if (!state.rowSequence.length || state.rowSequence.length >= capacity(state)) return [];
      const lastLength = span(state.rowSequence[state.rowSequence.length - 1]);
      return [lastLength, lastLength - 1]
        .filter((length, index, values) => length >= MIN_BOARD_LENGTH && values.indexOf(length) === index && availableRows(length) > 0)
        .map((length) => ({ state, planIndex, stateIndex, length }));
    }).sort((left, right) => right.length - left.length || left.planIndex - right.planIndex || left.stateIndex - right.stateIndex);
    if (!opportunities.length) break;
    const selected = opportunities[0];
    takeSolidRow(selected.state, selected.length, 'top');
  }

  // Row balance has priority over empty height and visual simplicity. Once
  // one-foot steps have been exhausted, place every remaining complete row
  // into an existing unlocked lift with free vertical capacity. Prefer the
  // closest lift length so any wider step is as small as physically possible.
  // This pass never creates another kiln cycle.
  while (true) {
    const remainingFullRows = [...stock.entries()]
      .filter(([length, quantity]) => Number(length) >= MIN_BOARD_LENGTH && availableRows(Number(length)) > 0)
      .map(([length]) => Number(length));
    const opportunities = positions.flatMap(({ state, planIndex, stateIndex }) => {
      if (isManuallyLimited(planIndex, stateIndex, state)) return [];
      if (state.rowSequence.length >= capacity(state)) return [];
      const liftLength = occupiedLiftLength(state);
      return remainingFullRows
        .filter((length) => length <= liftLength)
        .map((length) => ({
          state,
          planIndex,
          stateIndex,
          length,
          step: liftLength - length,
          rows: state.rowSequence.length,
        }));
    }).sort((left, right) => left.step - right.step
      || right.length - left.length
      || right.rows - left.rows
      || left.planIndex - right.planIndex
      || left.stateIndex - right.stateIndex);
    if (!opportunities.length) break;
    const selected = opportunities[0];
    takeSolidRow(selected.state, selected.length, 'top');
    selected.state.rowSequence.sort((left, right) => span(right) - span(left));
  }

  let cumulativeStock = new Map(sourceStock);
  return result.map((plan) => {
    const availableStock = new Map(cumulativeStock);
    const activeStates = plan.activeStates.map((state, index) => {
      const next = { ...state, index };
      next.groups = rebuildGroups(next);
      next.rowsLeft = capacity(next) - next.rowSequence.length;
      next.linesLeft = next.rowsLeft * geometry.across;
      return next;
    });
    const usedMap = new Map();
    activeStates.forEach((state) => state.rowSequence.forEach((row) => row.pattern.forEach((length) => {
      usedMap.set(length, Number(usedMap.get(length) || 0) + geometry.across);
    })));
    usedMap.forEach((quantity, length) => {
      cumulativeStock.set(length, Math.max(0, Number(cumulativeStock.get(length) || 0) - quantity));
    });
    const rowCounts = activeStates.map((state) => state.rowSequence.length);
    const complete = rowCounts.reduce((sum, rows) => sum + rows * geometry.across, 0);
    const usedFt = [...usedMap].reduce((sum, [length, quantity]) => sum + length * quantity, 0);
    return {
      ...plan,
      states: activeStates,
      activeStates,
      availableStock,
      usedMap,
      stock: new Map(cumulativeStock),
      complete,
      usedFt,
      fullLifts: activeStates.filter((state) => state.rowSequence.length === capacity(state)).length,
      completeLoad: plan.chamberGap === 0 && activeStates.length > 0
        && activeStates.every((state) => state.rowSequence.length === capacity(state)),
      minRows: rowCounts.length ? Math.min(...rowCounts) : 0,
      maxRows: rowCounts.length ? Math.max(...rowCounts) : 0,
      heightSpread: rowCounts.length ? Math.max(...rowCounts) - Math.min(...rowCounts) : geometry.rows,
    };
  });
}

function selectBestLiftStatesWithinCycles(states, seedStates, cycleLimit, capacity, geometry) {
  if (!states.length || cycleLimit <= 0 || capacity <= 0) return seedStates;
  const valueOf = (state) => (state.rowSequence || []).reduce((total, row) => total
    + row.pattern.reduce((rowTotal, length) => rowTotal + Number(length || 0), 0) * geometry.across, 0);
  const boardsOf = (state) => (state.rowSequence || []).reduce((total, row) => total
    + row.pattern.length * geometry.across, 0);
  const items = [...states]
    .map((state) => ({ state, length: occupiedLiftLength(state), value: valueOf(state), boards: boardsOf(state) }))
    .filter((item) => item.length > 0 && item.length <= capacity && item.value > 0)
    .sort((left, right) => right.value - left.value || right.boards - left.boards || right.length - left.length);
  const suffixValue = Array(items.length + 1).fill(0);
  for (let index = items.length - 1; index >= 0; index -= 1) suffixValue[index] = suffixValue[index + 1] + items[index].value;

  let bestStates = [...seedStates];
  let bestValue = bestStates.reduce((sum, state) => sum + valueOf(state), 0);
  let bestBoards = bestStates.reduce((sum, state) => sum + boardsOf(state), 0);
  const bins = [];
  const selected = [];
  const deadline = (typeof performance === 'undefined' ? Date.now() : performance.now()) + 900;

  function search(index, value, boards) {
    const now = typeof performance === 'undefined' ? Date.now() : performance.now();
    if (now > deadline || value + suffixValue[index] < bestValue) return;
    if (value > bestValue || (value === bestValue && boards > bestBoards)) {
      bestValue = value;
      bestBoards = boards;
      bestStates = [...selected];
    }
    if (index >= items.length) return;

    const item = items[index];
    const seenLoads = new Set();
    for (let binIndex = 0; binIndex < bins.length; binIndex += 1) {
      const used = bins[binIndex];
      if (seenLoads.has(used) || used + item.length > capacity) continue;
      seenLoads.add(used);
      bins[binIndex] += item.length;
      selected.push(item.state);
      search(index + 1, value + item.value, boards + item.boards);
      selected.pop();
      bins[binIndex] -= item.length;
    }
    if (bins.length < cycleLimit) {
      bins.push(item.length);
      selected.push(item.state);
      search(index + 1, value + item.value, boards + item.boards);
      selected.pop();
      bins.pop();
    }
    search(index + 1, value, boards);
  }

  search(0, 0, 0);
  return bestStates;
}

function solveSequentialFallback(sourceStock, geometry, kilnLength, maxStack, selectedMetal) {
  const plans = [];
  let stock = new Map(sourceStock);
  const metalOptions = selectedMetal < 0 ? [0, 4, 5, 6] : [selectedMetal];

  for (let cycle = 0; cycle < 50 && usableInventoryFeet(stock, geometry.across) > 0; cycle += 1) {
    const lengths = [...stock.keys()].filter((length) => length <= maxStack);
    let bestPlan = null;
    for (const metal of metalOptions) {
      const target = Math.max(0, kilnLength - metal);
      for (const scheme of schemesForInventory(target, lengths)) {
        const candidate = runSchemeOptimal(scheme, stock, geometry, lengths);
        if (!candidate) continue;
        candidate.metal = metal;
        candidate.target = target;
        candidate.activeStates = sortStatesByHeight(compactDescendingStates(candidate.states.filter((state) => state.rowSequence.length > 0), geometry));
        candidate.activeLength = candidate.activeStates.reduce((sum, state) => sum + state.length, 0);
        candidate.chamberGap = Math.max(0, target - candidate.activeLength);
        candidate.inactiveLifts = candidate.states.length - candidate.activeStates.length;
        candidate.completeLoad = candidate.chamberGap === 0 && candidate.activeStates.length > 0 && candidate.activeStates.every((state) => state.rowSequence.length === geometry.rows);
        candidate.remainingFt = inventoryFeet(candidate.stock);
        candidate.remainingUsableFt = usableInventoryFeet(candidate.stock, geometry.across);
        candidate.strandedFt = Math.max(0, candidate.remainingFt - candidate.remainingUsableFt);
        candidate.orderUsableFt = candidate.usedFt + candidate.remainingUsableFt;
        const heights = candidate.activeStates.map((state) => state.rowSequence.length);
        candidate.heightSpread = heights.length ? Math.max(...heights) - Math.min(...heights) : geometry.rows;
        if (isBetterKilnPlan(candidate, bestPlan)) bestPlan = candidate;
      }
    }
    if (!bestPlan || !bestPlan.valid || bestPlan.usedFt <= 0) break;
    bestPlan.availableStock = new Map(stock);
    bestPlan.usedMap = new Map([...stock.entries()].map(([length, quantity]) => [
      length,
      Math.max(0, quantity - (bestPlan.stock.get(length) || 0)),
    ]).filter(([, quantity]) => quantity > 0));
    plans.push(bestPlan);
    stock = new Map(bestPlan.stock);
  }
  // Establish the minimum practical cycle count first. Small tail plans are
  // candidates for consolidation, not permission to create extra kiln runs.
  const basePlans = [...plans];
  while (basePlans.length > 1) {
    const last = basePlans[basePlans.length - 1];
    const utilization = last.usedFt / Math.max(1, kilnLength * geometry.lines);
    if (utilization >= 0.15) break;
    basePlans.pop();
  }

  // Consolidate rows across every provisional cycle before packing chambers.
  // This allows a 14-ft lift to be completed by full-width 13-ft rows, then
  // 12-ft rows, while preserving the one-foot stepped profile.
  let selectedStates = compactDescendingStates(
    basePlans.flatMap((plan) => plan.activeStates || []),
    geometry,
  );
  const basePacked = repackPlansGlobally([{ activeStates: selectedStates }], sourceStock, geometry, kilnLength, selectedMetal);
  const cycleLimit = basePacked.length;
  const fixedMetal = selectedMetal >= 0 ? selectedMetal : 0;
  const capacity = Math.max(0, kilnLength - fixedMetal);
  // Select the highest-BF combination across all provisional lifts while
  // keeping the established minimum cycle count. This may replace a tiny lift
  // from a base cycle with a longer residual lift instead of preserving a poor
  // greedy choice merely because it was generated first.
  const allStates = compactDescendingStates(
    plans.flatMap((plan) => plan.activeStates || []),
    geometry,
  );
  selectedStates = compactDescendingStates(
    selectBestLiftStatesWithinCycles(allStates, selectedStates, cycleLimit, capacity, geometry),
    geometry,
  );

  const packedPlans = repackPlansGlobally(
    [{ activeStates: compactDescendingStates(selectedStates, geometry) }],
    sourceStock,
    geometry,
    kilnLength,
    selectedMetal,
  );
  return fillResidualRowsIntoExistingLifts(packedPlans, sourceStock, geometry);
}

function occupiedLiftLength(state) {
  const automatic = (state.rowSequence || []).map((row) =>
    row.pattern.reduce((sum, length) => sum + Number(length || 0), 0));
  const manual = (state.manualRows || []).map((row) => Number(row.length || 0));
  return Math.max(0, ...automatic, ...manual);
}

function effectiveLiftRows(state) {
  return (state.rowSequence || []).length + (state.manualRows || []).length;
}

function usedMapForStates(states, geometry) {
  const used = new Map();
  states.forEach((state) => {
    (state.rowSequence || []).forEach((row) => row.pattern.forEach((length) => {
      used.set(Number(length), Number(used.get(Number(length)) || 0) + geometry.across);
    }));
    (state.manualRows || []).forEach((row) => {
      const length = Number(row.length);
      const quantity = Math.max(0, Math.min(geometry.across, Math.floor(Number(row.quantity) || 0)));
      if (length > 0 && quantity > 0) used.set(length, Number(used.get(length) || 0) + quantity);
    });
  });
  return used;
}

function rebuildPlanBalances(plans, sourceStock, geometry, kilnLength) {
  const stock = new Map(sourceStock);
  return plans.map((sourcePlan) => {
    const activeStates = (sourcePlan.activeStates || []).map((state, index) => ({
      ...state,
      index,
      rowSequence: (state.rowSequence || []).map((row) => ({ ...row, pattern: [...row.pattern] })),
      manualRows: (state.manualRows || []).map((row) => ({ ...row })),
    }));
    const availableStock = new Map(stock);
    const usedMap = usedMapForStates(activeStates, geometry);
    usedMap.forEach((quantity, length) => {
      const available = Number(stock.get(length) || 0);
      if (quantity > available) throw new Error(`Inventory balance error: ${quantity} boards at ${length} ft requested, only ${available} available.`);
      stock.set(length, available - quantity);
    });
    const activeLength = activeStates.reduce((sum, state) => sum + occupiedLiftLength(state), 0);
    const metal = Number(sourcePlan.metal || 0);
    const chamberGap = Math.max(0, kilnLength - activeLength - metal);
    const rowCounts = activeStates.map(effectiveLiftRows);
    const complete = [...usedMap.values()].reduce((sum, quantity) => sum + quantity, 0);
    const usedFt = [...usedMap].reduce((sum, [length, quantity]) => sum + length * quantity, 0);
    const fullLifts = activeStates.filter((state) => {
      const capacity = Number(state.rowCapacity || geometry.rows);
      return effectiveLiftRows(state) >= capacity
        && (state.manualRows || []).every((row) => Number(row.quantity) === geometry.across);
    }).length;
    return {
      ...sourcePlan,
      scheme: activeStates.map(occupiedLiftLength),
      states: activeStates,
      activeStates,
      availableStock,
      usedMap,
      stock: new Map(stock),
      activeLength,
      chamberGap,
      complete,
      usedFt,
      fullLifts,
      completeLoad: chamberGap === 0 && activeStates.length > 0 && fullLifts === activeStates.length,
      minRows: rowCounts.length ? Math.min(...rowCounts) : 0,
      maxRows: rowCounts.length ? Math.max(...rowCounts) : 0,
      heightSpread: rowCounts.length ? Math.max(...rowCounts) - Math.min(...rowCounts) : geometry.rows,
    };
  });
}

function normalizeLiftLengths(plans) {
  return plans.map((plan) => {
    const activeStates = (plan.activeStates || []).map((state) => ({
      ...state,
      length: occupiedLiftLength(state),
    }));
    return { ...plan, states: activeStates, activeStates };
  });
}

function packLiftStatesGlobally(states, capacity) {
  const items = [...states].sort((left, right) =>
    occupiedLiftLength(right) - occupiedLiftLength(left)
    || right.rowSequence.length - left.rowSequence.length);
  if (!items.length || capacity <= 0) return [];

  // Best-fit decreasing gives an immediate feasible upper bound. The bounded
  // exact search below then tries to reduce the number of kiln cycles and to
  // concentrate any unavoidable free length in the final cycle.
  const seedBins = [];
  items.forEach((state) => {
    const stateLength = occupiedLiftLength(state);
    let target = -1;
    let smallestGap = Infinity;
    seedBins.forEach((bin, index) => {
      const gap = capacity - bin.used - stateLength;
      if (gap >= 0 && gap < smallestGap) {
        target = index;
        smallestGap = gap;
      }
    });
    if (target < 0) seedBins.push({ used: stateLength, states: [state] });
    else {
      seedBins[target].used += stateLength;
      seedBins[target].states.push(state);
    }
  });

  let best = seedBins.map((bin) => ({ used: bin.used, states: [...bin.states] }));
  const totalLength = items.reduce((sum, state) => sum + occupiedLiftLength(state), 0);
  const lowerBound = Math.ceil(totalLength / capacity);
  const deadline = (typeof performance === 'undefined' ? Date.now() : performance.now()) + 500;

  const quality = (bins) => bins.map((bin) => bin.used).sort((a, b) => b - a);
  const isBetter = (candidate, current) => {
    if (candidate.length !== current.length) return candidate.length < current.length;
    const next = quality(candidate);
    const previous = quality(current);
    for (let index = 0; index < next.length; index += 1) {
      if (next[index] !== previous[index]) return next[index] > previous[index];
    }
    return false;
  };

  function search(index, bins) {
    const now = typeof performance === 'undefined' ? Date.now() : performance.now();
    if (now > deadline || bins.length > best.length) return;
    if (index === items.length) {
      if (isBetter(bins, best)) best = bins.map((bin) => ({ used: bin.used, states: [...bin.states] }));
      return;
    }

    const state = items[index];
    const stateLength = occupiedLiftLength(state);
    const seenLoads = new Set();
    const order = bins
      .map((bin, binIndex) => ({ bin, binIndex, gap: capacity - bin.used - stateLength }))
      .filter(({ gap }) => gap >= 0)
      .sort((left, right) => left.gap - right.gap);

    for (const { bin, binIndex } of order) {
      if (seenLoads.has(bin.used)) continue;
      seenLoads.add(bin.used);
      bin.used += stateLength;
      bin.states.push(state);
      search(index + 1, bins);
      bin.states.pop();
      bin.used -= stateLength;
    }

    if (bins.length < best.length && bins.length < Math.max(lowerBound, best.length)) {
      bins.push({ used: stateLength, states: [state] });
      search(index + 1, bins);
      bins.pop();
    }
  }

  search(0, []);
  return best.sort((left, right) => {
    // Board dimensions and the number of positions across are constant for the
    // order, so the sum of board lengths is exactly proportional to BF.
    const bfUnits = (bin) => bin.states.reduce((binTotal, state) => binTotal
      + state.rowSequence.reduce((stateTotal, row) => stateTotal
        + row.pattern.reduce((rowTotal, length) => rowTotal + length, 0), 0), 0);
    const boardUnits = (bin) => bin.states.reduce((binTotal, state) => binTotal
      + state.rowSequence.reduce((stateTotal, row) => stateTotal + row.pattern.length, 0), 0);
    const leftBf = bfUnits(left);
    const rightBf = bfUnits(right);
    const leftBoards = boardUnits(left);
    const rightBoards = boardUnits(right);
    const leftClasses = left.states.map(liftPlacementClass);
    const rightClasses = right.states.map(liftPlacementClass);
    const leftWorst = Math.max(0, ...leftClasses);
    const rightWorst = Math.max(0, ...rightClasses);
    const leftIncomplete = leftClasses.filter((value) => value > 0).length;
    const rightIncomplete = rightClasses.filter((value) => value > 0).length;
    // Production queue: maximum BF first. Board count and occupied kiln length
    // are deterministic tie-breakers; low-volume cycles move to the end.
    return rightBf - leftBf
      || rightBoards - leftBoards
      || right.used - left.used
      || leftWorst - rightWorst
      || leftIncomplete - rightIncomplete;
  });
}

function repackPlansGlobally(plans, sourceStock, geometry, kilnLength, selectedMetal) {
  const states = plans.flatMap((plan) => plan.activeStates || []);
  if (!states.length) return plans;
  const fixedMetal = selectedMetal >= 0 ? selectedMetal : 0;
  const capacity = Math.max(0, kilnLength - fixedMetal);
  const bins = packLiftStatesGlobally(states, capacity);
  let cumulativeStock = new Map(sourceStock);

  return bins.map((bin, binIndex) => {
    const activeStates = sortStatesByHeight(bin.states).map((state, index) => ({ ...state, index }));
    const usedMap = new Map();
    activeStates.forEach((state) => state.rowSequence.forEach((row) => row.pattern.forEach((length) => {
      usedMap.set(length, (usedMap.get(length) || 0) + geometry.across);
    })));
    const availableStock = new Map(cumulativeStock);
    usedMap.forEach((quantity, length) => cumulativeStock.set(length, Math.max(0, (cumulativeStock.get(length) || 0) - quantity)));
    const activeLength = activeStates.reduce((sum, state) => sum + occupiedLiftLength(state), 0);
    const automaticGap = Math.max(0, kilnLength - activeLength);
    // Automatic metal closes only the unavoidable gap in the final cycle.
    // Earlier cycles must remain visibly incomplete so the optimizer cannot
    // disguise a poor wood layout with metal blocks.
    const isFinalCycle = binIndex === bins.length - 1;
    const metal = selectedMetal < 0 && isFinalCycle && [4, 5, 6].includes(automaticGap)
      ? automaticGap
      : fixedMetal;
    const chamberGap = Math.max(0, kilnLength - activeLength - metal);
    const rowCounts = activeStates.map((state) => state.rowSequence.length);
    const complete = rowCounts.reduce((sum, rows) => sum + rows * geometry.across, 0);
    const usedFt = [...usedMap.entries()].reduce((sum, [length, quantity]) => sum + length * quantity, 0);
    return {
      scheme: activeStates.map((state) => state.length),
      stock: new Map(cumulativeStock),
      availableStock,
      states: activeStates,
      activeStates,
      activeLength,
      usedMap,
      usedFt,
      complete,
      minRows: rowCounts.length ? Math.min(...rowCounts) : 0,
      maxRows: rowCounts.length ? Math.max(...rowCounts) : 0,
      gaps: 0,
      fullLifts: activeStates.filter((state) => state.rowSequence.length === Number(state.rowCapacity || geometry.rows)).length,
      metal,
      target: kilnLength - metal,
      chamberGap,
      inactiveLifts: 0,
      completeLoad: chamberGap === 0 && activeStates.every((state) => state.rowSequence.length === Number(state.rowCapacity || geometry.rows)),
      stability: { valid: true, label: 'globally repacked independent forklift-stable lifts' },
      valid: activeStates.length > 0,
      heightSpread: rowCounts.length ? Math.max(...rowCounts) - Math.min(...rowCounts) : geometry.rows,
    };
  });
}

function liftTargetKey(state, index) {
  return `${currentLoadNumber}:${index}:${state.length}`;
}

function targetRowsForLift(state, index, geometry) {
  const capacity = state.rowCapacity || liftGeometry(state, index, geometry).rows;
  const saved = manualLiftTargets.get(liftTargetKey(state, index));
  return Math.max(1, Math.min(capacity, Number.isFinite(saved) ? saved : state.rowSequence.length));
}

function requiredBoardsForTargetHeight(states, geometry) {
  const required = new Map();
  states.forEach((state, stateIndex) => {
    const targetRows = targetRowsForLift(state, stateIndex, geometry);
    const joinedPatterns = [];
    const joinedKeys = new Set();
    state.rowSequence.filter((row) => row.type === 'joined').forEach((row) => {
      const key = patternKey(row.pattern);
      if (!joinedKeys.has(key)) {
        joinedKeys.add(key);
        joinedPatterns.push(row.pattern);
      }
    });
    for (let rowIndex = effectiveLiftRows(state); rowIndex < targetRows; rowIndex += 1) {
      const joinedIndex = Math.floor(rowIndex / 2);
      const pattern = joinedPatterns.length && rowIndex % 2 === 1 ? joinedPatterns[joinedIndex % joinedPatterns.length] : [state.length];
      pattern.forEach((length) => required.set(length, (required.get(length) || 0) + geometry.across));
    }
  });
  return required;
}

function renderLiftEditor(states, geometry) {
  const body = $('liftEditor');
  const locked = lockedLoadNumbers().size > 0;
  body.innerHTML = '';
  states.forEach((state, index) => {
    const availableRows = effectiveLiftRows(state);
    const stateGeometry = liftGeometry(state, index, geometry);
    const targetRows = targetRowsForLift(state, index, geometry);
    const rowsToAdd = Math.max(0, targetRows - availableRows);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>Lift ${index + 1} (${state.length} ft)</td>
      <td><input class="lift-sticker" type="number" min="0.25" max="2" step="0.03125" value="${stateGeometry.sticker}" data-key="${liftStickerKey(currentLoadNumber, state, index)}" ${locked ? 'disabled' : ''}></td>
      <td>${availableRows} / ${stateGeometry.rows}</td>
      <td>${fmtMeasure(stateGeometry.usedHeight)}</td>
      <td><input class="lift-target-rows" type="number" min="1" max="${stateGeometry.rows}" step="1" value="${targetRows}" data-key="${liftTargetKey(state, index)}" ${locked ? 'disabled' : ''}></td>
      <td>${rowsToAdd}</td>
      <td>${rowsToAdd * geometry.across}</td>
      <td><span class="pill ${rowsToAdd ? 'warn' : 'good'}">${rowsToAdd ? 'Fill required' : 'Complete'}</span></td>
    `;
    body.appendChild(row);
  });
  body.querySelectorAll('.lift-sticker').forEach((input) => {
    input.addEventListener('change', () => {
      const base = num('sticker');
      const value = Number(input.value);
      if (!Number.isFinite(value) || value <= 0) input.value = base;
      const next = Number(input.value);
      if (Math.abs(next - base) < 1e-9) manualLiftStickers.delete(input.dataset.key);
      else manualLiftStickers.set(input.dataset.key, next);
      persistActiveOrder(false);
      markCalculationPending();
    });
  });
  body.querySelectorAll('.lift-target-rows').forEach((input) => {
    input.addEventListener('change', () => {
      const minimum = Number(input.min);
      const maximum = Number(input.max);
      const value = Math.max(minimum, Math.min(maximum, Math.floor(Number(input.value) || minimum)));
      manualLiftTargets.set(input.dataset.key, value);
      persistActiveOrder(false);
      markCalculationPending();
    });
  });
  $('applyLiftChanges').disabled = locked;
  $('applyLiftChanges').title = locked ? 'Started, completed and operator-adjusted cycles are structurally locked.' : '';
  $('openManualFill').disabled = isLoadCompleted(currentLoadNumber);
}

function renderVisual(bestPlan, geometry, kilnLength, metalBox, safetyClearance = 0) {
  const container = $('kilnVisual');
  container.innerHTML = '';
  const physicalKilnLength = kilnLength + safetyClearance;

  const activeStates = sortStatesByHeight(bestPlan.activeStates || bestPlan.states.filter((state) => effectiveLiftRows(state) > 0));
  const woodTotal = activeStates.reduce((sum, state) => sum + occupiedLiftLength(state), 0);
  const woodGap = Math.max(0, kilnLength - woodTotal);
  const measuredHeights = activeStates.map((state, index) => {
    const stateGeometry = liftGeometry(state, index, geometry);
    return physicalHeightForRows(effectiveLiftRows(state), state.stickerThickness || stateGeometry.sticker);
  });
  const tallestMeasuredHeight = measuredHeights.length ? Math.max(...measuredHeights) : 0;
  const LEVEL_MATCH_TOLERANCE_IN = 1;

  activeStates.forEach((state, index) => {
    const stateGeometry = liftGeometry(state, index, geometry);
    const rowCapacity = state.rowCapacity || stateGeometry.rows;
    const measuredHeight = measuredHeights[index];
    const levelMatched = tallestMeasuredHeight - measuredHeight <= LEVEL_MATCH_TOLERANCE_IN;
    const displayedHeight = levelMatched ? tallestMeasuredHeight : measuredHeight;
    const fillRatio = num('height') > 0 ? displayedHeight / num('height') : 0;
    const stackLength = occupiedLiftLength(state);
    const fillPercent = Math.min(100, 100 * fillRatio);

    const lift = document.createElement('div');
    lift.className = 'lift';
    lift.dataset.order = index + 1;
    lift.style.width = `${(stackLength / physicalKilnLength) * 100}%`;
    const rowCounts = new Map();
    state.rowSequence.forEach((row) => {
      const label = makePatternLabel(row.pattern);
      rowCounts.set(label, (rowCounts.get(label) || 0) + 1);
    });
    (state.manualRows || []).forEach((row) => {
      const label = `MANUAL ${row.quantity}/${geometry.across} × ${row.length} ft`;
      rowCounts.set(label, (rowCounts.get(label) || 0) + 1);
    });
    const rowSummary = [...rowCounts.entries()].map(([label, count]) => `${count} × ${label}`).join('<br>');
    const automaticBands = state.rowSequence.map((row, rowIndex) => {
      const occupiedLength = row.pattern.reduce((sum, length) => sum + length, 0);
      const width = Math.min(100, (occupiedLength / stackLength) * 100);
      return `<i class="row-band ${row.type}" style="bottom:${rowIndex * 100 / rowCapacity}%;height:${100 / rowCapacity}%;width:${width}%" title="Row ${rowIndex + 1}: ${makePatternLabel(row.pattern)} · ${fmtMeasure(state.stickerThickness || stateGeometry.sticker)} stickers"></i>`;
    }).join('');
    const manualBands = (state.manualRows || []).map((row, manualIndex) => {
      const rowIndex = state.rowSequence.length + manualIndex;
      const width = Math.min(100, (Number(row.length) / stackLength) * 100);
      return `<i class="row-band manual" style="bottom:${rowIndex * 100 / rowCapacity}%;height:${100 / rowCapacity}%;width:${width}%" title="Manual row ${manualIndex + 1}: ${row.quantity}/${geometry.across} boards × ${row.length} ft"></i>`;
    }).join('');
    const rowBands = automaticBands + manualBands;
    lift.innerHTML = `
      <div class="lift-rows">${rowBands}</div>
      <div class="lift-empty" style="height:${100 - fillPercent}%"></div>
      <div class="lift-label">Lift ${index + 1} · ${stackLength} ft maximum<br>${rowSummary}<br>${effectiveLiftRows(state)} row layers · ${fmtMeasure(measuredHeight)}${levelMatched && activeStates.length > 1 ? ' · level matched' : ''}<br>${geometry.across} positions across</div>
    `;
    container.appendChild(lift);
  });

  if (metalBox > 0) {
    const metal = document.createElement('div');
    metal.className = 'metal-box';
    metal.style.width = `${(metalBox / physicalKilnLength) * 100}%`;
    metal.innerHTML = `Metal<br>${metalBox} ft`;
    container.appendChild(metal);
  }

  const emptyTotal = Math.max(0, kilnLength - woodTotal - metalBox);

  if (emptyTotal > 0) {
    const empty = document.createElement('div');
    empty.style.width = `${(emptyTotal / physicalKilnLength) * 100}%`;
    empty.style.height = '100%';
    empty.style.background = '#fff4d9';
    empty.style.display = 'flex';
    empty.style.alignItems = 'center';
    empty.style.justifyContent = 'center';
    empty.style.textAlign = 'center';
    empty.innerHTML = `Empty<br>${emptyTotal} ft`;
    container.appendChild(empty);
  }

  if (safetyClearance > 0) {
    const clearance = document.createElement('div');
    clearance.style.width = `${(safetyClearance / physicalKilnLength) * 100}%`;
    clearance.style.height = '100%';
    clearance.style.background = 'repeating-linear-gradient(135deg, #f5d58a 0 12px, #fff4d9 12px 24px)';
    clearance.style.display = 'flex';
    clearance.style.alignItems = 'center';
    clearance.style.justifyContent = 'center';
    clearance.style.textAlign = 'center';
    clearance.innerHTML = `Safety<br>${safetyClearance} ft`;
    container.appendChild(clearance);
  }

  $('visualTitle').textContent = `4. Kiln Load ${currentLoadNumber} — Kiln and Lift Visualization`;
  $('visualMeta').innerHTML = `
    <span><b>Kiln Load ${currentLoadNumber}</b> of ${Math.max(1, globalOrderPlans.length)}</span>
    <span><b>${activeStates.length}</b> lifts · loaded left → right</span>
    <span>Lifts: <b>${activeStates.map((state) => `${occupiedLiftLength(state)} ft${new Set(state.rowSequence.map((row) => row.type)).size > 1 ? ' alternating' : ''}${(state.manualRows || []).length ? ' + manual' : ''}`).join(' → ') || '—'}</b></span>
    <span>Metal: <b>${metalBox} ft</b></span>
    <span>Physical kiln: <b>${physicalKilnLength} ft</b></span>
    <span>Usable length: <b>${kilnLength} ft</b></span>
    ${safetyClearance ? `<span>Supplier clearance: <b>${safetyClearance} ft</b></span>` : ''}
    <span>Calculated height: <b>${fmtMeasure(geometry.usedHeight)} / ${fmtMeasure(num('height'))}</b></span>
    ${woodGap >= kilnLength / 2 ? `<span class="pill warn"><b>LOW-EFFICIENCY FINAL CYCLE:</b> ${woodGap} ft without lumber${metalBox ? ` · closed by ${metalBox} ft metal` : ' · consolidate before running'}</span>` : ''}
  `;
}

function renderFinalInventory(plans, originalStock, geometry) {
  const container = $('finalInventoryVisual');
  const finalStock = plans.length ? plans[plans.length - 1].stock : originalStock;
  const remaining = [...finalStock.entries()].filter(([, quantity]) => quantity > 0).sort(([left], [right]) => right - left);
  const total = remaining.reduce((sum, [, quantity]) => sum + quantity, 0);
  const originalTotal = [...originalStock.values()].reduce((sum, quantity) => sum + quantity, 0);
  const completeRows = remaining.reduce((sum, [, quantity]) => sum + Math.floor(quantity / Math.max(1, geometry.across)), 0);
  const maximumQuantity = Math.max(1, ...remaining.map(([, quantity]) => quantity));
  const remainderSentence = remaining.length
    ? remaining.map(([length, quantity]) => `${quantity} board${quantity === 1 ? '' : 's'} at ${length} ft`).join(', ')
    : 'no boards';
  container.innerHTML = `
    <div class="final-inventory-heading">
      <span>${originalTotal ? `Projected inventory after all ${plans.length} planned cycle${plans.length === 1 ? '' : 's'} · viewing Kiln Load ${currentLoadNumber}` : 'No order entered'}</span>
      <strong>${fmt(total)} boards remaining</strong>
    </div>
    <p class="final-inventory-comment"><b>Calculated remainder:</b> ${remainderSentence}.</p>
    <div class="final-inventory-bars">
      ${remaining.length ? remaining.map(([length, quantity]) => `
        <div class="remainder-item">
          <span><b>${quantity}</b> boards × ${length} ft</span>
          <i style="width:${Math.max(3, (quantity / maximumQuantity) * 100)}%"></i>
        </div>
      `).join('') : '<div class="remainder-item"><span><b>0</b> · order completed</span></div>'}
    </div>
    <div class="carryover-decision ${completeRows ? 'requires-optimization' : total ? 'hold' : 'complete'}">
      <b>${!originalTotal ? 'AWAITING ORDER' : completeRows ? 'OPTIMIZATION REQUIRED' : total ? 'ROW BALANCE PASSED' : 'ORDER COMPLETED'}</b>
      <span>${!originalTotal ? 'Enter board quantities from 3 to 20 ft to generate an optimized kiln plan.' : completeRows ? `${completeRows} complete full-width row${completeRows === 1 ? '' : 's'} remain. The plan must explain or place them before acceptance.` : total ? 'Every remaining length is below one complete row. Keep this conditional inventory for a compatible future order.' : 'No carry-over inventory remains.'}</span>
    </div>
  `;
}

function renderOptimizationAudit(plans, originalStock, geometry) {
  const container = $('optimizationAudit');
  if (!container) return;
  const finalStock = plans.length ? plans[plans.length - 1].stock : originalStock;
  const completeRowsByLength = [...finalStock.entries()]
    .map(([length, quantity]) => [Number(length), Math.floor(Number(quantity || 0) / Math.max(1, geometry.across))])
    .filter(([, rows]) => rows > 0)
    .sort(([left], [right]) => right - left);
  const completeRows = completeRowsByLength.reduce((sum, [, rows]) => sum + rows, 0);
  const partialBoards = [...finalStock.values()].reduce((sum, quantity) => sum + (Number(quantity || 0) % Math.max(1, geometry.across)), 0);
  const emptyFeet = plans.reduce((sum, plan) => sum + Number(plan.chamberGap || 0), 0);
  const locked = [...lockedLoadNumbers()].sort((left, right) => left - right);
  const fullRowLabel = completeRowsByLength.map(([length, rows]) => `${rows}×${length} ft`).join(' · ') || 'none';
  const unlockedPlans = plans.filter((_, index) => !locked.includes(index + 1));
  const maxLiftLength = Math.floor(num('maxStack'));
  const unresolvedReasons = completeRowsByLength.map(([length, rows]) => {
    if (length > maxLiftLength) return `${rows} row${rows === 1 ? '' : 's'} at ${length} ft exceed the ${maxLiftLength} ft maximum lift length`;
    if (!unlockedPlans.length) return `${rows} row${rows === 1 ? '' : 's'} at ${length} ft cannot be placed because every existing cycle is locked`;
    const compatibleOpenLift = unlockedPlans.some((plan) => (plan.activeStates || []).some((state, index) => {
      const capacity = Number(state.rowCapacity || liftGeometry(state, index, geometry).rows);
      return occupiedLiftLength(state) >= length && effectiveLiftRows(state) < capacity;
    }));
    return compatibleOpenLift
      ? `${rows} row${rows === 1 ? '' : 's'} at ${length} ft still have a compatible unlocked lift slot; this plan must be optimized again`
      : `${rows} row${rows === 1 ? '' : 's'} at ${length} ft require another compatible lift/cycle because no unlocked lift has both the length and vertical row space`;
  });
  container.className = `optimization-audit ${completeRows ? 'has-warning' : 'is-balanced'}`;
  container.innerHTML = `
    <div><small>FULL ROWS REMAINING</small><b>${completeRows}</b><span>${fullRowLabel}</span></div>
    <div><small>NON-ROW REMAINDER</small><b>${fmt(partialBoards)}</b><span>boards below ${geometry.across} per length</span></div>
    <div><small>TOTAL EMPTY LENGTH</small><b>${fmt(emptyFeet)} ft</b><span>across ${plans.length} planned cycles</span></div>
    <div><small>LOCKED CYCLES</small><b>${locked.length}</b><span>${locked.length ? locked.map((number) => `#${number}`).join(', ') : 'none'}</span></div>
    ${completeRows ? `<p><b>Action required:</b> ${unresolvedReasons.join('; ')}. Optimize unstarted cycles before accepting this plan.</p>` : '<p><b>Row balance passed:</b> only quantities smaller than one complete row remain.</p>'}
  `;
}

function buildOptimizedPlanSet(sourceStock, geometry, kilnLength, maxStack, selectedMetal, applyManualOverrides = true) {
  const optimizedPlans = solveSequentialFallback(sourceStock, geometry, kilnLength, maxStack, selectedMetal);
  const stickerAdjustedPlans = applyManualOverrides
    ? applyLiftStickerOverrides(optimizedPlans, sourceStock, geometry)
    : optimizedPlans;
  const targetAdjustedPlans = applyManualOverrides
    ? applyLiftTargetOverrides(stickerAdjustedPlans, sourceStock, geometry)
    : stickerAdjustedPlans;
  const filledPlans = fillResidualRowsIntoExistingLifts(
    targetAdjustedPlans,
    sourceStock,
    geometry,
    applyManualOverrides,
  );
  return repackPlansGlobally(
    normalizeLiftLengths(filledPlans),
    sourceStock,
    geometry,
    kilnLength,
    selectedMetal,
  ).map(restorePlanTypes);
}

function optimizeUnlockedPlans(originalStock, geometry, kilnLength, maxStack, selectedMetal) {
  const locked = lockedLoadNumbers();
  const previousPlans = globalOrderPlans.map(restorePlanTypes);
  if (!locked.size) return buildOptimizedPlanSet(originalStock, geometry, kilnLength, maxStack, selectedMetal, true);
  const lockedUsed = new Map();
  locked.forEach((loadNumber) => {
    const plan = previousPlans[loadNumber - 1];
    if (!plan) throw new Error(`Kiln Load ${loadNumber} is locked but its saved plan is unavailable.`);
    plan.usedMap.forEach((quantity, length) => {
      lockedUsed.set(Number(length), Number(lockedUsed.get(Number(length)) || 0) + Number(quantity || 0));
    });
  });
  const remainingStock = new Map(originalStock);
  lockedUsed.forEach((quantity, length) => {
    const available = Number(remainingStock.get(length) || 0);
    if (quantity > available) throw new Error(`Locked-cycle balance error at ${length} ft.`);
    remainingStock.set(length, available - quantity);
  });
  const futurePlans = buildOptimizedPlanSet(remainingStock, geometry, kilnLength, maxStack, selectedMetal, false);
  const merged = [];
  let futureIndex = 0;
  const finalLockedNumber = Math.max(...locked);
  const slots = Math.max(previousPlans.length, finalLockedNumber);
  for (let index = 0; index < slots; index += 1) {
    const loadNumber = index + 1;
    if (locked.has(loadNumber)) {
      merged.push({ ...previousPlans[index], locked: true });
    } else if (futureIndex < futurePlans.length) {
      merged.push({ ...futurePlans[futureIndex], locked: false });
      futureIndex += 1;
    } else if (loadNumber < finalLockedNumber) {
      throw new Error(`Not enough remaining material to preserve locked Kiln Load ${finalLockedNumber} at its existing number.`);
    }
  }
  while (futureIndex < futurePlans.length) {
    merged.push({ ...futurePlans[futureIndex], locked: false });
    futureIndex += 1;
  }
  return rebuildPlanBalances(merged, originalStock, geometry, kilnLength);
}

function calculate(allowOptimization = false) {
  const physicalKilnLength = Math.floor(num('kiln'));
  const safetyClearance = Math.min(Math.max(0, physicalKilnLength - 1), Math.floor(num('supplierClearance')));
  const kilnLength = Math.max(1, physicalKilnLength - safetyClearance);
  const selectedMetal = Math.floor(Number($('metalBox').value));
  const metalOptions = selectedMetal < 0 ? [0, 4, 5, 6] : [selectedMetal];
  const maxStack = Math.floor(num('maxStack'));
  const geometry = computeGeometry();
  const originalStock = readInventory();
  const lengths = [...originalStock.keys()].filter((length) => length <= maxStack);
  const supplier = $('supplier').value.trim() || 'Not specified';
  saveSupplierProfile();
  $('reportMeta').textContent = `Supplier: ${supplier} · Ordered size: ${materialSizeLabel()} · Physical: ${fmtMeasure(num('actualT'))} × ${fmtMeasure(num('actualW'))} · Kiln: ${physicalKilnLength} ft physical / ${kilnLength} ft usable`;
  $('geometryPreview').innerHTML = `<strong>Live physical capacity:</strong> ${geometry.across} boards across × ${geometry.rows} rows high = ${geometry.lines} board positions per full lift. Physical batch: ${fmtMeasure(num('actualT'))} × ${fmtMeasure(num('actualW'))}.`;

  const signature = orderSignature(originalStock, geometry, kilnLength, maxStack, selectedMetal);
  if (signature !== globalOrderSignature && !allowOptimization) {
    throw new Error('Optimization is locked. Use the Calculate Load button to create a new plan.');
  }
  if (allowOptimization) {
    const previousLoadNumber = currentLoadNumber;
    globalOrderSignature = signature;
    // Use the same proven sequential planner in local files and on the web.
    // The HiGHS global model produced a different plan only after deployment,
    // because its WASM module cannot initialize from file:// URLs.
    globalOrderPlans = optimizeUnlockedPlans(originalStock, geometry, kilnLength, maxStack, selectedMetal);
    loadRecords.clear();
    currentLoadNumber = Math.min(previousLoadNumber, Math.max(1, globalOrderPlans.length));
  }

  let bestPlan = globalOrderPlans[currentLoadNumber - 1]
    ? restorePlanTypes(globalOrderPlans[currentLoadNumber - 1])
    : null;

  for (const metalBox of bestPlan ? [] : metalOptions) {
    const woodTarget = Math.max(0, kilnLength - metalBox);
    const schemes = schemesForInventory(woodTarget, lengths);

    for (const scheme of schemes) {
        const candidate = runSchemeOptimal(scheme, originalStock, geometry, lengths);
        if (!candidate) continue;
        candidate.metal = metalBox;
        candidate.target = woodTarget;
        candidate.activeStates = sortStatesByHeight(candidate.states.filter((state) => state.rowSequence.length > 0));
        candidate.activeLength = candidate.activeStates.reduce((sum, state) => sum + state.length, 0);
        candidate.chamberGap = Math.max(0, woodTarget - candidate.activeLength);
        candidate.inactiveLifts = candidate.states.length - candidate.activeStates.length;
        candidate.completeLoad = candidate.chamberGap === 0 && candidate.activeStates.length > 0 && candidate.activeStates.every((state) => state.rowSequence.length === geometry.rows);
        candidate.remainingFt = inventoryFeet(candidate.stock);
        candidate.remainingUsableFt = usableInventoryFeet(candidate.stock, geometry.across);
        candidate.strandedFt = Math.max(0, candidate.remainingFt - candidate.remainingUsableFt);
        candidate.orderUsableFt = candidate.usedFt + candidate.remainingUsableFt;
        const rowHeights = candidate.activeStates.map((state) => state.rowSequence.length);
        candidate.heightSpread = rowHeights.length ? Math.max(...rowHeights) - Math.min(...rowHeights) : geometry.rows;
        if (isBetterKilnPlan(candidate, bestPlan)) {
          bestPlan = candidate;
        }
    }
  }

  if (!bestPlan) {
    bestPlan = {
      scheme: [],
      stock: new Map(originalStock),
      states: [],
      usedFt: 0,
      complete: 0,
      gaps: 0,
      fullLifts: 0,
      minRows: 0,
      maxRows: 0,
      metal: 0,
      target: kilnLength,
      chamberGap: kilnLength,
      activeStates: [],
      activeLength: 0,
      inactiveLifts: 0,
      stability: { valid: false, label: 'no stable structure' },
      valid: false,
      completeLoad: false,
      remainingFt: inventoryFeet(originalStock),
      remainingUsableFt: usableInventoryFeet(originalStock, geometry.across),
      strandedFt: inventoryFeet(originalStock) - usableInventoryFeet(originalStock, geometry.across),
      orderUsableFt: usableInventoryFeet(originalStock, geometry.across),
      heightSpread: geometry.rows,
    };
  }

  const metalBox = bestPlan.metal;
  const target = bestPlan.target;
  const totalBf = [...originalStock.entries()].reduce((sum, [length, qty]) => sum + bf(length, qty), 0);
  const usedBf = bf(1, bestPlan.usedFt || 0);
  // restorePlanTypes returns a normalized copy, so object identity cannot be
  // used to decide whether this is a saved cycle. Use the selected index.
  // Otherwise Kiln Load N displays cumulative boards from loads 1..N as the
  // current cycle output.
  const globalPlanSelected = Boolean(globalOrderPlans[currentLoadNumber - 1]);
  const usedByLength = globalPlanSelected
    ? new Map(bestPlan.usedMap)
    : new Map([...originalStock.entries()].map(([length, qty]) => [
      length,
      bestPlan.stock.get(length) === undefined ? 0 : Math.max(0, qty - (bestPlan.stock.get(length) || 0)),
    ]));
  const remainingByLength = globalPlanSelected
    ? new Map(bestPlan.stock)
    : new Map([...originalStock.entries()].map(([length, quantity]) => [length, Math.max(0, quantity - (usedByLength.get(length) || 0))]));
  const cycleAvailableByLength = globalPlanSelected
    ? new Map(bestPlan.availableStock || originalStock)
    : new Map(originalStock);

  const inventoryTotalQty = [...originalStock.values()].reduce((sum, count) => sum + count, 0);
  const usedTotalQty = [...usedByLength.values()].reduce((sum, count) => sum + count, 0);
  const remainTotalQty = Math.max(0, inventoryTotalQty - usedTotalQty);

  const activeStates = bestPlan.activeStates || bestPlan.states.filter((state) => state.rowSequence.length > 0);
  const planLines = activeStates.reduce((sum, state, index) => sum
    + (state.rowCapacity || liftGeometry(state, index, geometry).rows) * geometry.across, 0);
  const lengthFilled = bestPlan.chamberGap === 0 && activeStates.length > 0;
  const fullLoad = lengthFilled && planLines > 0 && bestPlan.complete === planLines;
  const kilnCapacity = bf(kilnLength, geometry.lines);
  const layoutCapacity = activeStates.reduce((sum, state, index) => sum + bf(
    state.length,
    (state.rowCapacity || liftGeometry(state, index, geometry).rows) * geometry.across,
  ), 0);
  const missingBf = Math.max(0, layoutCapacity - usedBf);
  const unusedBf = Math.max(0, totalBf - usedBf);
  const usableOrderBf = bf(1, usableInventoryFeet(originalStock, geometry.across));
  const minimumCycles = usableOrderBf > 0 && kilnCapacity > 0 ? Math.ceil(usableOrderBf / kilnCapacity) : 0;
  const plannedCycles = globalOrderPlans.length || minimumCycles;
  const plannedBoards = globalOrderPlans.length
    ? globalOrderPlans.reduce((sum, plan) => sum + [...plan.usedMap.values()].reduce((loadSum, quantity) => loadSum + quantity, 0), 0)
    : usedTotalQty;
  const plannedLifts = globalOrderPlans.length
    ? globalOrderPlans.reduce((sum, plan) => sum + plan.activeStates.length, 0)
    : activeStates.length;
  // A kiln with an open longitudinal chamber gap is never production-ready,
  // regardless of how many rows happen to be present in the selected lifts.
  const efficientCycle = fullLoad;
  $('reportMeta').textContent = `${plannedCycles} planned kiln cycle${plannedCycles === 1 ? '' : 's'} · ${plannedLifts} lifts · ${plannedBoards} boards scheduled · Supplier: ${supplier}`;

  $('rows').textContent = geometry.rows;
  $('lines').textContent = fmt(geometry.lines);
  $('needPieces').textContent = activeStates.length || '—';
  $('capacity').textContent = fmt(planLines);
  $('capacityLabel').textContent = 'board positions in current layout';

  let totalQty = 0;
  let totalUsed = 0;
  let totalBefore = 0;

  document.querySelectorAll('#inventory tr').forEach((row) => {
    const length = Math.floor(Number(row.querySelector('.len').value) || 0);
    const quantity = Math.floor(Number(row.querySelector('.qty').value) || 0);
    const used = usedByLength.get(length) || 0;
    const before = cycleAvailableByLength.get(length) || 0;

    totalQty += quantity;
    totalUsed += used;
    totalBefore += before;

    row.querySelector('.before').textContent = before;
    row.querySelector('.used').textContent = used;
    row.querySelector('.remain').textContent = remainingByLength.get(length) || 0;
  });

  $('qtyTotal').textContent = fmt(totalQty);
  $('beforeTotal').textContent = fmt(totalBefore);
  $('usedTotal').textContent = fmt(totalUsed);
  $('remainTotal').textContent = fmt([...remainingByLength.values()].reduce((sum, quantity) => sum + quantity, 0));

  $('loadBF').textContent = fmt(totalUsed);
  $('fillPct').textContent = fmt(activeStates.length);
  $('missingBF').textContent = fmt(plannedCycles);
  $('unusedBF').textContent = fmt([...remainingByLength.values()].reduce((sum, quantity) => sum + quantity, 0));

  renderResidualTable(cycleAvailableByLength, usedByLength);

  const orderQty = [...originalStock.values()].reduce((sum, item) => sum + item, 0);
  renderLiftEditor(activeStates, geometry);
  const requiredFill = requiredBoardsForTargetHeight(activeStates, geometry);
  const requiredFillLabel = [...requiredFill.entries()]
    .sort(([left], [right]) => right - left)
    .map(([length, quantity]) => `${quantity}×${length} ft`)
    .join(', ') || 'none';
  const rowSchedule = activeStates.map((state, liftIndex) => {
    const automaticRows = state.rowSequence.map((row, rowIndex) => `<span class="stacking-row ${row.type === 'joined' ? 'joined' : 'solid'}"><b>${rowIndex + 1}</b><span>${makePatternLabel(row.pattern)}</span><small>${row.type === 'joined' ? 'JOINED' : 'SOLID'}</small></span>`).join('');
    const manualRows = (state.manualRows || []).map((row, index) => `<span class="stacking-row manual"><b>${state.rowSequence.length + index + 1}</b><span>${row.quantity}/${geometry.across} boards × ${row.length} ft</span><small>MANUAL PARTIAL</small></span>`).join('');
    const rows = automaticRows + manualRows;
    const boards = [...usedMapForStates([state], geometry).values()].reduce((sum, quantity) => sum + quantity, 0);
    return `<section class="stacking-lift"><header><div><small>LIFT ${liftIndex + 1}</small><b>${occupiedLiftLength(state)} ft maximum</b></div><span>${effectiveLiftRows(state)} row layers · ${fmt(boards)} boards</span></header><div class="stacking-grid">${rows || '<span class="stacking-empty">Empty</span>'}</div></section>`;
  }).join('');
  $('productionNeed').innerHTML = `
    <div class="plan-status-row">
      <span class="pill ${efficientCycle ? 'good' : 'warn'}">${efficientCycle ? 'READY / EFFICIENT LOAD' : 'DO NOT RUN — ADD MATERIAL'}</span>
      <span><b>${plannedCycles}</b> kiln cycles</span>
      <span><b>${plannedLifts}</b> total lifts</span>
      <span><b>${fmt(plannedBoards)}</b> boards scheduled</span>
    </div>
    ${requiredFillLabel === 'none' ? '' : `<div class="fill-warning"><b>Material required to complete selected lifts:</b> ${requiredFillLabel}</div>`}
    <details class="technical-details stacking-details"><summary><span><b>Exact row-by-row stacking sequence</b><small>Each numbered tile is one physical row from bottom to top</small></span><strong>${activeStates.length} lift${activeStates.length === 1 ? '' : 's'}</strong></summary><div class="stacking-schedule">${rowSchedule}</div></details>
  `;

  $('orderLoads').innerHTML = `
    <div class="order-flow">
      <div><small>ORIGINAL ORDER</small><b>${fmt(orderQty)}</b><span>boards</span></div>
      <i>→</i>
      <div><small>BEFORE LOAD ${currentLoadNumber}</small><b>${fmt(totalBefore)}</b><span>available</span></div>
      <i>→</i>
      <div class="current"><small>PROCESS NOW</small><b>${fmt(totalUsed)}</b><span>boards</span></div>
      <i>→</i>
      <div><small>REMAINING</small><b>${fmt([...remainingByLength.values()].reduce((sum, quantity) => sum + quantity, 0))}</b><span>boards</span></div>
    </div>
  `;

  $('orderRemaining').innerHTML = `
    <details class="remaining-details"><summary><b>Remaining inventory after Kiln Load ${currentLoadNumber}</b><span>View quantities by length</span></summary><p>${summarizeStock(remainingByLength)}</p></details>
  `;

  $('condLength').innerHTML = `<span class="pill ${lengthFilled ? 'good' : 'warn'}">${lengthFilled ? '✓' : '!'} ${kilnLength - bestPlan.chamberGap} / ${kilnLength} ft occupied</span>`;
  $('condHeight').innerHTML = `<span class="pill ${bestPlan.fullLifts ? 'good' : 'warn'}">${bestPlan.fullLifts ? `✓ ${bestPlan.fullLifts} full lift${bestPlan.fullLifts === 1 ? '' : 's'}` : `Lift rows: ${activeStates.map((state, index) => `${effectiveLiftRows(state)}/${state.rowCapacity || liftGeometry(state, index, geometry).rows}`).join(' · ')}`}</span>`;
  $('condMetal').innerHTML = `<span class="pill ${metalBox ? 'warn' : 'good'}">${metalBox ? `Metal box: ${metalBox} ft` : 'No metal box'}</span>`;
  const physicalFill = planLines > 0 ? (bestPlan.complete / planLines) * 100 : 0;
  $('condBF').innerHTML = `<span class="pill ${physicalFill >= 15 ? 'good' : 'warn'}">${fmt(totalUsed)} boards · ${fmt(physicalFill, 1)}% of planned row positions</span>`;

  $('status').innerHTML = `
    <p><span class="pill ${geometry.rows && target && maxStack && bestPlan.valid ? 'good' : 'warn'}">${geometry.rows && target && maxStack && bestPlan.valid ? 'Valid layout' : 'Layout check required'}</span></p>
    <p>Physical board: <b>${fmtMeasure(num('actualT'))} × ${fmtMeasure(num('actualW'))}</b>; row pitch <b>${fmtMeasure(num('actualT') + num('sticker'))}</b>.</p>
    <p><b>${geometry.rows}</b> complete rows × <b>${geometry.across}</b> positions across = <b>${geometry.lines}</b> board positions per lift.</p>
    <p>Height: <b>${fmtMeasure(geometry.usedHeight)}</b> / ${fmtMeasure(num('height'))}.</p>
    <p>Width: <b>${fmtMeasure(geometry.usedWidth)}</b> / ${fmtMeasure(num('liftWidth'))}; <b>${fmtMeasure(geometry.widthWaste)}</b> unused.</p>
    <p>Supplier: <b>${escapeHtml(supplier)}</b>.</p>
    <p>Material: <b>${escapeHtml($('species').value || '—')} · ordered ${materialSizeLabel()} · ${fmtMeasure(num('actualT'))} × ${fmtMeasure(num('actualW'))} physical</b>.</p>
  `;

  $('resultIntro').innerHTML = `
    <p>
      <span class="pill ${bestPlan.valid ? 'good' : 'warn'}">
        Layout: ${activeStates.length ? activeStates.map((state) => `${state.length} ft lift`).join(' | ') : 'no valid layout'}${metalBox ? ` | ${metalBox} ft metal` : ''}${bestPlan.chamberGap ? ` | ${bestPlan.chamberGap} ft empty` : ''}
      </span>
    </p>
    <p>
      <b>${bestPlan.fullLifts} of ${activeStates.length} lifts filled to maximum height.</b>
      ${fullLoad ? 'Maximum load height reached in every lift.' : `Individual lift heights: ${activeStates.map((state, index) => `${effectiveLiftRows(state)}/${state.rowCapacity || liftGeometry(state, index, geometry).rows} rows`).join(' · ')}.`}
      <b>Structure:</b> ${bestPlan.stability?.label || 'independent operator-stable lifts'}.
    </p>
  `;

  $('plan').innerHTML = activeStates.map((state, activeIndex) => {
    const patterns = [];
    let liftBoards = 0;
    state.groups.forEach((count, key) => {
      const [comboPart, gapPart] = key.split('|');
      const combo = comboPart;
      const gap = Number(gapPart) || 0;
      const pieces = combo.split(' + ').length;
      const boards = pieces * geometry.across * count;
      liftBoards += boards;
      const type = pieces === 1 ? 'Solid' : pieces === 2 ? 'Double mix' : 'Triple mix';
      patterns.push(`<div class="lift-pattern">
        <span class="pattern-type">${type}</span>
        <b>${makePatternLabel(combo.split(' + ').map(Number))}</b>
        <span>${count} row${count === 1 ? '' : 's'}</span>
        <strong>${fmt(boards)} boards</strong>
        ${gap ? `<em>${gap} ft step</em>` : ''}
      </div>`);
    });
    (state.manualRows || []).forEach((row) => {
      liftBoards += Number(row.quantity || 0);
      patterns.push(`<div class="lift-pattern manual"><span class="pattern-type">Manual partial</span><b>${row.length} ft</b><span>1 row · ${row.quantity}/${geometry.across} positions</span><strong>${row.quantity} boards</strong><em>operator verified</em></div>`);
    });
    return `<article class="lift-plan-card">
      <header><div><small>LIFT ${activeIndex + 1}</small><h3>${occupiedLiftLength(state)} ft maximum</h3><span>${fmtMeasure(state.stickerThickness || num('sticker'))} stickers</span></div><div class="lift-total"><b>${effectiveLiftRows(state)}/${state.rowCapacity || liftGeometry(state, activeIndex, geometry).rows}</b><span>row layers</span><strong>${fmt(liftBoards)} boards</strong></div></header>
      <div class="lift-patterns">${patterns.join('')}</div>
    </article>`;
  }).join('');

  $('shortage').innerHTML = fullLoad
    ? '<p class="note">A full kiln load has been assembled; remaining inventory is available for the next load.</p>'
    : bestPlan.valid
      ? `<p class="note"><b>Maximum inventory utilization:</b> ${bestPlan.fullLifts} lift${bestPlan.fullLifts === 1 ? '' : 's'} at full height; remaining lifts use every available complete stable row. Partial rows are prohibited.</p>`
      : '<p><b>No stable load:</b> inventory cannot form equal-height lifts across the selected kiln layout.</p>';

  $('cycleYield').innerHTML = orderQty ? `
      <span>Production output · Kiln Load ${currentLoadNumber}</span>
      <strong>${fmt(totalUsed)} boards</strong>
      <b>${fmt(usedBf, 1)} BF total output</b>
    ` : '<span>Enter an order to calculate production output.</span>';

  renderVisual(bestPlan, geometry, kilnLength, metalBox, safetyClearance);
  renderFinalInventory(globalOrderPlans, originalStock, geometry);
  renderOptimizationAudit(globalOrderPlans, originalStock, geometry);
  renderManualFillSummary(bestPlan);

  if (globalOrderPlans.length > 0) {
    loadRecords.clear();
    globalOrderPlans.forEach((plan, index) => {
      const number = index + 1;
      const usedBoards = [...plan.usedMap.values()].reduce((sum, quantity) => sum + quantity, 0);
      loadRecords.set(number, {
        number,
        available: new Map(plan.availableStock || originalStock),
        used: new Map(plan.usedMap),
        remaining: new Map(plan.stock),
        usedBoards,
        remainingBoards: [...plan.stock.values()].reduce((sum, quantity) => sum + quantity, 0),
        usedBf: bf(1, plan.usedFt),
        valid: plan.valid,
        layout: plan.activeStates.map((state) => `${state.length} ft`).join(' → ') || '—',
        global: true,
      });
    });
    currentLoadSnapshot = loadRecords.get(currentLoadNumber) || loadRecords.get(1);
  } else {
    currentLoadSnapshot = {
      number: currentLoadNumber,
      available: new Map(originalStock),
      used: new Map(usedByLength),
      remaining: new Map(remainingByLength),
      usedBoards: totalUsed,
      remainingBoards: [...remainingByLength.values()].reduce((sum, quantity) => sum + quantity, 0),
      usedBf,
      valid: bestPlan.valid,
      layout: activeStates.map((state) => `${state.length} ft`).join(' → ') || '—',
      global: false,
    };
    if (orderQty > 0 && currentLoadSnapshot.valid && currentLoadSnapshot.usedBoards > 0) loadRecords.set(currentLoadNumber, currentLoadSnapshot);
    else loadRecords.clear();
  }
  $('loadNumber').textContent = currentLoadNumber;
  $('nextLoad').disabled = !loadRecords.has(currentLoadNumber + 1);
  renderLoadNavigation();
}

function finalUnallocatedStock() {
  if (!globalOrderPlans.length) return readInventory();
  return new Map(globalOrderPlans[globalOrderPlans.length - 1].stock || []);
}

function renderManualFillSummary(plan = globalOrderPlans[currentLoadNumber - 1]) {
  const container = $('manualFillSummary');
  if (!container) return;
  const rows = (plan?.activeStates || []).flatMap((state, liftIndex) =>
    (state.manualRows || []).map((row) => ({ ...row, liftIndex })));
  container.innerHTML = rows.length
    ? `<b>Manual partial rows:</b> ${rows.map((row) => `Lift ${row.liftIndex + 1}: ${row.quantity}/${computeGeometry().across} × ${row.length} ft`).join(' · ')}`
    : '<span>No manual partial rows in this cycle.</span>';
}

function refreshManualFillDialog(message = '') {
  const plan = globalOrderPlans[editingManualLoadNumber - 1];
  if (!plan) return;
  const geometry = computeGeometry();
  const stock = finalUnallocatedStock();
  const liftSelect = $('manualFillLift');
  const previousLift = Number(liftSelect.value || 0);
  liftSelect.innerHTML = (plan.activeStates || []).map((state, index) => {
    const rows = effectiveLiftRows(state);
    const capacity = Number(state.rowCapacity || liftGeometry(state, index, geometry, editingManualLoadNumber).rows);
    return `<option value="${index}" ${index === previousLift ? 'selected' : ''}>Lift ${index + 1} · ${occupiedLiftLength(state)} ft · ${rows}/${capacity} row layers</option>`;
  }).join('');
  const liftIndex = Math.min(Number(liftSelect.value || 0), Math.max(0, (plan.activeStates || []).length - 1));
  const state = plan.activeStates[liftIndex];
  if (!state) {
    $('manualFillAvailability').className = 'calculation-status pending';
    $('manualFillAvailability').textContent = 'This cycle has no lift available for manual filling.';
    $('manualFillLength').innerHTML = '';
    $('addManualBoards').disabled = true;
    return;
  }
  const maxLength = occupiedLiftLength(state);
  const available = [...stock.entries()]
    .filter(([length, quantity]) => Number(quantity) > 0 && Number(length) <= maxLength)
    .sort(([left], [right]) => Number(right) - Number(left));
  $('manualFillLength').innerHTML = available.map(([length, quantity]) => `<option value="${length}">${length} ft · ${quantity} available</option>`).join('');
  const selectedLength = Number($('manualFillLength').value || 0);
  const selectedAvailable = Number(stock.get(selectedLength) || 0);
  const lastManual = (state.manualRows || []).at(-1);
  const openPositions = lastManual && Number(lastManual.length) === selectedLength
    ? Math.max(0, geometry.across - Number(lastManual.quantity || 0))
    : geometry.across;
  const rowCapacity = Number(state.rowCapacity || geometry.rows);
  const heightAvailable = Boolean(lastManual && Number(lastManual.length) === selectedLength && openPositions > 0)
    || effectiveLiftRows(state) < rowCapacity;
  const maximum = heightAvailable ? Math.min(selectedAvailable, openPositions || geometry.across) : 0;
  $('addManualBoards').disabled = maximum < 1;
  $('manualFillQuantity').max = String(Math.max(1, maximum));
  $('manualFillQuantity').value = String(Math.max(1, Math.min(maximum || 1, Number($('manualFillQuantity').value || 1))));
  $('manualFillAvailability').className = `calculation-status ${maximum ? 'ready' : 'pending'}`;
  $('manualFillAvailability').textContent = message || (maximum
    ? `${selectedAvailable} boards at ${selectedLength} ft remain unallocated. Up to ${maximum} can be placed in this manual row.`
    : available.length ? 'This lift has no vertical space for another manual row.' : 'No compatible boards remain for this lift.');
  const manualRows = (plan.activeStates || []).flatMap((lift, index) =>
    (lift.manualRows || []).map((row, rowIndex) => ({ ...row, liftIndex: index, rowIndex })));
  $('manualFillRows').innerHTML = manualRows.length ? manualRows.map((row) => `
    <div><span><b>Lift ${row.liftIndex + 1}</b> · ${row.quantity}/${geometry.across} boards × ${row.length} ft</span><button type="button" class="remove-manual-row secondary" data-lift="${row.liftIndex}" data-row="${row.rowIndex}">Remove</button></div>
  `).join('') : '<p class="note">No manual rows have been added to this cycle.</p>';
  $('manualFillRows').querySelectorAll('.remove-manual-row').forEach((button) => button.addEventListener('click', () => removeManualRow(Number(button.dataset.lift), Number(button.dataset.row))));
}

function openManualFillDialog() {
  if (!globalOrderPlans.length) return;
  if (isLoadCompleted(currentLoadNumber)) {
    $('calculationStatus').className = 'calculation-status pending';
    $('calculationStatus').textContent = `Kiln Load ${currentLoadNumber} is completed and cannot be changed.`;
    return;
  }
  editingManualLoadNumber = currentLoadNumber;
  $('manualFillTitle').textContent = `Manually fill Kiln Load ${currentLoadNumber}`;
  refreshManualFillDialog();
  $('manualFillDialog').showModal();
}

function addManualBoards(event) {
  event.preventDefault();
  const plan = globalOrderPlans[editingManualLoadNumber - 1];
  if (!plan || isLoadCompleted(editingManualLoadNumber)) return;
  const geometry = computeGeometry();
  const liftIndex = Number($('manualFillLift').value);
  const length = Number($('manualFillLength').value);
  const quantity = Math.floor(Number($('manualFillQuantity').value));
  const state = plan.activeStates[liftIndex];
  const available = Number(finalUnallocatedStock().get(length) || 0);
  if (!state || !Number.isFinite(length) || quantity < 1 || quantity > geometry.across || quantity > available) {
    refreshManualFillDialog('Check the lift, length and quantity. Only unallocated remainder can be added.');
    return;
  }
  if (length > occupiedLiftLength(state)) {
    refreshManualFillDialog('The selected board is longer than this lift. Choose another lift.');
    return;
  }
  const previousPlans = deserializeCalculatedPlans(serializeCalculatedPlans());
  state.manualRows = (state.manualRows || []).map((row) => ({ ...row }));
  const lastManual = state.manualRows.at(-1);
  if (lastManual && Number(lastManual.length) === length && Number(lastManual.quantity) < geometry.across) {
    const positions = geometry.across - Number(lastManual.quantity);
    if (quantity > positions) {
      refreshManualFillDialog(`Only ${positions} open positions remain in the current partial row.`);
      return;
    }
    lastManual.quantity = Number(lastManual.quantity) + quantity;
  } else {
    const capacity = Number(state.rowCapacity || geometry.rows);
    if (effectiveLiftRows(state) >= capacity) {
      refreshManualFillDialog('This lift has reached its maximum row height.');
      return;
    }
    state.manualRows.push({ id: `manual-${Date.now()}`, length, quantity, addedAt: new Date().toISOString() });
  }
  const physicalKilnLength = Math.floor(num('kiln'));
  const kilnLength = Math.max(1, physicalKilnLength - Math.floor(num('supplierClearance')));
  try {
    globalOrderPlans = rebuildPlanBalances(globalOrderPlans, readInventory(), geometry, kilnLength).map(restorePlanTypes);
    calculate(false);
    persistActiveOrder(true);
    refreshManualFillDialog(`${quantity} board${quantity === 1 ? '' : 's'} at ${length} ft added without rerunning the optimizer.`);
  } catch (error) {
    globalOrderPlans = previousPlans;
    calculate(false);
    refreshManualFillDialog(`Boards were not added: ${error?.message || 'inventory balance validation failed.'}`);
  }
}

function removeManualRow(liftIndex, rowIndex) {
  if (isLoadCompleted(editingManualLoadNumber)) return;
  const plan = globalOrderPlans[editingManualLoadNumber - 1];
  const state = plan?.activeStates?.[liftIndex];
  if (!state?.manualRows?.[rowIndex]) return;
  const previousPlans = deserializeCalculatedPlans(serializeCalculatedPlans());
  state.manualRows.splice(rowIndex, 1);
  const geometry = computeGeometry();
  const physicalKilnLength = Math.floor(num('kiln'));
  const kilnLength = Math.max(1, physicalKilnLength - Math.floor(num('supplierClearance')));
  try {
    globalOrderPlans = rebuildPlanBalances(globalOrderPlans, readInventory(), geometry, kilnLength).map(restorePlanTypes);
    calculate(false);
    persistActiveOrder(true);
    refreshManualFillDialog('Manual row removed and the inventory balance restored.');
  } catch (error) {
    globalOrderPlans = previousPlans;
    calculate(false);
    refreshManualFillDialog(`Manual row was not removed: ${error?.message || 'inventory balance validation failed.'}`);
  }
}

function renderLoadNavigation() {
  const history = $('loadHistory');
  history.innerHTML = '';
  [...loadRecords.values()].sort((left, right) => left.number - right.number).forEach((snapshot) => {
    const historyRow = document.createElement('article');
    historyRow.className = snapshot.number === currentLoadNumber ? 'current' : '';
    historyRow.dataset.load = snapshot.number;
    const completed = isLoadCompleted(snapshot.number);
    const inProgress = isLoadInProgress(snapshot.number);
    const actionLabel = completed ? '✓ Completed' : inProgress ? 'Complete' : 'Start';
    historyRow.classList.toggle('in-progress', inProgress);
    const hasDryingData = dryingPrograms.has(String(snapshot.number));
    const stateLabel = completed ? 'Processed' : inProgress ? 'In progress' : `${fmt(snapshot.remainingBoards)} remaining`;
    const hasThermoData = thermoPrograms.has(String(snapshot.number));
    historyRow.innerHTML = `<div class="load-actions"><button class="complete-cycle ${completed ? 'is-complete' : ''} ${inProgress ? 'is-progress' : ''}" type="button" ${completed ? 'disabled' : ''}>${actionLabel}</button>${inProgress ? '<button class="cancel-cycle-start" type="button" title="Return this kiln load to Planned">Cancel start</button>' : ''}<button class="drying-program-open ${hasDryingData ? 'has-data' : ''}" type="button">${hasDryingData ? 'Drying ✓' : 'Drying'}</button><button class="thermo-program-open ${hasThermoData ? 'has-data' : ''}" type="button">${hasThermoData ? 'TM ✓' : 'TM'}</button></div><b>Kiln Load ${snapshot.number}</b><span class="load-layout">${snapshot.layout}</span><span class="load-output">${fmt(snapshot.usedBoards)} boards <small>${fmt(snapshot.usedBf, 1)} BF</small></span><span class="load-state ${completed ? 'done' : inProgress ? 'active' : ''}">${stateLabel}</span>`;
    historyRow.querySelector('.complete-cycle').addEventListener('click', (event) => {
      event.stopPropagation();
      if (inProgress) openCycleCompletion(snapshot.number);
      else startKilnCycle(snapshot.number);
    });
    historyRow.querySelector('.cancel-cycle-start')?.addEventListener('click', (event) => {
      event.stopPropagation();
      cancelKilnCycleStart(snapshot.number);
    });
    historyRow.querySelector('.drying-program-open').addEventListener('click', (event) => {
      event.stopPropagation();
      openDryingProgram(snapshot.number);
    });
    historyRow.querySelector('.thermo-program-open').addEventListener('click', (event) => {
      event.stopPropagation();
      openThermoProgram(snapshot.number);
    });
    historyRow.addEventListener('click', () => selectSavedLoad(snapshot.number));
    history.appendChild(historyRow);
  });
  $('previousLoad').disabled = !loadRecords.has(currentLoadNumber - 1);
  $('nextSavedLoad').disabled = !loadRecords.has(currentLoadNumber + 1);
}

const MASPEL_DRYING_DEFAULTS = [
  { phase: 'PH1', mc: 20, mbar: 150, temp: 67 },
  { phase: 'PH2', mc: 18, mbar: 150, temp: 67 },
  { phase: 'PH3', mc: 17, mbar: 150, temp: 67 },
  { phase: 'PH4', mc: 12, mbar: 150, temp: 67 },
  { phase: 'PH5', mc: 10, mbar: 150, temp: 67 },
  { phase: 'PH6', mc: 9, mbar: 150, temp: 69 },
  { phase: 'PH7', mc: 8, mbar: 150, temp: 73 },
  { phase: 'PH8', mc: 7, mbar: 150, temp: 76 },
];

function defaultDryingRows() {
  return MASPEL_DRYING_DEFAULTS.map((row) => ({ ...row, emc: null, gradient: null }));
}

function renderDryingCurrentRows(rows) {
  $('dryingCurrentRows').innerHTML = rows.map((row) => `<tr><td>${escapeHtml(row.phase)}</td><td>${Number(row.mc)}</td><td>${Number(row.mbar)}</td><td>${Number(row.temp)}</td><td>${Number.isFinite(row.emc) ? row.emc.toFixed(2) : '—'}</td><td>${Number.isFinite(row.gradient) ? row.gradient.toFixed(2) : '—'}</td></tr>`).join('');
}

function renderDryingScenarioRows(rows, baseline = []) {
  $('dryingScenarioRows').innerHTML = rows.map((row, index) => {
    const current = baseline[index] || {};
    const deltaEmc = Number.isFinite(row.emc) && Number.isFinite(current.emc) ? row.emc - current.emc : null;
    const deltaGradient = Number.isFinite(row.gradient) && Number.isFinite(current.gradient) ? row.gradient - current.gradient : null;
    return `<tr data-phase="${index}"><td>${escapeHtml(row.phase)}</td><td><input class="drying-mc" type="number" min="0" max="100" step="0.1" value="${Number(row.mc)}"></td><td><input class="drying-mbar" type="number" min="0.1" step="0.1" value="${Number(row.mbar)}"></td><td><input class="drying-temp" type="number" min="-20" max="120" step="0.1" value="${Number(row.temp)}"></td><td><output class="drying-emc">${Number.isFinite(row.emc) ? row.emc.toFixed(2) : '—'}</output></td><td><output class="drying-gradient">${Number.isFinite(row.gradient) ? row.gradient.toFixed(2) : '—'}</output></td><td><output class="drying-delta-emc">${formatSigned(deltaEmc)}</output></td><td><output class="drying-delta-gradient">${formatSigned(deltaGradient)}</output></td></tr>`;
  }).join('');
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function openDryingProgram(loadNumber) {
  editingDryingLoadNumber = Number(loadNumber);
  $('dryingProgramTitle').textContent = `Kiln Load ${loadNumber} · drying program`;
  const saved = dryingPrograms.get(String(loadNumber));
  dryingBaselineRows = (saved?.rows?.length ? saved.rows : defaultDryingRows()).map((row) => ({ ...row }));
  dryingCalculatedScenarioRows = null;
  renderDryingCurrentRows(dryingBaselineRows);
  renderDryingScenarioRows(dryingBaselineRows.map((row) => ({ ...row })), dryingBaselineRows);
  $('dryingProgramStatus').className = `calculation-status ${saved?.calculatedAt ? 'ready' : 'pending'}`;
  $('dryingProgramStatus').textContent = saved?.calculatedAt
    ? `Saved ${new Date(saved.calculatedAt).toLocaleString()}. Edit only the comparison table; the saved program stays unchanged until Save scenario as current is pressed.`
    : 'MASPEL defaults loaded. Press Calculate comparison to preview EMC, gradient and differences without saving.';
  $('dryingProgramDialog').showModal();
}

function saturationVapourPressureMbar(tempC) {
  return 6.1121 * Math.exp((18.678 - tempC / 234.5) * (tempC / (257.14 + tempC)));
}

function hailwoodHorrobinEmc(tempC, relativeHumidity) {
  const h = Math.min(0.9999, Math.max(0.0001, relativeHumidity));
  const w = 349 + 1.29 * tempC + 0.0135 * tempC * tempC;
  const k = 0.805 + 0.000736 * tempC - 0.00000273 * tempC * tempC;
  const k1 = 6.27 - 0.00938 * tempC - 0.000303 * tempC * tempC;
  const k2 = 1.91 + 0.0407 * tempC - 0.000293 * tempC * tempC;
  const kh = k * h;
  return (1800 / w) * ((kh / (1 - kh)) + ((k1 * kh + 2 * k1 * k2 * kh * kh) / (1 + k1 * kh + k1 * k2 * kh * kh)));
}

function readAndCalculateDryingRows() {
  return [...$('dryingScenarioRows').querySelectorAll('tr')].map((row) => {
    const mc = Number(row.querySelector('.drying-mc').value);
    const mbar = Number(row.querySelector('.drying-mbar').value);
    const temp = Number(row.querySelector('.drying-temp').value);
    if (!Number.isFinite(mc) || mc < 0 || mc > 100 || !Number.isFinite(mbar) || mbar <= 0 || !Number.isFinite(temp) || temp < -20 || temp > 120) {
      throw new Error('Check MC, mBar and temperature values in every phase.');
    }
    const relativeHumidity = mbar / saturationVapourPressureMbar(temp);
    if (relativeHumidity >= 1) throw new Error(`${row.cells[0].textContent}: mBar is at or above saturation pressure for this temperature.`);
    const emc = hailwoodHorrobinEmc(temp, relativeHumidity);
    const gradient = emc > 0 ? mc / emc : 0;
    row.querySelector('.drying-emc').textContent = emc.toFixed(2);
    row.querySelector('.drying-gradient').textContent = gradient.toFixed(2);
    return { phase: row.cells[0].textContent, mc, mbar, temp, emc, gradient, relativeHumidity };
  });
}

function calculateDryingComparison() {
  try {
    const baseline = calculateDryingValues(dryingBaselineRows);
    const scenario = readAndCalculateDryingRows();
    dryingBaselineRows = baseline;
    dryingCalculatedScenarioRows = scenario.map((row) => ({ ...row }));
    renderDryingCurrentRows(baseline);
    renderDryingScenarioRows(scenario, baseline);
    $('dryingProgramStatus').className = 'calculation-status ready';
    $('dryingProgramStatus').textContent = 'Comparison calculated but not saved. Review Δ EMC and Δ Gradient.';
  } catch (error) {
    $('dryingProgramStatus').className = 'calculation-status error';
    $('dryingProgramStatus').textContent = error.message;
  }
}

function calculateDryingValues(rows) {
  return rows.map((row) => {
    const mc = Number(row.mc);
    const mbar = Number(row.mbar);
    const temp = Number(row.temp);
    if (!Number.isFinite(mc) || mc < 0 || mc > 100 || !Number.isFinite(mbar) || mbar <= 0 || !Number.isFinite(temp) || temp < -20 || temp > 120) {
      throw new Error(`${row.phase}: check MC, mBar and temperature values.`);
    }
    const relativeHumidity = mbar / saturationVapourPressureMbar(temp);
    if (relativeHumidity >= 1) throw new Error(`${row.phase}: mBar is at or above saturation pressure for this temperature.`);
    const emc = hailwoodHorrobinEmc(temp, relativeHumidity);
    return { ...row, mc, mbar, temp, emc, gradient: emc > 0 ? mc / emc : 0, relativeHumidity };
  });
}

function calculateAndSaveDryingProgram(event) {
  event.preventDefault();
  try {
    if (!dryingCalculatedScenarioRows) throw new Error('Calculate the comparison first. Editing values never starts a calculation automatically.');
    const rows = dryingCalculatedScenarioRows.map((row) => ({ ...row }));
    const calculatedAt = new Date().toISOString();
    dryingPrograms.set(String(editingDryingLoadNumber), { loadNumber: editingDryingLoadNumber, rows, calculatedAt });
    persistActiveOrder(false);
    dryingBaselineRows = rows.map((row) => ({ ...row }));
    dryingCalculatedScenarioRows = rows.map((row) => ({ ...row }));
    renderDryingCurrentRows(dryingBaselineRows);
    renderDryingScenarioRows(rows.map((row) => ({ ...row })), dryingBaselineRows);
    $('dryingProgramStatus').className = 'calculation-status ready';
    $('dryingProgramStatus').textContent = `Calculated and saved ${new Date(calculatedAt).toLocaleString()}.`;
    renderLoadNavigation();
  } catch (error) {
    $('dryingProgramStatus').className = 'calculation-status error';
    $('dryingProgramStatus').textContent = error.message;
  }
}

const THERMO_VACUUM_DEFAULTS = [
  { stage: 'PH1', setpoint: 350, temp: 179, duration: 240, note: 'Initial thermal rise' },
  { stage: 'PH1.1', setpoint: 350, temp: 186, duration: 90, note: 'Thermal hold 1' },
  { stage: 'PH1.2', setpoint: 350, temp: 193, duration: 90, note: 'Thermal hold 2' },
  { stage: 'PH1.3', setpoint: 350, temp: 200, duration: 180, note: 'Peak modification' },
  { stage: 'Cooling', setpoint: 350, temp: 70, duration: 360, note: 'Controlled cooling' },
];

function renderThermoProgramRows(rows) {
  $('thermoProgramRows').innerHTML = rows.map((row, index) => `<tr data-stage="${index}"><td><input class="thermo-stage" value="${escapeHtml(row.stage)}"></td><td><input class="thermo-setpoint" type="number" step="1" value="${Number(row.setpoint)}"></td><td><input class="thermo-temp" type="number" step="1" value="${Number(row.temp)}"></td><td><input class="thermo-duration" type="number" min="0" step="1" value="${Number(row.duration)}"></td><td><input class="thermo-note" value="${escapeHtml(row.note || '')}"></td></tr>`).join('');
}

function openThermoProgram(loadNumber) {
  editingThermoLoadNumber = Number(loadNumber);
  $('thermoProgramTitle').textContent = `Kiln Load ${loadNumber} · Thermo Vacuum program`;
  const saved = thermoPrograms.get(String(loadNumber));
  renderThermoProgramRows(saved?.rows?.length ? saved.rows : THERMO_VACUUM_DEFAULTS);
  $('thermoProgramStatus').className = `calculation-status ${saved?.savedAt ? 'ready' : 'pending'}`;
  $('thermoProgramStatus').textContent = saved?.savedAt ? `Saved ${new Date(saved.savedAt).toLocaleString()}.` : 'Photo defaults loaded. Review and save this TM program.';
  $('thermoProgramDialog').showModal();
}

function saveThermoProgram(event) {
  event.preventDefault();
  const rows = [...$('thermoProgramRows').querySelectorAll('tr')].map((row) => ({ stage: row.querySelector('.thermo-stage').value.trim(), setpoint: Number(row.querySelector('.thermo-setpoint').value), temp: Number(row.querySelector('.thermo-temp').value), duration: Number(row.querySelector('.thermo-duration').value), note: row.querySelector('.thermo-note').value.trim() }));
  if (rows.some((row) => !row.stage || !Number.isFinite(row.setpoint) || !Number.isFinite(row.temp) || !Number.isFinite(row.duration) || row.duration < 0)) {
    $('thermoProgramStatus').className = 'calculation-status error';
    $('thermoProgramStatus').textContent = 'Check every TM stage, setpoint, temperature and duration.';
    return;
  }
  const savedAt = new Date().toISOString();
  thermoPrograms.set(String(editingThermoLoadNumber), { loadNumber: editingThermoLoadNumber, rows, savedAt });
  persistActiveOrder(false);
  $('thermoProgramStatus').className = 'calculation-status ready';
  $('thermoProgramStatus').textContent = `TM program saved ${new Date(savedAt).toLocaleString()}.`;
  renderLoadNavigation();
}

function startKilnCycle(loadNumber) {
  const snapshot = loadRecords.get(loadNumber);
  if (!snapshot || isLoadCompleted(loadNumber)) return;
  const activeLoadNumber = Number(activeOrder?.activeCycleNumber || 0);
  if (activeLoadNumber && activeLoadNumber !== Number(loadNumber) && !isLoadCompleted(activeLoadNumber)) {
    const replace = window.confirm(`Kiln Load ${activeLoadNumber} is currently in progress. Cancel that start and begin Kiln Load ${loadNumber} instead?`);
    if (!replace) return;
  }
  activeOrder.activeCycleNumber = loadNumber;
  activeOrder.activeCycleStartedAt = new Date().toISOString();
  persistActiveOrder(false);
  if (loadNumber !== currentLoadNumber) selectSavedLoad(loadNumber);
  else renderLoadNavigation();
}

function cancelKilnCycleStart(loadNumber) {
  if (!isLoadInProgress(loadNumber) || isLoadCompleted(loadNumber)) return;
  const confirmed = window.confirm(`Cancel the start of Kiln Load ${loadNumber}? The saved calculation and drying settings will be kept.`);
  if (!confirmed) return;
  delete activeOrder.activeCycleNumber;
  delete activeOrder.activeCycleStartedAt;
  persistActiveOrder(false);
  renderLoadNavigation();
}

function openCycleCompletion(loadNumber) {
  const snapshot = loadRecords.get(loadNumber);
  if (!snapshot || isLoadCompleted(loadNumber)) return;
  completingLoadNumber = loadNumber;
  $('completeCycleTitle').textContent = `Kiln Load ${loadNumber} completed`;
  $('completeSupplier').value = $('supplier').value.trim() || 'New Westminster';
  $('completeDate').value = new Date().toISOString().slice(0, 10);
  $('completeMarking').value = '';
  $('finalProcessDate').value = '';
  const lengths = [...snapshot.used.entries()].sort((a, b) => a[0] - b[0]);
  $('completeCycleSummary').innerHTML = `<b>${fmt(snapshot.usedBoards)} boards · ${fmt(snapshot.usedBf, 1)} BF</b><span>${lengths.map(([length, quantity]) => `${quantity} × ${length} ft`).join(' · ')}</span>`;
  $('completeCycleDialog').showModal();
}

function saveCompletedCycle(event) {
  event.preventDefault();
  const snapshot = loadRecords.get(completingLoadNumber);
  if (!snapshot) return;
  const records = readCompletedCycles();
  const id = completionRecordId(completingLoadNumber);
  const record = {
    id,
    orderId: activeOrder?.id || globalOrderSignature || 'current-order',
    orderNumber: activeOrder?.number || $('orderNumber').value.trim(),
    loadNumber: completingLoadNumber,
    supplier: $('completeSupplier').value.trim(),
    marking: $('completeMarking').value.trim(),
    completedDate: $('completeDate').value,
    finalProcessDate: $('finalProcessDate').value,
    species: $('species').value.trim(),
    size: materialSizeLabel(),
    quantities: Object.fromEntries(snapshot.used),
    boards: snapshot.usedBoards,
    bf: snapshot.usedBf,
    createdAt: new Date().toISOString(),
  };
  const existingIndex = records.findIndex((item) => item.id === id);
  if (existingIndex >= 0) records[existingIndex] = record;
  else records.push(record);
  writeCompletedCycles(records);
  if (Number(activeOrder?.activeCycleNumber || 0) === Number(completingLoadNumber)) {
    delete activeOrder.activeCycleNumber;
    delete activeOrder.activeCycleStartedAt;
    persistActiveOrder(false);
  }
  $('completeCycleDialog').close();
  renderLoadNavigation();
}

function selectSavedLoad(loadNumber) {
  const snapshot = loadRecords.get(loadNumber);
  if (!snapshot || loadNumber === currentLoadNumber) return;
  if (calculationDirty) {
    const status = $('calculationStatus');
    status.className = 'calculation-status pending';
    status.textContent = 'Inputs changed — click Calculate Load before opening another saved kiln load.';
    return;
  }
  if (!globalOrderPlans.length || !globalOrderSignature) {
    const status = $('calculationStatus');
    status.className = 'calculation-status pending';
    status.textContent = 'This older saved result has no reusable plan data. Click Calculate Load once to save the complete plan.';
    return;
  }
  const scrollPosition = window.scrollY;
  currentLoadNumber = loadNumber;
  try {
    calculate(false);
  } catch (error) {
    console.error('Saved kiln load could not be rendered:', error);
    currentLoadNumber = currentLoadSnapshot?.number || 1;
    const status = $('calculationStatus');
    status.className = 'calculation-status pending';
    status.textContent = 'The saved plan does not match the current inputs. Click Recalculate Load explicitly to replace it.';
    return;
  }
  requestAnimationFrame(() => window.scrollTo({ top: scrollPosition, behavior: 'auto' }));
}

function loadRemainingInventory() {
  const nextNumber = currentLoadNumber + 1;
  if (loadRecords.has(nextNumber)) {
    selectSavedLoad(nextNumber);
  }
}

function bindEvents() {
  const clearInventory = () => {
    loadRecords.clear();
    currentLoadNumber = 1;
    document.querySelectorAll('.qty').forEach((input) => {
      input.value = 0;
    });
    $('loadNumber').textContent = '1';
    renderLoadNavigation();
    markCalculationPending();
    scheduleDraftSave();
  };

  $('calc').addEventListener('click', runCalculation);
  $('optimizeRemaining').addEventListener('click', runCalculation);
  $('addFromRemainder').addEventListener('click', openRemainderTransfer);
  $('remainderTransferForm').addEventListener('submit', applyRemainderTransfer);
  $('closeRemainderTransfer').addEventListener('click', () => $('remainderTransferDialog').close());
  $('applyLiftChanges').addEventListener('click', applyManualLiftChanges);
  $('openManualFill').addEventListener('click', openManualFillDialog);
  $('manualFillForm').addEventListener('submit', addManualBoards);
  $('closeManualFill').addEventListener('click', () => $('manualFillDialog').close());
  $('manualFillLift').addEventListener('change', () => refreshManualFillDialog());
  $('manualFillLength').addEventListener('change', () => refreshManualFillDialog());
  $('orderNumber').addEventListener('input', scheduleDraftSave);
  $('orderNumber').addEventListener('change', () => persistActiveOrder(false));
  $('orderSelector').addEventListener('change', (event) => switchOrder(event.target.value));
  $('newOrder').addEventListener('click', createOrder);
  $('saveOrder').addEventListener('click', () => {
    window.clearTimeout(draftSaveTimer);
    persistActiveOrder(false);
    $('orderSaveState').textContent = 'Order saved and synchronized';
  });
  $('nextLoad').addEventListener('click', loadRemainingInventory);
  $('previousLoad').addEventListener('click', () => selectSavedLoad(currentLoadNumber - 1));
  $('nextSavedLoad').addEventListener('click', () => selectSavedLoad(currentLoadNumber + 1));
  $('completeCycleForm').addEventListener('submit', saveCompletedCycle);
  $('cancelCompleteCycle').addEventListener('click', () => $('completeCycleDialog').close());
  $('dryingProgramForm').addEventListener('submit', calculateAndSaveDryingProgram);
  $('calculateDryingComparison').addEventListener('click', calculateDryingComparison);
  $('dryingScenarioRows').addEventListener('input', () => {
    dryingCalculatedScenarioRows = null;
    $('dryingProgramStatus').className = 'calculation-status pending';
    $('dryingProgramStatus').textContent = 'Scenario changed. Press Calculate comparison to update EMC, gradient and differences before saving.';
  });
  $('closeDryingProgram').addEventListener('click', () => $('dryingProgramDialog').close());
  $('resetDryingProgram').addEventListener('click', () => {
    dryingCalculatedScenarioRows = null;
    renderDryingScenarioRows(defaultDryingRows(), dryingBaselineRows);
    $('dryingProgramStatus').className = 'calculation-status pending';
    $('dryingProgramStatus').textContent = 'MASPEL defaults restored only in the comparison table. Calculate to preview them; save only if you want to replace the current program.';
  });
  $('thermoProgramForm').addEventListener('submit', saveThermoProgram);
  $('closeThermoProgram').addEventListener('click', () => $('thermoProgramDialog').close());
  $('resetThermoProgram').addEventListener('click', () => {
    renderThermoProgramRows(THERMO_VACUUM_DEFAULTS);
    $('thermoProgramStatus').className = 'calculation-status pending';
    $('thermoProgramStatus').textContent = 'Photo defaults restored in this form. Press Save TM program to apply them.';
  });
  $('addLength').addEventListener('click', () => {
    addRow(8, 0);
    markCalculationPending();
    scheduleDraftSave();
  });
  $('clear').addEventListener('click', clearInventory);
  $('clearTop').addEventListener('click', clearInventory);
  $('downloadPdf').addEventListener('click', () => {
    if (calculationDirty) {
      const status = $('calculationStatus');
      status.className = 'calculation-status pending';
      status.textContent = 'Calculate the changed order before downloading the report.';
      return;
    }
    const supplier = $('supplier').value.trim() || 'Supplier';
    const previousTitle = document.title;
    document.title = `Kiln Load Report - ${supplier} - ${new Date().toISOString().slice(0, 10)}`;
    window.print();
    window.setTimeout(() => { document.title = previousTitle; }, 500);
  });

  ['supplier', 'supplierClearance', 'species', 'size', 'batchProfile', 'kiln', 'height', 'maxStack', 'metalBox', 'liftWidth', 'sticker', 'topSticker']
    .forEach((id) => {
      $(id).addEventListener('input', () => { markCalculationPending(); scheduleDraftSave(); });
      $(id).addEventListener('change', () => { markCalculationPending(); scheduleDraftSave(); });
    });

  $('supplier').addEventListener('change', () => {
    loadSupplierProfile();
    markCalculationPending();
  });
  $('supplier').addEventListener('input', () => {
    applySupplierClearanceRule();
    markCalculationPending();
  });
  $('supplierClearance').addEventListener('change', saveSupplierProfile);

  $('size').addEventListener('change', () => {
    const custom = $('size').value === 'custom';
    $('customT').disabled = !custom;
    $('customW').disabled = !custom;
    if (custom) $('batchProfile').value = 'manual';
    applyPhysicalProfile();
    markCalculationPending();
  });

  $('batchProfile').addEventListener('change', () => {
    applyPhysicalProfile();
    markCalculationPending();
  });

  ['actualT', 'actualW'].forEach((id) => {
    $(id).addEventListener('input', () => {
      $('batchProfile').value = 'manual';
      markCalculationPending();
      scheduleDraftSave();
    });
  });

  ['customT', 'customW'].forEach((id) => {
    $(id).addEventListener('input', () => {
      if ($('size').value !== 'custom') return;
      if ($('batchProfile').value !== 'manual') {
        $('actualT').value = $('customT').value;
        $('actualW').value = $('customW').value;
      }
      markCalculationPending();
      scheduleDraftSave();
    });
  });
}

function init() {
  const savedOrder = recoverWestminster334605(readActiveOrder());
  activeOrder = savedOrder;
  if (!activeOrder) activeOrder = { id: `order-${Date.now()}`, number: newOrderNumber(), status: 'active', createdAt: new Date().toISOString(), inventory: {} };
  Object.entries(activeOrder.liftStickerOverrides || {}).forEach(([key, value]) => {
    const sticker = Number(value);
    if (Number.isFinite(sticker) && sticker > 0) manualLiftStickers.set(key, sticker);
  });
  Object.entries(activeOrder.liftTargetOverrides || {}).forEach(([key, value]) => {
    const rows = Math.floor(Number(value));
    if (Number.isFinite(rows) && rows > 0) manualLiftTargets.set(key, rows);
  });
  Object.entries(activeOrder.dryingPrograms || {}).forEach(([loadNumber, program]) => {
    if (program?.rows?.length) dryingPrograms.set(String(loadNumber), program);
  });
  Object.entries(activeOrder.thermoPrograms || {}).forEach(([loadNumber, program]) => {
    if (program?.rows?.length) thermoPrograms.set(String(loadNumber), program);
  });
  $('orderNumber').value = activeOrder.number || newOrderNumber();
  if (activeOrder.inputs) Object.entries(activeOrder.inputs).forEach(([id, value]) => { if ($(id)) $(id).value = value; });
  try {
    const lastSupplier = localStorage.getItem(LAST_SUPPLIER_STORAGE) || '';
    if (lastSupplier) $('supplier').value = lastSupplier;
  } catch (_) {
    // Ignore unavailable browser storage.
  }
  loadSupplierProfile();
  buildInventoryRows();
  bindEvents();
  applyPhysicalProfile();
  // Opening or refreshing the page must be read-only. Re-saving an unchanged
  // order here creates a new cloud revision and can make two open clients
  // continuously refresh one another.
  if (!savedOrder) persistActiveOrder(false);
  else {
    $('orderState').textContent = activeOrder.calculated ? `ACTIVE · ${activeOrder.plannedCycles || 0} KILN LOADS` : 'ACTIVE DRAFT';
  }
  renderOrderSelector();
  if (activeOrder.calculated) {
    if (!restoreRenderedCalculation()) {
      activeOrder.calculated = false;
      const status = $('calculationStatus');
      status.className = 'calculation-status pending';
      status.textContent = 'No reusable saved calculation was found. Click Calculate Load to create it; nothing was calculated automatically.';
    } else {
      // Re-render from the saved plan so restored manual controls receive live
      // event handlers and always drive the calculation and visualization.
      const physicalKilnLength = Math.floor(num('kiln'));
      const safetyClearance = Math.min(Math.max(0, physicalKilnLength - 1), Math.floor(num('supplierClearance')));
      const kilnLength = Math.max(1, physicalKilnLength - safetyClearance);
      const signature = orderSignature(readInventory(), computeGeometry(), kilnLength, Math.floor(num('maxStack')), Math.floor(Number($('metalBox').value)));
      if (signature !== globalOrderSignature) {
        const status = $('calculationStatus');
        status.className = 'calculation-status pending';
        status.textContent = 'The saved report is preserved, but its physical inputs no longer match. Click Calculate Load to explicitly rebuild only the unstarted cycles.';
      } else {
        try {
          calculate(false);
        } catch (error) {
          console.warn('Saved calculation could not be rendered:', error);
          const status = $('calculationStatus');
          status.className = 'calculation-status pending';
          status.textContent = 'The saved report is preserved. Click Calculate Load to explicitly rebuild only the unstarted cycles.';
        }
      }
    }
  }
}

init();
