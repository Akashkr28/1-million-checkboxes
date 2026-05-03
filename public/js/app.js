/**
 * app.js
 *
 * Frontend logic for 1 Million Checkboxes.
 *
 * Key decisions:
 *   - We NEVER render all 1,000,000 checkboxes at once (that would freeze the browser).
 *   - Instead we display one PAGE at a time (PAGE_SIZE checkboxes).
 *   - On page change, we fetch only the relevant bitfield slice from the server.
 *   - WebSocket updates are applied instantly to the visible DOM if the updated
 *     checkbox is on the current page; otherwise the bit is cached in `stateCache`.
 *   - State for the visible page is stored in a Uint8Array bitfield (1 bit per box).
 *
 * DOM strategy:
 *   - Grid cells are pre-allocated per page (createElement once, reuse on page change).
 *   - Only the label content (checked state) changes between pages — no innerHTML wipe.
 *   - This keeps reflow minimal and enables smooth page navigation.
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10_000;   // checkboxes visible at once

// ── State ─────────────────────────────────────────────────────────────────────

let currentPage  = 0;      // 0-indexed
let totalCheckboxes = 1_000_000;
let totalPages = Math.ceil(totalCheckboxes / PAGE_SIZE);
let pageData     = null;   // Uint8Array for the current page's bits
let isLoggedIn   = false;
let userName     = '';
let ws           = null;
let wsReady      = false;
let socketId     = null;
let gridCells    = [];     // pre-built DOM elements for this page
let gridColumns  = 0;      // how many columns currently fit
let reconnectTimer = null;
let toggleCooldownUntil = 0;
let cooldownTimer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const grid          = document.getElementById('checkbox-grid');
const loadingOverlay = document.getElementById('loading-overlay');
const checkedCountEl = document.getElementById('checked-count');
const usersCountEl  = document.getElementById('users-count');
const wsDot         = document.querySelector('.ws-dot');
const progressFill  = document.getElementById('progress-fill');
const authArea      = document.getElementById('auth-area');
const authBanner    = document.getElementById('auth-banner');
const pageInfoEl    = document.getElementById('page-info');
const btnPrev       = document.getElementById('btn-prev');
const btnNext       = document.getElementById('btn-next');
const btnJump       = document.getElementById('btn-jump');
const jumpInput     = document.getElementById('jump-input');
const themeToggle   = document.getElementById('theme-toggle');
const themeIcon     = document.querySelector('.theme-icon');
const cooldownPill  = document.getElementById('cooldown-pill');
const activityList  = document.getElementById('activity-list');

// ── Theme ────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);

  if (themeToggle && themeIcon) {
    const isDark = theme === 'dark';
    themeIcon.textContent = isDark ? '☀' : '☾';
    themeToggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  }
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

themeToggle?.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ── Bit helpers ───────────────────────────────────────────────────────────────

/** Read bit at `index` from a Uint8Array */
function getBit(arr, index) {
  const byte = arr[index >> 3];
  return (byte >> (7 - (index & 7))) & 1;
}

/** Set/clear bit at `index` in a Uint8Array */
function setBit(arr, index, value) {
  const byteIdx = index >> 3;
  const bitPos  = 7 - (index & 7);
  if (value) {
    arr[byteIdx] |=  (1 << bitPos);
  } else {
    arr[byteIdx] &= ~(1 << bitPos);
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast${type ? ' toast-' + type : ''}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function cooldownSecondsLeft() {
  return Math.max(0, Math.ceil((toggleCooldownUntil - Date.now()) / 1000));
}

function updateCooldownPill() {
  if (!cooldownPill) return;
  const left = cooldownSecondsLeft();
  cooldownPill.classList.toggle('cooling', left > 0);
  cooldownPill.textContent = left > 0 ? `Next toggle in ${left}s` : 'Ready to toggle';

  if (left === 0 && cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

function startCooldown(retryAfterMs = 5000) {
  toggleCooldownUntil = Date.now() + retryAfterMs;
  updateCooldownPill();
  if (!cooldownTimer) {
    cooldownTimer = setInterval(updateCooldownPill, 250);
  }
}

function addActivity({ index, state, toggledBy, socketId: eventSocketId, at }) {
  if (!activityList) return;
  const checkboxNumber = Number(index);
  if (!Number.isInteger(checkboxNumber) || checkboxNumber < 0) return;

  const empty = activityList.querySelector('.activity-empty');
  if (empty) empty.remove();

  const item = document.createElement('li');
  item.className = 'activity-item';
  const actor = eventSocketId === socketId ? 'You' : (toggledBy || 'Someone');
  const action = Number(state) === 1 ? 'checked' : 'unchecked';
  const time = new Date(at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  item.innerHTML = `
    <span class="activity-dot ${Number(state) === 1 ? 'checked' : 'unchecked'}"></span>
    <span class="activity-copy">
      <strong>${escapeHtml(actor)}</strong> ${action} <code>#${(checkboxNumber + 1).toLocaleString()}</code>
      <small>${time}</small>
    </span>
  `;

  activityList.prepend(item);
  while (activityList.children.length > 12) {
    activityList.lastElementChild.remove();
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function loadUser() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    isLoggedIn = data.loggedIn;
    userName   = data.name || '';

    if (isLoggedIn) {
      authArea.innerHTML = `
        <span class="user-chip"><strong title="${escapeHtml(data.email)}">${escapeHtml(userName)}</strong></span>
        <a href="/auth/logout" class="btn btn-ghost btn-danger">Logout</a>
      `;
    } else {
      authArea.innerHTML = `<a href="/auth/login" class="btn btn-accent">Login</a>`;
      authBanner.style.display = 'flex';
    }
  } catch {
    authArea.innerHTML = `<a href="/auth/login" class="btn btn-accent">Login</a>`;
  }
}

async function loadSystemInfo() {
  const res = await fetch('/api/checkboxes/info');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  totalCheckboxes = data.total;
  totalPages = Math.ceil(totalCheckboxes / PAGE_SIZE);
  const brandCount = document.querySelector('.brand-count');
  if (brandCount) brandCount.textContent = totalCheckboxes.toLocaleString();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ── Fetch page data from server ───────────────────────────────────────────────

async function fetchPageData(page) {
  const startCheckbox = page * PAGE_SIZE;
  const startByte     = Math.floor(startCheckbox / 8);
  const byteCount     = Math.ceil(PAGE_SIZE / 8);         // 1250 bytes per page

  const res = await fetch(`/api/checkboxes/state?offset=${startByte}&bytes=${byteCount}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const raw  = Uint8Array.from(atob(json.data), c => c.charCodeAt(0));
  return raw; // 1250-byte array, bits 0..PAGE_SIZE-1 are this page's states
}

// ── Grid rendering ────────────────────────────────────────────────────────────

/**
 * Build (or rebuild) the grid DOM for PAGE_SIZE checkboxes.
 * This is called once on load and on window resize (column count change).
 * On page changes we REUSE the cells and only update their checked state.
 */
function buildGrid() {
  // Measure available width to compute columns (for page-info display)
  const cellSize = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--check-size')) + 4;
  gridColumns = Math.floor(grid.clientWidth / cellSize) || 50;

  // Only rebuild DOM if cell count has changed
  if (gridCells.length === PAGE_SIZE) {
    applyPageData();
    return;
  }

  // Build DOM fragment for PAGE_SIZE cells
  const frag = document.createDocumentFragment();
  gridCells = [];

  for (let i = 0; i < PAGE_SIZE; i++) {
    const cell  = document.createElement('div');
    cell.className = 'cb-cell';
    if (!isLoggedIn) cell.classList.add('readonly');

    const input = document.createElement('input');
    input.type  = 'checkbox';
    input.id    = `cb-${i}`;

    const label = document.createElement('label');
    label.htmlFor = `cb-${i}`;
    label.setAttribute('aria-label', `Checkbox ${i}`);

    // Toggle handler
    input.addEventListener('change', (e) => {
      e.preventDefault(); // We manage state manually
      if (!isLoggedIn) {
        toast('Login to toggle checkboxes.', 'warn');
        input.checked = getBit(pageData, i) === 1; // revert
        return;
      }
      const cooldownLeft = cooldownSecondsLeft();
      if (cooldownLeft > 0) {
        toast(`Please wait ${cooldownLeft}s before toggling again.`, 'warn');
        input.checked = getBit(pageData, i) === 1;
        return;
      }
      const globalIndex = currentPage * PAGE_SIZE + i;
      sendToggle(globalIndex);
      input.checked = getBit(pageData, i) === 1;
    });

    cell.appendChild(input);
    cell.appendChild(label);
    frag.appendChild(cell);
    gridCells.push({ cell, input });
  }

  grid.innerHTML = '';
  grid.appendChild(frag);
}

/** Apply `pageData` bit states to existing grid cells. O(PAGE_SIZE). */
function applyPageData() {
  if (!pageData || gridCells.length === 0) return;

  for (let i = 0; i < PAGE_SIZE; i++) {
    const checked = getBit(pageData, i) === 1;
    gridCells[i].input.checked = checked;
    // Update readonly class based on login state
    if (isLoggedIn) {
      gridCells[i].cell.classList.remove('readonly');
    } else {
      gridCells[i].cell.classList.add('readonly');
    }
  }
}

function updatePageInfo() {
  const start = currentPage * PAGE_SIZE + 1;
  const end   = Math.min((currentPage + 1) * PAGE_SIZE, totalCheckboxes);
  pageInfoEl.textContent = `#${start.toLocaleString()} - #${end.toLocaleString()} · Page ${currentPage + 1} / ${totalPages}`;
  btnPrev.disabled = currentPage === 0;
  btnNext.disabled = currentPage === totalPages - 1;
}

// ── Navigation ─────────────────────────────────────────────────────────────────

async function goToPage(page) {
  page = Math.max(0, Math.min(totalPages - 1, page));
  if (page === currentPage && pageData) return;

  showLoading(true);
  currentPage = page;
  updatePageInfo();

  try {
    pageData = await fetchPageData(page);
    applyPageData();
  } catch (err) {
    toast('Failed to load page. Retrying…', 'error');
    console.error(err);
  } finally {
    showLoading(false);
  }
}

function showLoading(show) {
  loadingOverlay.classList.toggle('hidden', !show);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  setWSDot('connecting');

  ws.addEventListener('open', () => {
    wsReady = true;
    setWSDot('connected');
    clearTimeout(reconnectTimer);
  });

  ws.addEventListener('message', (e) => {
    try {
      handleWSMessage(JSON.parse(e.data));
    } catch {}
  });

  ws.addEventListener('close', () => {
    wsReady = false;
    setWSDot('disconnected');
    // Exponential backoff reconnect
    reconnectTimer = setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

function setWSDot(state) {
  wsDot.className = `ws-dot ${state}`;
  wsDot.parentElement.title = `WebSocket: ${state}`;
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      // Server confirmed connection
      socketId = msg.socketId || socketId;
      if (msg.total && msg.total !== totalCheckboxes) {
        totalCheckboxes = msg.total;
        totalPages = Math.ceil(totalCheckboxes / PAGE_SIZE);
        updatePageInfo();
      }
      break;

    case 'update': {
      // A checkbox was toggled by someone (maybe us, maybe another user)
      const { index, state } = msg;
      const page     = Math.floor(index / PAGE_SIZE);
      const localIdx = index % PAGE_SIZE;

      if (page === currentPage && pageData) {
        setBit(pageData, localIdx, state);
        const cell  = gridCells[localIdx];
        if (cell) {
          cell.input.checked = state === 1;
          // Brief flash animation
          cell.cell.classList.add('flash');
          setTimeout(() => cell.cell.classList.remove('flash'), 300);
        }
      }
      addActivity(msg);
      break;
    }

    case 'stats':
      if (msg.checkedCount !== undefined) {
        const checkedCount = Number(msg.checkedCount);
        checkedCountEl.textContent = checkedCount.toLocaleString();
        if (progressFill) {
          const pct = Math.min(100, (checkedCount / totalCheckboxes) * 100);
          progressFill.style.width = `${pct}%`;
        }
      }
      if (msg.connected !== undefined) {
        usersCountEl.textContent = msg.connected;
      }
      break;

    case 'error':
      toast(msg.message, 'error');
      break;

    case 'rate_limited':
      startCooldown(msg.retryAfterMs || 5000);
      toast(msg.message || 'Please wait before toggling again.', 'warn');
      break;

    case 'cooldown':
      startCooldown(msg.retryAfterMs || 5000);
      break;

    case 'pong':
      break;
  }
}

function sendToggle(globalIndex) {
  if (!wsReady || !ws || ws.readyState !== WebSocket.OPEN) {
    toast('Not connected. Reconnecting…', 'warn');
    return;
  }
  ws.send(JSON.stringify({ type: 'toggle', index: globalIndex }));
}

// ── Keepalive ping ────────────────────────────────────────────────────────────

setInterval(() => {
  if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 25_000);

// ── Event listeners ───────────────────────────────────────────────────────────

btnPrev.addEventListener('click', () => goToPage(currentPage - 1));
btnNext.addEventListener('click', () => goToPage(currentPage + 1));

// Keyboard navigation
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft'  || e.key === 'PageUp')   goToPage(currentPage - 1);
  if (e.key === 'ArrowRight' || e.key === 'PageDown')  goToPage(currentPage + 1);
  if (e.key === 'Home') goToPage(0);
  if (e.key === 'End')  goToPage(totalPages - 1);
});

// Jump to index
btnJump.addEventListener('click', () => {
  jumpInput.style.display = jumpInput.style.display === 'none' ? 'inline-block' : 'none';
  if (jumpInput.style.display !== 'none') jumpInput.focus();
});

jumpInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const idx = Math.max(1, Math.min(totalCheckboxes, parseInt(jumpInput.value, 10) || 1));
    goToPage(Math.floor((idx - 1) / PAGE_SIZE));
    jumpInput.style.display = 'none';
    jumpInput.value = '';
  }
  if (e.key === 'Escape') {
    jumpInput.style.display = 'none';
    jumpInput.value = '';
  }
});

// Resize → rebuild grid to fit new column count
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    gridCells = []; // force rebuild
    buildGrid();
  }, 250);
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  initTheme();
  updateCooldownPill();
  await loadSystemInfo();
  await loadUser();
  buildGrid();
  await goToPage(0);
  connectWS();
  updatePageInfo();
}

init();
