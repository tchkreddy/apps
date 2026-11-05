/**
 * B401 Meter PWA — app.js
 * Native ES6 module. No build step.
 *
 * SAFE API CONTRACT:
 *   ✅ GetOnlineData   — read-only live snapshot
 *   ✅ GetFromMonthlyBill (command:"select") — read-only historical bills
 *   ✅ RCHistoryReport — read-only recharge history
 *   ❌ MeterStatus — NEVER CALLED (can trigger on/off)
 *   ❌ Any POST / write / command:"update" — NEVER called
 *
 * ACCESS CONTROL:
 *   The Apps Script proxy requires a secret passed as ?secret=<token>.
 *   The token is read from the URL hash: bookmark the URL with #yourSecret.
 *   The hash never leaves the browser and is not in source control.
 */

// ── Config ────────────────────────────────────────────
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbzMkvnwPWKb4cttij712tL1vNiio2L9bue9S2nQZeA23HVsgZsxsn4R43ayMKzLf9gl/exec';
const FLAT      = 'B401';
const LS_KEY    = 'em_secret';

// Secret resolution order:
//   1. URL hash  → save to localStorage (seeds the installed PWA)
//   2. localStorage (used by every home-screen launch after the first)
//   3. Neither   → show lock screen
(function seedSecret() {
  const fromHash = location.hash.replace(/^#/, '');
  if (fromHash) {
    localStorage.setItem(LS_KEY, fromHash);
    // Strip hash from URL bar without reload (cosmetic)
    history.replaceState(null, '', location.pathname + location.search);
  }
})();
const ACCESS_SECRET = localStorage.getItem(LS_KEY) || '';
const EB_TARIFF_FALLBACK  = 8.45;
const DG_TARIFF_FALLBACK  = 32.0;

// Month names the server uses
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

// ── State ─────────────────────────────────────────────
let liveData      = null;      // latest GetOnlineData response
let monthlyCache  = {};        // { "Month, YYYY": billObj }
let rechargeData  = null;
let selectedMonth = null;      // e.g. "September, 2026"
let refreshTimer  = null;

// ── DOM refs ──────────────────────────────────────────
const $ = id => document.getElementById(id);
const $refresh    = $('refresh-btn');
const $toast      = $('toast');
const $liveStatus = $('live-status-text');
const $liveDot    = $('live-status-dot');
const $liveTime   = $('live-timestamp');

// ── Utilities ─────────────────────────────────────────
function fmt(n, dec = 2) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtInt(n) {
  if (n == null || n === '') return '—';
  return Math.round(Number(n)).toLocaleString('en-IN');
}
function fmtTime(d = new Date()) {
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function showToast(msg, duration = 2500) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  setTimeout(() => $toast.classList.remove('show'), duration);
}

/**
 * Safe GET — routes through the Apps Script proxy.
 * Proxy enforces read-only whitelist + ACCESS_SECRET gate.
 */
async function safeGet(taskid, params) {
  const ALLOWED = ['GetOnlineData', 'GetFromMonthlyBill', 'RCHistoryReport'];
  if (!ALLOWED.includes(taskid)) {
    throw new Error(`BLOCKED client-side: taskid "${taskid}" is not on the safe list.`);
  }
  if (!ACCESS_SECRET) {
    const err = new Error('No access secret — open the app via your private bookmarked URL.');
    err.isUnauthorized = true;
    throw err;
  }
  const param = encodeURIComponent(JSON.stringify({ taskid, params }));
  const url   = `${PROXY_URL}?secret=${encodeURIComponent(ACCESS_SECRET)}&param=${param}`;
  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const err = new Error(body.error || `HTTP ${r.status}`);
    if (r.status === 403 || (body.error || '').toLowerCase().includes('unauthorized')) {
      err.isUnauthorized = true;
    }
    throw err;
  }
  return r.json();
}

// ── Tab navigation ────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === target);
        t.setAttribute('aria-selected', t.dataset.tab === target);
      });
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.toggle('active', p.id === `tab-${target}`);
      });
      if (target === 'monthly' && Object.keys(monthlyCache).length === 0) {
        loadAllMonthly();
      }
      if (target === 'recharge' && !rechargeData) {
        loadRecharge();
      }
    });
  });
}

// ══════════════════════════════════════════════════════
//  LIVE TAB
// ══════════════════════════════════════════════════════
async function loadLive() {
  $liveDot.className  = 'status-dot loading';
  $liveStatus.textContent = 'Fetching…';
  $refresh.classList.add('spinning');

  try {
    const json = await safeGet('GetOnlineData', {
      arguments: [{ custid: FLAT }]
    });
    liveData = json.onlinedata?.[0];
    if (!liveData) throw new Error('Empty response');

    renderLive(liveData);
    $liveDot.className  = 'status-dot ok';
    $liveStatus.textContent = 'Live';
    $liveTime.textContent = fmtTime();
  } catch (e) {
    if (e.isUnauthorized) {
      // Clear bad cached secret so user can re-seed via URL
      localStorage.removeItem(LS_KEY);
      showLockScreen('Wrong access secret. Clear your browser data and re-open via your private bookmarked URL.');
      return;
    }
    $liveDot.className = 'status-dot err';
    $liveStatus.textContent = 'Error — tap ↻';
    console.error('loadLive:', e);
    showToast('⚠️ Could not fetch live data');
  } finally {
    $refresh.classList.remove('spinning');
  }
}

function renderLive(d) {
  // Balance hero
  $('live-balance').textContent = fmtInt(d.pmb);
  $('live-energy-type').textContent =
    d.energytype === 1 ? 'EB Grid active' :
    d.energytype === 2 ? 'DG / Generator active' : '';

  // Metric cards
  $('live-wattage').textContent = fmt(d.w, 1);
  $('live-current').textContent = fmt(d.a, 3);
  $('live-eb').textContent      = fmt(d.ebwh, 2);
  $('live-dg').textContent      = fmt(d.dgwh, 3);

  // This-month estimate
  renderThisMonthEstimate(d);
}

function renderThisMonthEstimate(live) {
  // Find the most recent billed month's end readings
  const months = getSortedMonths();
  if (months.length === 0) {
    // No monthly data yet — show partial from live only
    $('estimate-note').textContent = 'Load Monthly tab first for full estimate';
    $('estimate-note').classList.add('visible');
    return;
  }

  const lastBill = monthlyCache[months[0]]; // most recent
  const mis = lastBill.mis ?? lastBill;

  const ebStart  = mis.ebpresentreading  ?? 0;
  const dgStart  = mis.dgbpresentreading ?? 0;
  const ebTariff = mis.ebtariff  || EB_TARIFF_FALLBACK;
  const dgTariff = mis.dgtariff  || DG_TARIFF_FALLBACK;

  const ebUsed = Math.max(0, (live.ebwh ?? 0) - ebStart);
  const dgUsed = Math.max(0, (live.dgwh ?? 0) - dgStart);
  const ebCost = ebUsed * ebTariff;
  const dgCost = dgUsed * dgTariff;
  const total  = ebCost + dgCost;

  $('est-eb-usage').textContent = fmt(ebUsed, 2);
  $('est-eb-cost').textContent  = fmt(ebCost, 0);
  $('est-dg-usage').textContent = fmt(dgUsed, 3);
  $('est-dg-cost').textContent  = fmt(dgCost, 2);
  $('est-total').textContent    = fmt(total, 0);

  $('estimate-note').textContent =
    `Tariff: EB ₹${ebTariff}/kWh · DG ₹${dgTariff}/kWh · Base from ${months[0]}`;
  $('estimate-note').classList.add('visible');
}

function renderWaterGrid(mis) {
  const grid = $('water-grid');
  if (!mis) {
    grid.innerHTML = '<div class="water-loading">No monthly data loaded yet</div>';
    return;
  }
  const diMeters = [];
  for (let i = 1; i <= 4; i++) {
    const cons = mis[`di${i}consumption`];
    const curr = mis[`di${i}presentreading`];
    const prev = mis[`di${i}previousreading`];
    const text = mis[`di${i}text`] || `DI${i}`;
    if (curr != null) {
      diMeters.push({ label: `${text.toUpperCase()} (DI${i})`, curr, prev, cons });
    }
  }
  if (diMeters.length === 0) {
    grid.innerHTML = '<div class="water-loading">No DI meter data</div>';
    return;
  }
  grid.innerHTML = diMeters.map(m => `
    <div class="water-card">
      <div class="water-card-label">💧 ${escHtml(m.label)}</div>
      <div class="water-card-reading">${fmt(m.curr, 1)}</div>
      <div class="water-card-unit">cumulative reading</div>
      <div class="water-card-delta">+${fmt(m.cons, 1)} this month</div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════════════════
//  MONTHLY TAB
// ══════════════════════════════════════════════════════
function getSortedMonths() {
  return Object.keys(monthlyCache).sort((a, b) => {
    const parse = s => {
      const [mn, yr] = s.split(', ');
      return new Date(`${mn} 1, ${yr}`);
    };
    return parse(b) - parse(a); // descending
  });
}

async function loadAllMonthly() {
  const now = new Date();

  // Build ordered month keys: most recent first
  const allKeys = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    allKeys.push(`${MONTH_NAMES[d.getMonth()]}, ${d.getFullYear()}`);
  }

  const toLoad = allKeys.filter(k => !monthlyCache[k]);
  if (toLoad.length === 0) {
    renderMonthSelector();
    renderTrendChart();
    renderWaterTrendChart();
    return;
  }

  // Show spinner while loading
  showMonthlyState('loading');

  // ── Phase 1: load last 3 months first → render immediately ──
  const urgent   = toLoad.slice(0, 3);
  const deferred = toLoad.slice(3);

  const urgentResults = await Promise.allSettled(urgent.map(k => loadOneMonth(k)));

  // Check if the upstream DB is down (all urgent months errored with DB error)
  const months = getSortedMonths();
  if (months.length === 0) {
    // No data came back — could be DB down or genuinely no bills
    // Check if any result had a DB error flag
    const hasDbError = urgentResults.some(r => r.reason?.isDbError);
    showMonthlyState(hasDbError ? 'db-error' : 'empty');
    return;
  }

  // Some data arrived — render it
  showMonthlyState('ready');
  renderMonthSelector();
  if (selectedMonth) renderMonthlyDetail(selectedMonth);
  const mis = monthlyCache[months[0]]?.mis ?? monthlyCache[months[0]];
  renderWaterGrid(mis);
  if (liveData) renderThisMonthEstimate(liveData);

  // ── Phase 2: load remaining months in background (3 at a time) ──
  for (let i = 0; i < deferred.length; i += 3) {
    const batch = deferred.slice(i, i + 3);
    await Promise.allSettled(batch.map(k => loadOneMonth(k)));
    // Re-render charts as more data arrives
    renderTrendChart();
    renderWaterTrendChart();
  }
}

/** Show one of: 'loading' | 'ready' | 'db-error' | 'empty' */
function showMonthlyState(state) {
  const loading = $('monthly-loading');
  const content = $('monthly-content');
  if (state === 'ready') {
    loading.style.display = 'none';
    content.style.display = 'block';
  } else if (state === 'loading') {
    loading.style.display = 'flex';
    loading.innerHTML = '<div class="spinner"></div><span>Fetching monthly data\u2026</span>';
    content.style.display = 'none';
  } else if (state === 'db-error') {
    loading.style.display = 'flex';
    loading.innerHTML = `
      <div style="text-align:center;padding:16px">
        <div style="font-size:2rem;margin-bottom:8px">\u26a0\ufe0f</div>
        <div style="color:var(--accent-red);font-weight:600;margin-bottom:4px">Billing server unavailable</div>
        <div style="color:var(--text-dim);font-size:0.8rem;margin-bottom:12px">The Elmeasure billing database is temporarily down.<br>Live data still works.</div>
        <button onclick="monthlyCache={};selectedMonth=null;loadAllMonthly()"
                style="background:var(--accent-blue);color:#fff;border:none;border-radius:8px;padding:8px 20px;font-size:0.9rem;cursor:pointer">\u21bb Retry</button>
      </div>`;
    content.style.display = 'none';
  } else {
    loading.style.display = 'flex';
    loading.innerHTML = '<span style="color:var(--text-dim)">No billing data available</span>';
    content.style.display = 'none';
  }
}

async function loadOneMonth(monthKey) {
  try {
    const json = await safeGet('GetFromMonthlyBill', {
      date: monthKey,
      command: 'select',
      custid: FLAT
    });
    if (json.success === false) {
      // Upstream DB error (e.g. "ERROR: null" from Elmeasure)
      const err = new Error(json.msg || 'Upstream error');
      err.isDbError = true;
      throw err;
    }
    const bills = json.bills;
    if (bills && bills.length > 0) {
      monthlyCache[monthKey] = bills[0];
      // Progressive: update selector chip as each month arrives
      renderMonthSelector();
    }
  } catch (e) {
    console.warn(`loadOneMonth(${monthKey}):`, e.message);
    throw e;  // re-throw so Promise.allSettled captures the reason
  }
}

function renderMonthSelector() {
  const months = getSortedMonths();
  if (months.length === 0) return;

  if (!selectedMonth) selectedMonth = months[0];

  const sel = $('month-selector');
  sel.innerHTML = months.map(m => `
    <button class="month-chip ${m === selectedMonth ? 'active' : ''}"
            data-month="${escHtml(m)}" role="option"
            aria-selected="${m === selectedMonth}">
      ${escHtml(shortMonth(m))}
    </button>
  `).join('');

  sel.querySelectorAll('.month-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedMonth = chip.dataset.month;
      sel.querySelectorAll('.month-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.month === selectedMonth);
        c.setAttribute('aria-selected', c.dataset.month === selectedMonth);
      });
      renderMonthlyDetail(selectedMonth);
    });
  });

  renderMonthlyDetail(selectedMonth);
}

function shortMonth(key) {
  // "September, 2026" → "Sep '26"
  const [mn, yr] = key.split(', ');
  return `${mn.slice(0, 3)} '${yr.slice(2)}`;
}

function renderMonthlyDetail(monthKey) {
  const bill = monthlyCache[monthKey];
  const loading = $('monthly-loading');
  const content = $('monthly-content');

  if (!bill) {
    loading.style.display = 'flex';
    // Only overwrite the spinner text if it still looks like our spinner
    // (don't clobber the db-error state which uses innerHTML, not a span)
    const span = loading.querySelector('span');
    if (span) span.textContent = `No data for ${monthKey}`;
    content.style.display = 'none';
    return;
  }

  loading.style.display = 'none';
  content.style.display = 'block';

  const mis = bill.mis ?? bill;

  $('monthly-period').textContent = mis.reportingmonth || monthKey;
  $('monthly-dates').textContent  =
    `${mis.firstreadingdate || ''} → ${mis.lastreadingdate || ''}`;

  // EB row
  $('m-eb-prev').textContent  = fmt(mis.ebpreviousreading, 2);
  $('m-eb-curr').textContent  = fmt(mis.ebpresentreading, 2);
  $('m-eb-units').textContent = fmt(mis.ebconsumption, 2);
  $('m-eb-cost').textContent  = `₹${fmt(mis.ebtotalamount, 0)}`;

  // DG row
  $('m-dg-prev').textContent  = fmt(mis.dgpreviousreading, 3);
  $('m-dg-curr').textContent  = fmt(mis.dgbpresentreading, 3);
  $('m-dg-units').textContent = fmt(mis.dgconsumption, 3);
  $('m-dg-cost').textContent  = `₹${fmt(mis.dgtotalamount, 2)}`;

  // DI / Water rows
  const waterTable = $('monthly-water-table');
  let waterRows = '';
  let totalWaterCost = 0;
  for (let i = 1; i <= 4; i++) {
    const curr = mis[`di${i}presentreading`];
    if (curr == null) continue;
    const label = (mis[`di${i}text`] || `DI${i}`).toUpperCase();
    const prev  = mis[`di${i}previousreading`] ?? '—';
    const cons  = mis[`di${i}consumption`]     ?? 0;
    const cost  = mis[`di${i}totalamount`]     ?? 0;
    totalWaterCost += Number(cost);
    waterRows += `
      <div class="bill-row">
        <span class="src-badge di-badge">${escHtml(label)}</span>
        <span>${fmt(prev, 1)}</span>
        <span>${fmt(curr, 1)}</span>
        <span>${fmt(cons, 1)}</span>
        <span>₹${fmt(cost, 0)}</span>
      </div>`;
  }
  // Replace everything after the header row
  const headerRow = waterTable.querySelector('.bill-header-row');
  // Remove old data rows
  waterTable.querySelectorAll('.bill-row:not(.bill-header-row)').forEach(r => r.remove());
  headerRow.insertAdjacentHTML('afterend', waterRows);

  // Total
  const totalBill = (mis.ebtotalamount || 0) + (mis.dgtotalamount || 0) + totalWaterCost + (mis.fixedcost || 0);
  $('monthly-total-amount').textContent = `₹ ${fmt(totalBill, 0)}`;
}

// ── Trend Charts ─────────────────────────────────────
function renderTrendChart() {
  const months   = getSortedMonths().reverse(); // oldest first
  const labels   = months.map(shortMonth);
  const ebData   = months.map(m => {
    const mis = monthlyCache[m]?.mis ?? monthlyCache[m];
    return mis?.ebconsumption ?? 0;
  });

  drawBarChart('trend-chart', labels, [
    { label: 'EB kWh', data: ebData, color: '#facc15' }
  ]);
}

function renderWaterTrendChart() {
  const months = getSortedMonths().reverse();
  const labels = months.map(shortMonth);
  const waterData = months.map(m => {
    const mis = monthlyCache[m]?.mis ?? monthlyCache[m];
    const di3 = mis?.di3consumption ?? 0;
    const di4 = mis?.di4consumption ?? 0;
    return di3 + di4;
  });

  drawBarChart('water-trend-chart', labels, [
    { label: 'Water (DI3+DI4)', data: waterData, color: '#38bdf8' }
  ]);
}

/** Minimal canvas bar chart — no external library needed */
function drawBarChart(canvasId, labels, datasets) {
  const canvas  = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx     = canvas.getContext('2d');
  const dpr     = window.devicePixelRatio || 1;
  const W       = canvas.parentElement.clientWidth - 24;
  const H       = 170;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  const PAD_L = 44, PAD_B = 36, PAD_T = 10, PAD_R = 10;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  // Background
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, W, H);

  const allVals  = datasets.flatMap(d => d.data);
  const maxVal   = Math.max(...allVals, 1);
  const nBars    = labels.length;
  if (nBars === 0) return;

  const groupW   = chartW / nBars;
  const barW     = Math.max(6, groupW * 0.55);
  const radius   = Math.min(4, barW / 2);

  // Grid lines
  ctx.strokeStyle = '#2d3f57';
  ctx.lineWidth   = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = PAD_T + chartH - (i / gridLines) * chartH;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + chartW, y);
    ctx.stroke();
    // Y labels
    ctx.fillStyle = '#64748b';
    ctx.font = `${10 * dpr / dpr}px -apple-system, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(Math.round((i / gridLines) * maxVal), PAD_L - 4, y + 3);
  }

  // Bars
  datasets.forEach(dataset => {
    dataset.data.forEach((val, i) => {
      const barH  = (val / maxVal) * chartH;
      const x     = PAD_L + i * groupW + (groupW - barW) / 2;
      const y     = PAD_T + chartH - barH;

      // Gradient fill
      const grad = ctx.createLinearGradient(x, y, x, y + barH);
      grad.addColorStop(0, dataset.color);
      grad.addColorStop(1, dataset.color + '55');
      ctx.fillStyle = grad;

      // Rounded top bar
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + barW - radius, y);
      ctx.quadraticCurveTo(x + barW, y, x + barW, y + radius);
      ctx.lineTo(x + barW, y + barH);
      ctx.lineTo(x, y + barH);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fill();

      // Value label above bar (only if bar is tall enough)
      if (barH > 20) {
        ctx.fillStyle = dataset.color;
        ctx.font = `bold ${9}px -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(val), x + barW / 2, y - 3);
      }
    });
  });

  // X labels
  ctx.fillStyle = '#64748b';
  ctx.font = `${9}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  labels.forEach((lbl, i) => {
    const x = PAD_L + i * groupW + groupW / 2;
    ctx.fillText(lbl, x, H - PAD_B + 14);
  });
}

// ══════════════════════════════════════════════════════
//  RECHARGE TAB
// ══════════════════════════════════════════════════════
async function loadRecharge() {
  $('recharge-list').innerHTML = `
    <div class="recharge-loading"><div class="spinner"></div><span>Fetching recharge history…</span></div>`;

  const today    = new Date();
  const fromDate = new Date(today);
  fromDate.setFullYear(fromDate.getFullYear() - 1);
  const fmtDate  = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;

  try {
    const json = await safeGet('RCHistoryReport', {
      customerid: FLAT,
      paymode: 'All',
      fromdate: fmtDate(fromDate),
      todate: fmtDate(today)
    });

    const histories = json.rchistories;
    if (!histories || histories.length === 0) throw new Error('No data');
    rechargeData = histories[0];

    renderRecharge(rechargeData);
  } catch (e) {
    $('recharge-list').innerHTML =
      `<div class="recharge-loading" style="color:var(--accent-red)">⚠️ Could not load recharge history</div>`;
    console.error('loadRecharge:', e);
  }
}

function renderRecharge(data) {
  const rclist = data.rclist ?? [];
  const total  = data.total  ?? rclist.reduce((s, r) => s + (r.rcamount ?? 0), 0);

  // Summary
  $('rs-total').textContent = `₹${fmtInt(total)}`;
  $('rs-count').textContent = rclist.length;
  $('rs-avg').textContent   = rclist.length
    ? `₹${fmtInt(total / rclist.length)}`
    : '—';

  // List (most recent first)
  const sorted = [...rclist].sort((a, b) =>
    parseDDMMYYYY(b.receiptdate) - parseDDMMYYYY(a.receiptdate)
  );

  $('recharge-list').innerHTML = sorted.map(r => `
    <div class="recharge-item">
      <div class="recharge-icon">₹</div>
      <div class="recharge-info">
        <div class="recharge-date">${escHtml(r.receiptdate || '—')}</div>
        <div class="recharge-mode">${escHtml(r.paymode || '')} · ${escHtml(r.bankname || '')}</div>
      </div>
      <div class="recharge-amount">₹${fmtInt(r.rcamount)}</div>
    </div>
  `).join('');
}

function parseDDMMYYYY(str) {
  if (!str) return 0;
  // "17/11/2025 02:38 PM" → Date
  const [datePart] = str.split(' ');
  const [dd, mm, yyyy] = datePart.split('/');
  return new Date(`${yyyy}-${mm}-${dd}`).getTime();
}

// ── Security helper ───────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────
async function init() {
  // Guard: if no secret in URL hash, show lock screen and stop
  if (!ACCESS_SECRET) {
    showLockScreen('Open the app via your private bookmarked URL (with #secret).<br><br>Once opened with the secret, the installed app will remember it.');
    return;
  }

  initTabs();

  $refresh.addEventListener('click', () => {
    clearTimeout(refreshTimer);
    loadLive();
    scheduleAutoRefresh();
  });

  // Initial load
  await loadLive();

  // Auto-refresh every 60 seconds
  scheduleAutoRefresh();
}

/** Full-page lock screen shown when secret is missing or rejected */
function showLockScreen(msg) {
  document.body.innerHTML = `
    <div style="
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      min-height:100dvh;background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;
      padding:24px;text-align:center;gap:16px">
      <div style="font-size:3rem">🔒</div>
      <div style="font-size:1.1rem;font-weight:600">Access Restricted</div>
      <div style="color:#8b949e;font-size:0.85rem;max-width:280px;line-height:1.5">${msg}</div>
    </div>`;
}

function scheduleAutoRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadLive();
    scheduleAutoRefresh();
  }, 60_000);
}

// ── Service Worker registration ───────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(err => {
    console.warn('SW registration failed:', err);
  });
}

init();
