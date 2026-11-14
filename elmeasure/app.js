/**
 * B401 Meter PWA — app.js  v2.3
 * Native ES6 module. No build step.
 *
 * SAFE API CONTRACT:
 *   ✅ GetOnlineData            — read-only live snapshot
 *   ✅ GetFromMonthlyBill (select) — read-only historical bills
 *   ✅ RCHistoryReport          — read-only recharge history
 *   ❌ MeterStatus              — NEVER CALLED (toggles meter power)
 *   ❌ command:"update"         — NEVER called
 *
 * ACCESS CONTROL:
 *   Proxy requires ?secret=TOKEN. Token read from URL #hash on first visit,
 *   then persisted to localStorage so installed PWA works without the hash.
 */

// ═══════════════════════════════════════════════════════
//  CONFIG & BOOTSTRAP
// ═══════════════════════════════════════════════════════
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbzMkvnwPWKb4cttij712tL1vNiio2L9bue9S2nQZeA23HVsgZsxsn4R43ayMKzLf9gl/exec';
const LS_KEY    = 'em_secret';
const LS_FLAT   = 'em_flat';

// Seed secret from URL hash → localStorage (runs once on load)
(function seedSecret() {
  const h = location.hash.replace(/^#/, '');
  if (h) {
    localStorage.setItem(LS_KEY, h);
    history.replaceState(null, '', location.pathname + location.search);
  }
})();

const ACCESS_SECRET = localStorage.getItem(LS_KEY) || '';
let   FLAT          = (localStorage.getItem(LS_FLAT) || 'B401').toUpperCase();

const EB_TARIFF_FALLBACK = 8.45;
const DG_TARIFF_FALLBACK = 32.0;
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

// ═══════════════════════════════════════════════════════
//  MUTABLE STATE  (all cleared by resetAll() on flat change)
// ═══════════════════════════════════════════════════════
let liveData     = null;   // GetOnlineData response object
let monthlyCache = {};     // { "Month, YYYY": billObj }
let rechargeData = null;   // RCHistoryReport response object
let selectedMonth = null;  // currently displayed month key
let refreshTimer  = null;  // setInterval handle

// ═══════════════════════════════════════════════════════
//  DOM SHORTCUTS
// ═══════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const $refresh    = $('refresh-btn');
const $toast      = $('toast');
const $liveStatus = $('live-status-text');
const $liveDot    = $('live-status-dot');
const $liveTime   = $('live-timestamp');

// ═══════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════
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
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function showToast(msg, duration = 2500) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  setTimeout(() => $toast.classList.remove('show'), duration);
}

// ═══════════════════════════════════════════════════════
//  SAFE API CALL
// ═══════════════════════════════════════════════════════
async function safeGet(taskid, params) {
  const ALLOWED = ['GetOnlineData', 'GetFromMonthlyBill', 'RCHistoryReport'];
  if (!ALLOWED.includes(taskid)) throw new Error(`BLOCKED: ${taskid}`);
  if (!ACCESS_SECRET) {
    const e = new Error('No secret'); e.isUnauthorized = true; throw e;
  }
  const param = encodeURIComponent(JSON.stringify({ taskid, params }));
  const url   = `${PROXY_URL}?secret=${encodeURIComponent(ACCESS_SECRET)}&param=${param}`;
  const r     = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body.error || `HTTP ${r.status}`);
    if (r.status === 403 || String(body.error).toLowerCase().includes('unauthorized')) e.isUnauthorized = true;
    throw e;
  }
  return r.json();
}

// ═══════════════════════════════════════════════════════
//  FULL RESET  — clears all state + every DOM element
//  Called on flat number change before reloading all data
// ═══════════════════════════════════════════════════════
function resetAll() {
  // State
  liveData      = null;
  monthlyCache  = {};
  rechargeData  = null;
  selectedMonth = null;
  clearTimeout(refreshTimer);

  // ── Live tab ──
  $('live-balance').textContent     = '—';
  $('live-wattage').textContent     = '—';
  $('live-energy-type').textContent = 'W';
  $('live-eb').textContent          = '—';
  $('live-dg').textContent          = '—';
  $('live-current').textContent     = '—';
  $('est-total').textContent        = '—';
  $('est-eb-cost').textContent      = '—';
  $('est-dg-cost').textContent      = '—';
  $('est-eb-usage').textContent     = '—';
  $('est-dg-usage').textContent     = '—';
  const estProj = $('est-projected'); if (estProj) estProj.textContent = '—';
  const liveRunway = $('live-runway'); if (liveRunway) liveRunway.textContent = '';
  const powerCost = $('live-power-cost'); if (powerCost) powerCost.textContent = '';
  const note = $('estimate-note');
  note.textContent = '';
  note.classList.remove('visible');
  $('water-grid').innerHTML = '<div class="water-loading">Loading water data…</div>';
  // Prediction cards
  const pc = $('prediction-cards');
  if (pc) pc.innerHTML = '<div class="pred-loading">Calculating…</div>';
  $liveDot.className                = 'status-dot';
  $liveStatus.textContent           = 'Fetching…';
  $liveTime.textContent             = '';

  // ── Monthly tab ──
  $('month-selector').innerHTML = '';
  showMonthlyState('loading');
  // Clear chart canvases so old flat's bars don't linger
  ['trend-chart', 'water-trend-chart'].forEach(id => {
    const c = $(id);
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    // Fill with chart background colour
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, c.width, c.height);
  });

  // ── Recharge tab ──
  $('rs-total').textContent = '—';
  $('rs-avg').textContent   = '—';
  $('rs-count').textContent = '—';
  $('recharge-list').innerHTML =
    '<div class="recharge-loading"><div class="spinner"></div><span>Loading…</span></div>';
}

// ═══════════════════════════════════════════════════════
//  FLAT BADGE — tappable, inline edit
// ═══════════════════════════════════════════════════════
function initFlatBadge() {
  attachBadgeClick();
}

function attachBadgeClick() {
  const badge = $('flat-badge');
  if (!badge) return;
  badge.style.cursor = 'pointer';
  badge.title = 'Tap to change flat';
  badge.addEventListener('click', onBadgeClick, { once: true });
}

function onBadgeClick() {
  const badge = $('flat-badge');
  if (!badge) return;

  const input = document.createElement('input');
  input.id    = 'flat-input';
  input.className = 'flat-badge-input';
  input.value     = FLAT;
  input.maxLength = 10;
  input.setAttribute('autocapitalize', 'characters');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');

  badge.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;

  function commit() {
    if (committed) return;
    committed = true;
    const val = input.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (val && val !== FLAT) {
      FLAT = val;
      localStorage.setItem(LS_FLAT, FLAT);
      document.title = `${FLAT} — Meter`;
      restoreBadge(FLAT);
      resetAll();
      // Fire all three independently — none depend on each other
      loadLive();
      loadAllMonthly();
      loadRecharge();
    } else {
      restoreBadge(FLAT);
    }
  }

  function cancel() {
    if (committed) return;
    committed = true;
    restoreBadge(FLAT);
  }

  // Force uppercase while typing
  input.addEventListener('input', () => {
    const pos = input.selectionStart;
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    try { input.setSelectionRange(pos, pos); } catch (_) {}
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  // Blur = cancel (slight delay so Enter's blur doesn't double-fire)
  input.addEventListener('blur', () => setTimeout(cancel, 120));
}

function restoreBadge(text) {
  const el = $('flat-input') || $('flat-badge');
  if (!el) return;
  const span = document.createElement('span');
  span.id        = 'flat-badge';
  span.className = 'flat-badge';
  span.textContent = text;
  el.replaceWith(span);
  attachBadgeClick();
}

// ═══════════════════════════════════════════════════════
//  TAB NAV
// ═══════════════════════════════════════════════════════
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
      // Lazy-load only if not already loaded
      if (target === 'monthly' && Object.keys(monthlyCache).length === 0) loadAllMonthly();
      if (target === 'monthly' && Object.keys(monthlyCache).length > 0) {
        // Redraw charts now that tab is visible (they may have drawn at width=0)
        renderTrendChart();
        renderWaterTrendChart();
      }
      if (target === 'recharge' && !rechargeData) loadRecharge();
    });
  });
}

// ═══════════════════════════════════════════════════════
//  LIVE TAB
// ═══════════════════════════════════════════════════════
async function loadLive() {
  $liveDot.className      = 'status-dot loading';
  $liveStatus.textContent = 'Fetching…';
  $refresh.classList.add('spinning');

  try {
    const json = await safeGet('GetOnlineData', { arguments: [{ custid: FLAT }] });
    liveData = json.onlinedata?.[0];
    if (!liveData) throw new Error('Empty response');

    renderLive(liveData);
    $liveDot.className      = 'status-dot ok';
    $liveStatus.textContent = 'Live';
    $liveTime.textContent   = fmtTime();
  } catch (e) {
    if (e.isUnauthorized) {
      localStorage.removeItem(LS_KEY);
      showLockScreen('Wrong access secret. Re-open via your private bookmarked URL.');
      return;
    }
    $liveDot.className      = 'status-dot err';
    $liveStatus.textContent = 'Error — tap ↻';
    console.error('loadLive:', e);
    showToast('⚠️ Could not fetch live data');
  } finally {
    $refresh.classList.remove('spinning');
  }
}

function renderLive(d) {
  // Balance strip
  $('live-balance').textContent     = fmtInt(d.pmb);
  $('live-wattage').textContent     = fmt(d.w, 1);
  $('live-energy-type').textContent = d.energytype === 2 ? 'W · DG' : 'W · EB';

  // Live power cost rate (EB tariff only — that's what billing uses)
  const ebTariffNow = (() => {
    const months = getSortedMonths();
    if (!months.length) return EB_TARIFF_FALLBACK;
    const mis = monthlyCache[months[0]]?.mis ?? monthlyCache[months[0]];
    return mis?.ebtariff || EB_TARIFF_FALLBACK;
  })();
  const watt    = Number(d.w) || 0;
  const costHr  = (watt / 1000) * ebTariffNow;
  const costDay = costHr * 24;
  const powerCostEl = $('live-power-cost');
  if (powerCostEl) {
    powerCostEl.textContent = watt > 0
      ? `₹${fmt(costHr, 2)}/hr · ₹${fmt(costDay, 0)}/day`
      : '';
  }

  // Details collapsible
  $('live-eb').textContent      = fmt(d.ebwh, 2);
  $('live-dg').textContent      = fmt(d.dgwh, 3);
  $('live-current').textContent = fmt(d.a, 3);

  // Hero estimate (uses monthlyCache if available)
  renderEstimate(d);
  renderPredictions(d);
}

function renderEstimate(live) {
  const months = getSortedMonths();
  if (months.length === 0) {
    $('estimate-note').textContent = 'Loading billing data for estimate…';
    $('estimate-note').classList.add('visible');
    return;
  }

  const mis      = monthlyCache[months[0]]?.mis ?? monthlyCache[months[0]];
  const ebStart  = mis.ebpresentreading  ?? 0;
  const dgStart  = mis.dgbpresentreading ?? 0;
  const ebTariff = mis.ebtariff  || EB_TARIFF_FALLBACK;
  const dgTariff = mis.dgtariff  || DG_TARIFF_FALLBACK;

  const ebUsed = Math.max(0, (live.ebwh ?? 0) - ebStart);
  const dgUsed = Math.max(0, (live.dgwh ?? 0) - dgStart);
  const ebCost = ebUsed * ebTariff;
  const dgCost = dgUsed * dgTariff;
  const actualTotal = ebCost + dgCost;

  // Days elapsed this month vs days in month → project full month cost
  const now       = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projected  = dayOfMonth > 0 ? (actualTotal / dayOfMonth) * daysInMonth : actualTotal;

  // Hero: actual / projected
  $('est-total').textContent     = fmt(actualTotal, 0);
  const projEl = $('est-projected');
  if (projEl) projEl.textContent = fmt(projected, 0);
  $('est-eb-cost').textContent   = fmt(ebCost, 0);
  $('est-dg-cost').textContent   = fmt(dgCost, 0);
  $('est-eb-usage').textContent  = fmt(ebUsed, 2);
  $('est-dg-usage').textContent  = fmt(dgUsed, 3);

  $('estimate-note').textContent =
    `EB ₹${ebTariff}/kWh · DG ₹${dgTariff}/kWh · day ${dayOfMonth}/${daysInMonth}`;
  $('estimate-note').classList.add('visible');

  // Also update prediction cards now that we have billing data
  renderPredictions(live);
}

// ── Prediction Cards ─────────────────────────────────────
function renderPredictions(live) {
  const pc = $('prediction-cards');
  if (!pc) return;

  const months = getSortedMonths();
  const balance = Number(live?.pmb ?? 0);

  // Need at least 1 month of history for avg
  if (months.length === 0) {
    pc.innerHTML = '<div class="pred-loading">Need billing data for predictions…</div>';
    return;
  }

  // 3-month average daily rate (or fewer if we don't have 3)
  const recent = months.slice(0, Math.min(3, months.length));
  const totalBill = recent.reduce((s, m) => {
    const mis = monthlyCache[m]?.mis ?? monthlyCache[m];
    return s + Number(mis?.grandtotal || mis?.ebtotalamount || 0) +
               Number(mis?.dgtotalamount || 0);
  }, 0);
  const avgMonthlyBill = totalBill / recent.length;
  const dailyRate = avgMonthlyBill / 30;

  // Days balance will last
  const daysLeft = dailyRate > 0 ? Math.floor(balance / dailyRate) : null;
  const runoutDate = daysLeft != null
    ? new Date(Date.now() + daysLeft * 86400000)
    : null;

  // Days until end of NEXT month
  const now = new Date();
  const endNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0); // last day of next month
  const daysToEndNext = Math.ceil((endNextMonth - now) / 86400000);

  // Recharge needed = cost through end of next month minus current balance, rounded up to ₹500
  const neededRaw = dailyRate * daysToEndNext - balance;
  const rechargeNeeded = neededRaw > 0
    ? Math.ceil(neededRaw / 500) * 500
    : 0;

  // Format runout date as "12 Nov" or "comfortable"
  const runoutStr = runoutDate
    ? runoutDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    : '—';
  const runoutLabel = daysLeft != null
    ? (daysLeft >= daysToEndNext ? '✅ Beyond next month' : `~${daysLeft} days · till ${runoutStr}`)
    : '—';

  pc.innerHTML = `
    <div class="pred-card">
      <div class="pred-label">3-Month Avg Bill</div>
      <div class="pred-value">₹${fmtInt(avgMonthlyBill)}</div>
      <div class="pred-sub">₹${Math.round(dailyRate)}/day · basis for estimates</div>
    </div>
    <div class="pred-card ${rechargeNeeded === 0 ? 'pred-ok' : 'pred-warn'}">
      <div class="pred-label">Recharge</div>
      <div class="pred-value">${rechargeNeeded === 0 ? 'Not needed ✅' : '₹' + fmtInt(rechargeNeeded)}</div>
      <div class="pred-sub">to cover till ${endNextMonth.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>
    </div>`;

  // Also update inline runway under Balance strip
  const runwayEl = $('live-runway');
  if (runwayEl && daysLeft != null) {
    const runoutShort = runoutDate
      ? runoutDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      : '';
    runwayEl.textContent = `Lasts ~${daysLeft}d (till ${runoutShort})`;
  }
}

function renderWaterGrid(mis) {
  const grid = $('water-grid');
  if (!mis) {
    grid.innerHTML = '<div class="water-loading">No monthly data</div>';
    return;
  }

  // Collect all 4 DI channels that have readings
  const channels = [];
  for (let i = 1; i <= 4; i++) {
    const curr = mis[`di${i}presentreading`];
    if (curr == null) continue;
    const prev = mis[`di${i}previousreading`] ?? curr;
    const cons = Number(mis[`di${i}consumption`] ?? (curr - prev)) || 0;
    channels.push({ i, curr: Number(curr), prev: Number(prev), cons });
  }

  if (!channels.length) {
    grid.innerHTML = '<div class="water-loading">No DI meter data</div>';
    return;
  }

  // Smart label: show channels that have non-zero consumption this month first.
  // If none have consumption (e.g. billing DB had zeros), fall back to top-2 by reading value.
  const withConsumption = channels.filter(c => c.cons > 0);
  const toShow = withConsumption.length > 0
    ? withConsumption.slice(0, 4)                                        // all active ones
    : [...channels].sort((a, b) => b.curr - a.curr).slice(0, 2);        // top-2 by absolute reading

  const cards = toShow.map(c => `
    <div class="water-card">
      <div class="water-card-label">💧 D${c.i}</div>
      <div class="water-card-reading">${fmt(c.curr, 1)}</div>
      <div class="water-card-unit">cumulative reading</div>
      <div class="water-card-delta">${c.cons > 0 ? `+${fmt(c.cons, 1)} that month` : 'no change that month'}</div>
    </div>`);

  grid.innerHTML = cards.join('');
}

// ═══════════════════════════════════════════════════════
//  MONTHLY TAB
// ═══════════════════════════════════════════════════════
function getSortedMonths() {
  return Object.keys(monthlyCache).sort((a, b) => {
    const p = s => { const [mn, yr] = s.split(', '); return new Date(`${mn} 1, ${yr}`); };
    return p(b) - p(a);
  });
}

async function loadAllMonthly() {
  const now     = new Date();
  const allKeys = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    allKeys.push(`${MONTH_NAMES[d.getMonth()]}, ${d.getFullYear()}`);
  }

  const toLoad = allKeys.filter(k => !monthlyCache[k]);
  if (toLoad.length === 0) {
    // Already cached (e.g. tab switch after first load)
    renderMonthSelector();
    renderTrendChart();
    renderWaterTrendChart();
    return;
  }

  showMonthlyState('loading');

  // Phase 1: 3 most recent months — render as soon as they arrive
  const urgent   = toLoad.slice(0, 3);
  const deferred = toLoad.slice(3);

  const phase1 = await Promise.allSettled(urgent.map(k => loadOneMonth(k)));

  const months = getSortedMonths();
  if (months.length === 0) {
    // All failed — check if DB error or just no data
    const dbDown = phase1.some(r => r.reason?.isDbError);
    showMonthlyState(dbDown ? 'db-error' : 'empty');
    return;
  }

  // Render immediately with what we have
  showMonthlyState('ready');
  renderMonthSelector();
  renderMonthlyDetail(selectedMonth);

  const topMis = monthlyCache[months[0]]?.mis ?? monthlyCache[months[0]];
  renderWaterGrid(topMis);
  if (liveData) renderEstimate(liveData);  // update hero with real base readings

  // Phase 2: remaining 9 months in background, 3 at a time
  for (let i = 0; i < deferred.length; i += 3) {
    await Promise.allSettled(deferred.slice(i, i + 3).map(k => loadOneMonth(k)));
    renderTrendChart();
    renderWaterTrendChart();
  }
}

async function loadOneMonth(monthKey) {
  try {
    const json = await safeGet('GetFromMonthlyBill', {
      date: monthKey, command: 'select', custid: FLAT
    });
    if (json.success === false) {
      const e = new Error(json.msg || 'DB error');
      e.isDbError = true;
      throw e;
    }
    if (json.bills?.length > 0) {
      monthlyCache[monthKey] = json.bills[0];
      renderMonthSelector(); // progressive chip update
    }
  } catch (e) {
    console.warn(`loadOneMonth(${monthKey}):`, e.message);
    throw e;
  }
}

function showMonthlyState(state) {
  const loading = $('monthly-loading');
  const content = $('monthly-content');
  if (state === 'ready') {
    loading.style.display = 'none';
    content.style.display = 'block';
  } else if (state === 'loading') {
    loading.style.display = 'flex';
    loading.innerHTML = '<div class="spinner"></div><span>Fetching monthly data…</span>';
    content.style.display = 'none';
  } else if (state === 'db-error') {
    loading.style.display = 'flex';
    loading.innerHTML = `
      <div style="text-align:center;padding:16px">
        <div style="font-size:2rem;margin-bottom:8px">⚠️</div>
        <div style="color:var(--accent-red);font-weight:600;margin-bottom:4px">Billing server unavailable</div>
        <div style="color:var(--text-muted);font-size:0.8rem;margin-bottom:12px">The Elmeasure billing DB is temporarily down.<br>Live data still works.</div>
        <button onclick="monthlyCache={};selectedMonth=null;loadAllMonthly()"
                style="background:var(--accent-blue);color:#fff;border:none;border-radius:8px;padding:8px 20px;font-size:0.9rem;cursor:pointer">↻ Retry</button>
      </div>`;
    content.style.display = 'none';
  } else { // 'empty'
    loading.style.display = 'flex';
    loading.innerHTML = '<span style="color:var(--text-muted)">No billing data available</span>';
    content.style.display = 'none';
  }
}

function renderMonthSelector() {
  const months = getSortedMonths();
  if (months.length === 0) return;
  if (!selectedMonth || !months.includes(selectedMonth)) selectedMonth = months[0];

  const sel = $('month-selector');
  sel.innerHTML = months.map(m => `
    <button class="month-chip ${m === selectedMonth ? 'active' : ''}"
            data-month="${escHtml(m)}" role="option"
            aria-selected="${m === selectedMonth}">
      ${escHtml(shortMonth(m))}
    </button>`).join('');

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
  const [mn, yr] = key.split(', ');
  return `${mn.slice(0, 3)} '${yr.slice(2)}`;
}

function renderMonthlyDetail(monthKey) {
  if (!monthKey) return;
  const bill    = monthlyCache[monthKey];
  const loading = $('monthly-loading');
  const content = $('monthly-content');

  if (!bill) {
    loading.style.display = 'flex';
    const span = loading.querySelector('span');
    if (span) span.textContent = `No data for ${monthKey}`;
    content.style.display = 'none';
    return;
  }

  loading.style.display = 'none';
  content.style.display = 'block';

  const mis = bill.mis ?? bill;

  $('monthly-period').textContent = mis.reportingmonth || monthKey;
  $('monthly-dates').textContent  = `${mis.firstreadingdate || ''} → ${mis.lastreadingdate || ''}`;

  // Main view: units + cost only
  $('m-eb-units').textContent = fmt(mis.ebconsumption, 2);
  $('m-eb-cost').textContent  = `₹${fmt(mis.ebtotalamount, 0)}`;
  $('m-dg-units').textContent = fmt(mis.dgconsumption, 3);
  $('m-dg-cost').textContent  = `₹${fmt(mis.dgtotalamount, 2)}`;

  // Collapsible details: exact readings
  $('m-eb-prev').textContent = fmt(mis.ebpreviousreading, 2);
  $('m-eb-curr').textContent = fmt(mis.ebpresentreading, 2);
  $('m-dg-prev').textContent = fmt(mis.dgpreviousreading, 3);
  $('m-dg-curr').textContent = fmt(mis.dgbpresentreading, 3);

  // Water DI meters
  const waterTable = $('monthly-water-table');
  waterTable.querySelectorAll('.bill-row:not(.bill-header-row)').forEach(r => r.remove());
  let totalWaterCost = 0;
  let waterRows = '';
  for (let i = 1; i <= 4; i++) {
    const curr = mis[`di${i}presentreading`];
    if (curr == null) continue;
    const label = (mis[`di${i}text`] || `DI${i}`).toUpperCase();
    const cons  = mis[`di${i}consumption`] ?? 0;
    const cost  = mis[`di${i}totalamount`] ?? 0;
    totalWaterCost += Number(cost);
    waterRows += `
      <div class="bill-row">
        <span class="src-badge di-badge">${escHtml(label)}</span>
        <span>${fmt(cons, 1)}</span>
        <span>₹${fmt(cost, 0)}</span>
      </div>`;
  }
  const headerRow = waterTable.querySelector('.bill-header-row');
  if (headerRow) headerRow.insertAdjacentHTML('afterend', waterRows);

  // Total
  const total = (mis.ebtotalamount || 0) + (mis.dgtotalamount || 0) + totalWaterCost + (mis.fixedcost || 0);
  $('monthly-total-amount').textContent = `₹ ${fmt(total, 0)}`;
}

// ── Trend Charts ─────────────────────────────────────────
function renderTrendChart() {
  const months = getSortedMonths().reverse();
  drawBarChart('trend-chart', months.map(shortMonth), [{
    label: 'EB kWh',
    data:  months.map(m => (monthlyCache[m]?.mis ?? monthlyCache[m])?.ebconsumption ?? 0),
    color: '#facc15'
  }]);
}

function renderWaterTrendChart() {
  const months = getSortedMonths().reverse();
  drawBarChart('water-trend-chart', months.map(shortMonth), [{
    label: 'Water KL',
    data:  months.map(m => {
      const mis = monthlyCache[m]?.mis ?? monthlyCache[m];
      return (mis?.di3consumption ?? 0) + (mis?.di4consumption ?? 0);
    }),
    color: '#38bdf8'
  }]);
}

function drawBarChart(canvasId, labels, datasets) {
  const canvas = $(canvasId);
  if (!canvas) return;

  // If the monthly tab is hidden, clientWidth=0 — measure window width instead
  const parentW = canvas.parentElement.clientWidth;
  const W = (parentW > 20 ? parentW : window.innerWidth) - 24;
  const H = 170;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  const PAD_L = 44, PAD_B = 36, PAD_T = 10, PAD_R = 10;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, W, H);

  if (labels.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', W / 2, H / 2);
    return;
  }

  const allVals = datasets.flatMap(d => d.data);
  const maxVal  = Math.max(...allVals, 1);
  const nBars   = labels.length;
  const groupW  = chartW / nBars;
  const barW    = Math.max(6, groupW * 0.55);
  const radius  = Math.min(4, barW / 2);

  // Grid lines + Y labels
  ctx.strokeStyle = '#2d3f57';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD_T + chartH - (i / 4) * chartH;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + chartW, y); ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round((i / 4) * maxVal), PAD_L - 4, y + 3);
  }

  // Bars
  datasets.forEach(ds => {
    ds.data.forEach((val, i) => {
      const barH = (val / maxVal) * chartH;
      const x    = PAD_L + i * groupW + (groupW - barW) / 2;
      const y    = PAD_T + chartH - barH;
      const grad = ctx.createLinearGradient(x, y, x, y + barH);
      grad.addColorStop(0, ds.color);
      grad.addColorStop(1, ds.color + '55');
      ctx.fillStyle = grad;
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
      if (barH > 20) {
        ctx.fillStyle = ds.color;
        ctx.font = 'bold 9px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(val), x + barW / 2, y - 3);
      }
    });
  });

  // X labels
  ctx.fillStyle = '#64748b';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((lbl, i) => {
    ctx.fillText(lbl, PAD_L + i * groupW + groupW / 2, H - PAD_B + 14);
  });
}

// ═══════════════════════════════════════════════════════
//  RECHARGE TAB
// ═══════════════════════════════════════════════════════
async function loadRecharge() {
  $('recharge-list').innerHTML =
    '<div class="recharge-loading"><div class="spinner"></div><span>Fetching recharge history…</span></div>';

  const today    = new Date();
  const fromDate = new Date(today);
  fromDate.setFullYear(fromDate.getFullYear() - 1);
  const fmtDate  = d =>
    `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;

  try {
    const json = await safeGet('RCHistoryReport', {
      customerid: FLAT, paymode: 'All',
      fromdate: fmtDate(fromDate), todate: fmtDate(today)
    });
    const histories = json.rchistories;
    if (!histories?.length) throw new Error('No data');
    rechargeData = histories[0];
    renderRecharge(rechargeData);
  } catch (e) {
    $('recharge-list').innerHTML =
      '<div class="recharge-loading" style="color:var(--accent-red)">⚠️ Could not load recharge history</div>';
    console.error('loadRecharge:', e);
  }
}

function parseDDMMYYYY(str) {
  if (!str) return 0;
  const [dd, mm, yyyy] = str.split(' ')[0].split('/');
  return new Date(`${yyyy}-${mm}-${dd}`).getTime();
}

function monthsSpanned(rclist) {
  if (!rclist.length) return 1;
  const dates = rclist.map(r => parseDDMMYYYY(r.receiptdate)).filter(Boolean);
  if (!dates.length) return 1;
  const min  = new Date(Math.min(...dates));
  const to   = new Date(); // always measure to today
  return Math.max(1,
    (to.getFullYear() - min.getFullYear()) * 12 + (to.getMonth() - min.getMonth()) + 1
  );
}

function renderRecharge(data) {
  const rclist = data.rclist ?? [];
  const total  = data.total ?? rclist.reduce((s, r) => s + (r.rcamount ?? 0), 0);

  $('rs-total').textContent = `₹${fmtInt(total)}`;
  $('rs-count').textContent = rclist.length;
  $('rs-avg').textContent   = rclist.length ? `₹${fmtInt(total / monthsSpanned(rclist))}` : '—';

  const sorted = [...rclist].sort((a, b) => parseDDMMYYYY(b.receiptdate) - parseDDMMYYYY(a.receiptdate));
  $('recharge-list').innerHTML = sorted.map(r => `
    <div class="recharge-item">
      <div class="recharge-icon">₹</div>
      <div class="recharge-info">
        <div class="recharge-date">${escHtml(r.receiptdate || '—')}</div>
        <div class="recharge-mode">${escHtml(r.paymode || '')} · ${escHtml(r.bankname || '')}</div>
      </div>
      <div class="recharge-amount">₹${fmtInt(r.rcamount)}</div>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════
//  LOCK SCREEN
// ═══════════════════════════════════════════════════════
function showLockScreen(msg) {
  document.body.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
      min-height:100dvh;background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;
      padding:24px;text-align:center;gap:16px">
      <div style="font-size:3rem">🔒</div>
      <div style="font-size:1.1rem;font-weight:600">Access Restricted</div>
      <div style="color:#8b949e;font-size:0.85rem;max-width:280px;line-height:1.5">${msg}</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════
//  AUTO-REFRESH
// ═══════════════════════════════════════════════════════
function scheduleAutoRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadLive();
    scheduleAutoRefresh();
  }, 60_000);
}

// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════
async function init() {
  if (!ACCESS_SECRET) {
    showLockScreen('Open the app via your private bookmarked URL (with #secret).<br><br>Once opened with the secret, the installed app will remember it.');
    return;
  }

  // Sync badge to actual stored flat (HTML default may say B401)
  const badge = $('flat-badge');
  if (badge) badge.textContent = FLAT;
  document.title = `${FLAT} — Meter`;

  initTabs();
  initFlatBadge();

  $refresh.addEventListener('click', () => {
    clearTimeout(refreshTimer);
    loadLive();
    scheduleAutoRefresh();
  });

  // All three start in parallel — none depend on each other
  loadLive();
  loadAllMonthly();
  loadRecharge();

  scheduleAutoRefresh();
}

// ── Service Worker ────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(err =>
    console.warn('SW registration failed:', err)
  );
}

init();
