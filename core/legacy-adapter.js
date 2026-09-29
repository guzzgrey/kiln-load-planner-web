// Legacy storage → Kiln Core input. Read-only: never writes. Record selection is
// identical to the warehouse screen (same order match, same completed-cycle merge),
// so every screen counts the same boards. `getItem` is localStorage.getItem or a
// snapshot lookup, which keeps this testable outside the browser.
(function (root) {
  'use strict';
  const KEYS = {
    active: 'kiln-planner-active-order-v1', orderPrefix: 'kiln-planner-order-v1:',
    completed: 'kiln-planner-completed-cycles-v1', tags: 'kiln-planner-shipping-tags-v1',
    shipments: 'kiln-planner-shipments-v1', recovery: 'kiln-planner-recovery-operations-v1',
    tests: 'kiln-planner-test-boards-v1', preorders: 'kiln-planner-preliminary-orders-v1',
  };
  const num = (value) => Number(value || 0);
  function readJson(getItem, key, fallback) {
    try { const raw = getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch (_) { return fallback; }
  }
  const readList = (getItem, key) => { const value = readJson(getItem, key, []); return Array.isArray(value) ? value : []; };
  function activeOrder(getItem) {
    const pointer = readJson(getItem, KEYS.active, null);
    if (!pointer?.orderRef) return pointer;
    return readJson(getItem, KEYS.orderPrefix + pointer.orderRef, null);
  }
  function belongsToOrder(item, order) {
    return !order || item.orderId === order.id || item.orderId === order.planSignature
      || item.productionOrderNumber === order.number || item.orderNumber === order.number;
  }
  function completed(getItem, order) {
    const merged = new Map();
    const ledger = readList(getItem, KEYS.completed).filter((item) => belongsToOrder(item, order));
    const embedded = Array.isArray(order?.completedCycles) ? order.completedCycles : [];
    [...embedded, ...ledger].forEach((record, index) => {
      const key = record?.id || `${record?.orderId || record?.orderNumber || 'order'}::load-${record?.loadNumber || index}`;
      merged.set(key, record);
    });
    return [...merged.values()].sort((a, b) => String(a.completedDate).localeCompare(String(b.completedDate)) || a.loadNumber - b.loadNumber);
  }
  function nominal(order) {
    const raw = String(order?.inputs?.size || '');
    const values = raw === 'custom' ? [] : (raw.match(/[\d.]+/g) || []).map(Number);
    const thicknessIn = values[0] || num(order?.inputs?.customT);
    const widthIn = values[1] || num(order?.inputs?.customW);
    return thicknessIn > 0 && widthIn > 0 ? { thicknessIn, widthIn } : null;
  }
  const quantitiesToLines = (quantities, material) => Object.entries(quantities || {})
    .map(([length, quantity]) => ({ lengthFt: num(length), material, quantity: num(quantity) }))
    .filter((line) => line.quantity > 0);
  // Completed record → lots by length and material; the confirmed quantities win,
  // quality lots only split them by material.
  function cycleLots(record, species) {
    const lots = Array.isArray(record?.qualityLots) ? record.qualityLots : [];
    return Object.entries(record?.quantities || {}).flatMap(([rawLength, rawQuantity]) => {
      const lengthFt = num(rawLength);
      let remaining = Math.max(0, num(rawQuantity));
      const result = [];
      lots.filter((lot) => num(lot.length) === lengthFt && num(lot.quantity) > 0).forEach((lot) => {
        const quantity = Math.min(remaining, num(lot.quantity));
        const material = lot.material && !/UNASSIGNED/i.test(lot.material) ? lot.material : species;
        if (quantity > 0) result.push({ lengthFt, material, quantity });
        remaining -= quantity;
      });
      if (remaining > 0) result.push({ lengthFt, material: record?.species || species, quantity: remaining });
      return result;
    });
  }
  function load(getItem) {
    const order = activeOrder(getItem);
    if (!order) return null;
    const species = order.inputs?.species || 'Material';
    const cycles = completed(getItem, order);
    const cycleIds = new Set(cycles.map((item) => item.id));
    const tags = readList(getItem, KEYS.tags).filter((tag) => belongsToOrder(tag, order) || (tag.sourceLoads || []).some((source) => cycleIds.has(source.id)));
    const tagIds = new Set(tags.map((tag) => tag.id));
    const shipments = readList(getItem, KEYS.shipments).filter((item) => belongsToOrder(item, order) || (item.tagIds || []).some((id) => tagIds.has(id)));
    const shippedTagIds = new Set(shipments.flatMap((shipment) => shipment.tagIds || []));
    const recoveries = readList(getItem, KEYS.recovery).filter((item) => belongsToOrder(item, order));
    const tests = readList(getItem, KEYS.tests).filter((item) => belongsToOrder(item, order));
    const allDrafts = readList(getItem, KEYS.preorders);
    const drafts = allDrafts.filter((draft) => draft.orderId === order.id);
    const plans = (() => { const raw = order.viewCache?.plans; try { return typeof raw === 'string' ? JSON.parse(raw) : raw || []; } catch (_) { return []; } })();
    const records = Array.isArray(order.viewCache?.records) ? order.viewCache.records : [];
    const completedNumbers = new Set(cycles.map((record) => num(record.loadNumber)));
    const activeNumber = num(order.activeCycleNumber);
    const unmap = (value) => (value && value.__kilnMap ? Object.fromEntries(value.__kilnMap) : value || {});
    const inProgressRecord = activeNumber && !completedNumbers.has(activeNumber) ? records.find((item) => num(item.number) === activeNumber) : null;
    const plannedLoads = plans.map((plan, index) => ({ loadNumber: index + 1, plan }))
      .filter(({ loadNumber }) => !completedNumbers.has(loadNumber) && loadNumber !== activeNumber)
      .map(({ loadNumber, plan }) => ({ loadNumber, lots: quantitiesToLines(unmap(plan.usedMap), species) }));
    const tagLines = (tag) => quantitiesToLines(tag.quantities || tag.directQuantities, tag.material || species);
    const planning = {
      orderId: order.id, species, nominal: nominal(order),
      kilnOutput: cycles.map((record) => ({ cycleId: record.id, loadNumber: num(record.loadNumber), lots: cycleLots(record, species) })),
      inProgress: inProgressRecord ? { loadNumber: activeNumber, lots: quantitiesToLines(inProgressRecord.used, species) } : null,
      plannedLoads,
      recoveries: recoveries.map((item) => ({ id: item.id, sourceLengthFt: num(item.sourceLength), quantity: num(item.quantity), piecesFt: (item.outputs || []).map(num) })),
      tags: tags.map((tag) => ({ id: tag.id, label: String(tag.tag || ''), lines: tagLines(tag), shipped: shippedTagIds.has(tag.id), date: tag.date || '' })),
      tests: tests.map((test) => ({ id: test.id, lines: quantitiesToLines(test.quantities || { [test.length]: test.quantity }, test.material || species) })),
      drafts,
    };
    const balance = {
      nominal: nominal(order), maxCycles: num(order.plannedCycles) || null,
      receipts: [{ id: `receipt:${order.id}`, lines: quantitiesToLines(order.calculatedInventory || order.inventory, species) }],
      cycles: [
        ...cycles.map((record) => ({ id: record.id, number: num(record.loadNumber), status: 'completed', lines: quantitiesToLines(record.quantities, species) })),
        ...(inProgressRecord ? [{ id: `active:${activeNumber}`, number: activeNumber, status: 'in-progress', lines: quantitiesToLines(inProgressRecord.used, species) }] : []),
        ...plannedLoads.map((load) => ({ id: `plan:${load.loadNumber}`, number: load.loadNumber, status: 'planned', lines: load.lots })),
      ],
      recoveries: planning.recoveries,
      tags: planning.tags.map((tag) => ({ id: tag.id, label: tag.label, lines: tag.lines })),
      tests: planning.tests,
    };
    return { order, species, planning, balance, allDrafts };
  }
  root.KilnLegacy = Object.freeze({ KEYS, load, activeOrder, belongsToOrder });
})(typeof globalThis !== 'undefined' ? globalThis : window);
