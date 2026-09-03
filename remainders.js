const LENGTHS = Array.from({ length: 18 }, (_, index) => index + 3);
const REMAINDER_INVENTORY_KEY = 'kiln-planner-remainder-inventory-v1';
const $ = (id) => document.getElementById(id);

function records() {
  try {
    const saved = JSON.parse(localStorage.getItem(REMAINDER_INVENTORY_KEY) || '[]');
    const result = Array.isArray(saved) ? saved : [];
    const knownIds = new Set(result.map((record) => record.id));
    const archive = JSON.parse(localStorage.getItem('kiln-planner-order-archive-v1') || '[]');
    let changed = false;
    (Array.isArray(archive) ? archive : []).forEach((record) => {
      if (knownIds.has(record.id)) return;
      const quantities = Object.fromEntries(
        (record.rows || [])
          .filter((row) => Number(row.unprocessed || 0) > 0)
          .map((row) => [row.length, Number(row.unprocessed)])
      );
      if (!Object.keys(quantities).length) return;
      const order = JSON.parse(localStorage.getItem(`kiln-planner-order-v1:${record.id}`) || 'null');
      const size = order?.inputs?.size || '';
      const values = String(size).match(/[\d.]+/g)?.map(Number) || [];
      const thickness = values[0] || Number(order?.inputs?.actualT || 0);
      const width = values[1] || Number(order?.inputs?.actualW || 0);
      const boards = Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);
      const bf = LENGTHS.reduce(
        (sum, length) => sum + thickness * width * length * Number(quantities[length] || 0) / 12,
        0
      );
      result.push({
        id: record.id,
        orderNumber: record.number,
        supplier: record.supplier || '',
        product: [order?.inputs?.species, size].filter(Boolean).join(' · '),
        species: order?.inputs?.species || '',
        size,
        actualT: Number(order?.inputs?.actualT || 0),
        actualW: Number(order?.inputs?.actualW || 0),
        quantities,
        boards,
        bf,
        completedAt: record.completedAt,
      });
      knownIds.add(record.id);
      changed = true;
    });
    if (changed) localStorage.setItem(REMAINDER_INVENTORY_KEY, JSON.stringify(result));
    return result;
  } catch (_) {
    return [];
  }
}

function esc(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function fmt(value, digits = 0) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function render() {
  const source = records().filter((record) => Object.values(record.quantities || {}).some((quantity) => Number(quantity) > 0)).sort((left, right) =>
    String(right.completedAt || '').localeCompare(String(left.completedAt || ''))
  );
  const boardTotal = source.reduce((sum, record) => sum + Number(record.boards || 0), 0);
  const bfTotal = source.reduce((sum, record) => sum + Number(record.bf || 0), 0);
  $('remainderOrders').textContent = fmt(source.length);
  $('remainderBoards').textContent = fmt(boardTotal);
  $('remainderBf').textContent = fmt(bfTotal, 1);
  $('emptyRemainders').hidden = source.length > 0;
  $('remainderTable').hidden = source.length === 0;
  if (!source.length) {
    $('remainderTable').innerHTML = '';
    return;
  }
  const totals = Object.fromEntries(LENGTHS.map((length) => [
    length,
    source.reduce((sum, record) => sum + Number(record.quantities?.[length] || 0), 0),
  ]));
  $('remainderTable').innerHTML = `<thead><tr><th>ORDER #</th><th>SUPPLIER</th><th>PRODUCT</th>${LENGTHS.map((length) => `<th>${length}</th>`).join('')}<th>PCS</th><th>BF</th></tr></thead><tbody>${source.map((record) => `<tr><td><b>${esc(record.orderNumber)}</b><small>${esc(String(record.completedAt || '').slice(0, 10))}</small></td><td>${esc(record.supplier || '-')}</td><td>${esc(record.product || record.size || '-')}</td>${LENGTHS.map((length) => `<td>${Number(record.quantities?.[length] || 0) ? fmt(record.quantities[length]) : ''}</td>`).join('')}<td><b>${fmt(record.boards)}</b></td><td><b>${fmt(record.bf, 1)}</b></td></tr>`).join('')}</tbody><tfoot><tr><th colspan="3">TOTAL CONDITIONAL STOCK</th>${LENGTHS.map((length) => `<th>${totals[length] ? fmt(totals[length]) : ''}</th>`).join('')}<th>${fmt(boardTotal)}</th><th>${fmt(bfTotal, 1)}</th></tr></tfoot>`;
}

$('printRemainders').addEventListener('click', () => {
  const previousTitle = document.title;
  document.title = `Remainder Inventory - ${new Date().toISOString().slice(0, 10)}`;
  window.addEventListener('afterprint', () => { document.title = previousTitle; }, { once: true });
  window.print();
});

render();
