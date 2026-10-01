// PDF printing for every screen. Each block (a card on the page) can be saved as its
// own PDF, or several blocks together, one block per page. Before printing, wide tables
// are fitted to the sheet (smaller type, never cut off) and the orientation is chosen:
// a table that would need very small type in portrait switches the report to landscape.
// Read-only: it changes nothing but the page's print layout, and restores it afterwards.
(function () {
  'use strict';
  const BLOCKS = [
    'main.wrap > section.management-dashboard',
    'main.wrap > section.card',
    'main.wrap > section.remainder-summary',
    'main.wrap > .grid > section.card',
  ].join(', ');
  // Printable width in CSS px (96 dpi) with 10 mm margins, the narrower of Letter and A4.
  const SHEET = { portrait: { width: 718, height: 960 }, landscape: { width: 980, height: 700 } };
  const MIN_FONT_PX = 6.5;
  const LANDSCAPE_BELOW = 0.8; // auto: switch to landscape if portrait needs type below 80 %
  const isSafari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function blocks() {
    return [...document.querySelectorAll(BLOCKS)].filter((el) => !el.closest('dialog') && el.id !== 'kilnSettingsReport'
      && el.offsetParent !== null && el.textContent.trim());
  }
  // Blocks that are only an entry form or have nothing recorded yet are offered but
  // not pre-selected for the report.
  function reportDefault(el) {
    if (el.dataset.printDefault === 'off') return false;
    const empty = [...el.querySelectorAll('.empty-state')].some((node) => node.offsetParent !== null);
    return !empty || Boolean(el.querySelector('table tbody tr'));
  }
  function titleOf(el) {
    const heading = el.querySelector('h2, h1');
    const text = heading?.textContent || el.getAttribute('aria-label') || el.querySelector('.eyebrow')?.textContent || 'Summary';
    return text.replace(/\s+/g, ' ').trim();
  }
  function orderContext() {
    try {
      const pointer = JSON.parse(localStorage.getItem('kiln-planner-active-order-v1') || 'null');
      const order = pointer?.orderRef ? JSON.parse(localStorage.getItem(`kiln-planner-order-v1:${pointer.orderRef}`) || 'null') : pointer;
      return { number: order?.number || '', supplier: order?.inputs?.supplier || '' };
    } catch (_) {
      return { number: '', supplier: '' };
    }
  }
  const pageName = () => document.querySelector('.page-header h1')?.textContent.trim() || document.title;
  const today = () => new Date().toISOString().slice(0, 10);

  // ---------- per-block buttons ----------
  function decorate() {
    blocks().forEach((el, index) => {
      if (!el.dataset.printBlock) el.dataset.printBlock = `block-${index + 1}`;
      if (el.querySelector(':scope > .kp-block-button')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'kp-block-button';
      button.textContent = 'PDF';
      button.title = 'Save this block as PDF';
      button.setAttribute('aria-label', `Save “${titleOf(el)}” as PDF`);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        printBlocks([el.dataset.printBlock], { orientation: 'auto', name: titleOf(el) });
      });
      el.prepend(button);
    });
  }
  let pending = 0;
  const observer = new MutationObserver(() => {
    window.clearTimeout(pending);
    pending = window.setTimeout(decorate, 250);
  });

  // ---------- form fields print as their values ----------
  // An input keeps its screen width on paper and clips the number inside it; on a
  // report every field is replaced by its plain value for the time of printing.
  function materializeFields(targets) {
    const added = [];
    targets.forEach((block) => block.querySelectorAll('input, select, textarea').forEach((field) => {
      if (['checkbox', 'radio', 'hidden', 'button', 'submit', 'file'].includes(field.type)) return;
      const value = field.tagName === 'SELECT' ? (field.selectedOptions[0]?.textContent || '') : field.value;
      const span = document.createElement('span');
      span.className = 'kp-value';
      span.textContent = value;
      field.after(span);
      field.classList.add('kp-hidden-field');
      added.push({ field, span });
    }));
    return () => added.forEach(({ field, span }) => { span.remove(); field.classList.remove('kp-hidden-field'); });
  }

  // ---------- fitting tables to the sheet ----------
  function measure(targets, sheet) {
    document.body.style.setProperty('--kp-width', `${sheet.width}px`);
    document.body.classList.add('kp-measure');
    const fits = [];
    targets.forEach((block) => block.querySelectorAll('table').forEach((table) => {
      if (table.closest('.kp-skip')) return;
      table.classList.add('kp-fit');
      const available = table.parentElement.clientWidth || sheet.width;
      const base = parseFloat(getComputedStyle(table).fontSize) || 12;
      let size = base;
      table.style.fontSize = '';
      for (let step = 0; step < 6 && table.scrollWidth > available + 1; step += 1) {
        size = Math.max(MIN_FONT_PX, size * Math.max(0.6, available / table.scrollWidth));
        table.style.fontSize = `${size}px`;
        if (size === MIN_FONT_PX) break;
      }
      // The type size is not fixed here: the sheet decides it at print time. Safari
      // ignores the orientation a page asks for, so the same report must fit whichever
      // sheet the person picks. k ties the type size to the block's printed width
      // (CSS: font-size = 100cqi * k, never above the screen size).
      const style = getComputedStyle(block);
      const blockContent = Math.max(1, block.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      fits.push({ table, ratio: size / base, size, base, k: (base * (size / base) * 0.97) / blockContent,
        keep: table.getBoundingClientRect().height < sheet.height * 0.8 });
      table.style.fontSize = '';
    }));
    document.body.classList.remove('kp-measure');
    return fits;
  }
  // Tables are always measured on the narrower (portrait) sheet, so they fit whichever
  // orientation the browser finally prints; on a landscape sheet they simply get larger
  // type, up to their screen size. The orientation only chooses the requested page.
  function chooseOrientation(targets, requested) {
    const fits = measure(targets, SHEET.portrait);
    if (requested === 'portrait' || requested === 'landscape') return { orientation: requested, fits };
    const tightest = Math.min(1, ...fits.map((fit) => fit.ratio));
    return { orientation: tightest >= LANDSCAPE_BELOW ? 'portrait' : 'landscape', fits };
  }

  // ---------- printing ----------
  let cleanupPrint = null;
  function printBlocks(ids, { orientation = 'auto', newPage = true, name = '' } = {}) {
    if (cleanupPrint) cleanupPrint();
    const all = blocks();
    const targets = all.filter((el) => ids.includes(el.dataset.printBlock));
    if (!targets.length) return;
    const restoreFields = materializeFields(targets);
    const chosen = chooseOrientation(targets, orientation);
    const context = orderContext();

    const style = document.createElement('style');
    style.id = 'kp-page';
    style.textContent = `@page { size: ${chosen.orientation}; margin: 10mm; }`;
    document.head.append(style);
    const meta = document.createElement('div');
    meta.className = 'kp-meta';
    meta.innerHTML = `<b>${esc(name || pageName())}</b><span>${esc([context.number, context.supplier].filter(Boolean).join(' · '))}</span><span>Printed ${esc(new Date().toLocaleString())}</span>`;
    document.querySelector('main.wrap')?.prepend(meta);

    document.body.classList.add('kp-printing', `kp-${chosen.orientation}`);
    targets.forEach((el, index) => { el.classList.add('kp-include'); if (newPage && index > 0) el.classList.add('kp-break'); });
    chosen.fits.forEach((fit) => {
      fit.table.classList.add('kp-fit');
      fit.table.style.setProperty('--kp-base', `${fit.base}px`);
      fit.table.style.setProperty('--kp-k', String(fit.k));
      if (fit.keep) fit.table.classList.add('kp-keep');
    });
    const previousTitle = document.title;
    document.title = [pageName(), name && name !== pageName() ? name : '', context.number, today()].filter(Boolean).join(' - ');

    cleanupPrint = () => {
      cleanupPrint = null;
      window.removeEventListener('afterprint', cleanupPrint);
      document.body.classList.remove('kp-printing', 'kp-portrait', 'kp-landscape');
      all.forEach((el) => el.classList.remove('kp-include', 'kp-break'));
      chosen.fits.forEach((fit) => {
        fit.table.style.removeProperty('--kp-base');
        fit.table.style.removeProperty('--kp-k');
        fit.table.classList.remove('kp-keep', 'kp-fit');
      });
      restoreFields();
      style.remove();
      meta.remove();
      document.title = previousTitle;
    };
    window.addEventListener('afterprint', cleanupPrint);
    window.print();
    // Safari and Chrome return from print() when the dialog closes; afterprint is the
    // primary signal, this is the fallback.
    window.setTimeout(() => cleanupPrint?.(), 1000);
    return chosen.orientation;
  }

  // ---------- report dialog ----------
  function openDialog({ name = '' } = {}) {
    decorate();
    let dialog = document.getElementById('kpDialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'kpDialog';
      dialog.className = 'kp-dialog';
      document.body.append(dialog);
    }
    const items = blocks();
    dialog.innerHTML = `<form method="dialog">
      <h2>PDF report</h2>
      <p class="kp-hint">Choose the blocks to include. Each block starts on its own page; tables are never cut off and are fitted to the sheet.</p>
      <div class="kp-blocks">${items.map((el) => `<label class="kp-check"><input type="checkbox" value="${esc(el.dataset.printBlock)}" ${reportDefault(el) ? 'checked' : ''}><span>${esc(titleOf(el))}</span></label>`).join('')}</div>
      <fieldset class="kp-orientation"><legend>Orientation</legend>
        <label class="kp-check"><input type="radio" name="kpOrientation" value="auto" checked><span>Auto</span></label>
        <label class="kp-check"><input type="radio" name="kpOrientation" value="portrait"><span>Portrait</span></label>
        <label class="kp-check"><input type="radio" name="kpOrientation" value="landscape"><span>Landscape</span></label></fieldset>
      <label class="kp-check"><input type="checkbox" name="kpNewPage" checked><span>Each block on a new page</span></label>
      ${isSafari ? '<p class="kp-hint kp-safari"><b>Safari:</b> it always opens its print window in portrait. For a wide report click <b>Show Details</b> there and pick the <b>landscape</b> icon. Tables fit the page either way; landscape only makes them larger.</p>' : ''}
      <p class="kp-status" role="status"></p>
      <div class="kp-actions"><button type="button" class="secondary kp-select-none">Clear</button><button type="button" class="secondary kp-cancel">Cancel</button><button type="submit" class="kp-print">Create PDF</button></div>
    </form>`;
    dialog.querySelector('.kp-cancel').addEventListener('click', () => dialog.close());
    dialog.querySelector('.kp-select-none').addEventListener('click', () => dialog.querySelectorAll('.kp-blocks input').forEach((input) => { input.checked = false; }));
    dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const ids = [...dialog.querySelectorAll('.kp-blocks input:checked')].map((input) => input.value);
      if (!ids.length) { dialog.querySelector('.kp-status').textContent = 'Select at least one block.'; return; }
      const orientation = dialog.querySelector('input[name="kpOrientation"]:checked').value;
      const newPage = dialog.querySelector('input[name="kpNewPage"]').checked;
      dialog.close();
      window.setTimeout(() => printBlocks(ids, { orientation, newPage, name }), 50);
    });
    dialog.showModal();
  }

  window.KilnPrint = { open: openDialog, printBlocks, blocks: () => blocks().map((el) => ({ id: el.dataset.printBlock, title: titleOf(el) })) };
  const start = () => {
    decorate();
    const main = document.querySelector('main.wrap');
    if (main) observer.observe(main, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());
