'use strict';

// ── Ingress-aware API base path ────────────────────────────────────────────
// When served via HA ingress the page is at /api/hassio_ingress/<token>/.
// All fetch(API_BASE + '/api/...') calls must be prefixed with that base so requests
// route back through the ingress proxy to this add-on, not to HA itself.
const API_BASE = location.pathname === '/' ? '' : location.pathname.replace(/\/$/, '');

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  devices:           new Map(),
  mappings:          {},
  history:           new Map(),
  labels:            JSON.parse(localStorage.getItem('rtl433-labels')  || '{}'),
  pinned:            JSON.parse(localStorage.getItem('rtl433-pinned')  || '[]'),
  ignored:           JSON.parse(localStorage.getItem('rtl433-ignored') || '[]'),
  mqttStatus:        'disconnected',
  rtl433Status:      'waiting',    // data-flow: 'waiting' | 'receiving' | 'idle'
  rtl433ProcStatus:  'stopped',    // process:   'stopped' | 'starting' | 'running' | 'error'
  frequency:         '433.92M',
  scanner:           { active: false, aborted: false, results: {}, packetsThisWindow: 0 },
  sortBySignal:      false,
  stream:            [],
  minRssi:           -120,
  maxAgeMs:          0,
  newDevices:        new Set(),
  selectedKey:       null,
  expandedCards:     new Set(JSON.parse(localStorage.getItem('rtl433-expanded') || '[]')),
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

function ageClass(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s > 900) return 'age-stale';
  if (s > 300) return 'age-old';
  return '';
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

/** Return field→topic (string) map for a specific device from state.mappings. */
function fieldMappings(dev) {
  const prefix = `${dev.model}.${dev.id}.`;
  const result = {};
  for (const [k, v] of Object.entries(state.mappings)) {
    if (k.startsWith(prefix)) {
      result[k.slice(prefix.length)] = typeof v === 'string' ? v : v.topic;
    }
  }
  return result;
}

// ── WebSocket ──────────────────────────────────────────────────────────────
let ws = null;

function wsConnect() {
  // Build the WebSocket URL relative to the page's current path.
  // This works both locally (ws://localhost:3000/ws) and behind HA ingress
  // (wss://ha-host/api/hassio_ingress/<token>/ws) because HA proxies all
  // sub-paths of the ingress token to the add-on container.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base  = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  ws = new WebSocket(`${proto}//${location.host}${base}ws`);

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

// ── Message dispatcher ─────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      state.mqttStatus       = msg.status.mqtt;
      state.rtl433Status     = msg.status.rtl433     || 'waiting';
      state.rtl433ProcStatus = msg.status.rtl433proc || 'stopped';
      // Normalise mappings: legacy string values → { topic } objects
      state.mappings = {};
      for (const [k, v] of Object.entries(msg.mappings ?? {})) {
        state.mappings[k] = typeof v === 'string' ? { topic: v } : v;
      }
      state.devices.clear();
      for (const dev of msg.devices) state.devices.set(deviceKey(dev), dev);
      renderAll();
      break;

    case 'device_update': {
      const dev  = msg.device;
      const dkey = deviceKey(dev);
      const isNew = !state.devices.has(dkey);
      // Count packets for the band scanner
      if (state.scanner.active) state.scanner.packetsThisWindow++;
      for (const [field, { value }] of Object.entries(dev.fields)) {
        if (typeof value !== 'number') continue;
        const hkey = `${dkey}|${field}`;
        if (!state.history.has(hkey)) state.history.set(hkey, []);
        const arr = state.history.get(hkey);
        arr.push(value);
        if (arr.length > 20) arr.shift();
      }
      state.devices.set(dkey, dev);
      if (isNew) {
        state.newDevices.add(dkey);
        setTimeout(() => {
          state.newDevices.delete(dkey);
          const el = document.querySelector(`[data-device-key="${CSS.escape(dkey)}"]`);
          if (el) el.classList.remove('device-new');
        }, 30_000);
      }
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
      if (msg.mqtt) {
        state.mqttStatus = msg.mqtt;
        const el = document.getElementById('status-mqtt');
        el.textContent = `MQTT: ${msg.mqtt}`;
        el.className   = `badge ${msg.mqtt}`;
      }
      if (msg.rtl433) {
        state.rtl433Status = msg.rtl433;
        const el = document.getElementById('status-rtl433');
        el.textContent = `data: ${msg.rtl433}`;
        el.className   = `badge ${msg.rtl433}`;
      }
      if (msg.rtl433proc) {
        state.rtl433ProcStatus = msg.rtl433proc;
        handleRtl433ProcStatus(msg.rtl433proc);
      }
      break;

    case 'logs_init':
      logClear();
      for (const line of msg.lines) logAppend(line);
      break;

    case 'log_line':
      logAppend(msg.line);
      break;
  }
}

// ── Full render ─────────────────────────────────────────────────────────────
function renderAll() {
  const mqttEl = document.getElementById('status-mqtt');
  mqttEl.textContent = `MQTT: ${state.mqttStatus}`;
  mqttEl.className   = `badge ${state.mqttStatus}`;

  const procEl = document.getElementById('status-rtl433proc');
  procEl.textContent = `rtl_433: ${state.rtl433ProcStatus}`;
  procEl.className   = `badge ${state.rtl433ProcStatus}`;

  const rtlEl = document.getElementById('status-rtl433');
  rtlEl.textContent = `data: ${state.rtl433Status}`;
  rtlEl.className   = `badge ${state.rtl433Status}`;

  updateFreqButtons(state.frequency);
  renderDevices();
  renderMappings();
}

// ── Devices ─────────────────────────────────────────────────────────────────
function sortedDevices() {
  const now = Date.now();
  const list = Array.from(state.devices.values())
    .filter(d => !state.ignored.includes(deviceKey(d)))
    .filter(d => state.minRssi <= -120 || d.rssi == null || d.rssi >= state.minRssi)
    .filter(d => state.maxAgeMs === 0 || (now - d.lastSeen) <= state.maxAgeMs);
  const pinned   = list.filter(d =>  state.pinned.includes(deviceKey(d)));
  const unpinned = list.filter(d => !state.pinned.includes(deviceKey(d)));
  const cmp = state.sortBySignal
    ? (a, b) => b.signalCount - a.signalCount
    : (a, b) => b.lastSeen - a.lastSeen;
  return [...pinned.sort(cmp), ...unpinned.sort(cmp)];
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

// ── Sparkline ────────────────────────────────────────────────────────────────
function sparkline(hkey) {
  const values = state.history.get(hkey);
  if (!values || values.length < 2) return '';
  const W = 56, H = 16, pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = (pad + (i / (n - 1)) * (W - 2 * pad)).toFixed(1);
    const y = (pad + (1 - (v - min) / range) * (H - 2 * pad)).toFixed(1);
    return `${x},${y}`;
  }).join(' ');
  const x0 = pad.toFixed(1), xN = (W - pad).toFixed(1), yB = (H - pad).toFixed(1);
  const area = `M${x0},${yB} ` + values.map((v, i) => {
    const x = (pad + (i / (n - 1)) * (W - 2 * pad)).toFixed(1);
    const y = (pad + (1 - (v - min) / range) * (H - 2 * pad)).toFixed(1);
    return `L${x},${y}`;
  }).join(' ') + ` L${xN},${yB} Z`;
  return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <path d="${area}" fill="var(--accent)" opacity="0.12"/>
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ── RSSI widget ───────────────────────────────────────────────────────────────
function rssiWidget(rssi) {
  if (rssi == null) return '';
  const bars  = rssi > -60 ? 4 : rssi > -75 ? 3 : rssi > -85 ? 2 : 1;
  const colour = bars === 4 ? 'var(--green)'
               : bars === 3 ? '#4ade80'
               : bars === 2 ? 'var(--yellow)'
               : 'var(--red)';
  const heights = [4, 7, 10, 13];
  const svgBars = heights.map((h, i) => {
    const filled = (i + 1) <= bars;
    const y = 14 - h;
    return `<rect x="${i * 4}" y="${y}" width="3" height="${h}" rx="0.8"
      fill="${filled ? colour : 'rgba(255,255,255,.12)'}"/>`;
  }).join('');
  return `<span class="rssi-widget" title="RSSI: ${escHtml(rssi)} dBm">
    <svg viewBox="0 0 15 15" class="rssi-svg" aria-hidden="true">${svgBars}</svg>
    <span class="rssi-value" style="color:${colour}">${escHtml(rssi)}</span>
  </span>`;
}

// ── Device type inference ─────────────────────────────────────────────────────
// Priority order: fields reported take precedence over model name patterns.

function deviceType(dev) {
  const fields = Object.keys(dev.fields || {});
  const model  = dev.model || '';

  const has = (...names) => names.some(n => fields.includes(n));
  const hasMatch = re => re.test(model);

  // ERT/AMR utility meter — ert_type field tells us gas/water/electric
  // Check this first before any generic field matching
  if (hasMatch(/scm\+?|scmplus|ert|idm|netidm|itron|sensus|neptune|badger|elster|master.?meter/i) ||
      has('ert_type', 'consumption', 'consumption_data', 'current_consumption')) {
    const ertType = dev.fields?.ert_type?.value ?? dev.fields?.type?.value ?? null;
    // ert_type: 2=electric, 4=gas, 7=water, 8=electric-interval, 12=water
    const GAS_TYPES     = [4, 5, 6];
    const WATER_TYPES   = [7, 11, 12, 13];
    const ELECTRIC_TYPES = [2, 8, 9, 10];
    if (ertType != null) {
      if (ELECTRIC_TYPES.includes(Number(ertType)))
        return { icon: '\u26a1',          label: 'Electric Meter (ERT/AMR)' };
      if (WATER_TYPES.includes(Number(ertType)))
        return { icon: '\u{1f4a7}',       label: 'Water Meter (ERT/AMR)' };
      if (GAS_TYPES.includes(Number(ertType)))
        return { icon: '\u{1f525}',       label: 'Gas Meter (ERT/AMR)' };
    }
    // ert_type unknown — guess from model name or fields
    if (hasMatch(/gas/i) || has('consumption', 'consumption_data', 'current_consumption'))
      return { icon: '\u{1f525}',         label: 'Gas Meter (ERT/AMR)' };
    if (hasMatch(/water/i) || has('water_m3', 'water_L'))
      return { icon: '\u{1f4a7}',         label: 'Water Meter (ERT/AMR)' };
    if (hasMatch(/elec|kwh|kw/i) || has('energy_kWh', 'current_A'))
      return { icon: '\u26a1',            label: 'Electric Meter (ERT/AMR)' };
    return { icon: '\u{1f4ca}',           label: 'Utility Meter (ERT/AMR)' };
  }

  const hasTemp     = has('temperature_C', 'temperature_F', 'temperature_1_C', 'temperature_2_C');
  const hasHumidity = has('humidity', 'moisture');
  const hasWind     = has('wind_speed_km_h', 'wind_avg_km_h', 'wind_avg_m_s', 'wind_max_m_s',
                          'gust_speed_km_h', 'wind_dir_deg', 'wind_avg_mi_h');
  const hasRain     = has('rain_mm', 'rain_in', 'rain_mm_h', 'rain_rate_in_h');
  const hasPressure = has('pressure_hPa');
  const hasPower    = has('power_W');
  const hasLight    = has('lux', 'uv');
  const hasAlarm    = has('alarm', 'tamper', 'motion');
  const hasLightning = has('strike_distance', 'strike_count', 'storm_dist');
  const hasDepth    = has('depth_cm');
  const hasMoisture = has('moisture');
  const hasButton   = has('button', 'cmd', 'command', 'key', 'event', 'action');
  const hasSwitch   = has('switch', 'state', 'relay', 'on_off');
  const hasFan      = has('fan_speed', 'fan');
  const hasSetpoint = has('setpoint', 'target_temperature', 'target_temp');
  const hasCO2      = has('co2', 'co2_ppm', 'voc', 'pm2_5', 'pm10', 'aqi');
  const hasSoil     = has('soil_moisture', 'soil_temp');
  const hasGPS      = has('lat', 'lon', 'latitude', 'longitude', 'speed', 'heading');
  const hasCounter  = has('count', 'counter', 'total', 'pulses');
  const hasCurrent  = has('current_A', 'voltage_V', 'energy_kWh', 'apparent_power');
  const hasBattery  = fields.length <= 3 && has('battery_ok', 'battery_mV', 'battery_V');
  const hasCode     = has('code', 'learn');
  const hasSubGhz   = fields.length === 0;
  // Utility meter fields (ERT/AMR protocol — gas, water, electric)
  const hasGasConsumption  = has('consumption', 'consumption_data', 'current_consumption', 'last_consumption');
  const hasWaterConsumption = has('water_m3', 'water_L');
  const hasElecConsumption  = has('energy_kWh', 'current_A', 'voltage_V', 'apparent_power');

  // Field-based inference (most reliable)
  if (hasWind && (hasRain || hasTemp))
    return { icon: '\u26c5',          label: 'Weather Station' };
  if (hasWind && hasRain)
    return { icon: '\u26c5',          label: 'Weather Station' };
  if (hasWind)
    return { icon: '\u{1f32c}\ufe0f', label: 'Wind Sensor' };
  if (hasRain && hasTemp)
    return { icon: '\u{1f327}\ufe0f', label: 'Rain + Temp' };
  if (hasRain)
    return { icon: '\u{1f327}\ufe0f', label: 'Rain Gauge' };
  if (hasLightning)
    return { icon: '\u26a1',          label: 'Lightning Detector' };
  if (hasGasConsumption)
    return { icon: '\u{1f525}',       label: 'Gas Meter (ERT/AMR)' };
  if (hasWaterConsumption)
    return { icon: '\u{1f4a7}',       label: 'Water Meter (ERT/AMR)' };
  if (hasGPS)
    return { icon: '\u{1f4cd}',       label: 'GPS Tracker' };
  if (hasCO2)
    return { icon: '\u{1f32b}\ufe0f', label: 'Air Quality Sensor' };
  if (hasSoil)
    return { icon: '\u{1f331}',       label: 'Soil Sensor' };
  if (hasFan)
    return { icon: '\u{1f4a8}',       label: 'Fan / HVAC' };
  if (hasSetpoint && hasTemp)
    return { icon: '\u{1f321}\ufe0f', label: 'Thermostat' };
  if (hasCurrent)
    return { icon: '\u{1f50c}',       label: 'Energy Monitor' };
  if (hasPower)
    return { icon: '\u{1f50c}',       label: 'Power Meter' };
  if (hasLight)
    return { icon: '\u{1f31e}',       label: 'Light / UV' };
  if (hasDepth)
    return { icon: '\u{1f4cf}',       label: 'Depth / Level' };
  if (hasMoisture && !hasTemp)
    return { icon: '\u{1f4a7}',       label: 'Moisture Sensor' };
  if (hasAlarm)
    return { icon: '\u{1f6a8}',       label: 'Alarm / Security' };
  if (hasCounter)
    return { icon: '\u{1f522}',       label: 'Counter / Meter' };
  if (hasTemp && hasHumidity && hasPressure)
    return { icon: '\u{1f321}\ufe0f', label: 'Temp / Humidity / Pressure' };
  if (hasTemp && hasHumidity)
    return { icon: '\u{1f321}\ufe0f', label: 'Temp / Humidity' };
  if (hasTemp)
    return { icon: '\u{1f321}\ufe0f', label: 'Temperature Sensor' };
  if (hasHumidity)
    return { icon: '\u{1f4a7}',       label: 'Humidity Sensor' };
  if (hasPressure)
    return { icon: '\u{1f321}\ufe0f', label: 'Barometer' };
  if (hasSwitch)
    return { icon: '\u{1f4a1}',       label: 'Switch / Relay' };
  if (hasButton || hasCode)
    return { icon: '\u{1f4f2}',       label: 'Remote / Button' };
  if (hasBattery)
    return { icon: '\u{1f50b}',       label: 'Sensor (battery only)' };

  // Model-name fallback patterns
  if (hasMatch(/wind|anemom|weather/i))
    return { icon: '\u26c5',          label: 'Weather Station' };
  if (hasMatch(/rain|gauge/i))
    return { icon: '\u{1f327}\ufe0f', label: 'Rain Gauge' };
  if (hasMatch(/thermo|temp|hydro|lacrosse|acurite|oregon|hideki|prologue|gt-wt|hygrochron/i))
    return { icon: '\u{1f321}\ufe0f', label: 'Temperature Sensor' };
  if (hasMatch(/door|window|contact|entry/i))
    return { icon: '\u{1f6aa}',       label: 'Door / Window' };
  if (hasMatch(/motion|pir/i))
    return { icon: '\u{1f441}\ufe0f', label: 'Motion Sensor' };
  if (hasMatch(/smoke|fire|carbon|co\b/i))
    return { icon: '\u{1f525}',       label: 'Smoke / CO Detector' };
  if (hasMatch(/garage|chamberlain|gdo/i))
    return { icon: '\u{1f697}',       label: 'Garage Door' };
  if (hasMatch(/tpms|schrader|tyre|tire/i))
    return { icon: '\u{1f6de}',       label: 'Tire Pressure (TPMS)' };
  if (hasMatch(/energy|power|meter|efergy|kwh/i))
    return { icon: '\u{1f50c}',       label: 'Energy Meter' };
  if (hasMatch(/bell|doorbell/i))
    return { icon: '\u{1f514}',       label: 'Doorbell' };
  if (hasMatch(/alarm|security|kerui/i))
    return { icon: '\u{1f6a8}',       label: 'Alarm / Security' };
  if (hasMatch(/water|leak|flood/i))
    return { icon: '\u{1f4a7}',       label: 'Water / Leak' };
  if (hasMatch(/lock\b/i))
    return { icon: '\u{1f512}',       label: 'Lock' };
  if (hasMatch(/remote|keyfob|fob|button|transmit/i))
    return { icon: '\u{1f4f2}',       label: 'Remote / Keyfob' };
  if (hasMatch(/pool|spa|hot.?tub/i))
    return { icon: '\u{1f6be}',       label: 'Pool / Spa' };
  if (hasMatch(/soil|plant|garden/i))
    return { icon: '\u{1f331}',       label: 'Soil / Garden' };
  if (hasMatch(/fan|hvac|vent/i))
    return { icon: '\u{1f4a8}',       label: 'Fan / HVAC' };
  if (hasMatch(/scale|weigh/i))
    return { icon: '\u2696\ufe0f',    label: 'Scale' };
  if (hasMatch(/switch|relay|plug|socket/i))
    return { icon: '\u{1f4a1}',       label: 'Switch / Plug' };
  if (hasMatch(/thermostat|heat|cool/i))
    return { icon: '\u{1f321}\ufe0f', label: 'Thermostat' };
  if (hasMatch(/vehicle|car|auto/i))
    return { icon: '\u{1f697}',       label: 'Vehicle Sensor' };

  // Last resort: at least describe it as sub-GHz RF with field count hint
  if (fields.length > 0)
    return { icon: '\u{1f4e1}',       label: `RF Sensor (${fields.length} field${fields.length > 1 ? 's' : ''})` };

  return { icon: '\u{1f4e1}',         label: 'RF Transmitter' };
}

function deviceIcon(dev) {
  // Accept either a device object or legacy model string
  const d = typeof dev === 'string' ? { model: dev, fields: {} } : dev;
  const { icon, label } = deviceType(d);
  return `<span class="device-icon" title="${escHtml(label)}">${icon}</span>`;
}

function deviceTypeTag(dev) {
  const { label } = deviceType(dev);
  return `<span class="device-type-tag">${escHtml(label)}</span>`;
}

function buildCard(dev) {
  const key        = deviceKey(dev);
  const fmaps      = fieldMappings(dev);
  const hasFields  = Object.keys(dev.fields).length > 0;
  const isExpanded = state.expandedCards.has(key);

  const card = document.createElement('div');
  card.className = `device-card${state.newDevices.has(key) ? ' device-new' : ''}${isExpanded ? ' expanded' : ''}`;
  card.dataset.deviceKey = key;

  // Header — two rows for readability
  const header = document.createElement('div');
  header.className = 'device-header';
  const isPinned = state.pinned.includes(key);
  const label    = state.labels[key];

  // Row 1: icon + name + type tag + chevron
  const headerTop = document.createElement('div');
  headerTop.className = 'device-header-top';
  headerTop.innerHTML = [
    deviceIcon(dev),
    label
      ? `<span class="device-label">${escHtml(label)}</span><span class="device-model device-model-sub">${escHtml(dev.model)}</span>`
      : `<span class="device-model">${escHtml(dev.model)}</span>`,
    deviceTypeTag(dev),
    `<span class="card-chevron" aria-hidden="true">&#9654;</span>`,
  ].filter(Boolean).join('');

  // Row 2: metadata + action buttons
  const headerMeta = document.createElement('div');
  headerMeta.className = 'device-header-meta';
  headerMeta.innerHTML = [
    dev.id !== 'unknown'  ? `<span class="device-meta">ID\u00a0${escHtml(dev.id)}</span>` : '',
    dev.channel != null   ? `<span class="device-meta">Ch\u00a0${escHtml(dev.channel)}</span>` : '',
    `<span class="device-meta">${dev.signalCount}\u00a0pkts</span>`,
    dev.rssi != null      ? rssiWidget(dev.rssi) : '',
    `<span class="device-meta last-seen ${ageClass(dev.lastSeen)}" data-ts="${dev.lastSeen}">${timeAgo(dev.lastSeen)}</span>`,
    `<button class="btn-rename" title="Rename device" data-key="${escHtml(key)}">\u270f\ufe0f</button>`,
    `<button class="btn-pin ${isPinned ? 'pinned' : ''}" title="${isPinned ? 'Unpin' : 'Pin'} device" data-key="${escHtml(key)}">\u{1f4cc}</button>`,
    `<button class="btn-ignore" title="Hide device" data-key="${escHtml(key)}">\u{1f6ab}</button>`,
    `<button class="btn-forget" title="Forget device" data-model="${escHtml(dev.model)}" data-id="${escHtml(dev.id)}">\u{1f5d1}\ufe0f</button>`,
  ].filter(Boolean).join('');

  header.appendChild(headerTop);
  header.appendChild(headerMeta);
  card.appendChild(header);

  if (!hasFields) {
    const noFields = document.createElement('div');
    noFields.className = 'empty';
    noFields.textContent = 'No mappable fields detected';
    card.appendChild(noFields);
    return card;
  }

  // Compact summary (visible when collapsed)
  const summary = document.createElement('div');
  summary.className = 'card-summary';
  summary.innerHTML = Object.entries(dev.fields)
    .slice(0, 5)
    .map(([f, { value }]) =>
      `<span class="summary-item"><span class="summary-key">${escHtml(f)}</span>\u00a0<span class="summary-val">${escHtml(String(value))}</span></span>`
    ).join('');
  card.appendChild(summary);

  // All field rows (visible when expanded)
  const fieldsContainer = document.createElement('div');
  fieldsContainer.className = 'card-fields';

  for (const [field, { value }] of Object.entries(dev.fields)) {
    const topic = fmaps[field];
    const hkey  = `${key}|${field}`;
    const spark = sparkline(hkey);
    const row   = document.createElement('div');
    row.className = `field-row${topic ? ' mapped' : ''}`;

    row.innerHTML = [
      `<span class="field-name">${escHtml(field)}</span>`,
      `<span class="field-value">${escHtml(String(value))}</span>`,
      spark,
      topic
        ? `<span class="field-topic">${escHtml(topic)}</span>
           <button class="btn-test-publish" title="Publish current value to MQTT"
             data-topic="${escHtml(topic)}" data-value="${escHtml(String(value))}">&#9654;</button>
           <button class="btn-unmap"
             data-model="${escHtml(dev.model)}"
             data-id="${escHtml(dev.id)}"
             data-field="${escHtml(field)}">Unmap</button>`
        : `<button class="btn-map"
             data-model="${escHtml(dev.model)}"
             data-id="${escHtml(dev.id)}"
             data-field="${escHtml(field)}">Map</button>`,
    ].join('');

    fieldsContainer.appendChild(row);
  }

  card.appendChild(fieldsContainer);
  return card;
}

// ── Mappings panel ──────────────────────────────────────────────────────────
function renderMappings() {
  const list    = document.getElementById('mappings-list');
  const entries = Object.entries(state.mappings);

  document.getElementById('mapping-count').textContent = entries.length;
  document.getElementById('btn-ha-discovery').style.display = entries.length ? '' : 'none';

  if (entries.length === 0) {
    list.innerHTML = '<p class="empty">No mappings yet. Click <strong>Map</strong> on a field.</p>';
    return;
  }

  list.innerHTML = '';
  for (const [key, mapping] of entries) {
    const topic = typeof mapping === 'string' ? mapping : mapping.topic;
    const parts = key.split('.');
    const field = parts.slice(2).join('.');
    const model = parts[0];
    const id    = parts[1];
    // Build badge list for any active overrides
    const ovr = typeof mapping === 'object' ? mapping : {};
    const badges = [
      ovr.name         ? `<span class="mapping-badge" title="name">${escHtml(ovr.name)}</span>` : '',
      ovr.device_class ? `<span class="mapping-badge" title="device_class">${escHtml(ovr.device_class)}</span>` : '',
      ovr.state_class  ? `<span class="mapping-badge" title="state_class">${escHtml(ovr.state_class)}</span>` : '',
      ovr.unit         ? `<span class="mapping-badge" title="unit">${escHtml(ovr.unit)}</span>` : '',
      ovr.icon         ? `<span class="mapping-badge" title="icon">${escHtml(ovr.icon)}</span>` : '',
    ].filter(Boolean).join('');

    const row = document.createElement('div');
    row.className = 'mapping-row';
    row.innerHTML = `
      <div class="mapping-info">
        <span class="mapping-key">${escHtml(key)}</span>
        <span class="mapping-arrow">&rarr;</span>
        <span class="mapping-topic">${escHtml(topic)}</span>
        ${badges}
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
  // Tag entry so it can link to its device card
  if (data.model != null && data.id != null) {
    entry.dataset.deviceKey = `${data.model}|${data.id}`;
  }
  const time    = new Date().toLocaleTimeString();
  const compact = JSON.stringify(data);
  const pretty  = JSON.stringify(data, null, 2);
  entry.innerHTML = `
    <div class="stream-row">
      <span class="stream-time">${time}</span>
      <span class="stream-data">${escHtml(compact)}</span>
      <button class="stream-copy" title="Copy JSON" tabindex="-1">&#128203;</button>
      <button class="stream-expand" title="Expand/collapse JSON" tabindex="-1">&#9660;</button>
    </div>
    <pre class="stream-pretty hidden">${escHtml(pretty)}</pre>
  `;
  // Wire up expand toggle
  const expandBtn = entry.querySelector('.stream-expand');
  const pre       = entry.querySelector('.stream-pretty');
  expandBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = pre.classList.toggle('hidden');
    expandBtn.textContent = open ? '\u25BC' : '\u25B2';
    entry.classList.toggle('stream-entry-expanded', !open);
  });
  // Wire up copy button
  entry.querySelector('.stream-copy').addEventListener('click', e => {
    e.stopPropagation();
    navigator.clipboard?.writeText(pretty).then(() => {
      const btn = e.currentTarget;
      const orig = btn.textContent;
      btn.textContent = '\u2713';
      setTimeout(() => { btn.textContent = orig; }, 1200);
    });
  });
  // Auto-highlight if this device is currently selected
  if (entry.dataset.deviceKey && entry.dataset.deviceKey === state.selectedKey) {
    entry.classList.add('stream-highlighted');
  }
  list.prepend(entry);
  while (list.children.length > MAX_STREAM) list.removeChild(list.lastChild);
}

// ── Server log panel ──────────────────────────────────────────────────────────
const MAX_LOG_LINES = 150;

function logAppend(line) {
  const list = document.getElementById('log-list');
  if (!list) return;
  const entry = document.createElement('div');
  entry.className = `log-entry log-${line.level}`;
  const time = new Date(line.ts).toLocaleTimeString();
  entry.innerHTML = `<span class="log-time">${escHtml(time)}</span><span class="log-text">${escHtml(line.text)}</span>`;
  list.appendChild(entry);
  while (list.children.length > MAX_LOG_LINES) list.removeChild(list.firstChild);
  // Auto-scroll to bottom
  list.scrollTop = list.scrollHeight;
  // Update count badge
  const count = document.getElementById('log-count');
  if (count) count.textContent = list.children.length;
}

function logClear() {
  const list = document.getElementById('log-list');
  if (list) list.innerHTML = '';
  const count = document.getElementById('log-count');
  if (count) count.textContent = '0';
}

// ── HA MQTT templates ─────────────────────────────────────────────────────────
function haSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function haTopicFlat(model, id, field) {
  return `rtl433/${haSlug(model)}/${haSlug(id)}/${haSlug(field)}`;
}

function haTopicState(model, id, field) {
  const type = haEntityType(field);
  return `homeassistant/${type}/rtl433_${haSlug(model)}_${haSlug(id)}/${haSlug(field)}/state`;
}

// S = sensor, B = binary_sensor
const HA_FIELD_META = {
  // Temperature
  temperature_C:       { type: 'sensor', device_class: 'temperature',             unit: '\u00b0C',  precision: 1 },
  temperature_F:       { type: 'sensor', device_class: 'temperature',             unit: '\u00b0F',  precision: 1 },
  temperature_1_C:     { type: 'sensor', device_class: 'temperature',             unit: '\u00b0C',  precision: 1 },
  temperature_2_C:     { type: 'sensor', device_class: 'temperature',             unit: '\u00b0C',  precision: 1 },
  // Humidity / moisture
  humidity:            { type: 'sensor', device_class: 'humidity',                unit: '%',        precision: 1 },
  moisture:            { type: 'sensor', device_class: 'moisture',                unit: '%',        precision: 1 },
  // Pressure
  pressure_hPa:        { type: 'sensor', device_class: 'pressure',               unit: 'hPa',      precision: 1 },
  // Wind
  wind_speed_km_h:     { type: 'sensor', device_class: 'wind_speed',             unit: 'km/h',     precision: 1 },
  wind_avg_km_h:       { type: 'sensor', device_class: 'wind_speed',             unit: 'km/h',     precision: 1 },
  wind_avg_m_s:        { type: 'sensor', device_class: 'wind_speed',             unit: 'm/s',      precision: 1 },
  wind_max_m_s:        { type: 'sensor', device_class: 'wind_speed',             unit: 'm/s',      precision: 1 },
  gust_speed_km_h:     { type: 'sensor', device_class: 'wind_speed',             unit: 'km/h',     precision: 1 },
  gust_speed_m_s:      { type: 'sensor', device_class: 'wind_speed',             unit: 'm/s',      precision: 1 },
  wind_dir_deg:        { type: 'sensor', device_class: null,                      unit: '\u00b0',   precision: 0 },
  wind_avg_mi_h:       { type: 'sensor', device_class: 'wind_speed',             unit: 'mi/h',     precision: 1 },
  // Rain
  rain_mm:             { type: 'sensor', device_class: 'precipitation',           unit: 'mm',       precision: 1, state_class: 'total_increasing' },
  rain_in:             { type: 'sensor', device_class: 'precipitation',           unit: 'in',       precision: 2, state_class: 'total_increasing' },
  rain_mm_h:           { type: 'sensor', device_class: 'precipitation_intensity', unit: 'mm/h',     precision: 1 },
  rain_rate_in_h:      { type: 'sensor', device_class: 'precipitation_intensity', unit: 'in/h',     precision: 2 },
  // Light / UV
  lux:                 { type: 'sensor', device_class: 'illuminance',             unit: 'lx',       precision: 0 },
  uv:                  { type: 'sensor', device_class: null,                      unit: 'UV index',  precision: 1 },
  // Power / energy
  power_W:             { type: 'sensor', device_class: 'power',                  unit: 'W',        precision: 1 },
  // Signal quality
  rssi:                { type: 'sensor', device_class: 'signal_strength',         unit: 'dBm',      precision: 0 },
  snr:                 { type: 'sensor', device_class: 'signal_strength',         unit: 'dB',       precision: 1 },
  noise:               { type: 'sensor', device_class: 'signal_strength',         unit: 'dBm',      precision: 0 },
  // Distance / depth
  depth_cm:            { type: 'sensor', device_class: 'distance',               unit: 'cm',       precision: 1 },
  storm_dist:          { type: 'sensor', device_class: 'distance',               unit: 'km',       precision: 0 },
  strike_distance:     { type: 'sensor', device_class: 'distance',               unit: 'km',       precision: 0 },
  strike_count:        { type: 'sensor', device_class: null,                      unit: 'strikes',   precision: 0, state_class: 'total_increasing' },
  // Air quality
  co2_ppm:             { type: 'sensor', device_class: 'carbon_dioxide',          unit: 'ppm',      precision: 0 },
  pm2_5:               { type: 'sensor', device_class: 'pm25',                    unit: '\u00b5g/m\u00b3', precision: 1 },
  pm10:                { type: 'sensor', device_class: 'pm10',                    unit: '\u00b5g/m\u00b3', precision: 1 },
  pm1_0:               { type: 'sensor', device_class: 'pm1',                     unit: '\u00b5g/m\u00b3', precision: 1 },
  tvoc:                { type: 'sensor', device_class: 'volatile_organic_compounds_parts', unit: 'ppb', precision: 0 },
  // Motion / occupancy / presence
  motion:              { type: 'binary_sensor', device_class: 'motion',      payload_on: '1', payload_off: '0' },
  occupancy:           { type: 'binary_sensor', device_class: 'occupancy',   payload_on: '1', payload_off: '0' },
  // Door / window / lock
  opening:             { type: 'binary_sensor', device_class: 'opening',     payload_on: '1', payload_off: '0' },
  door:                { type: 'binary_sensor', device_class: 'door',        payload_on: '1', payload_off: '0' },
  window:              { type: 'binary_sensor', device_class: 'window',      payload_on: '1', payload_off: '0' },
  lock:                { type: 'binary_sensor', device_class: 'lock',        payload_on: '1', payload_off: '0' },
  // Safety
  smoke:               { type: 'binary_sensor', device_class: 'smoke',       payload_on: '1', payload_off: '0' },
  co:                  { type: 'binary_sensor', device_class: 'co',          payload_on: '1', payload_off: '0' },
  vibration:           { type: 'binary_sensor', device_class: 'vibration',   payload_on: '1', payload_off: '0' },
  // Binary sensors (battery_ok=0 means battery LOW → problem ON)
  battery_ok:          { type: 'binary_sensor', device_class: 'battery',     payload_on: '0', payload_off: '1', value_template: '{{ value | string }}' },
  alarm:               { type: 'binary_sensor', device_class: 'problem',     payload_on: '1', payload_off: '0' },
  tamper:              { type: 'binary_sensor', device_class: 'tamper',      payload_on: '1', payload_off: '0' },
  // Utility meters (ERT/AMR — gas, water, electric)
  // force_update: true is REQUIRED for HA Energy dashboard — without it, HA ignores
  // repeated identical readings (meters broadcast same value every ~30s) and creates
  // no statistics records. no_expire: true means we omit expire_after so the sensor
  // stays available during brief reception gaps instead of going 'unavailable'.
  consumption:          { type: 'sensor', device_class: 'gas',             unit: 'CCF',        precision: 0, state_class: 'total_increasing', force_update: true, no_expire: true },
  consumption_data:     { type: 'sensor', device_class: 'gas',             unit: 'CCF',        precision: 0, state_class: 'total_increasing', force_update: true, no_expire: true },
  current_consumption:  { type: 'sensor', device_class: 'gas',             unit: 'CCF',        precision: 0, state_class: 'total_increasing', force_update: true, no_expire: true },
  last_consumption:     { type: 'sensor', device_class: 'gas',             unit: 'CCF',        precision: 0, state_class: 'total_increasing', force_update: true, no_expire: true },
  water_m3:             { type: 'sensor', device_class: 'water',           unit: 'm\u00b3',    precision: 3, state_class: 'total_increasing', force_update: true, no_expire: true },
  water_L:              { type: 'sensor', device_class: 'water',           unit: 'L',          precision: 0, state_class: 'total_increasing', force_update: true, no_expire: true },
  energy_kWh:           { type: 'sensor', device_class: 'energy',          unit: 'kWh',        precision: 3, state_class: 'total_increasing', force_update: true, no_expire: true },
  current_A:            { type: 'sensor', device_class: 'current',         unit: 'A',          precision: 2 },
  voltage_V:            { type: 'sensor', device_class: 'voltage',         unit: 'V',          precision: 1 },
  apparent_power:       { type: 'sensor', device_class: 'apparent_power',  unit: 'VA',         precision: 1 },
};

// How long HA should wait (seconds) before marking a sensor unavailable.
// Only applied to transient sensors (weather stations, etc.) — NOT utility meters.
// Utility meters use no_expire:true in their meta to omit this field entirely,
// so HA keeps the last known reading during brief reception gaps.
const HA_EXPIRE_AFTER = 600;

function haEntityType(field) {
  return (HA_FIELD_META[field] || {}).type || 'sensor';
}

function haDiscoveryPayload(model, id, field, stateTopic, overrides = {}) {
  const meta     = HA_FIELD_META[field] || {};
  const isBinary = meta.type === 'binary_sensor';
  const uid      = `rtl433_${haSlug(model)}_${haSlug(id)}_${haSlug(field)}`;
  const label    = state.labels[`${model}|${id}`] || model;
  const payload  = {
    name:         overrides.name || `${label} ${field.replace(/_/g, ' ')}`,
    unique_id:    uid,
    state_topic:  stateTopic,
    object_id:    uid,
    device: {
      identifiers:  [`rtl433_${haSlug(model)}_${haSlug(id)}`],
      name:         `${label} (${id})`,
      model:        model,
      manufacturer: 'rtl_433',
    },
  };
  // Only set expire_after for transient sensors, not utility meters
  if (!meta.no_expire) payload.expire_after = HA_EXPIRE_AFTER;
  // force_update: true is required for energy dashboard (records stats on every push)
  if (meta.force_update) payload.force_update = true;
  // Apply overrides first, then fall back to HA_FIELD_META defaults
  const dc = overrides.device_class !== undefined && overrides.device_class !== ''
    ? overrides.device_class : meta.device_class;
  const unit = overrides.unit !== undefined && overrides.unit !== ''
    ? overrides.unit : meta.unit;
  const sc = overrides.state_class !== undefined && overrides.state_class !== ''
    ? overrides.state_class : meta.state_class;
  if (dc)            payload.device_class        = dc;
  if (unit)          payload.unit_of_measurement = unit;
  if (sc)            payload.state_class         = sc;
  if (overrides.icon) payload.icon               = overrides.icon;
  if (meta.precision != null) payload.suggested_display_precision = meta.precision;
  if (meta.value_template)    payload.value_template = meta.value_template;
  if (isBinary) {
    payload.payload_on  = meta.payload_on  ?? '1';
    payload.payload_off = meta.payload_off ?? '0';
  }
  return payload;
}

// ── Modal ───────────────────────────────────────────────────────────────────
let pendingMap = null;

function collectAdvancedOverrides() {
  const overrides = {};
  const name         = document.getElementById('modal-adv-name').value.trim();
  const icon         = document.getElementById('modal-adv-icon').value.trim();
  const device_class = document.getElementById('modal-adv-device-class').value.trim();
  const state_class  = document.getElementById('modal-adv-state-class').value;
  const unit         = document.getElementById('modal-adv-unit').value.trim();
  if (name)         overrides.name         = name;
  if (icon)         overrides.icon         = icon;
  if (device_class) overrides.device_class = device_class;
  if (state_class)  overrides.state_class  = state_class;
  if (unit)         overrides.unit         = unit;
  return overrides;
}

function openModal(model, id, field) {
  pendingMap = { model, id, field };
  const mkey  = `${model}.${id}.${field}`;
  document.getElementById('modal-label').textContent = mkey;
  const existing = state.mappings[mkey];
  const existingTopic = existing ? existing.topic : null;
  const meta  = HA_FIELD_META[field] || {};
  const label = state.labels[`${model}|${id}`] || model;
  document.getElementById('modal-topic').value = existingTopic || haTopicFlat(model, id, field);
  // Populate advanced fields: use existing overrides if any, otherwise show meta defaults as placeholders
  document.getElementById('modal-adv-name').value         = existing?.name         || '';
  document.getElementById('modal-adv-name').placeholder   = `${label} ${field.replace(/_/g, ' ')}`;
  document.getElementById('modal-adv-icon').value         = existing?.icon         || '';
  document.getElementById('modal-adv-device-class').value = existing?.device_class || '';
  document.getElementById('modal-adv-device-class').placeholder = meta.device_class || 'e.g. temperature';
  document.getElementById('modal-adv-state-class').value  = existing?.state_class  || '';
  document.getElementById('modal-adv-unit').value         = existing?.unit         || '';
  document.getElementById('modal-adv-unit').placeholder   = meta.unit || 'e.g. °C';
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('modal-topic').focus();
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  document.getElementById('modal-advanced').open = false;
  document.getElementById('modal-adv-name').value         = '';
  document.getElementById('modal-adv-icon').value         = '';
  document.getElementById('modal-adv-device-class').value = '';
  document.getElementById('modal-adv-state-class').value  = '';
  document.getElementById('modal-adv-unit').value         = '';
  pendingMap = null;
}

async function saveMapping(autoDiscovery = false) {
  const topic = document.getElementById('modal-topic').value.trim();
  if (!topic || !pendingMap) return;

  const { model, id, field } = pendingMap;
  const overrides = collectAdvancedOverrides();

  const res = await fetch(API_BASE + '/api/mappings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, id, field, topic, ...overrides }),
  });

  if (res.ok) {
    state.mappings[`${model}.${id}.${field}`] = { topic, ...overrides };
    renderMappings();
    renderDevices();
    closeModal();
    // Auto-publish HA discovery whenever the topic looks like an HA state topic
    if (autoDiscovery || topic.startsWith('homeassistant/')) {
      const discTopic   = `homeassistant/${haEntityType(field)}/rtl433_${haSlug(model)}_${haSlug(id)}_${haSlug(field)}/config`;
      const discPayload = haDiscoveryPayload(model, id, field, topic, overrides);
      fetch(API_BASE + '/api/publish', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ topic: discTopic, value: JSON.stringify(discPayload), retain: true }),
      }).catch(() => {/* best-effort */});
    }
  } else {
    const { error } = await res.json();
    alert(`Could not save: ${error}`);
  }
}

async function doUnmap(model, id, field) {
  const res = await fetch(API_BASE + '/api/mappings', {
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
  const mapBtn     = e.target.closest('.btn-map');
  const unmapBtn   = e.target.closest('.btn-unmap');
  const renameBtn  = e.target.closest('.btn-rename');
  const pinBtn     = e.target.closest('.btn-pin');
  const ignoreBtn  = e.target.closest('.btn-ignore');
  const forgetBtn  = e.target.closest('.btn-forget');
  const testPubBtn = e.target.closest('.btn-test-publish');
  if (mapBtn)      openModal(mapBtn.dataset.model, mapBtn.dataset.id, mapBtn.dataset.field);
  if (unmapBtn)    doUnmap(unmapBtn.dataset.model, unmapBtn.dataset.id, unmapBtn.dataset.field);
  if (renameBtn)   openRenameInput(renameBtn);
  if (pinBtn)      togglePin(pinBtn.dataset.key);
  if (ignoreBtn)   toggleIgnore(ignoreBtn.dataset.key);
  if (forgetBtn)   doForget(forgetBtn.dataset.model, forgetBtn.dataset.id);
  if (testPubBtn)  doTestPublish(testPubBtn);
  // Click on device header (not on an action button) → expand/collapse + highlight stream
  if (!mapBtn && !unmapBtn && !renameBtn && !pinBtn && !ignoreBtn && !forgetBtn && !testPubBtn) {
    const header = e.target.closest('.device-header');
    if (header) {
      const card = header.closest('.device-card');
      if (card) {
        toggleCardExpand(card.dataset.deviceKey);
        selectDevice(card.dataset.deviceKey);
      }
    }
  }
});

// ── Card expand/collapse ──────────────────────────────────────────────────────
function toggleCardExpand(key) {
  if (state.expandedCards.has(key)) {
    state.expandedCards.delete(key);
  } else {
    state.expandedCards.add(key);
  }
  localStorage.setItem('rtl433-expanded', JSON.stringify([...state.expandedCards]));
  const card = document.querySelector(`.device-card[data-device-key="${CSS.escape(key)}"]`);
  if (card) card.classList.toggle('expanded', state.expandedCards.has(key));
}

// ── Card ↔ Stream link-highlighting ──────────────────────────────────────────
function selectDevice(key) {
  // Clear existing highlights
  document.querySelectorAll('.device-card.card-highlighted').forEach(el => el.classList.remove('card-highlighted'));
  document.querySelectorAll('.stream-entry.stream-highlighted').forEach(el => el.classList.remove('stream-highlighted'));
  if (!key || state.selectedKey === key) {
    state.selectedKey = null;
    return;
  }
  state.selectedKey = key;
  // Highlight the device card
  const card = document.querySelector(`.device-card[data-device-key="${CSS.escape(key)}"]`);
  if (card) {
    card.classList.add('card-highlighted');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  // Highlight matching stream entries and scroll to the newest one
  const entries = document.querySelectorAll(`.stream-entry[data-device-key="${CSS.escape(key)}"]`);
  entries.forEach(el => el.classList.add('stream-highlighted'));
  if (entries.length) entries[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('stream-list').addEventListener('click', e => {
  const entry = e.target.closest('.stream-entry');
  if (!entry) return;
  // Clicking the compact data line toggles expansion
  if (e.target.classList.contains('stream-data')) {
    const pre     = entry.querySelector('.stream-pretty');
    const expandBtn = entry.querySelector('.stream-expand');
    const open = pre.classList.toggle('hidden');
    expandBtn.textContent = open ? '\u25BC' : '\u25B2';
    entry.classList.toggle('stream-entry-expanded', !open);
    return;
  }
  // Clicking elsewhere (but not a button) selects the device
  if (!e.target.closest('button') && entry.dataset.deviceKey) selectDevice(entry.dataset.deviceKey);
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

document.querySelector('.modal-templates').addEventListener('click', async e => {
  const btn = e.target.closest('.btn-tpl');
  if (!btn || !pendingMap) return;
  const { model, id, field } = pendingMap;
  const topicInput = document.getElementById('modal-topic');

  if (btn.dataset.tpl === 'flat') {
    topicInput.value = haTopicFlat(model, id, field);
    topicInput.focus();
  } else if (btn.dataset.tpl === 'ha-state') {
    topicInput.value = haTopicState(model, id, field);
    topicInput.focus();
  } else if (btn.dataset.tpl === 'ha-disc') {
    // Set topic, publish discovery, save mapping and close — all in one click
    const stateTopic  = haTopicState(model, id, field);
    topicInput.value  = stateTopic;
    const overrides   = collectAdvancedOverrides();
    const discTopic   = `homeassistant/${haEntityType(field)}/rtl433_${haSlug(model)}_${haSlug(id)}_${haSlug(field)}/config`;
    const discPayload = haDiscoveryPayload(model, id, field, stateTopic, overrides);
    const orig = btn.textContent;
    btn.textContent = '...';
    btn.disabled    = true;
    try {
      const [pubRes] = await Promise.all([
        fetch(API_BASE + '/api/publish', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ topic: discTopic, value: JSON.stringify(discPayload), retain: true }),
        }),
        fetch(API_BASE + '/api/mappings', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ model, id, field, topic: stateTopic, ...overrides }),
        }),
      ]);
      if (pubRes.ok) {
        state.mappings[`${model}.${id}.${field}`] = { topic: stateTopic, ...overrides };
        renderMappings();
        renderDevices();
        setTimeout(() => closeModal(), 600);
        btn.textContent = 'Saved ✓';
      } else {
        btn.textContent = 'Error';
      }
    } catch {
      btn.textContent = 'Error';
    }
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  }
});

document.getElementById('sort-by-signal').addEventListener('change', e => {
  state.sortBySignal = e.target.checked;
  renderDevices();
});

document.getElementById('clear-stream').addEventListener('click', () => {
  document.getElementById('stream-list').innerHTML = '';
});

// Log panel: clear button + toggle collapse
document.getElementById('clear-logs').addEventListener('click', e => {
  e.stopPropagation(); // don't trigger the toggle
  logClear();
});

document.getElementById('log-panel-toggle').addEventListener('click', e => {
  // Clear-logs button click should not toggle expansion
  if (e.target.closest('#clear-logs')) return;
  const panel = document.getElementById('log-panel');
  if (panel.classList.contains('log-panel-expanded')) {
    panel.classList.remove('log-panel-expanded');
  } else {
    panel.classList.remove('log-panel-collapsed');
    panel.classList.add('log-panel-expanded');
    // Scroll to bottom when expanding so latest logs are visible
    const list = document.getElementById('log-list');
    list.scrollTop = list.scrollHeight;
  }
});

document.getElementById('clear-ignored').addEventListener('click', () => {
  state.ignored = [];
  localStorage.removeItem('rtl433-ignored');
  document.getElementById('clear-ignored').style.display = 'none';
  renderDevices();
});

if (state.ignored.length) document.getElementById('clear-ignored').style.display = '';

// ── Bulk HA discovery ─────────────────────────────────────────────────────────
document.getElementById('btn-ha-discovery').addEventListener('click', async function () {
  const btn     = this;
  const entries = Object.entries(state.mappings);
  if (!entries.length) return;
  btn.disabled    = true;
  btn.textContent = `... 0/${entries.length}`;
  let ok = 0;
  for (const [mkey, mapping] of entries) {
    const parts      = mkey.split('.');
    const model      = parts[0], id = parts[1], field = parts.slice(2).join('.');
    const stateTopic = typeof mapping === 'string' ? mapping : mapping.topic;
    const overrides  = typeof mapping === 'object' ? mapping : {};
    const discTopic   = `homeassistant/${haEntityType(field)}/rtl433_${haSlug(model)}_${haSlug(id)}_${haSlug(field)}/config`;
    const discPayload = haDiscoveryPayload(model, id, field, stateTopic, overrides);
    try {
      const res = await fetch(API_BASE + '/api/publish', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ topic: discTopic, value: JSON.stringify(discPayload), retain: true }),
      });
      if (res.ok) ok++;
    } catch { /* skip */ }
    btn.textContent = `... ${ok}/${entries.length}`;
  }
  btn.textContent = `${ok}/${entries.length} published`;
  btn.disabled    = false;
  setTimeout(() => { btn.textContent = 'HA Discovery'; }, 3000);
});

// ── Test publish ──────────────────────────────────────────────────────────────
async function doTestPublish(btn) {
  const { topic, value } = btn.dataset;
  btn.disabled    = true;
  btn.textContent = '...';
  try {
    const res = await fetch(API_BASE + '/api/publish', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ topic, value }),
    });
    btn.textContent = res.ok ? 'OK' : 'ERR';
  } catch {
    btn.textContent = 'ERR';
  }
  setTimeout(() => { btn.textContent = '\u25ba'; btn.disabled = false; }, 1500);
}

// ── Pin / ignore / forget ─────────────────────────────────────────────────────
function togglePin(key) {
  const i = state.pinned.indexOf(key);
  if (i === -1) state.pinned.push(key);
  else          state.pinned.splice(i, 1);
  localStorage.setItem('rtl433-pinned', JSON.stringify(state.pinned));
  renderDevices();
}

function toggleIgnore(key) {
  if (!confirm('Hide this device? You can restore it by clicking "Show ignored".')) return;
  state.ignored.push(key);
  localStorage.setItem('rtl433-ignored', JSON.stringify(state.ignored));
  document.getElementById('clear-ignored').style.display = state.ignored.length ? '' : 'none';
  renderDevices();
}

async function doForget(model, id) {
  if (!confirm(`Remove ${model} (ID: ${id}) from the device list? It will reappear if it transmits again.`)) return;
  const key = `${model}|${id}`;
  state.devices.delete(key);
  for (const k of state.history.keys()) {
    if (k.startsWith(key + '|')) state.history.delete(k);
  }
  const pi = state.pinned.indexOf(key);  if (pi !== -1) state.pinned.splice(pi, 1);
  const ii = state.ignored.indexOf(key); if (ii !== -1) state.ignored.splice(ii, 1);
  localStorage.setItem('rtl433-pinned',  JSON.stringify(state.pinned));
  localStorage.setItem('rtl433-ignored', JSON.stringify(state.ignored));
  renderDevices();
  await fetch(API_BASE + '/api/devices', {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, id }),
  });
}

// ── Device rename ─────────────────────────────────────────────────────────────
function openRenameInput(btn) {
  const key    = btn.dataset.key;
  const header = btn.closest('.device-header');
  const target = header.querySelector('.device-label') || header.querySelector('.device-model');
  const current = state.labels[key] || '';

  const input = document.createElement('input');
  input.type        = 'text';
  input.className   = 'rename-input';
  input.value       = current;
  input.placeholder = 'Enter label...';
  input.maxLength   = 40;
  target.replaceWith(input);
  const sub = header.querySelector('.device-model-sub');
  if (sub) sub.style.display = 'none';
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    if (val) state.labels[key] = val;
    else     delete state.labels[key];
    localStorage.setItem('rtl433-labels', JSON.stringify(state.labels));
    const dev = state.devices.get(key);
    if (dev) upsertDeviceCard(dev);
  }

  input.addEventListener('blur',    commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

// ── Periodic "last seen" refresh ─────────────────────────────────────────────
setInterval(() => {
  for (const el of document.querySelectorAll('.last-seen[data-ts]')) {
    const ts = parseInt(el.dataset.ts, 10);
    el.textContent = timeAgo(ts);
    el.className = `device-meta last-seen ${ageClass(ts)}`;
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
    const res = await fetch(API_BASE + '/api/frequency', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ frequency: freq }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error ?? msg; } catch { /* non-JSON body */ }
      alert(`Frequency change failed: ${msg}`);
      updateFreqButtons(state.frequency); // revert UI
    } else {
      // Command sent to rtl_433 via MQTT — update state optimistically
      state.frequency = freq;
      updateFreqButtons(freq);
    }
  } catch (err) {
    alert(`Network error switching frequency: ${err.message}`);
    updateFreqButtons(state.frequency);
  }
});

// ── Frequency scanner ─────────────────────────────────────────────────────────
const SCAN_FREQS = ['433.92M', '315M', '868M', '915M'];

// Duration options in ms per band per pass
const SCAN_WINDOWS = { '30s': 30_000, '1m': 60_000, '5m': 300_000 };

// Scanner extended state (on top of state.scanner)
let scanWindowMs   = 60_000;   // default: 1 min per band
let scanTimerEnd   = 0;        // absolute ms when current window ends
let scanTimerRaf   = null;     // rAF handle for progress bar
let scanPassCount  = 0;        // how many full passes completed
let scanFreqIdx    = 0;        // which freq we are currently on

function abortScan() {
  state.scanner.active  = false;
  state.scanner.aborted = true;
  if (scanTimerRaf) { cancelAnimationFrame(scanTimerRaf); scanTimerRaf = null; }
  const btn = document.getElementById('btn-scan');
  btn.disabled    = false;
  btn.textContent = '⏵ Scan bands';
  renderScanResults(false); // show final results, keep panel open
}

// Animate the progress bar for the current window
function tickScanProgress() {
  if (!state.scanner.active) return;
  const remaining = Math.max(0, scanTimerEnd - Date.now());
  const pct       = 100 - Math.round((remaining / scanWindowMs) * 100);
  const barEl     = document.getElementById('scan-progress-bar');
  if (barEl) barEl.style.width = `${pct}%`;

  const labelEl = document.getElementById('scan-progress-label');
  if (labelEl) {
    const secLeft = Math.ceil(remaining / 1000);
    labelEl.textContent = `${SCAN_FREQS[scanFreqIdx]} — ${secLeft}s left`;
  }
  scanTimerRaf = requestAnimationFrame(tickScanProgress);
}

async function tuneTo(freq) {
  try {
    await fetch(API_BASE + '/api/frequency', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ frequency: freq }),
    });
  } catch { /* network error - continue scan */ }
}

async function startScan() {
  if (state.scanner.active) return;
  state.scanner.active        = true;
  state.scanner.aborted       = false;
  state.scanner.results       = {};
  state.scanner.packetsThisWindow = 0;
  scanPassCount = 0;
  scanFreqIdx   = 0;

  const btn       = document.getElementById('btn-scan');
  const resultsEl = document.getElementById('scan-results');
  btn.disabled            = true;
  resultsEl.style.display = '';
  renderScanLive();

  // Continuous multi-pass loop — runs until abortScan() is called
  while (state.scanner.active) {
    const freq = SCAN_FREQS[scanFreqIdx];
    state.scanner.packetsThisWindow = 0;
    scanTimerEnd = Date.now() + scanWindowMs;

    await tuneTo(freq);

    // Start progress animation
    if (scanTimerRaf) cancelAnimationFrame(scanTimerRaf);
    scanTimerRaf = requestAnimationFrame(tickScanProgress);

    // Wait for the window
    await new Promise(r => setTimeout(r, scanWindowMs));
    if (scanTimerRaf) { cancelAnimationFrame(scanTimerRaf); scanTimerRaf = null; }

    if (state.scanner.aborted) return;

    // Accumulate results (add this window's count to running total)
    state.scanner.results[freq] = (state.scanner.results[freq] ?? 0) + state.scanner.packetsThisWindow;

    // Advance to next band
    scanFreqIdx = (scanFreqIdx + 1) % SCAN_FREQS.length;
    if (scanFreqIdx === 0) scanPassCount++;

    renderScanLive();
  }
}

function renderScanLive() {
  const el = document.getElementById('scan-results');
  if (!el) return;
  const results = state.scanner.results;
  const max     = Math.max(...SCAN_FREQS.map(f => results[f] ?? 0), 1);
  const best    = SCAN_FREQS.reduce((b, f) =>
    (results[f] ?? 0) > (results[b] ?? 0) ? f : b, SCAN_FREQS[0]);
  const hasCounts = SCAN_FREQS.some(f => (results[f] ?? 0) > 0);

  el.innerHTML =
    `<div class="scan-header-row">` +
    `<span class="scan-pass-label">Pass ${scanPassCount + 1} &middot; ${scanWindowLabel()}/band</span>` +
    `<div class="scan-window-btns">` +
    Object.keys(SCAN_WINDOWS).map(k =>
      `<button class="btn-scan-window${scanWindowMs === SCAN_WINDOWS[k] ? ' active' : ''}" data-ms="${SCAN_WINDOWS[k]}">${k}</button>`
    ).join('') +
    `</div>` +
    `<button class="scan-stop-btn" id="btn-scan-stop">⏹ Stop</button>` +
    `</div>` +
    `<div class="scan-progress-wrap">` +
    `<div class="scan-progress-track"><div class="scan-progress-bar" id="scan-progress-bar" style="width:0%"></div></div>` +
    `<span class="scan-progress-label" id="scan-progress-label">${SCAN_FREQS[scanFreqIdx]}</span>` +
    `</div>` +
    `<div class="scan-results-grid">` +
    SCAN_FREQS.map(f => {
      const n      = results[f] ?? 0;
      const w      = Math.round((n / max) * 100);
      const isBest = f === best && hasCounts;
      const isActive = state.scanner.active && f === SCAN_FREQS[scanFreqIdx];
      const color  = isBest ? 'var(--green)' : isActive ? 'var(--accent)' : 'var(--text-dim)';
      return `<span class="scan-freq${isBest ? ' best' : ''}${isActive ? ' scanning' : ''}">${escHtml(f)}</span>` +
             `<span class="scan-bar-wrap"><span class="scan-bar" style="width:${w}%;background:${color}"></span></span>` +
             `<span class="scan-count">${n} pkt</span>`;
    }).join('') +
    `</div>`;

  document.getElementById('btn-scan-stop')?.addEventListener('click', abortScan);
  document.querySelectorAll('.btn-scan-window').forEach(b => {
    b.addEventListener('click', () => {
      scanWindowMs = parseInt(b.dataset.ms, 10);
      renderScanLive(); // re-render to update active button
    });
  });
}

function renderScanResults(keepOpen = true) {
  const el = document.getElementById('scan-results');
  if (!el) return;
  const results = state.scanner.results;
  const max     = Math.max(...SCAN_FREQS.map(f => results[f] ?? 0), 1);
  const best    = SCAN_FREQS.reduce((b, f) =>
    (results[f] ?? 0) > (results[b] ?? 0) ? f : b, SCAN_FREQS[0]);
  const hasCounts = SCAN_FREQS.some(f => (results[f] ?? 0) > 0);

  if (!keepOpen && !hasCounts) {
    el.style.display = 'none';
    document.getElementById('btn-scan').disabled    = false;
    document.getElementById('btn-scan').textContent = '⏵ Scan bands';
    return;
  }

  el.innerHTML =
    `<div class="scan-header-row">` +
    `<span class="scan-pass-label">Scan complete &middot; ${scanPassCount} pass${scanPassCount !== 1 ? 'es' : ''}</span>` +
    `<button class="scan-close" id="btn-scan-dismiss">Dismiss</button>` +
    `</div>` +
    `<div class="scan-results-grid">` +
    SCAN_FREQS.map(f => {
      const n      = results[f] ?? 0;
      const w      = Math.round((n / max) * 100);
      const isBest = f === best && hasCounts;
      const color  = isBest ? 'var(--green)' : 'var(--accent)';
      return `<span class="scan-freq${isBest ? ' best' : ''}">${escHtml(f)}</span>` +
             `<span class="scan-bar-wrap"><span class="scan-bar" style="width:${w}%;background:${color}"></span></span>` +
             `<span class="scan-count">${n} pkt</span>`;
    }).join('') +
    `</div>`;

  document.getElementById('btn-scan-dismiss')?.addEventListener('click', () => {
    el.style.display = 'none';
    document.getElementById('btn-scan').disabled    = false;
    document.getElementById('btn-scan').textContent = '⏵ Scan bands';
  });
}

function scanWindowLabel() {
  return Object.entries(SCAN_WINDOWS).find(([, ms]) => ms === scanWindowMs)?.[0] ?? '?';
}

document.getElementById('btn-scan').addEventListener('click', startScan);

// ── RSSI filter ───────────────────────────────────────────────────────────────
document.getElementById('rssi-filter').addEventListener('input', e => {
  state.minRssi = parseInt(e.target.value, 10);
  document.getElementById('rssi-filter-val').textContent =
    state.minRssi <= -120 ? 'All' : `${state.minRssi} dBm`;
  renderDevices();
});

// ── Age filter ────────────────────────────────────────────────────────────────
document.getElementById('age-filter').addEventListener('click', e => {
  const btn = e.target.closest('.btn-age');
  if (!btn) return;
  state.maxAgeMs = parseInt(btn.dataset.ms, 10);
  for (const b of document.querySelectorAll('.btn-age')) b.classList.remove('active');
  btn.classList.add('active');
  renderDevices();
});

// ── Config modal ─────────────────────────────────────────────────────────────
const configModal    = document.getElementById('config-modal');
const cfgUrlInput    = document.getElementById('cfg-mqtt-url');
const cfgUserInput   = document.getElementById('cfg-mqtt-user');
const cfgPassInput   = document.getElementById('cfg-mqtt-pass');
const cfgPassHint    = document.getElementById('cfg-mqtt-pass-hint');
const cfgError       = document.getElementById('config-error');
const cfgRtlConf     = document.getElementById('cfg-rtl433-conf');
const cfgRtlBadge    = document.getElementById('cfg-rtl433-proc-badge');

function updateRtl433ProcBadge(status) {
  // Update both the header badge and the modal badge
  const headerEl = document.getElementById('status-rtl433proc');
  if (headerEl) {
    headerEl.textContent = `rtl_433: ${status}`;
    headerEl.className   = `badge ${status}`;
  }
  if (cfgRtlBadge) {
    cfgRtlBadge.textContent = status;
    cfgRtlBadge.className   = `badge cfg-proc-badge ${status}`;
  }
}

async function openConfigModal() {
  cfgError.style.display = 'none';
  cfgPassInput.value = '';
  try {
    const res  = await fetch(API_BASE + '/api/config');
    const data = await res.json();
    cfgUrlInput.value  = data.mqttUrl      || '';
    cfgUserInput.value = data.mqttUsername || '';
    cfgPassHint.style.display = data.mqttHasPassword ? '' : 'none';
  } catch {
    cfgUrlInput.value  = '';
    cfgUserInput.value = '';
  }
  // Load rtl_433 config file + process status
  try {
    const [confRes, statRes] = await Promise.all([
      fetch(API_BASE + '/api/rtl433/config'),
      fetch(API_BASE + '/api/rtl433/status'),
    ]);
    cfgRtlConf.value = await confRes.text();
    const stat = await statRes.json();
    updateRtl433ProcBadge(stat.status);
  } catch { /* ignore */ }
  configModal.classList.remove('hidden');
  cfgUrlInput.focus();
}

function closeConfigModal() {
  configModal.classList.add('hidden');
}

document.getElementById('btn-config').addEventListener('click', openConfigModal);
document.getElementById('config-cancel').addEventListener('click', closeConfigModal);
configModal.addEventListener('click', e => { if (e.target === configModal) closeConfigModal(); });

// rtl_433 process controls
document.getElementById('cfg-rtl433-start').addEventListener('click', async () => {
  await fetch(API_BASE + '/api/rtl433/start', { method: 'POST' });
  setTimeout(async () => {
    const r = await fetch(API_BASE + '/api/rtl433/status');
    updateRtl433ProcBadge((await r.json()).status);
  }, 600);
});
document.getElementById('cfg-rtl433-stop').addEventListener('click', async () => {
  await fetch(API_BASE + '/api/rtl433/stop', { method: 'POST' });
  setTimeout(async () => {
    const r = await fetch(API_BASE + '/api/rtl433/status');
    updateRtl433ProcBadge((await r.json()).status);
  }, 600);
});
document.getElementById('cfg-rtl433-restart').addEventListener('click', async () => {
  await fetch(API_BASE + '/api/rtl433/restart', { method: 'POST' });
  setTimeout(async () => {
    const r = await fetch(API_BASE + '/api/rtl433/status');
    updateRtl433ProcBadge((await r.json()).status);
  }, 800);
});

// Save rtl_433 config file and restart subprocess
document.getElementById('cfg-rtl433-save').addEventListener('click', async () => {
  const text = cfgRtlConf.value;
  try {
    await fetch(API_BASE + '/api/rtl433/config', {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    text,
    });
    // Show brief feedback on the button
    const btn = document.getElementById('cfg-rtl433-save');
    const orig = btn.textContent;
    btn.textContent = 'Saved & restarting…';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  } catch (err) {
    cfgError.textContent = `Failed to save: ${err.message}`;
    cfgError.style.display = '';
  }
});

// Load config file from disk
document.getElementById('cfg-rtl433-load-file').addEventListener('click', () => {
  document.getElementById('cfg-rtl433-file-input').click();
});
document.getElementById('cfg-rtl433-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { cfgRtlConf.value = ev.target.result; };
  reader.readAsText(file);
  e.target.value = ''; // reset so same file can be re-selected
});

// Update badge when subprocess status changes via WebSocket
function handleRtl433ProcStatus(status) {
  updateRtl433ProcBadge(status);
}

document.getElementById('config-save').addEventListener('click', async () => {
  cfgError.style.display = 'none';
  const url  = cfgUrlInput.value.trim();
  const user = cfgUserInput.value.trim();
  const pass = cfgPassInput.value;  // don't trim passwords

  if (!url) {
    cfgError.textContent = 'Broker URL is required.';
    cfgError.style.display = '';
    cfgUrlInput.focus();
    return;
  }
  if (!url.startsWith('mqtt://') && !url.startsWith('mqtts://')) {
    cfgError.textContent = 'URL must start with mqtt:// or mqtts://';
    cfgError.style.display = '';
    cfgUrlInput.focus();
    return;
  }

  const body = { mqttUrl: url, mqttUsername: user };
  if (pass) body.mqttPassword = pass;  // only send if user typed something

  try {
    const res  = await fetch(API_BASE + '/api/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      cfgError.textContent = data.error || 'Failed to save settings.';
      cfgError.style.display = '';
      return;
    }
    closeConfigModal();
  } catch (err) {
    cfgError.textContent = `Network error: ${err.message}`;
    cfgError.style.display = '';
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────
wsConnect();
