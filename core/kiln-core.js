// Kiln Core — pure production rules shared by all screens (and by the As-To-Be core).
// No DOM, no storage, no clock: callers pass plain data in and get plain data back.
// Every quantity is counted once; anything that would count a board twice or use
// more boards than exist is reported, never silently clamped.
(function (root) {
  'use strict';
  const EPSILON = 1e-6;
  const num = (value) => Number(value || 0);
  const positiveLines = (lines) => (lines || []).filter((line) => num(line.quantity) > 0);
  const keyOf = (lengthFt, material) => `${num(lengthFt)}|${material || 'Material'}`;
  const bfFor = (nominal, lengthFt, quantity) => (nominal && nominal.thicknessIn > 0 && nominal.widthIn > 0
    ? nominal.thicknessIn * nominal.widthIn * num(lengthFt) * num(quantity) / 12 : 0);

  class CoreError extends Error {
    constructor(code, message) { super(message || code); this.name = 'CoreError'; this.code = code; }
  }
  function ensure(condition, code, message) { if (!condition) throw new CoreError(code, message); }
  function unique(items, key, code) {
    const seen = new Set();
    items.forEach((item) => {
      const value = key(item);
      if (seen.has(value)) throw new CoreError(code, `${code}: ${value}`);
      seen.add(value);
    });
  }

  // ---------------------------------------------------------------------------
  // Order balance: received → kiln (completed / in kiln / planned / unplanned)
  // and finished → recovery → TAG / TEST → untagged. Same rules as As-To-Be
  // src/domain/order-balance.js. Throws CoreError on any double count/overdraw.
  function orderBalance(input) {
    const receipts = input.receipts || [];
    const cycles = input.cycles || [];
    const recoveries = input.recoveries || [];
    const tags = input.tags || [];
    const tests = input.tests || [];
    [[receipts, 'receipt'], [cycles, 'cycle'], [recoveries, 'recovery'], [tags, 'tag'], [tests, 'test']]
      .forEach(([items]) => unique(items, (item) => item.id, 'DUPLICATE_ID'));
    unique(cycles, (cycle) => num(cycle.number), 'DUPLICATE_CYCLE_NUMBER');
    unique(tags, (tag) => String(tag.label || '').trim().toLowerCase(), 'DUPLICATE_TAG_LABEL');
    if (input.maxCycles != null) ensure(cycles.length <= num(input.maxCycles), 'CYCLE_LIMIT_EXCEEDED');

    const raw = new Map();
    const finished = new Map();
    const add = (map, length, field, count) => {
      const row = map.get(num(length)) || {};
      row[field] = (row[field] || 0) + num(count);
      map.set(num(length), row);
    };
    receipts.forEach((receipt) => positiveLines(receipt.lines).forEach((line) => add(raw, line.lengthFt, 'input', line.quantity)));
    cycles.forEach((cycle) => {
      ensure(['planned', 'in-progress', 'completed'].includes(cycle.status), 'INVALID_CYCLE_STATUS');
      const field = cycle.status === 'completed' ? 'completed' : cycle.status === 'in-progress' ? 'inProgress' : 'planned';
      positiveLines(cycle.lines).forEach((line) => {
        add(raw, line.lengthFt, field, line.quantity);
        if (cycle.status === 'completed') add(finished, line.lengthFt, 'kilnOutput', line.quantity);
      });
    });
    const recoverySummaries = recoveries.map((recovery) => {
      const source = num(recovery.sourceLengthFt);
      const boards = num(recovery.quantity);
      const pieces = (recovery.piecesFt || []).map(num).filter((piece) => piece > 0);
      ensure(boards > 0 && pieces.length && pieces.every((piece) => piece < source), 'INVALID_RECOVERY', `Recovery ${recovery.id} is invalid`);
      const used = pieces.reduce((sum, piece) => sum + piece, 0);
      ensure(used <= source + EPSILON, 'RECOVERY_LONGER_THAN_SOURCE', `Recovery ${recovery.id} produces more footage than the source board`);
      add(finished, source, 'recoveryIn', boards);
      pieces.forEach((piece) => add(finished, piece, 'recoveryOut', boards));
      return { id: recovery.id, sourceLengthFt: source, boards, piecesFt: pieces, usefulFt: used * boards, removedFt: (source - used) * boards };
    });
    tags.forEach((tag) => positiveLines(tag.lines).forEach((line) => add(finished, line.lengthFt, 'tagged', line.quantity)));
    tests.forEach((test) => positiveLines(test.lines).forEach((line) => add(finished, line.lengthFt, 'tested', line.quantity)));

    const rawRows = [...raw.entries()].sort(([a], [b]) => a - b).map(([lengthFt, row]) => {
      const result = { lengthFt, input: row.input || 0, completed: row.completed || 0, inProgress: row.inProgress || 0, planned: row.planned || 0 };
      result.unplanned = result.input - result.completed - result.inProgress - result.planned;
      ensure(result.unplanned >= 0, 'RAW_OVERDRAWN', `More ${lengthFt} ft boards are loaded or planned than were received`);
      return result;
    });
    const finishedRows = [...finished.entries()].sort(([a], [b]) => a - b).map(([lengthFt, row]) => {
      const result = { lengthFt, kilnOutput: row.kilnOutput || 0, recoveryIn: row.recoveryIn || 0, recoveryOut: row.recoveryOut || 0, tagged: row.tagged || 0, tested: row.tested || 0 };
      result.finished = result.kilnOutput - result.recoveryIn + result.recoveryOut;
      result.untagged = result.finished - result.tagged - result.tested;
      ensure(result.finished >= 0 && result.untagged >= 0, 'FINISHED_OVERDRAWN', `More ${lengthFt} ft finished boards are cut, tagged or tested than exist`);
      return result;
    });
    const ft = (rows, field) => rows.reduce((sum, row) => sum + row.lengthFt * row[field], 0);
    const removedFt = recoverySummaries.reduce((sum, item) => sum + item.removedFt, 0);
    ensure(Math.abs(ft(finishedRows, 'finished') - (ft(finishedRows, 'kilnOutput') - removedFt)) < EPSILON, 'FOOTAGE_NOT_CONSERVED');
    const total = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0);
    const bf = (feet) => bfFor(input.nominal, 1, feet);
    return {
      cycles: { max: input.maxCycles == null ? null : num(input.maxCycles), total: cycles.length,
        completed: cycles.filter((cycle) => cycle.status === 'completed').length,
        inProgress: cycles.filter((cycle) => cycle.status === 'in-progress').length,
        planned: cycles.filter((cycle) => cycle.status === 'planned').length },
      raw: rawRows, finished: finishedRows, recoveries: recoverySummaries,
      totals: {
        raw: { input: total(rawRows, 'input'), completed: total(rawRows, 'completed'), inProgress: total(rawRows, 'inProgress'), planned: total(rawRows, 'planned'), unplanned: total(rawRows, 'unplanned') },
        finished: { kilnOutput: total(finishedRows, 'kilnOutput'), finished: total(finishedRows, 'finished'), tagged: total(finishedRows, 'tagged'), tested: total(finishedRows, 'tested'), untagged: total(finishedRows, 'untagged') },
        linearFt: { finished: ft(finishedRows, 'finished'), removed: removedFt },
        boardFeet: { input: bf(ft(rawRows, 'input')), completed: bf(ft(rawRows, 'completed')), finished: bf(ft(finishedRows, 'finished')), untagged: bf(ft(finishedRows, 'untagged')) },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Customer TAG planning. Supply comes only from kiln loads:
  //   READY    = completed kiln output ± recovery cuts − TEST − physical TAGs
  //   EXPECTED = the cycle currently in the kiln
  //   FORECAST = loads planned but not started (information only, not reservable)
  // A planned stack reserves loose boards. A stack linked to a physical TAG is
  // fulfilled by that TAG: its boards are already inside "physical TAGs", so they
  // are never reserved a second time. Reservations of ALL drafts are counted.
  function tagPlanning(input) {
    const species = input.species || 'Material';
    const nominal = input.nominal || null;
    const issues = [];
    const rows = new Map();
    const row = (lengthFt, material) => {
      const key = keyOf(lengthFt, material);
      if (!rows.has(key)) rows.set(key, { key, lengthFt: num(lengthFt), material: material || species,
        kilnOutput: 0, recoveryIn: 0, recoveryOut: 0, tagged: 0, tested: 0, reservedReady: 0, expected: 0, reservedExpected: 0, forecast: 0 });
      return rows.get(key);
    };
    (input.kilnOutput || []).forEach((cycle) => positiveLines(cycle.lots).forEach((lot) => { row(lot.lengthFt, lot.material).kilnOutput += num(lot.quantity); }));

    // Recovery cuts consume a source length and add shorter pieces of the same material.
    (input.recoveries || []).forEach((recovery) => {
      const candidates = [...rows.values()].filter((item) => item.lengthFt === num(recovery.sourceLengthFt) && item.kilnOutput + item.recoveryOut - item.recoveryIn > 0);
      const material = candidates.length === 1 ? candidates[0].material
        : (candidates.find((item) => item.material === species) || candidates[0] || { material: species }).material;
      if (candidates.length > 1) issues.push({ level: 'warning', code: 'RECOVERY_MATERIAL_ASSUMED', message: `Recovery ${recovery.id}: ${recovery.sourceLengthFt} ft exists in several materials; ${material} was used.` });
      row(recovery.sourceLengthFt, material).recoveryIn += num(recovery.quantity);
      (recovery.piecesFt || []).forEach((piece) => { row(piece, material).recoveryOut += num(recovery.quantity); });
    });

    const tagsById = new Map();
    (input.tags || []).forEach((tag) => {
      if (tagsById.has(tag.id)) { issues.push({ level: 'error', code: 'DUPLICATE_TAG_ID', message: `TAG ${tag.label} appears twice.` }); return; }
      tagsById.set(tag.id, tag);
      positiveLines(tag.lines).forEach((line) => { row(line.lengthFt, line.material).tagged += num(line.quantity); });
    });
    const labels = new Map();
    (input.tags || []).forEach((tag) => {
      const label = String(tag.label || '').trim().toLowerCase();
      if (labels.has(label)) issues.push({ level: 'error', code: 'DUPLICATE_TAG_LABEL', message: `TAG number ${tag.label} is used twice.` });
      labels.set(label, tag.id);
    });
    (input.tests || []).forEach((test) => positiveLines(test.lines).forEach((line) => { row(line.lengthFt, line.material).tested += num(line.quantity); }));
    if (input.inProgress) positiveLines(input.inProgress.lots).forEach((lot) => { row(lot.lengthFt, lot.material).expected += num(lot.quantity); });
    (input.plannedLoads || []).forEach((load) => positiveLines(load.lots).forEach((lot) => { row(lot.lengthFt, lot.material).forecast += num(lot.quantity); }));

    // Drafts: linked stacks are fulfilled by TAGs, planned stacks reserve loose supply.
    const linkedBy = new Map();
    const drafts = (input.drafts || []).map((draft) => {
      const stacks = (draft.stacks || []).map((stack) => {
        if (stack.tagId) {
          const tag = tagsById.get(stack.tagId);
          if (!tag) {
            issues.push({ level: 'error', code: 'LINKED_TAG_MISSING', message: `${draft.customer || draft.number || 'Draft'}: stack ${stack.name} is linked to a TAG that no longer exists.` });
            return { ...stack, status: 'broken', lines: [], boards: 0, bf: 0 };
          }
          if (linkedBy.has(tag.id)) {
            issues.push({ level: 'error', code: 'TAG_LINKED_TWICE', message: `TAG ${tag.label} is assigned to two stacks.` });
            return { ...stack, status: 'broken', lines: [], boards: 0, bf: 0 };
          }
          linkedBy.set(tag.id, { draftId: draft.id, stackId: stack.id });
          const lines = positiveLines(tag.lines).map((line) => ({ lengthFt: num(line.lengthFt), material: line.material || species, quantity: num(line.quantity) }));
          return { ...stack, status: tag.shipped ? 'shipped' : 'tagged', tagLabel: tag.label, lines,
            boards: lines.reduce((sum, line) => sum + line.quantity, 0), bf: lines.reduce((sum, line) => sum + bfFor(nominal, line.lengthFt, line.quantity), 0) };
        }
        const lines = positiveLines(stack.items).map((item) => ({ id: item.id, lengthFt: num(item.lengthFt ?? item.length), material: item.material || species, quantity: num(item.quantity), source: item.source === 'expected' ? 'expected' : 'ready' }));
        lines.forEach((line) => { const target = row(line.lengthFt, line.material); if (line.source === 'expected') target.reservedExpected += line.quantity; else target.reservedReady += line.quantity; });
        return { ...stack, status: 'planned', lines, boards: lines.reduce((sum, line) => sum + line.quantity, 0), bf: lines.reduce((sum, line) => sum + bfFor(nominal, line.lengthFt, line.quantity), 0) };
      });
      const sumBf = (status) => stacks.filter((stack) => status.includes(stack.status)).reduce((sum, stack) => sum + stack.bf, 0);
      const fulfilledBf = sumBf(['tagged', 'shipped']);
      const plannedBf = sumBf(['planned']);
      const targetBf = num(draft.targetBf);
      return { ...draft, stacks, fulfilledBf, plannedBf, totalBf: fulfilledBf + plannedBf, targetBf,
        remainingBf: targetBf > 0 ? targetBf - fulfilledBf - plannedBf : null };
    });

    const result = [...rows.values()].sort((a, b) => a.lengthFt - b.lengthFt || a.material.localeCompare(b.material)).map((item) => {
      const finished = item.kilnOutput - item.recoveryIn + item.recoveryOut;
      const loose = finished - item.tagged - item.tested;
      const freeReady = loose - item.reservedReady;
      const freeExpected = item.expected - item.reservedExpected;
      if (finished < 0 || loose < 0) issues.push({ level: 'error', code: 'FINISHED_OVERDRAWN', message: `${item.lengthFt} ft ${item.material}: more boards are cut, tagged or tested than were produced.` });
      if (freeReady < 0) issues.push({ level: 'error', code: 'READY_OVERBOOKED', message: `${item.lengthFt} ft ${item.material}: ${-freeReady} boards more are planned than are free in the warehouse.` });
      if (freeExpected < 0) issues.push({ level: 'error', code: 'EXPECTED_OVERBOOKED', message: `${item.lengthFt} ft ${item.material}: ${-freeExpected} boards more are planned than the kiln cycle holds.` });
      return { ...item, finished, loose, freeReady, freeExpected,
        freeReadyBf: bfFor(nominal, item.lengthFt, Math.max(0, freeReady)), freeExpectedBf: bfFor(nominal, item.lengthFt, Math.max(0, freeExpected)) };
    });
    const tags = [...tagsById.values()].map((tag) => {
      const boards = positiveLines(tag.lines).reduce((sum, line) => sum + num(line.quantity), 0);
      return { id: tag.id, label: tag.label, shipped: Boolean(tag.shipped), boards,
        bf: positiveLines(tag.lines).reduce((sum, line) => sum + bfFor(nominal, line.lengthFt, line.quantity), 0),
        lines: positiveLines(tag.lines), assignment: linkedBy.get(tag.id) || null };
    });
    const sum = (field) => result.reduce((total, item) => total + item[field], 0);
    return {
      rows: result, tags, drafts, issues,
      blocking: issues.filter((issue) => issue.level === 'error').map((issue) => issue.code + ':' + issue.message),
      totals: { finished: sum('finished'), tagged: sum('tagged'), tested: sum('tested'), loose: sum('loose'),
        reservedReady: sum('reservedReady'), freeReady: sum('freeReady'), expected: sum('expected'),
        reservedExpected: sum('reservedExpected'), freeExpected: sum('freeExpected'), forecast: sum('forecast') },
    };
  }

  // Legacy preliminary drafts → planner format. A legacy stack is linked to a physical
  // TAG only when its name equals the TAG number of the same order AND its board counts
  // per length equal the TAG exactly; nothing is linked by guesswork.
  function migrateLegacyDrafts(drafts, tags) {
    const byLabel = new Map(tags.map((tag) => [String(tag.label || '').trim().toLowerCase(), tag]));
    const perLength = (lines) => JSON.stringify(Object.entries(positiveLines(lines).reduce((acc, line) => {
      acc[num(line.lengthFt)] = (acc[num(line.lengthFt)] || 0) + num(line.quantity); return acc;
    }, {})).sort(([a], [b]) => a - b));
    const linked = new Set();
    drafts.forEach((draft) => (draft.stacks || []).forEach((stack) => { if (stack.tagId) linked.add(stack.tagId); }));
    let changed = false;
    const next = drafts.map((draft) => ({ ...draft, stacks: (draft.stacks || []).map((stack) => {
      const items = (stack.items || []).map((item) => (item.lengthFt != null ? item : {
        id: item.id, lengthFt: num(item.length), material: item.material, quantity: num(item.quantity),
        source: item.sourceStatus === 'expected' ? 'expected' : 'ready', legacyLotId: item.lotId || null,
      }));
      if (items.some((item, index) => item !== (stack.items || [])[index])) changed = true;
      if (stack.tagId) return { ...stack, items };
      const tag = byLabel.get(String(stack.name || '').trim().toLowerCase());
      if (tag && !linked.has(tag.id) && perLength(tag.lines) === perLength(items)) {
        linked.add(tag.id);
        changed = true;
        return { ...stack, items, tagId: tag.id, linkedAt: 'migration' };
      }
      return { ...stack, items };
    }) }));
    return { drafts: next, changed };
  }

  root.KilnCore = Object.freeze({ CoreError, orderBalance, tagPlanning, migrateLegacyDrafts, boardFeet: bfFor, lotKey: keyOf });
})(typeof globalThis !== 'undefined' ? globalThis : window);
