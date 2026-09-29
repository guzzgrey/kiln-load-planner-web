// Customer TAG Planner screen. All rules live in core/kiln-core.js; this file only
// renders and saves drafts. Every change is re-checked by the core before it is saved:
// a change that would overbook material or assign a TAG twice is refused.
(function () {
  'use strict';
  const { tagPlanning, migrateLegacyDrafts, boardFeet } = window.KilnCore;
  const { load, KEYS } = window.KilnLegacy;
  const $ = (id) => document.getElementById(id);
  const fmt = (value, digits = 0) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const newId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const getItem = (key) => localStorage.getItem(key);
  let activeDraftId = '';
  let state = null;

  function status(kind, text) {
    $('plannerStatus').className = `calculation-status ${kind}`;
    $('plannerStatus').textContent = text;
  }

  // Replace this order's drafts inside the shared preliminary-orders list.
  function writeDrafts(drafts) {
    const others = state.allDrafts.filter((draft) => draft.orderId !== state.order.id);
    localStorage.setItem(KEYS.preorders, JSON.stringify([...others, ...drafts]));
  }

  // The single write path: compute the plan for the proposed drafts, refuse anything
  // that introduces a new blocking problem, otherwise save and re-render.
  function commit(nextDrafts, successMessage) {
    const current = tagPlanning({ ...state.planning, drafts: state.drafts });
    const proposed = tagPlanning({ ...state.planning, drafts: nextDrafts });
    const introduced = proposed.blocking.filter((issue) => !current.blocking.includes(issue));
    if (introduced.length) {
      status('pending', `Not saved: ${introduced.map((issue) => issue.split(':').slice(1).join(':').trim()).join(' ')}`);
      return false;
    }
    nextDrafts.forEach((draft) => { draft.updatedAt = new Date().toISOString(); });
    writeDrafts(nextDrafts);
    refresh();
    if (successMessage) status('ready', successMessage);
    return true;
  }

  function refresh() {
    const loaded = load(getItem);
    if (!loaded) {
      state = null;
      $('plannerSummary').innerHTML = '<div><b>—</b><span>No active production order. Open one in the Kiln Load Planner.</span></div>';
      return;
    }
    state = { ...loaded, drafts: loaded.planning.drafts.map((draft) => structuredClone(draft)) };
    render();
  }

  function migrateOnce() {
    const loaded = load(getItem);
    if (!loaded) return '';
    const { drafts, changed } = migrateLegacyDrafts(loaded.planning.drafts, loaded.planning.tags);
    if (!changed) return '';
    state = { ...loaded, drafts: loaded.planning.drafts };
    const linked = drafts.flatMap((draft) => draft.stacks).filter((stack) => stack.linkedAt === 'migration').length;
    writeDrafts(drafts.map((draft) => ({ ...draft, planner: 'tag-planner-v1' })));
    return linked ? `${linked} existing stack(s) were matched to their built YARD TAGs by TAG number and exact content.` : '';
  }

  function activeDraft() {
    const drafts = state.drafts;
    return drafts.find((draft) => draft.id === activeDraftId) || drafts[0] || null;
  }

  function render() {
    const plan = tagPlanning({ ...state.planning, drafts: state.drafts });
    const nominal = state.planning.nominal;
    const bf = (length, quantity) => boardFeet(nominal, length, quantity);
    const draft = activeDraft();
    activeDraftId = draft?.id || '';
    const planned = state.planning.plannedLoads;
    const t = plan.totals;

    $('plannerSummary').innerHTML = `
      <div><b>${esc(state.order.number || '—')}</b><span>${esc(state.order.inputs?.supplier || '')} · ${esc(state.species)}</span></div>
      <div><b>${fmt(state.planning.kilnOutput.length)} / ${fmt(Number(state.order.plannedCycles || 0) || state.planning.kilnOutput.length + planned.length)}</b><span>kiln loads completed</span></div>
      <div><b>${fmt(t.finished)}</b><span>finished boards (after cuts)</span><small>${fmt(t.tagged)} in YARD TAGs · ${fmt(t.tested)} TEST</small></div>
      <div><b>${fmt(t.freeReady)}</b><span>free to plan now</span><small>${fmt(t.reservedReady)} planned in open drafts</small></div>
      <div><b>${fmt(t.forecast)}</b><span>forecast from ${fmt(planned.length)} unstarted load(s)</span><small>${fmt(t.freeExpected)} expected from the cycle in the kiln</small></div>`;

    const rows = plan.rows.filter((row) => row.finished || row.expected || row.forecast || row.reservedReady);
    $('supplyTable').innerHTML = `<thead><tr><th>Length · material</th><th>Kiln output</th><th>Cut out</th><th>Recovered</th><th>Finished</th><th>YARD TAGs</th><th>TEST</th><th>Planned</th><th>Free to plan</th><th>In kiln (free)</th><th>Forecast</th></tr></thead>
      <tbody>${rows.map((row) => `<tr><td><b>${fmt(row.lengthFt)} ft</b> <small>${esc(row.material)}</small></td><td>${fmt(row.kilnOutput)}</td><td>${row.recoveryIn ? `−${fmt(row.recoveryIn)}` : ''}</td><td>${row.recoveryOut ? `+${fmt(row.recoveryOut)}` : ''}</td><td><b>${fmt(row.finished)}</b></td><td>${fmt(row.tagged)}</td><td>${fmt(row.tested)}</td><td>${fmt(row.reservedReady)}</td><td class="${row.freeReady < 0 ? 'bad' : 'ok'}">${fmt(row.freeReady)}</td><td>${row.expected ? fmt(row.freeExpected) : ''}</td><td>${row.forecast ? fmt(row.forecast) : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th>TOTAL</th><th>${fmt(rows.reduce((s, r) => s + r.kilnOutput, 0))}</th><th>−${fmt(rows.reduce((s, r) => s + r.recoveryIn, 0))}</th><th>+${fmt(rows.reduce((s, r) => s + r.recoveryOut, 0))}</th><th>${fmt(t.finished)}</th><th>${fmt(t.tagged)}</th><th>${fmt(t.tested)}</th><th>${fmt(t.reservedReady)}</th><th>${fmt(t.freeReady)}</th><th>${fmt(t.freeExpected)}</th><th>${fmt(t.forecast)}</th></tr></tfoot>`;
    $('supplyIssues').innerHTML = plan.issues.length
      ? plan.issues.map((issue) => `<p class="calculation-status ${issue.level === 'error' ? 'pending' : 'idle'}">${issue.level === 'error' ? 'CHECK: ' : ''}${esc(issue.message)}</p>`).join('')
      : `<p class="calculation-status ready">Balanced: ${fmt(t.finished)} finished = ${fmt(t.tagged)} in YARD TAGs + ${fmt(t.tested)} TEST + ${fmt(t.reservedReady)} planned + ${fmt(t.freeReady)} free. No TAG is counted twice.</p>`;

    // Draft header
    $('draftSelect').innerHTML = state.drafts.length ? state.drafts.map((item) => {
      const label = item.purpose === 'customer' ? `${item.customer || 'Customer'}${item.number ? ` · ${item.number}` : ''}` : 'Unassigned stock plan';
      return `<option value="${esc(item.id)}" ${item.id === activeDraftId ? 'selected' : ''}>${esc(label)} · ${fmt(item.targetBf || 0)} BF</option>`;
    }).join('') : '<option value="">No drafts yet</option>';
    const planDraft = plan.drafts.find((item) => item.id === activeDraftId);
    const hasDraft = Boolean(draft);
    ['draftPurpose', 'draftCustomer', 'draftNumber', 'draftTarget', 'deleteDraft', 'addStack', 'assignTag', 'assignTagSelect'].forEach((id) => { $(id).disabled = !hasDraft; });
    if (!hasDraft) {
      $('draftMetrics').innerHTML = '';
      $('draftStacks').innerHTML = '<div class="empty-state">Create a draft for a customer order or an unassigned stock plan.</div>';
      $('assignTagSelect').innerHTML = '';
      return;
    }
    const customer = draft.purpose === 'customer';
    $('draftPurpose').value = customer ? 'customer' : 'stock';
    $('draftCustomer').value = draft.customer || '';
    $('draftNumber').value = draft.number || '';
    $('draftTarget').value = Number(draft.targetBf || 0);
    document.querySelectorAll('.preorder-customer-field').forEach((field) => field.classList.toggle('is-disabled', !customer));
    $('draftCustomer').disabled = !customer; $('draftNumber').disabled = !customer;
    $('draftEyebrow').textContent = customer ? 'CUSTOMER ORDER' : 'UNASSIGNED STOCK PLAN';
    $('draftHeading').textContent = customer ? `${draft.customer || 'Customer'} — future TAG stacks` : 'Stage finished material without a customer';

    const remaining = planDraft.remainingBf;
    $('draftMetrics').innerHTML = `
      <div><b>${planDraft.targetBf ? fmt(planDraft.targetBf, 1) : '—'}</b><span>target BF</span></div>
      <div><b>${fmt(planDraft.fulfilledBf, 1)}</b><span>fulfilled by built YARD TAGs</span></div>
      <div><b>${fmt(planDraft.plannedBf, 1)}</b><span>planned in future stacks</span></div>
      <div class="${remaining != null && remaining < 0 ? 'over' : ''}"><b>${remaining == null ? '—' : `${remaining < 0 ? '+' : ''}${fmt(Math.abs(remaining), 1)}`}</b><span>${remaining == null ? 'no target set' : remaining < 0 ? 'BF over target' : 'BF still needed'}</span></div>`;

    const unassigned = plan.tags.filter((tag) => !tag.assignment);
    $('assignTagSelect').innerHTML = unassigned.length
      ? unassigned.map((tag) => `<option value="${esc(tag.id)}">TAG ${esc(tag.label)} · ${fmt(tag.boards)} PCS · ${fmt(tag.bf, 1)} BF${tag.shipped ? ' · shipped' : ''}</option>`).join('')
      : '<option value="">All built TAGs are already assigned</option>';
    $('assignTag').disabled = !unassigned.length;

    const supplyOptions = (source) => plan.rows
      .filter((row) => (source === 'expected' ? row.freeExpected : row.freeReady) > 0)
      .map((row) => `<option value="${esc(row.key)}|${source}">${fmt(row.lengthFt)} ft · ${esc(row.material)} · ${fmt(source === 'expected' ? row.freeExpected : row.freeReady)} free${source === 'expected' ? ' (in kiln)' : ''}</option>`).join('');
    const options = supplyOptions('ready') + supplyOptions('expected');

    $('draftStacks').innerHTML = planDraft.stacks.length ? planDraft.stacks.map((stack) => {
      const lines = stack.lines.map((line) => stack.status === 'planned'
        ? `<article class="preorder-allocation ${line.source}"><span><b>${fmt(line.lengthFt)} ft · ${esc(line.material)}</b><small>${line.source === 'expected' ? 'EXPECTED · in kiln' : 'READY'} · ${fmt(bf(line.lengthFt, line.quantity), 1)} BF</small></span><input class="line-qty" data-stack="${esc(stack.id)}" data-line="${esc(line.id)}" type="number" min="1" value="${line.quantity}" aria-label="Boards"><button class="danger line-remove" data-stack="${esc(stack.id)}" data-line="${esc(line.id)}" type="button">×</button></article>`
        : `<article class="preorder-allocation tagged"><span><b>${fmt(line.lengthFt)} ft · ${esc(line.material)}</b><small>${fmt(bf(line.lengthFt, line.quantity), 1)} BF</small></span><b>${fmt(line.quantity)}</b></article>`).join('');
      if (stack.status !== 'planned') {
        const label = stack.status === 'broken' ? 'TAG LINK NEEDS REVIEW' : stack.status === 'shipped' ? `TAG ${esc(stack.tagLabel)} · SHIPPED` : `TAG ${esc(stack.tagLabel)} · BUILT`;
        return `<article class="preorder-stack tag-stack ${stack.status}"><header><span class="tag-stack-label">${label}</span><span><b>${fmt(stack.boards)} PCS</b> · ${fmt(stack.bf, 1)} BF</span><button class="secondary stack-unassign" data-stack="${esc(stack.id)}" type="button">Unassign</button></header><div class="preorder-stack-items">${lines || '<div class="preorder-empty">The linked TAG was not found.</div>'}</div></article>`;
      }
      const buildOptions = unassigned.map((tag) => `<option value="${esc(tag.id)}">TAG ${esc(tag.label)} · ${fmt(tag.boards)} PCS</option>`).join('');
      return `<article class="preorder-stack" data-stack-id="${esc(stack.id)}"><header><input class="stack-name" data-stack="${esc(stack.id)}" value="${esc(stack.name)}" aria-label="Future TAG name"><span><b>${fmt(stack.boards)} PCS</b> · ${fmt(stack.bf, 1)} BF</span><button class="danger stack-remove" data-stack="${esc(stack.id)}" type="button">×</button></header>
        <div class="preorder-stack-items">${lines || '<div class="preorder-empty">Add lengths from free supply</div>'}</div>
        <div class="stack-add-row"><select class="stack-add-source" data-stack="${esc(stack.id)}" ${options ? '' : 'disabled'}>${options || '<option>No free supply</option>'}</select><input class="stack-add-qty" data-stack="${esc(stack.id)}" type="number" min="1" value="1" aria-label="Boards to add"><button class="stack-add" data-stack="${esc(stack.id)}" type="button" ${options ? '' : 'disabled'}>Add</button></div>
        <div class="stack-add-row"><select class="stack-built-tag" data-stack="${esc(stack.id)}" ${buildOptions ? '' : 'disabled'}>${buildOptions || '<option>No unassigned TAG</option>'}</select><button class="secondary stack-mark-built" data-stack="${esc(stack.id)}" type="button" ${buildOptions ? '' : 'disabled'}>Built as this TAG</button></div></article>`;
    }).join('') : '<div class="empty-state">Add a future TAG stack, or assign a TAG that is already built.</div>';
    bindStackEvents();
  }

  const findStack = (drafts, stackId) => {
    const draft = drafts.find((item) => item.id === activeDraftId);
    return { draft, stack: draft?.stacks.find((item) => item.id === stackId) };
  };
  const cloneDrafts = () => structuredClone(state.drafts);
  const afterEvent = (task) => window.setTimeout(task, 0);

  function bindStackEvents() {
    document.querySelectorAll('.stack-add').forEach((button) => button.addEventListener('click', () => {
      const drafts = cloneDrafts(); const { stack } = findStack(drafts, button.dataset.stack); if (!stack) return;
      const [lengthFt, material, source] = document.querySelector(`.stack-add-source[data-stack="${button.dataset.stack}"]`).value.split('|');
      const quantity = Math.floor(Number(document.querySelector(`.stack-add-qty[data-stack="${button.dataset.stack}"]`).value || 0));
      if (!(quantity > 0)) { status('pending', 'Enter a whole number of boards.'); return; }
      stack.items = stack.items || [];
      const existing = stack.items.find((item) => Number(item.lengthFt) === Number(lengthFt) && item.material === material && item.source === source);
      if (existing) existing.quantity = Number(existing.quantity) + quantity;
      else stack.items.push({ id: newId('line'), lengthFt: Number(lengthFt), material, source, quantity });
      commit(drafts, `${fmt(quantity)} × ${lengthFt} ft ${material} planned into ${stack.name}.`);
    }));
    document.querySelectorAll('.line-qty').forEach((input) => input.addEventListener('change', () => afterEvent(() => {
      const drafts = cloneDrafts(); const { stack } = findStack(drafts, input.dataset.stack); if (!stack) return;
      const line = stack.items.find((item) => item.id === input.dataset.line); if (!line) return;
      const quantity = Math.floor(Number(input.value || 0));
      if (!(quantity > 0)) { render(); status('pending', 'Quantity must be at least 1; use × to remove a line.'); return; }
      line.quantity = quantity;
      if (!commit(drafts, 'Quantity updated.')) render();
    })));
    document.querySelectorAll('.line-remove').forEach((button) => button.addEventListener('click', () => {
      const drafts = cloneDrafts(); const { stack } = findStack(drafts, button.dataset.stack); if (!stack) return;
      stack.items = stack.items.filter((item) => item.id !== button.dataset.line);
      commit(drafts, 'Line removed; its boards are free to plan again.');
    }));
    document.querySelectorAll('.stack-name').forEach((input) => input.addEventListener('change', () => afterEvent(() => {
      const drafts = cloneDrafts(); const { stack } = findStack(drafts, input.dataset.stack); if (!stack) return;
      stack.name = input.value.trim() || 'Future TAG';
      commit(drafts, 'Stack renamed.');
    })));
    document.querySelectorAll('.stack-remove').forEach((button) => button.addEventListener('click', () => {
      const drafts = cloneDrafts(); const { draft, stack } = findStack(drafts, button.dataset.stack); if (!stack) return;
      if ((stack.items || []).length && !window.confirm(`Delete ${stack.name} and free its planned boards?`)) return;
      draft.stacks = draft.stacks.filter((item) => item.id !== stack.id);
      commit(drafts, `${stack.name} deleted; its boards are free to plan again.`);
    }));
    document.querySelectorAll('.stack-mark-built').forEach((button) => button.addEventListener('click', () => {
      const drafts = cloneDrafts(); const { stack } = findStack(drafts, button.dataset.stack); if (!stack) return;
      const tagId = document.querySelector(`.stack-built-tag[data-stack="${button.dataset.stack}"]`).value;
      const tag = state.planning.tags.find((item) => item.id === tagId); if (!tag) return;
      if (!window.confirm(`Mark ${stack.name} as built into YARD TAG ${tag.label}? The planned lines are released and the TAG's actual content counts instead.`)) return;
      stack.tagId = tag.id; stack.name = tag.label; stack.linkedAt = new Date().toISOString();
      commit(drafts, `${stack.name} is now fulfilled by YARD TAG ${tag.label}.`);
    }));
    document.querySelectorAll('.stack-unassign').forEach((button) => button.addEventListener('click', () => {
      const drafts = cloneDrafts(); const { draft, stack } = findStack(drafts, button.dataset.stack); if (!stack) return;
      if (!window.confirm(`Unassign TAG ${stack.name} from this draft? The TAG stays in the YARD and becomes available to assign elsewhere.`)) return;
      draft.stacks = draft.stacks.filter((item) => item.id !== stack.id);
      commit(drafts, `TAG ${stack.name} unassigned.`);
    }));
  }

  // Header and draft-level controls (bound once).
  $('draftSelect').addEventListener('change', (event) => { activeDraftId = event.target.value; render(); });
  ['draftPurpose', 'draftCustomer', 'draftNumber', 'draftTarget'].forEach((id) => $(id).addEventListener('change', () => afterEvent(() => {
    const drafts = cloneDrafts(); const draft = drafts.find((item) => item.id === activeDraftId); if (!draft) return;
    draft.purpose = $('draftPurpose').value === 'customer' ? 'customer' : 'stock';
    draft.customer = $('draftCustomer').value.trim();
    draft.number = $('draftNumber').value.trim();
    draft.targetBf = Math.max(0, Number($('draftTarget').value || 0));
    commit(drafts, 'Draft saved.');
  })));
  $('newDraft').addEventListener('click', () => {
    if (!state) return;
    const draft = { id: newId('preorder'), orderId: state.order.id, purpose: 'customer', customer: '', number: '', targetBf: 0, stacks: [], planner: 'tag-planner-v1', createdAt: new Date().toISOString() };
    activeDraftId = draft.id;
    commit([...cloneDrafts(), draft], 'New draft created. Enter the customer and target.');
  });
  $('deleteDraft').addEventListener('click', () => {
    const draft = activeDraft(); if (!draft) return;
    if (!window.confirm(`Delete draft ${draft.customer || draft.number || ''}? Planned boards become free; built TAGs stay in the YARD.`)) return;
    activeDraftId = '';
    commit(cloneDrafts().filter((item) => item.id !== draft.id), 'Draft deleted.');
  });
  $('addStack').addEventListener('click', () => {
    const drafts = cloneDrafts(); const draft = drafts.find((item) => item.id === activeDraftId); if (!draft) return;
    draft.stacks = draft.stacks || [];
    draft.stacks.push({ id: newId('future-tag'), name: `Future TAG ${draft.stacks.filter((stack) => !stack.tagId).length + 1}`, items: [] });
    commit(drafts, 'Future TAG stack added.');
  });
  $('assignTag').addEventListener('click', () => {
    const drafts = cloneDrafts(); const draft = drafts.find((item) => item.id === activeDraftId); if (!draft) return;
    const tag = state.planning.tags.find((item) => item.id === $('assignTagSelect').value); if (!tag) return;
    draft.stacks = draft.stacks || [];
    draft.stacks.push({ id: newId('tag-stack'), name: tag.label, tagId: tag.id, items: [], linkedAt: new Date().toISOString() });
    commit(drafts, `YARD TAG ${tag.label} assigned to ${draft.customer || 'this draft'}.`);
  });

  const migrated = migrateOnce();
  refresh();
  if (migrated) status('ready', migrated);
  else if (state) status('idle', 'Plan future TAG stacks from free supply, or assign TAGs that are already built.');
})();
