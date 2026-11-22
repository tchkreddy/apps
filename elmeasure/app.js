/**
 * B401 Meter PWA — app.js  v2.4
 * Native ES6 module. No build step.
 *
 * SAFE API CONTRACT:
 *   ✅ GetOnlineData              — read-only live snapshot
 *   ✅ GetFromMonthlyBill (select) — read-only historical bills
 *   ✅ RCHistoryReport            — read-only recharge history
 *   ✅ GetDailyMonthlyTrend       — read-only daily trend
 *   ✅ GetCustomerDetail          — read-only customer info
 *   ❌ MeterStatus                — NEVER CALLED (toggles meter power)
 *   ❌ command:"update"           — NEVER called
 */

// ═══════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════
const PROXY_URL          = 'https://script.google.com/macros/s/AKfycbzMkvnwPWKb4cttij712tL1vNiio2L9bue9S2nQZeA23HVsgZsxsn4R43ayMKzLf9gl/exec';
const LS_KEY             = 'em_secret';
const LS_FLAT            = 'em_flat';
const EB_TARIFF_FALLBACK = 8.45;
const DG_TARIFF_FALLBACK = 32.0;
const MONTH_NAMES        = ['January','February','March','April','May','June',
                            'July','August','September','October','November','December'];
const MON_SHORT          = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MON_FULL           = ['January','February','March','April','May','June',
                            'July','August','September','October','November','December'];

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

// ═══════════════════════════════════════════════════════
//  MUTABLE STATE  (all cleared by resetAll() on flat change)
// ═══════════════════════════════════════════════════════
let liveData          = null;   // GetOnlineData response object
let monthlyCache      = {};     // { "Month, YYYY": billObj }
let rechargeData      = null;   // RCHistoryReport response
let selectedMonth     = null;   // currently displayed month key
let meterid           = null;   // numeric device ID — set by loadAllMonthly Phase 0
let dailyCache        = {};     // { "Nov-2026": [{label,value},...] }
let selectedDailyMonth = null;  // currently displayed daily month key
let refreshTimer      = null;   // setTimeout handle

// meteridReady: plain deferred — resolved once meterid is known
// Replace each time on flat change so old awaiters don't interfere
let meteridReady = makeDeferred();

// HTML snapshots taken at DOMContentLoaded — restored by resetAll()
let _snapshots = null;

// ═══════════════════════════════════════════════════════
//  DOM SHORTCUTS
// ═══════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════
function makeDeferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

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
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

/** getMis(key) — returns the mis sub-object or the bill itself */
function getMis(key) {
  const b = monthlyCache[key];
  return b ? (b.mis ?? b) : null;
}

/** Returns months in monthlyCache sorted newest → oldest */
function getSortedMonths() {
  return Object.keys(monthlyCache).sort((a, b) => {
    const p = s => { const [mn, yr] = s.split(', '); return new Date(`${mn} 1, ${yr}`); };
    return p(b) - p(a);
  });
}

/** "September, 2026" → "Sep '26" */
function shortMonth(key) {
  const [mn, yr] = key.split(', ');
  return `${mn.slice(0, 3)} '${yr.slice(2)}`;
}

/** Current month as "Nov-2026" */
function dailyKeyNow() {
  const d = new Date();
  return `${MON_SHORT[d.getMonth()]}-${d.getFullYear()}`;
}

/** "Nov-2026" → "November 2026" */
function dailyKeyToDisplay(key) {
  const [mon, yr] = key.split('-');
  const idx = MON_SHORT.indexOf(mon);
  return idx >= 0 ? `${MON_FULL[idx]} ${yr}` : key;
}

/** Last n months as "Mon-YYYY" keys, newest first */
function getDailyMonthKeys(n = 12) {
  const keys = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${MON_SHORT[d.getMonth()]}-${d.getFullYear()}`);
  }
  return keys;
}

/** Strips title prefix, sets header subtitle */
function setOwnerName(name) {
  const sub = $('header-subtitle');
  if (!sub || sub.dataset.ownerSet) return;
  const short = name.replace(/^(Mr\.|Mrs\.|Ms\.|Dr\.)\s*/i, '');
  sub.textContent    = `Galaxy Apartments · ${short}`;
  sub.dataset.ownerSet = '1';
}

function showEl(id) { const el = $(id); if (el) el.style.display = ''; }
function hideEl(id) { const el = $(id); if (el) el.style.display = 'none'; }

// ═══════════════════════════════════════════════════════
//  SAFE API CALL
// ═══════════════════════════════════════════════════════
async function safeGet(taskid, params) {
  const ALLOWED = ['GetOnlineData', 'GetFromMonthlyBill', 'RCHistoryReport',
                   'GetDailyMonthlyTrend', 'GetCustomerDetail'];
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
//  RESET  — restores DOM snapshots, resets all JS state
// ═══════════════════════════════════════════════════════
function resetAll() {
  // JS state
  liveData          = null;
  monthlyCache      = {};
  rechargeData      = null;
  selectedMonth     = null;
  meterid           = null;
  dailyCache        = {};
  selectedDailyMonth = null;
  clearTimeout(refreshTimer);
  meteridReady = makeDeferred(); // new deferred for new flat's meterid

  // Restore DOM snapshots
  if (_snapshots) {
    ['tab-live', 'tab-monthly', 'tab-daily', 'tab-recharge'].forEach(id => {
      const el = $(id);
      if (el && _snapshots[id] != null) el.innerHTML = _snapshots[id];
    });
    const sub = $('header-subtitle');
    if (sub) {
      sub.textContent = _snapshots['header-subtitle'] || 'Galaxy Apartments';
      delete sub.dataset.ownerSet;
    }
    // Status bar
    const dot = $('live-status-dot');
    const txt = $('live-status-text');
    const ts  = $('live-timestamp');
    if (dot) dot.className = 'status-dot';
    if (txt) txt.textContent = 'Fetching…';
    if (ts)  ts.textContent = '';
  }
}

// ═══════════════════════════════════════════════════════
//  FLAT BADGE — tappable, inline edit (merged into one fn)
// ═══════════════════════════════════════════════════════
function initFlatBadge() {
  const badge = $('flat-badge');
  if (!badge) return;
  badge.style.cursor = 'pointer';
  badge.title = 'Tap to change flat';

  badge.addEventListener('click', function onBadgeClick() {
    const badge = $('flat-badge');
    if (!badge) return;

    const input = document.createElement('input');
    input.id          = 'flat-input';
    input.className   = 'flat-badge-input';
    input.value       = FLAT;
    input.maxLength   = 10;
    input.setAttribute('autocapitalize', 'characters');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocomplete', 'off');

    badge.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;

    function restoreBadge(text) {
      const el = $('flat-input') || $('flat-badge');
      if (!el) return;
      const span = document.createElement('span');
      span.id          = 'flat-badge';
      span.className   = 'flat-badge';
      span.textContent = text;
      el.replaceWith(span);
      initFlatBadge();
    }

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
        startAll();
      } else {
        restoreBadge(FLAT);
      }
    }

    function cancel() {
      if (committed) return;
      committed = true;
      restoreBadge(FLAT);
    }

    input.addEventListener('input', () => {
      const pos = input.selectionStart;
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      try { input.setSelectionRange(pos, pos); } catch (_) {}
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', () => setTimeout(cancel, 120));
  }, { once: true });
}

// ═══════════════════════════════════════════════════════
//  TAB NAV
// ═══════════════════════════════════════════════════════
function initTabs() {
  const tabLoaders = {
    monthly: () => {
      if (Object.keys(monthlyCache).length === 0) {
        loadAllMonthly();
      } else {
        // Redraw charts now that tab is visible (may have drawn at width=0)
        renderTrendChart();
        renderWaterTrendChart();
      }
    },
    daily: () => {
      renderDailyMonthSelector();
      if (selectedDailyMonth) {
        if (dailyCache[selectedDailyMonth]) {
          renderDailyDetail(selectedDailyMonth);
        } else {
          loadDailyMonth(selectedDailyMonth);
        }
      }
    },
    recharge: () => {
      if (!rechargeData) loadRecharge();
    },
  };

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
      tabLoaders[target]?.();
    });
  });
}

// ═══════════════════════════════════════════════════════
//  START ALL — fires on init and on flat change
// ═══════════════════════════════════════════════════════
function startAll() {
  // These three run in parallel — no interdependencies
  loadLive();
  loadAllMonthly(); // Phase 0 inside here resolves meteridReady
  loadRecharge();

  // After meterid is known, load customer detail + daily
  meteridReady.promise.then(() => {
    loadCustomerDetail();
    if (selectedDailyMonth) loadDailyMonth(selectedDailyMonth);
  });

  scheduleAutoRefresh();
}

// ═══════════════════════════════════════════════════════
//  LIVE TAB
// ═══════════════════════════════════════════════════════
async function loadLive() {
  const dot = $('live-status-dot');
  const txt = $('live-status-text');
  const refreshBtn = $('refresh-btn');
  if (dot) dot.className = 'status-dot loading';
  if (txt) txt.textContent = 'Fetching…';
  if (refreshBtn) refreshBtn.classList.add('spinning');

  try {
    const json = await safeGet('GetOnlineData', { arguments: [{ custid: FLAT }] });
    liveData = json.onlinedata?.[0];
    if (!liveData) throw new Error('Empty response');

    renderLive(liveData);
    if (dot) dot.className = 'status-dot ok';
    if (txt) txt.textContent = 'Live';
    const ts = $('live-timestamp');
    if (ts) ts.textContent = fmtTime();
  } catch (e) {
    if (e.isUnauthorized) {
      localStorage.removeItem(LS_KEY);
      showLockScreen('Wrong access secret. Re-open via your private bookmarked URL.');
      return;
    }
    if (dot) dot.className = 'status-dot err';
    if (txt) txt.textContent = 'Error — tap ↻';
    console.error('loadLive:', e);
    showToast('⚠️ Could not fetch live data');
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

function renderLive(d) {
  // Balance strip
  const balEl = $('live-balance');
  const wEl   = $('live-wattage');
  const etEl  = $('live-energy-type');
  if (balEl) balEl.textContent = fmtInt(d.pmb);
  if (wEl)   wEl.textContent   = fmt(d.w, 1);
  if (etEl)  etEl.textContent  = d.energytype === 2 ? 'W · DG' : 'W · EB';

  // Live power cost rate
  const months = getSortedMonths();
  const ebTariffNow = months.length
    ? (getMis(months[0])?.ebtariff || EB_TARIFF_FALLBACK)
    : EB_TARIFF_FALLBACK;
  const watt   = Number(d.w) || 0;
  const costHr = (watt / 1000) * ebTariffNow;
  const costDay = costHr * 24;
  const powerCostEl = $('live-power-cost');
  if (powerCostEl) {
    powerCostEl.textContent = watt > 0
      ? `₹${fmt(costHr, 2)}/hr · ₹${fmt(costDay, 0)}/day`
      : '';
  }

  // Details collapsible
  const ebEl  = $('live-eb');
  const dgEl  = $('live-dg');
  const ampEl = $('live-current');
  if (ebEl)  ebEl.textContent  = fmt(d.ebwh, 2);
  if (dgEl)  dgEl.textContent  = fmt(d.dgwh, 3);
  if (ampEl) ampEl.textContent = fmt(d.a, 3);

  // Hero estimate + predictions (use shared calc)
  renderEstimate(d);
  renderPredictions(d);
}

// ── Shared calc — eliminates the duplication between renderEstimate & renderPredictions ──
function calcCurrentMonth(live, mis) {
  const ebStart   = mis?.ebpresentreading  ?? 0;
  const dgStart   = mis?.dgbpresentreading ?? 0;
  const ebTariff  = mis?.ebtariff  || EB_TARIFF_FALLBACK;
  const dgTariff  = mis?.dgtariff  || DG_TARIFF_FALLBACK;
  const ebUsed    = Math.max(0, (live?.ebwh ?? 0) - ebStart);
  const dgUsed    = Math.max(0, (live?.dgwh ?? 0) - dgStart);
  const ebCost    = ebUsed * ebTariff;
  const dgCost    = dgUsed * dgTariff;
  const actual    = ebCost + dgCost;
  const now       = new Date();
  const dayOfMonth  = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projected   = dayOfMonth > 0 ? (actual / dayOfMonth) * daysInMonth : actual;
  return { ebUsed, dgUsed, ebCost, dgCost, actual, projected, dayOfMonth, daysInMonth, ebTariff, dgTariff };
}

function renderEstimate(live) {
  const months = getSortedMonths();
  const noteEl = $('estimate-note');
  if (months.length === 0) {
    if (noteEl) { noteEl.textContent = 'Loading billing data for estimate…'; noteEl.classList.add('visible'); }
    return;
  }

  const mis = getMis(months[0]);
  const { ebUsed, dgUsed, ebCost, dgCost, actual, projected, dayOfMonth, daysInMonth, ebTariff, dgTariff }
    = calcCurrentMonth(live, mis);

  const totEl  = $('est-total');
  const projEl = $('est-projected');
  const ebCEl  = $('est-eb-cost');
  const dgCEl  = $('est-dg-cost');
  const ebUEl  = $('est-eb-usage');
  const dgUEl  = $('est-dg-usage');
  if (totEl)  totEl.textContent  = fmt(actual, 0);
  if (projEl) projEl.textContent = fmt(projected, 0);
  if (ebCEl)  ebCEl.textContent  = fmt(ebCost, 0);
  if (dgCEl)  dgCEl.textContent  = fmt(dgCost, 0);
  if (ebUEl)  ebUEl.textContent  = fmt(ebUsed, 2);
  if (dgUEl)  dgUEl.textContent  = fmt(dgUsed, 3);

  if (noteEl) {
    noteEl.textContent = `EB ₹${ebTariff}/kWh · DG ₹${dgTariff}/kWh · day ${dayOfMonth}/${daysInMonth}`;
    noteEl.classList.add('visible');
  }

  // ↑/↓ vs last billed month
  const vsEl = $('estimate-vs');
  if (vsEl) {
    const lastTotal = Number(mis?.grandtotal || mis?.ebtotalamount || 0) +
                      Number(mis?.dgtotalamount || 0);
    const delta = projected - lastTotal;
    const absDelta = Math.abs(Math.round(delta));
    if (lastTotal > 0) {
      if (delta > 50) {
        vsEl.textContent = `↑ ₹${absDelta} up from last month`;
        vsEl.className   = 'estimate-vs est-vs-up';
      } else if (delta < -50) {
        vsEl.textContent = `↓ ₹${absDelta} down from last month`;
        vsEl.className   = 'estimate-vs est-vs-down';
      } else {
        vsEl.textContent = `≈ Same as last month`;
        vsEl.className   = 'estimate-vs est-vs-same';
      }
    } else {
      vsEl.textContent = '';
      vsEl.className   = 'estimate-vs';
    }
  }
}

function renderPredictions(live) {
  const pc = $('prediction-cards');
  if (!pc) return;

  const months  = getSortedMonths();
  const hasLive = live && live.pmb != null;
  const balance = hasLive ? Number(live.pmb) : 0;

  if (months.length === 0) {
    pc.innerHTML = '<div class="pred-loading">Need billing data for predictions…</div>';
    return;
  }

  // 3-month average daily rate
  const recent = months.slice(0, Math.min(3, months.length));
  const totalBill = recent.reduce((s, m) => {
    const mis = getMis(m);
    return s + Number(mis?.grandtotal || mis?.ebtotalamount || 0) + Number(mis?.dgtotalamount || 0);
  }, 0);
  const avgMonthlyBill = totalBill / recent.length;
  const dailyRate      = avgMonthlyBill / 30;

  // Last billed month
  const lastMis       = getMis(months[0]);
  const lastMonthTotal = Number(lastMis?.grandtotal || lastMis?.ebtotalamount || 0) +
                         Number(lastMis?.dgtotalamount || 0);
  const lastMonthName  = months[0].split(', ')[0].slice(0, 3);

  const now           = new Date();
  const endNextMonth  = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  const daysToEndNext = Math.ceil((endNextMonth - now) / 86400000);
  const neededRaw      = dailyRate * daysToEndNext - balance;
  const rechargeNeeded = neededRaw > 0 ? Math.ceil(neededRaw / 500) * 500 : 0;

  const daysLeft   = (hasLive && dailyRate > 0) ? Math.floor(balance / dailyRate) : null;
  const runoutDate = daysLeft != null ? new Date(Date.now() + daysLeft * 86400000) : null;

  const rechargeCardHtml = hasLive ? `
    <div class="pred-card ${rechargeNeeded === 0 ? 'pred-ok' : 'pred-warn'}">
      <div class="pred-label">Recharge</div>
      <div class="pred-value">${rechargeNeeded === 0 ? 'Not needed ✅' : '₹' + fmtInt(rechargeNeeded)}</div>
      <div class="pred-sub">to cover till ${endNextMonth.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>
    </div>` : `
    <div class="pred-card">
      <div class="pred-label">Recharge</div>
      <div class="pred-value">—</div>
      <div class="pred-sub">Waiting for live balance…</div>
    </div>`;

  pc.innerHTML = `
    <div class="pred-card">
      <div class="pred-label">Spending</div>
      <div class="pred-value">₹${fmtInt(avgMonthlyBill)}<span class="pred-value-unit">/mo avg</span></div>
      <div class="pred-sub">Last ${lastMonthName} ₹${fmtInt(lastMonthTotal)}</div>
    </div>${rechargeCardHtml}`;

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
  if (!grid) return;
  if (!mis) {
    grid.innerHTML = '<div class="water-loading">No monthly data</div>';
    return;
  }

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

  grid.innerHTML = channels.map(c => `
    <div class="water-card">
      <div class="water-card-label">💧 D${c.i}</div>
      <div class="water-card-reading">${fmt(c.curr, 1)}</div>
      <div class="water-card-unit">cumulative reading</div>
      <div class="water-card-delta">${c.cons > 0 ? `+${fmtInt(c.cons * 10)} L that month` : 'no change that month'}</div>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════
//  MONTHLY TAB
//  Phase 0: first bill with deviceid → meterid, meteridReady.resolve()
//  Phase 1: 3 urgent months → render immediately
//  Phase 2: remaining 9 months in background
// ═══════════════════════════════════════════════════════
async function loadAllMonthly() {
  const now = new Date();
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
    renderPredictions(liveData);
    if (liveData) renderEstimate(liveData);
    return;
  }

  showMonthlyLoading();

  // Phase 0: sequential scan of up to 3 recent months to find meterid
  // This is folded into loadAllMonthly — no separate loadBootstrap needed.
  // The first successful bill that has a deviceid resolves meteridReady.
  if (!meterid) {
    for (let i = 0; i < Math.min(3, toLoad.length); i++) {
      const key = toLoad[i];
      try {
        const json = await safeGet('GetFromMonthlyBill', {
          date: key, command: 'select', custid: FLAT
        });
        if (json.success === false) {
          const e = new Error(json.msg || 'DB error');
          e.isDbError = true;
          throw e;
        }
        if (json.bills?.length > 0) {
          monthlyCache[key] = json.bills[0];
          // Extract meterid from first bill that has one
          if (!meterid && json.bills[0].deviceid) {
            meterid = json.bills[0].deviceid;
            if (!selectedDailyMonth) {
              selectedDailyMonth = dailyKeyNow();
              renderDailyMonthSelector();
            }
            meteridReady.resolve(meterid);
          }
          // Extract owner name from bill (fast path)
          if (json.bills[0].custname) setOwnerName(json.bills[0].custname);
        }
      } catch (e) {
        console.warn(`loadAllMonthly Phase0(${key}):`, e.message);
        if (e.isDbError) {
          showMonthlyDbError();
          // Resolve meteridReady as null so dependents don't hang
          meteridReady.resolve(null);
          return;
        }
      }
      // If we found meterid, stop the sequential Phase 0 scan
      if (meterid) break;
    }
    // If still no meterid after scanning, resolve as null so app doesn't hang
    if (!meterid) {
      console.warn('loadAllMonthly: no bill with deviceid found in first 3 months');
      meteridReady.resolve(null);
    }
  }

  // Phase 1: load remaining urgent months (the ones not yet in cache)
  const urgent   = toLoad.filter(k => !monthlyCache[k]).slice(0, 3);
  const deferred = toLoad.filter(k => !monthlyCache[k]).slice(3);

  await Promise.allSettled(urgent.map(k => loadOneMonth(k)));

  const months = getSortedMonths();
  if (months.length === 0) {
    showMonthlyEmpty();
    return;
  }

  // Render immediately with what we have
  showMonthlyReady();
  renderMonthSelector();
  renderMonthlyDetail(selectedMonth);
  renderWaterGrid(getMis(months[0]));
  renderPredictions(liveData);
  if (liveData) renderEstimate(liveData);

  // Phase 2: remaining 9 months in background, 3 at a time
  for (let i = 0; i < deferred.length; i += 3) {
    await Promise.allSettled(deferred.slice(i, i + 3).map(k => loadOneMonth(k)));
    renderTrendChart();
    renderWaterTrendChart();
    renderPredictions(liveData);
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

function showMonthlyLoading() {
  const loading = $('monthly-loading');
  const content = $('monthly-content');
  if (loading) {
    loading.style.display = 'flex';
    loading.innerHTML = '<div class="spinner"></div><span>Fetching monthly data…</span>';
  }
  if (content) content.style.display = 'none';
}

function showMonthlyReady() {
  const loading = $('monthly-loading');
  const content = $('monthly-content');
  if (loading) loading.style.display = 'none';
  if (content) content.style.display = 'block';
}

function showMonthlyDbError() {
  const loading = $('monthly-loading');
  const content = $('monthly-content');
  if (loading) {
    loading.style.display = 'flex';
    loading.innerHTML = `
      <div style="text-align:center;padding:16px">
        <div style="font-size:2rem;margin-bottom:8px">⚠️</div>
        <div style="color:var(--accent-red);font-weight:600;margin-bottom:4px">Billing server unavailable</div>
        <div style="color:var(--text-muted);font-size:0.8rem;margin-bottom:12px">The Elmeasure billing DB is temporarily down.<br>Live data still works.</div>
        <button onclick="monthlyCache={};selectedMonth=null;loadAllMonthly()"
                style="background:var(--accent-blue);color:#fff;border:none;border-radius:8px;padding:8px 20px;font-size:0.9rem;cursor:pointer">↻ Retry</button>
      </div>`;
  }
  if (content) content.style.display = 'none';
}

function showMonthlyEmpty() {
  const loading = $('monthly-loading');
  const content = $('monthly-content');
  if (loading) {
    loading.style.display = 'flex';
    loading.innerHTML = '<span style="color:var(--text-muted)">No billing data available</span>';
  }
  if (content) content.style.display = 'none';
}

function renderMonthSelector() {
  const months = getSortedMonths();
  if (months.length === 0) return;
  if (!selectedMonth || !months.includes(selectedMonth)) selectedMonth = months[0];

  const sel = $('month-selector');
  if (!sel) return;
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

function renderMonthlyDetail(monthKey) {
  if (!monthKey) return;
  const bill    = monthlyCache[monthKey];
  const loading = $('monthly-loading');
  const content = $('monthly-content');

  if (!bill) {
    if (loading) {
      loading.style.display = 'flex';
      const span = loading.querySelector('span');
      if (span) span.textContent = `No data for ${monthKey}`;
    }
    if (content) content.style.display = 'none';
    return;
  }

  if (loading) loading.style.display = 'none';
  if (content) content.style.display = 'block';

  const mis = bill.mis ?? bill;

  const pEl = $('monthly-period');
  const dEl = $('monthly-dates');
  if (pEl) pEl.textContent = mis.reportingmonth || monthKey;
  if (dEl) dEl.textContent = `${mis.firstreadingdate || ''} → ${mis.lastreadingdate || ''}`;

  const ebUEl = $('m-eb-units'); if (ebUEl) ebUEl.textContent = fmt(mis.ebconsumption, 2);
  const ebCEl = $('m-eb-cost');  if (ebCEl) ebCEl.textContent = `₹${fmt(mis.ebtotalamount, 0)}`;
  const dgUEl = $('m-dg-units'); if (dgUEl) dgUEl.textContent = fmt(mis.dgconsumption, 3);
  const dgCEl = $('m-dg-cost');  if (dgCEl) dgCEl.textContent = `₹${fmt(mis.dgtotalamount, 2)}`;
  const ebPEl = $('m-eb-prev');  if (ebPEl) ebPEl.textContent = fmt(mis.ebpreviousreading, 2);
  const ebCREl= $('m-eb-curr');  if (ebCREl) ebCREl.textContent = fmt(mis.ebpresentreading, 2);
  const dgPEl = $('m-dg-prev');  if (dgPEl) dgPEl.textContent = fmt(mis.dgpreviousreading, 3);
  const dgCREl= $('m-dg-curr');  if (dgCREl) dgCREl.textContent = fmt(mis.dgbpresentreading, 3);

  // Water DI meters
  const waterTable = $('monthly-water-table');
  if (waterTable) {
    waterTable.querySelectorAll('.bill-row:not(.bill-header-row)').forEach(r => r.remove());
    let totalWaterCost = 0;
    let waterRows = '';
    for (let i = 1; i <= 4; i++) {
      const curr = mis[`di${i}presentreading`];
      if (curr == null) continue;
      const label = `D${i}`;
      const cons  = mis[`di${i}consumption`] ?? 0;
      const cost  = mis[`di${i}totalamount`] ?? 0;
      totalWaterCost += Number(cost);
      waterRows += `
        <div class="bill-row">
          <span class="src-badge di-badge">${escHtml(label)}</span>
          <span>${fmt(cons, 1)} <span class="water-liters">${fmtInt(cons * 10)} L</span></span>
          <span>₹${fmt(cost, 0)}</span>
        </div>`;
    }
    const headerRow = waterTable.querySelector('.bill-header-row');
    if (headerRow) headerRow.insertAdjacentHTML('afterend', waterRows);
  }

  const total = (mis.ebtotalamount || 0) + (mis.dgtotalamount || 0) + (mis.fixedcost || 0);
  // Recompute totalWaterCost for grand total
  let grandWaterCost = 0;
  for (let i = 1; i <= 4; i++) {
    const cost = mis[`di${i}totalamount`];
    if (cost != null) grandWaterCost += Number(cost);
  }
  const grandTotal = (mis.ebtotalamount || 0) + (mis.dgtotalamount || 0) + grandWaterCost + (mis.fixedcost || 0);
  const totEl = $('monthly-total-amount');
  if (totEl) totEl.textContent = `₹ ${fmt(grandTotal, 0)}`;
}

// ── Trend Charts ──────────────────────────────────────────
function renderTrendChart() {
  const months = getSortedMonths().reverse();
  drawBarChart('trend-chart', months.map(shortMonth), [{
    label: 'EB kWh',
    data:  months.map(m => getMis(m)?.ebconsumption ?? 0),
    color: '#facc15'
  }]);
}

function renderWaterTrendChart() {
  const months = getSortedMonths().reverse();
  drawBarChart('water-trend-chart', months.map(shortMonth), [{
    label: 'Water KL',
    data:  months.map(m => {
      const mis   = getMis(m);
      const units = (mis?.di3consumption ?? 0) + (mis?.di4consumption ?? 0);
      return +(units / 100).toFixed(2); // units → KL  (1 unit = 10L, 1 KL = 1000L → ÷100)
    }),
    color: '#38bdf8'
  }]);
}

function drawBarChart(canvasId, labels, datasets, avgLine = null) {
  const canvas = $(canvasId);
  if (!canvas) return;

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

  // Bars — color can be an array (per-bar) or a string (gradient)
  datasets.forEach(ds => {
    ds.data.forEach((val, i) => {
      const barH = (val / maxVal) * chartH;
      const x    = PAD_L + i * groupW + (groupW - barW) / 2;
      const y    = PAD_T + chartH - barH;

      let fillStyle;
      if (Array.isArray(ds.color)) {
        // Per-bar solid color
        fillStyle = ds.color[i] ?? '#3b82f6';
        ctx.fillStyle = fillStyle;
      } else {
        // Gradient using the string color
        const grad = ctx.createLinearGradient(x, y, x, y + barH);
        grad.addColorStop(0, ds.color);
        grad.addColorStop(1, ds.color + '55');
        fillStyle  = ds.color;
        ctx.fillStyle = grad;
      }

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
        ctx.fillStyle = Array.isArray(ds.color) ? (ds.color[i] ?? '#3b82f6') : ds.color;
        ctx.font = 'bold 9px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(val), x + barW / 2, y - 3);
      }
    });
  });

  // Average dashed line
  if (avgLine != null && avgLine > 0 && avgLine <= maxVal) {
    const avgY = PAD_T + chartH - (avgLine / maxVal) * chartH;
    ctx.save();
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.75)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD_L, avgY);
    ctx.lineTo(PAD_L + chartW, avgY);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 9px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`avg ${avgLine.toFixed(1)}`, PAD_L + chartW - 2, Math.max(PAD_T + 8, avgY - 4));
  }

  // X labels
  ctx.fillStyle = '#64748b';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((lbl, i) => {
    ctx.fillText(lbl, PAD_L + i * groupW + groupW / 2, H - PAD_B + 14);
  });
}

// ═══════════════════════════════════════════════════════
//  DAILY TAB
// ═══════════════════════════════════════════════════════
function renderDailyMonthSelector() {
  const sel = $('daily-month-selector');
  if (!sel) return;
  const keys = getDailyMonthKeys(12);
  if (!selectedDailyMonth || !keys.includes(selectedDailyMonth)) selectedDailyMonth = keys[0];

  sel.innerHTML = keys.map(k => `
    <button class="month-chip ${k === selectedDailyMonth ? 'active' : ''}"
            data-month="${k}" role="option"
            aria-selected="${k === selectedDailyMonth}">${k}</button>
  `).join('');

  sel.querySelectorAll('.month-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedDailyMonth = chip.dataset.month;
      sel.querySelectorAll('.month-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.month === selectedDailyMonth);
        c.setAttribute('aria-selected', c.dataset.month === selectedDailyMonth);
      });
      if (dailyCache[selectedDailyMonth]) {
        renderDailyDetail(selectedDailyMonth);
      } else {
        loadDailyMonth(selectedDailyMonth);
      }
    });
  });
}

async function loadDailyMonth(monthKey) {
  await meteridReady.promise; // wait for meterid (resolved by loadAllMonthly Phase 0)
  if (!meterid) {
    const tbl = $('daily-table');
    if (tbl) tbl.innerHTML = '<div class="daily-loading">Meter ID unavailable — no billing data found.</div>';
    return;
  }
  const tbl = $('daily-table');
  if (tbl) tbl.innerHTML = '<div class="daily-loading"><div class="spinner"></div><span>Loading…</span></div>';

  try {
    const json = await safeGet('GetDailyMonthlyTrend', {
      meterid, monthyear: monthKey, paramId: 'kWh'
    });
    const trend = json.dailymonthlytrend;
    if (!trend?.length) {
      if (tbl) tbl.innerHTML = '<div class="daily-loading">No data for this month</div>';
      return;
    }
    dailyCache[monthKey] = trend;
    renderDailyDetail(monthKey);
  } catch (e) {
    if (tbl) tbl.innerHTML = `<div class="daily-loading">Error: ${e.message}</div>`;
  }
}

function renderDailyDetail(monthKey) {
  const trend = dailyCache[monthKey];
  if (!trend) return;

  const values  = trend.map(r => Number(r.value) || 0);
  const total   = values.reduce((s, v) => s + v, 0);
  const nonZero = values.filter(v => v > 0);
  const avg     = nonZero.length ? total / nonZero.length : 0;

  const months  = getSortedMonths();
  const mis     = months.length ? getMis(months[0]) : null;
  const tariff  = Number(mis?.ebtariff) || EB_TARIFF_FALLBACK;
  const estCost = total * tariff;

  const totEl  = $('daily-total'); if (totEl)  totEl.textContent  = fmt(total, 2);
  const avgEl  = $('daily-avg');   if (avgEl)  avgEl.textContent   = fmt(avg, 2);
  const costEl = $('daily-cost');  if (costEl) costEl.textContent  = fmtInt(estCost);

  // Rank non-zero days: Top 7 highest (red/amber) & Top 5 lowest (green)
  const validDays = trend
    .map(r => ({ label: r.label, val: Number(r.value) || 0 }))
    .filter(d => d.val > 0);
  const byDesc = [...validDays].sort((a, b) => b.val - a.val);
  const top3RedSet   = new Set(byDesc.slice(0, 3).map(d => d.label));
  const next4AmbSet  = new Set(byDesc.slice(3, 7).map(d => d.label));
  const top7HighSet  = new Set([...top3RedSet, ...next4AmbSet]);

  const byAsc = [...validDays].sort((a, b) => a.val - b.val);
  const low5GreenSet = new Set();
  for (const d of byAsc) {
    if (low5GreenSet.size >= 5) break;
    if (!top7HighSet.has(d.label)) low5GreenSet.add(d.label);
  }

  // Bar chart — top 3 red, next 4 amber, lowest 5 green, others blue + average line
  const labels = trend.map(r => r.label);
  const colors = trend.map(r => {
    if (top3RedSet.has(r.label))   return '#ef4444';
    if (next4AmbSet.has(r.label))  return '#f59e0b';
    if (low5GreenSet.has(r.label)) return '#22c55e';
    return '#3b82f6';
  });
  drawBarChart('daily-chart', labels, [{ label: 'kWh', data: values, color: colors }], avg);

  // Day table
  const monthLabel = dailyKeyToDisplay(monthKey).split(' ')[0];
  const [mon, yr]  = monthKey.split('-');
  const monIdx     = MON_SHORT.indexOf(mon);
  const DAYS       = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const rows = [...trend].reverse().map(r => {
    const isRed   = top3RedSet.has(r.label);
    const isAmb   = next4AmbSet.has(r.label);
    const isLow   = low5GreenSet.has(r.label);
    const rowCls  = isRed ? ' daily-high-red' : isAmb ? ' daily-high-amber' : isLow ? ' daily-low-green' : '';
    const badge   = isRed ? '🔴 ' : isAmb ? '🟠 ' : isLow ? '🟢 ' : '';
    const cost    = (Number(r.value) || 0) * tariff;
    const dayName = monIdx >= 0 ? DAYS[new Date(Number(yr), monIdx, Number(r.label)).getDay()] : '';
    return `<div class="daily-row${rowCls}">
      <span class="daily-day">${badge}${monthLabel} ${r.label} <span class="daily-dow">${dayName}</span></span>
      <span class="daily-kwh">${fmt(r.value, 2)} kWh</span>
      <span class="daily-cost-cell">₹${fmtInt(cost)}</span>
    </div>`;
  }).join('');

  const tbl = $('daily-table');
  if (tbl) tbl.innerHTML = rows || '<div class="daily-loading">No data</div>';
}

// ═══════════════════════════════════════════════════════
//  CUSTOMER DETAIL — best-effort owner name refinement
// ═══════════════════════════════════════════════════════
async function loadCustomerDetail() {
  await meteridReady.promise;
  if (!meterid) return;
  try {
    const json = await safeGet('GetCustomerDetail', { meterid });
    const det  = json.customerdetails?.[0];
    if (det?.custname) setOwnerName(det.custname);
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════
//  RECHARGE TAB
// ═══════════════════════════════════════════════════════
async function loadRecharge() {
  const list = $('recharge-list');
  if (list) list.innerHTML = '<div class="recharge-loading"><div class="spinner"></div><span>Fetching recharge history…</span></div>';

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
    if (list) list.innerHTML = '<div class="recharge-loading" style="color:var(--accent-red)">⚠️ Could not load recharge history</div>';
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
  const min = new Date(Math.min(...dates));
  const to  = new Date();
  return Math.max(1,
    (to.getFullYear() - min.getFullYear()) * 12 + (to.getMonth() - min.getMonth()) + 1
  );
}

function renderRecharge(data) {
  const rclist = data.rclist ?? [];
  const total  = data.total ?? rclist.reduce((s, r) => s + (r.rcamount ?? 0), 0);

  const totEl = $('rs-total'); if (totEl) totEl.textContent = `₹${fmtInt(total)}`;
  const cntEl = $('rs-count'); if (cntEl) cntEl.textContent = rclist.length;
  const avgEl = $('rs-avg');   if (avgEl) avgEl.textContent = rclist.length ? `₹${fmtInt(total / monthsSpanned(rclist))}` : '—';

  const sorted = [...rclist].sort((a, b) => parseDDMMYYYY(b.receiptdate) - parseDDMMYYYY(a.receiptdate));
  const list = $('recharge-list');
  if (list) list.innerHTML = sorted.map(r => `
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
//  MYGATE TAB — Persistent Named Window & Session Tracker
// ═══════════════════════════════════════════════════════
const LS_MG_LAST = 'em_mygate_last';

function initMyGateTab() {
  const panel = $('tab-mygate');
  if (!panel) return;

  function updateSessionCard() {
    const raw = localStorage.getItem(LS_MG_LAST);
    const badge = $('mg-session-badge');
    const last  = $('mg-session-last');
    if (raw) {
      try {
        const { label, ts } = JSON.parse(raw);
        if (badge) {
          badge.textContent = '✅ Session Initialized';
          badge.classList.add('mg-badge-ok');
        }
        if (last) {
          const dt = new Date(ts);
          last.textContent = `Last opened: ${label} (${dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${fmtTime(dt)})`;
        }
      } catch (_) {}
    }
  }

  updateSessionCard();

  panel.querySelectorAll('a[target="mygate_portal"]').forEach(link => {
    link.addEventListener('click', () => {
      const label = link.dataset.mgLabel || 'MyGate Portal';
      localStorage.setItem(LS_MG_LAST, JSON.stringify({ label, ts: Date.now() }));
      updateSessionCard();
    });
  });
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
function init() {
  if (!ACCESS_SECRET) {
    showLockScreen('Open the app via your private bookmarked URL (with #secret).<br><br>Once opened with the secret, the installed app will remember it.');
    return;
  }

  // Snapshot tab HTML for clean resets on flat change
  _snapshots = {
    'tab-live':     $('tab-live')?.innerHTML     ?? '',
    'tab-monthly':  $('tab-monthly')?.innerHTML  ?? '',
    'tab-daily':    $('tab-daily')?.innerHTML    ?? '',
    'tab-recharge': $('tab-recharge')?.innerHTML ?? '',
    'header-subtitle': $('header-subtitle')?.textContent ?? 'Galaxy Apartments',
  };

  // Sync badge to actual stored flat
  const badge = $('flat-badge');
  if (badge) badge.textContent = FLAT;
  document.title = `${FLAT} — Meter`;

  initTabs();
  initFlatBadge();
  initMyGateTab();

  const refreshBtn = $('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      clearTimeout(refreshTimer);
      loadLive();
      scheduleAutoRefresh();
    });
  }

  startAll();
}

// ── Service Worker ──────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(err =>
    console.warn('SW registration failed:', err)
  );
}

init();
