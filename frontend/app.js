'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  devices:       new Map(),   // "Model|id" → device object
  mappings:      {},          // "Model.id.field" → topic
  history:       new Map(),   // "Model|id|field" → number[] (capped at 20)
  labels:        JSON.parse(localStorage.getItem('rtl433-labels')  || '{}'),
  pinned:        JSON.parse(localStorage.getItem('rtl433-pinned')  || '[]'),
  ignored:       JSON.parse(localStorage.getItem('rtl433-ignored') || '[]'),
  rtl433Status:  'stopped',
  mqttStatus:    'disconnected',
  frequency:     null,
  sortBySignal:  false,
  stream:        [],
  minRssi:       -120,
  maxAgeMs:      0,
  newDevices:    new Set(),
  scanner:       { active: false, aborted: false, results: {}, packetsThisWindow: 0 },
  selectedKey:   null,  // currently highlighted device key for card-stream linking
  expandedCards: new Set(JSON.parse(localStorage.getItem('rtl433-expanded') || '[]')),
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
      // Abort any in-progress scan — server restarted
      if (state.scanner.active) abortScan();
      state.rtl433Status = msg.status.rtl433;
      state.mqttStatus   = msg.status.mqtt;
      state.frequency    = msg.status.frequency;
      state.mappings     = msg.mappings;
      state.devices.clear();
      for (const dev of msg.devices) state.devices.set(deviceKey(dev), dev);
      renderAll();
      break;

    case 'device_update': {
      const dev  = msg.device;
      const dkey = deviceKey(dev);
      const isNew = !state.devices.has(dkey);
      for (const [field, { value }] of Object.entries(dev.fields)) {
        if (typeof value !== 'number') continue;
        const hkey = `${dkey}|${field}`;
        if (!state.history.has(hkey)) state.history.set(hkey, []);
        const arr = state.history.get(hkey);
        arr.push(value);
        if (arr.length > 20) arr.shift();
      }
      if (state.scanner.active) state.scanner.packetsThisWindow++;
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
  for (const [key, topic] of entries) {
    const parts = key.split('.');
    const field = parts.slice(2).join('.');
    const model = parts[0];
    const id    = parts[1];

    const row = document.createElement('div');
    row.className = 'mapping-row';
    row.innerHTML = `
      <div class="mapping-info">
        <span class="mapping-key">${escHtml(key)}</span>
        <span class="mapping-arrow">&rarr;</span>
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
  // Tag entry so it can link to its device card
  if (data.model != null && data.id != null) {
    entry.dataset.deviceKey = `${data.model}|${data.id}`;
  }
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `
    <span class="stream-time">${time}</span>
    <span class="stream-data">${escHtml(JSON.stringify(data))}</span>
  `;
  // Auto-highlight if this device is currently selected
  if (entry.dataset.deviceKey && entry.dataset.deviceKey === state.selectedKey) {
    entry.classList.add('stream-highlighted');
  }
  list.prepend(entry);
  while (list.children.length > MAX_STREAM) list.removeChild(list.lastChild);
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
  consumption:          { type: 'sensor', device_class: 'gas',             unit: 'CCF',        precision: 0, state_class: 'total_increasing' },
  consumption_data:     { type: 'sensor', device_class: 'gas',             unit: 'CCF',        precision: 0, state_class: 'total_increasing' },
  current_consumption:  { type: 'sensor', device_class: 'gas',             unit: 'CCF',        precision: 0, state_class: 'total_increasing' },
  last_consumption:     { type: 'sensor', device_class: 'gas',             unit: 'CCF',        precision: 0, state_class: 'total_increasing' },
  water_m3:             { type: 'sensor', device_class: 'water',           unit: 'm\u00b3',    precision: 3, state_class: 'total_increasing' },
  water_L:              { type: 'sensor', device_class: 'water',           unit: 'L',          precision: 0, state_class: 'total_increasing' },
  energy_kWh:           { type: 'sensor', device_class: 'energy',          unit: 'kWh',        precision: 3, state_class: 'total_increasing' },
  current_A:            { type: 'sensor', device_class: 'current',         unit: 'A',          precision: 2 },
  voltage_V:            { type: 'sensor', device_class: 'voltage',         unit: 'V',          precision: 1 },
  apparent_power:       { type: 'sensor', device_class: 'apparent_power',  unit: 'VA',         precision: 1 },
};

// How long HA should wait (seconds) before marking a sensor unavailable.
// rtl_433 devices typically transmit every 30–300 s; we use a generous 3× headroom.
// Battery-powered devices often transmit every ~60 s, so 600 s = 10 min is safe.
const HA_EXPIRE_AFTER = 600;

function haEntityType(field) {
  return (HA_FIELD_META[field] || {}).type || 'sensor';
}

function haDiscoveryPayload(model, id, field, stateTopic) {
  const meta     = HA_FIELD_META[field] || {};
  const isBinary = meta.type === 'binary_sensor';
  const uid      = `rtl433_${haSlug(model)}_${haSlug(id)}_${haSlug(field)}`;
  const label    = state.labels[`${model}|${id}`] || model;
  const payload  = {
    name:         `${label} ${field.replace(/_/g, ' ')}`,
    unique_id:    uid,
    state_topic:  stateTopic,
    object_id:    uid,
    expire_after: HA_EXPIRE_AFTER,
    device: {
      identifiers:  [`rtl433_${haSlug(model)}_${haSlug(id)}`],
      name:         `${label} (${id})`,
      model:        model,
      manufacturer: 'rtl_433',
    },
  };
  if (meta.device_class) payload.device_class = meta.device_class;
  if (meta.unit)         payload.unit_of_measurement = meta.unit;
  if (meta.state_class)  payload.state_class = meta.state_class;
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

function openModal(model, id, field) {
  pendingMap = { model, id, field };
  const mkey = `${model}.${id}.${field}`;
  document.getElementById('modal-label').textContent = mkey;
  const existing = state.mappings[mkey];
  document.getElementById('modal-topic').value = existing || haTopicFlat(model, id, field);
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
  if (entry && entry.dataset.deviceKey) selectDevice(entry.dataset.deviceKey);
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
    const stateTopic  = haTopicState(model, id, field);
    topicInput.value  = stateTopic;
    const discTopic   = `homeassistant/${haEntityType(field)}/rtl433_${haSlug(model)}_${haSlug(id)}_${haSlug(field)}/config`;
    const discPayload = haDiscoveryPayload(model, id, field, stateTopic);
    const orig = btn.textContent;
    btn.textContent = '...';
    btn.disabled    = true;
    try {
      const res = await fetch('/api/publish', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ topic: discTopic, value: JSON.stringify(discPayload), retain: true }),
      });
      btn.textContent = res.ok ? 'Sent OK' : 'Send ERR';
    } catch {
      btn.textContent = 'Send ERR';
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
  for (const [mkey, stateTopic] of entries) {
    const parts = mkey.split('.');
    const model = parts[0], id = parts[1], field = parts.slice(2).join('.');
    const discTopic   = `homeassistant/${haEntityType(field)}/rtl433_${haSlug(model)}_${haSlug(id)}_${haSlug(field)}/config`;
    const discPayload = haDiscoveryPayload(model, id, field, stateTopic);
    try {
      const res = await fetch('/api/publish', {
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
    const res = await fetch('/api/publish', {
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
  await fetch('/api/devices', {
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

// ── Frequency scanner ─────────────────────────────────────────────────────────
const SCAN_FREQS     = ['433.92M', '315M', '868M', '915M'];
const SCAN_WINDOW_MS = 9000;

function abortScan() {
  state.scanner.active  = false;
  state.scanner.aborted = true;
  const btn = document.getElementById('btn-scan');
  btn.disabled    = false;
  btn.textContent = 'Scan bands';
  document.getElementById('scan-results').style.display = 'none';
}

async function startScan() {
  if (state.scanner.active) return;
  state.scanner.active  = true;
  state.scanner.aborted = false;
  state.scanner.results = {};

  const btn       = document.getElementById('btn-scan');
  const resultsEl = document.getElementById('scan-results');
  btn.disabled            = true;
  resultsEl.style.display = '';

  for (let i = 0; i < SCAN_FREQS.length; i++) {
    if (state.scanner.aborted) return;
    const freq = SCAN_FREQS[i];
    state.scanner.packetsThisWindow = 0;
    resultsEl.innerHTML = `<span class="scan-status">Scanning ${escHtml(freq)}... (${i + 1}/${SCAN_FREQS.length})</span>`;
    try {
      await fetch('/api/frequency', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ frequency: freq }),
      });
    } catch { /* network error - continue */ }
    await new Promise(r => setTimeout(r, SCAN_WINDOW_MS));
    if (state.scanner.aborted) return;
    state.scanner.results[freq] = state.scanner.packetsThisWindow;
  }

  state.scanner.active = false;
  btn.disabled         = false;
  btn.textContent      = 'Scan bands';
  renderScanResults();
}

function renderScanResults() {
  const el      = document.getElementById('scan-results');
  const results = state.scanner.results;
  const max     = Math.max(...Object.values(results), 1);
  const best    = SCAN_FREQS.reduce((b, f) =>
    (results[f] ?? 0) > (results[b] ?? 0) ? f : b, SCAN_FREQS[0]);

  el.innerHTML =
    '<div class="scan-results-grid">' +
    SCAN_FREQS.map(f => {
      const n      = results[f] ?? 0;
      const w      = Math.round((n / max) * 100);
      const isBest = f === best && n > 0;
      const color  = isBest ? 'var(--green)' : 'var(--accent)';
      return `<span class="scan-freq${isBest ? ' best' : ''}">${escHtml(f)}</span>` +
             `<span class="scan-bar-wrap"><span class="scan-bar" style="width:${w}%;background:${color}"></span></span>` +
             `<span class="scan-count">${n} pkt</span>`;
    }).join('') +
    '</div>' +
    `<button class="scan-close" onclick="document.getElementById('scan-results').style.display='none'">X dismiss</button>`;
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

async function openConfigModal() {
  cfgError.style.display = 'none';
  cfgPassInput.value = '';
  try {
    const res  = await fetch('/api/config');
    const data = await res.json();
    cfgUrlInput.value  = data.mqttUrl      || '';
    cfgUserInput.value = data.mqttUsername || '';
    cfgPassHint.style.display = data.mqttHasPassword ? '' : 'none';
  } catch {
    cfgUrlInput.value  = '';
    cfgUserInput.value = '';
  }
  configModal.classList.remove('hidden');
  cfgUrlInput.focus();
}

function closeConfigModal() {
  configModal.classList.add('hidden');
}

document.getElementById('btn-config').addEventListener('click', openConfigModal);
document.getElementById('config-cancel').addEventListener('click', closeConfigModal);
configModal.addEventListener('click', e => { if (e.target === configModal) closeConfigModal(); });

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
    const res  = await fetch('/api/config', {
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
