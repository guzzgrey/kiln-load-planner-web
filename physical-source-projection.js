(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KilnPhysicalSourceProjection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function empty(lengths) {
    return Object.fromEntries(lengths.map((length) => [Number(length), 0]));
  }

  function addQuantities(target, quantities, multiplier = 1) {
    Object.entries(quantities || {}).forEach(([rawLength, rawQuantity]) => {
      const length = Number(rawLength);
      if (!Object.hasOwn(target, length)) return;
      target[length] += multiplier * Math.max(0, Number(rawQuantity || 0));
    });
    return target;
  }

  function sumRecords(lengths, records) {
    const totals = empty(lengths);
    (records || []).forEach((record) => addQuantities(totals, record.quantities));
    return totals;
  }

  function boardFeet(lengths, quantities, dimensions) {
    const thickness = Number(dimensions?.thickness || 0);
    const width = Number(dimensions?.width || 0);
    return lengths.reduce((sum, length) => sum + thickness * width * Number(length) * Number(quantities?.[length] || 0) / 12, 0);
  }

  function projectPhysicalSources({ lengths, completed, recoveries, tests, tags, shipments, dimensions }) {
    const normalizedLengths = (lengths || []).map(Number);
    const original = sumRecords(normalizedLengths, completed);
    const cutOut = empty(normalizedLengths);
    const recovered = empty(normalizedLengths);
    let inputLinearFt = 0;
    let outputLinearFt = 0;

    (recoveries || []).forEach((record) => {
      const sourceLength = Number(record.sourceLength || 0);
      const quantity = Math.max(0, Number(record.quantity || 0));
      if (Object.hasOwn(cutOut, sourceLength)) cutOut[sourceLength] += quantity;
      (record.outputs || []).forEach((rawLength) => {
        const length = Number(rawLength);
        if (Object.hasOwn(recovered, length)) recovered[length] += quantity;
      });
      inputLinearFt += sourceLength * quantity;
      outputLinearFt += (record.outputs || []).reduce((sum, length) => sum + Number(length || 0), 0) * quantity;
    });

    const regularBeforeOutgoing = empty(normalizedLengths);
    normalizedLengths.forEach((length) => {
      regularBeforeOutgoing[length] = Math.max(0, Number(original[length] || 0) - Number(cutOut[length] || 0));
    });

    const tested = sumRecords(normalizedLengths, tests);
    const shippedTagIds = new Set((shipments || []).flatMap((shipment) => shipment.tagIds || []));
    const shipped = sumRecords(normalizedLengths, (tags || []).filter((tag) => shippedTagIds.has(tag.id)));
    const regular = empty(normalizedLengths);
    const recoveredCurrent = empty(normalizedLengths);
    const current = empty(normalizedLengths);

    normalizedLengths.forEach((length) => {
      let outgoing = Number(tested[length] || 0) + Number(shipped[length] || 0);
      const regularUsed = Math.min(regularBeforeOutgoing[length], outgoing);
      regular[length] = regularBeforeOutgoing[length] - regularUsed;
      outgoing -= regularUsed;
      recoveredCurrent[length] = Math.max(0, Number(recovered[length] || 0) - outgoing);
      current[length] = regular[length] + recoveredCurrent[length];
    });

    const wasteLinearFt = inputLinearFt - outputLinearFt;
    const originalBf = boardFeet(normalizedLengths, original, dimensions);
    const regularBf = boardFeet(normalizedLengths, regular, dimensions);
    const recoveredBf = boardFeet(normalizedLengths, recoveredCurrent, dimensions);
    const currentBf = regularBf + recoveredBf;
    const testedBf = boardFeet(normalizedLengths, tested, dimensions);
    const shippedBf = boardFeet(normalizedLengths, shipped, dimensions);
    const wasteBf = Number(dimensions?.thickness || 0) * Number(dimensions?.width || 0) * wasteLinearFt / 12;

    return {
      original, cutOut, recovered, regular, recoveredCurrent, current, tested, shipped,
      inputLinearFt, outputLinearFt, wasteLinearFt,
      originalBf, regularBf, recoveredBf, currentBf, testedBf, shippedBf, wasteBf,
      reconciliationDeltaBf: originalBf - currentBf - testedBf - shippedBf - wasteBf,
    };
  }

  function snapshotProtectedOperations({ orders, completed, tags }) {
    const snapshot = {
      orders: (orders || []).map((order) => ({
        id: order.id,
        number: order.number,
        activeCycleNumber: order.activeCycleNumber ?? null,
        plannedCycles: order.plannedCycles ?? null,
        viewCacheRecords: (order.viewCache?.records || []).map((record) => ({
          number: record.number,
          used: record.used,
          boards: record.usedBoards,
          lifts: record.plan?.activeStates || record.lifts || null,
        })),
      })),
      completed: (completed || []).map((record) => ({
        id: record.id,
        orderId: record.orderId,
        loadNumber: record.loadNumber,
        quantities: record.quantities,
        boards: record.boards,
        bf: record.bf,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        planSnapshot: record.planSnapshot,
      })),
      tags: (tags || []).map((tag) => ({ id: tag.id, tag: tag.tag, quantities: tag.quantities, sourceLoads: tag.sourceLoads })),
    };
    return JSON.stringify(snapshot);
  }

  return { projectPhysicalSources, snapshotProtectedOperations, boardFeet };
});
