'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  devices:       new Map(),   // "Model|id" → device object
  mappings:      {},          // "Model.id.field" → topic
  rtl433Status:  'stopped',
  mqttStatus:    'disconnected',
  frequency:     null,        // currently active frequency, e.g. "433.92M"
  sortBySignal:  false,
  stream:        [],          // capped list of raw entries
};

const MAX_STREAM = 60;

// ── Helpers ────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function deviceKey(dev) {
  return `${dev.model}|${dev.id}`;
}

/** Return field→topic map for a specific device from state.mappings. */
function fieldMappings(dev) {
  const prefix = `${dev.model}.${dev.id}.`;
  const result = {};
  for (const [k, v] of Object.entries(state.mappings)) {
    if (k.startsWith(prefix)) result[k.slice(prefix.length)] = v;
  }
  return result;
}

// ── WebSocket ──────────────────────────────────────────────────────────────
let ws = null;

function wsConnect() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.addEventListener('open', () => {
    setWsBadge('connected');
  });

  ws.addEventListener('message', evt => {
    try { handleMessage(JSON.parse(evt.data)); } catch { /* ignore */ }
  });

  ws.addEventListener('close', () => {
    setWsBadge('disconnected');
    setTimeout(wsConnect, 3000);
  });

  ws.addEventListener('error', () => ws.close());
}

function setWsBadge(state) {
  const el = document.getElementById('status-ws');
  el.textContent = `WS: ${state}`;
  el.className   = `badge ${state}`;
}

// ── Radar animation (rAF-driven, Safari-safe) ────────────────────────────
const radarGroup  = document.getElementById('radar-sweep-group');
let   radarAngle  = 0;
let   radarRafId  = null;
const RADAR_DEG_PER_MS = 360 / 2400; // full rotation in 2.4 s

function radarStep(ts) {
  if (!radarStep._last) radarStep._last = ts;
  radarAngle = (radarAngle + (ts - radarStep._last) * RADAR_DEG_PER_MS) % 360;
  radarStep._last = ts;
  radarGroup.setAttribute('transform', `translate(30,30) rotate(${radarAngle})`);
  radarRafId = requestAnimationFrame(radarStep);
}

function setRadar(rtl433Status) {
  const wrap = document.getElementById('radar-wrap');
  wrap.className = rtl433Status === 'running' ? 'radar-running' : 'radar-stopped';

  if (rtl433Status === 'running') {
    if (!radarRafId) {
      radarStep._last = null;
      radarRafId = requestAnimationFrame(radarStep);
    }
  } else {
    if (radarRafId) {
      cancelAnimationFrame(radarRafId);
      radarRafId = null;
    }
  }
}

// ── Message dispatcher ─────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      state.rtl433Status = msg.status.rtl433;
      state.mqttStatus   = msg.status.mqtt;
      state.frequency    = msg.status.frequency;
      state.mappings     = msg.mappings;
      state.devices.clear();
      for (const dev of msg.devices) state.devices.set(deviceKey(dev), dev);
      renderAll();
      break;

    case 'device_update': {
      const dev = msg.device;
      state.devices.set(deviceKey(dev), dev);
      upsertDeviceCard(dev);
      document.getElementById('device-count').textContent = state.devices.size;
      break;
    }

    case 'devices_full':
      state.devices.clear();
      for (const dev of msg.devices) state.devices.set(deviceKey(dev), dev);
      renderDevices();
      break;

    case 'raw':
      addStreamEntry(msg.data);
      break;

    case 'status_update':
      if (msg.rtl433) {
        state.rtl433Status = msg.rtl433;
        const el = document.getElementById('status-rtl433');
        el.textContent = `rtl_433: ${msg.rtl433}`;
        el.className   = `badge ${msg.rtl433}`;
        setRadar(msg.rtl433);
      }
      if (msg.mqtt) {
        state.mqttStatus = msg.mqtt;
        const el = document.getElementById('status-mqtt');
        el.textContent = `MQTT: ${msg.mqtt}`;
        el.className   = `badge ${msg.mqtt}`;
      }
      if (msg.frequency !== undefined) {
        state.frequency = msg.frequency;
        updateFreqButtons(msg.frequency);
      }
      break;
  }
}

// ── Full render ─────────────────────────────────────────────────────────────
function renderAll() {
  // Status badges
  const rtlEl  = document.getElementById('status-rtl433');
  const mqttEl = document.getElementById('status-mqtt');
  rtlEl.textContent  = `rtl_433: ${state.rtl433Status}`;
  rtlEl.className    = `badge ${state.rtl433Status}`;
  mqttEl.textContent = `MQTT: ${state.mqttStatus}`;
  mqttEl.className   = `badge ${state.mqttStatus}`;

  setRadar(state.rtl433Status);
  updateFreqButtons(state.frequency);
  renderDevices();
  renderMappings();
}

// ── Devices ─────────────────────────────────────────────────────────────────
function sortedDevices() {
  const list = Array.from(state.devices.values());
  return state.sortBySignal
    ? list.sort((a, b) => b.signalCount - a.signalCount)
    : list.sort((a, b) => b.lastSeen - a.lastSeen);
}

function renderDevices() {
  const container = document.getElementById('devices-list');
  container.innerHTML = '';

  const devices = sortedDevices();
  if (devices.length === 0) {
    container.innerHTML = '<p class="empty">Waiting for rtl_433 data…</p>';
  } else {
    for (const dev of devices) container.appendChild(buildCard(dev));
  }
  document.getElementById('device-count').textContent = state.devices.size;
}

/** Insert or replace a single card without re-rendering the whole list. */
function upsertDeviceCard(dev) {
  const key      = deviceKey(dev);
  const cssKey   = CSS.escape(key);
  const existing = document.querySelector(`[data-device-key="${cssKey}"]`);
  const card     = buildCard(dev);

  if (existing) {
    existing.replaceWith(card);
  } else {
    const container = document.getElementById('devices-list');
    // Remove placeholder if present
    const placeholder = container.querySelector('.empty');
    if (placeholder) placeholder.remove();

    if (state.sortBySignal) {
      container.appendChild(card);
    } else {
      container.prepend(card); // newest first
    }
  }
}

function buildCard(dev) {
  const key     = deviceKey(dev);
  const fmaps   = fieldMappings(dev);
  const hasFields = Object.keys(dev.fields).length > 0;

  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.deviceKey = key;

  // Header
  const header = document.createElement('div');
  header.className = 'device-header';
  header.innerHTML = [
    `<span class="device-model">${escHtml(dev.model)}</span>`,
    dev.id !== 'unknown' ? `<span class="device-meta">ID: ${escHtml(dev.id)}</span>` : '',
    dev.channel != null   ? `<span class="device-meta">Ch: ${escHtml(dev.channel)}</span>` : '',
    `<span class="device-meta">Signals: ${dev.signalCount}</span>`,
    dev.rssi != null      ? `<span class="device-meta">RSSI: ${escHtml(dev.rssi)} dBm</span>` : '',
    `<span class="device-meta last-seen" data-ts="${dev.lastSeen}">${timeAgo(dev.lastSeen)}</span>`,
  ].filter(Boolean).join('');
  card.appendChild(header);

  if (!hasFields) {
    const noFields = document.createElement('div');
    noFields.className = 'empty';
    noFields.textContent = 'No mappable fields detected';
    card.appendChild(noFields);
    return card;
  }

  for (const [field, { value }] of Object.entries(dev.fields)) {
    const topic = fmaps[field];
    const row   = document.createElement('div');
    row.className = `field-row${topic ? ' mapped' : ''}`;

    row.innerHTML = [
      `<span class="field-name">${escHtml(field)}</span>`,
      `<span class="field-value">${escHtml(String(value))}</span>`,
      topic
        ? `<span class="field-topic">${escHtml(topic)}</span>
           <button class="btn-unmap"
             data-model="${escHtml(dev.model)}"
             data-id="${escHtml(dev.id)}"
             data-field="${escHtml(field)}">Unmap</button>`
        : `<button class="btn-map"
             data-model="${escHtml(dev.model)}"
             data-id="${escHtml(dev.id)}"
             data-field="${escHtml(field)}">Map →</button>`,
    ].join('');

    card.appendChild(row);
  }

  return card;
}

// ── Mappings panel ──────────────────────────────────────────────────────────
function renderMappings() {
  const list    = document.getElementById('mappings-list');
  const entries = Object.entries(state.mappings);

  document.getElementById('mapping-count').textContent = entries.length;

  if (entries.length === 0) {
    list.innerHTML = '<p class="empty">No mappings yet. Click <strong>Map →</strong> on a field.</p>';
    return;
  }

  list.innerHTML = '';
  for (const [key, topic] of entries) {
    const parts = key.split('.');                // "Model.id.field"
    const field = parts.slice(2).join('.');      // handles dots in field names
    const model = parts[0];
    const id    = parts[1];

    const row = document.createElement('div');
    row.className = 'mapping-row';
    row.innerHTML = `
      <div class="mapping-info">
        <span class="mapping-key">${escHtml(key)}</span>
        <span class="mapping-arrow">→</span>
        <span class="mapping-topic">${escHtml(topic)}</span>
      </div>
      <button class="btn-unmap"
        data-model="${escHtml(model)}"
        data-id="${escHtml(id)}"
        data-field="${escHtml(field)}">Remove</button>
    `;
    list.appendChild(row);
  }
}

// ── Raw stream ──────────────────────────────────────────────────────────────
function addStreamEntry(data) {
  const list  = document.getElementById('stream-list');
  const entry = document.createElement('div');
  entry.className = 'stream-entry';

  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `
    <span class="stream-time">${time}</span>
    <span class="stream-data">${escHtml(JSON.stringify(data))}</span>
  `;

  list.prepend(entry);
  while (list.children.length > MAX_STREAM) list.removeChild(list.lastChild);
}

// ── Modal ───────────────────────────────────────────────────────────────────
let pendingMap = null;

function openModal(model, id, field) {
  pendingMap = { model, id, field };
  const mkey = `${model}.${id}.${field}`;
  document.getElementById('modal-label').textContent  = mkey;
  document.getElementById('modal-topic').value        = state.mappings[mkey] || '';
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('modal-topic').focus();
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  pendingMap = null;
}

async function saveMapping() {
  const topic = document.getElementById('modal-topic').value.trim();
  if (!topic || !pendingMap) return;

  const { model, id, field } = pendingMap;
  const res = await fetch('/api/mappings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, id, field, topic }),
  });

  if (res.ok) {
    state.mappings[`${model}.${id}.${field}`] = topic;
    renderMappings();
    renderDevices();
    closeModal();
  } else {
    const { error } = await res.json();
    alert(`Could not save: ${error}`);
  }
}

async function doUnmap(model, id, field) {
  const res = await fetch('/api/mappings', {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, id, field }),
  });

  if (res.ok) {
    delete state.mappings[`${model}.${id}.${field}`];
    renderMappings();
    renderDevices();
  }
}

// ── Event delegation ─────────────────────────────────────────────────────────
document.getElementById('devices-list').addEventListener('click', e => {
  const mapBtn   = e.target.closest('.btn-map');
  const unmapBtn = e.target.closest('.btn-unmap');
  if (mapBtn)   openModal(mapBtn.dataset.model,   mapBtn.dataset.id,   mapBtn.dataset.field);
  if (unmapBtn) doUnmap(unmapBtn.dataset.model, unmapBtn.dataset.id, unmapBtn.dataset.field);
});

document.getElementById('mappings-list').addEventListener('click', e => {
  const unmapBtn = e.target.closest('.btn-unmap');
  if (unmapBtn) doUnmap(unmapBtn.dataset.model, unmapBtn.dataset.id, unmapBtn.dataset.field);
});

document.getElementById('modal-save').addEventListener('click', saveMapping);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal').addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal();
});
document.getElementById('modal-topic').addEventListener('keydown', e => {
  if (e.key === 'Enter')  saveMapping();
  if (e.key === 'Escape') closeModal();
});

document.getElementById('sort-by-signal').addEventListener('change', e => {
  state.sortBySignal = e.target.checked;
  renderDevices();
});

document.getElementById('clear-stream').addEventListener('click', () => {
  document.getElementById('stream-list').innerHTML = '';
});

// ── Periodic "last seen" refresh ─────────────────────────────────────────────
setInterval(() => {
  for (const el of document.querySelectorAll('.last-seen[data-ts]')) {
    el.textContent = timeAgo(parseInt(el.dataset.ts, 10));
  }
}, 10_000);

// ── Frequency buttons ────────────────────────────────────────────────────
function updateFreqButtons(activeFreq) {
  for (const btn of document.querySelectorAll('.btn-freq')) {
    btn.classList.toggle('active',    btn.dataset.freq === activeFreq);
    btn.classList.remove('switching');
  }
}

document.getElementById('freq-toolbar').addEventListener('click', async e => {
  const btn = e.target.closest('.btn-freq');
  if (!btn) return;

  const freq = btn.dataset.freq;
  if (freq === state.frequency) return;  // already on this frequency

  // Visual feedback: mark as "switching" until the status_update arrives
  for (const b of document.querySelectorAll('.btn-freq')) {
    b.classList.remove('active', 'switching');
  }
  btn.classList.add('switching');

  try {
    const res = await fetch('/api/frequency', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ frequency: freq }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error ?? msg; } catch { /* non-JSON body */ }
      alert(`Frequency change failed: ${msg}`);
      updateFreqButtons(state.frequency); // revert UI
    }
    // On success, the server broadcasts a status_update with the new frequency,
    // which calls updateFreqButtons() automatically.
  } catch (err) {
    alert(`Network error switching frequency: ${err.message}`);
    updateFreqButtons(state.frequency);
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────
wsConnect();
