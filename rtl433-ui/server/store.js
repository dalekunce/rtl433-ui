'use strict';
const fs   = require('fs');
const path = require('path');
const config = require('./config');

// ── In-memory device store ─────────────────────────────────────────────────
// key: "Model|id" (id may be the string 'unknown' for devices without an ID)
const devices = new Map();

// Fields excluded from the mapping UI (signal metadata, not sensor data)
const META_FIELDS = new Set([
  'time', 'model', 'id', 'channel', 'mic', 'mod',
  'freq', 'freq1', 'freq2', 'rssi', 'snr', 'noise',
  'protocol', 'message_type',
]);

/**
 * Normalise a device id to a stable string.
 * rtl_433 emits numeric ids; absent ids are undefined/null.
 */
function safeId(id) {
  return (id !== undefined && id !== null) ? String(id) : 'unknown';
}

function deviceKey(model, id) {
  return `${model}|${safeId(id)}`;
}

/** Update (or create) a device entry from a decoded rtl_433 JSON object. */
function updateDevice(data) {
  const { time, model, id, channel, rssi, snr, noise, ...rest } = data;
  if (!model) return null;

  const now = Date.now();
  const key  = deviceKey(model, id);

  // Collect only meaningful sensor fields
  const fields = {};
  for (const [k, v] of Object.entries(rest)) {
    if (!META_FIELDS.has(k) && (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')) {
      fields[k] = { value: v, lastSeen: now };
    }
  }

  if (devices.has(key)) {
    const dev = devices.get(key);
    dev.lastSeen    = now;
    dev.signalCount += 1;
    if (channel !== undefined) dev.channel = channel;
    if (rssi    !== undefined) dev.rssi    = rssi;
    Object.assign(dev.fields, fields);
  } else {
    devices.set(key, {
      model,
      id:          safeId(id),
      channel:     channel ?? null,
      rssi:        rssi    ?? null,
      firstSeen:   now,
      lastSeen:    now,
      signalCount: 1,
      fields,
    });
  }

  return devices.get(key);
}

function getDevices() {
  return Array.from(devices.values());
}

/** Remove a single device by model+id. Returns true if it existed. */
function forgetDevice(model, id) {
  const key = deviceKey(model, safeId(id));
  return devices.delete(key);
}

/** Remove devices not seen for more than config.forgetAfterMs. */
function purgeStale() {
  if (!config.forgetAfterMs) return;
  const cutoff = Date.now() - config.forgetAfterMs;
  for (const [key, dev] of devices.entries()) {
    if (dev.lastSeen < cutoff) devices.delete(key);
  }
}

// ── Mappings ───────────────────────────────────────────────────────────────
// Mapping key format: "Model.id.fieldName"  (id is always the safeId string)
let mappings = {};

function loadMappings() {
  try {
    mappings = JSON.parse(fs.readFileSync(config.mappingsFile, 'utf8'));
  } catch {
    mappings = {};
  }
}

function saveMappings() {
  fs.mkdirSync(path.dirname(config.mappingsFile), { recursive: true });
  fs.writeFileSync(config.mappingsFile, JSON.stringify(mappings, null, 2), 'utf8');
}

function mappingKey(model, id, field) {
  return `${model}.${safeId(id)}.${field}`;
}

function addMapping(model, id, field, topic) {
  mappings[mappingKey(model, id, field)] = topic;
  saveMappings();
}

function removeMapping(model, id, field) {
  delete mappings[mappingKey(model, id, field)];
  saveMappings();
}

function getMappings() {
  return { ...mappings };
}

/**
 * Return field→topic map for a single device.
 * Used by the MQTT publisher to find relevant topics quickly.
 */
function getMappingsForDevice(model, id) {
  const prefix = `${model}.${safeId(id)}.`;
  const result = {};
  for (const [k, v] of Object.entries(mappings)) {
    if (k.startsWith(prefix)) result[k.slice(prefix.length)] = v;
  }
  return result;
}

loadMappings();

// ── rtl_433 data-flow status ──────────────────────────────────────────────
let _lastDataAt = 0;
const RTL433_IDLE_MS = 30_000; // 30 s without a packet → consider idle

function recordDataReceived() {
  _lastDataAt = Date.now();
}

function getRtl433Status() {
  if (_lastDataAt === 0) return 'waiting';
  return (Date.now() - _lastDataAt) < RTL433_IDLE_MS ? 'receiving' : 'idle';
}

module.exports = {
  updateDevice,
  getDevices,
  forgetDevice,
  purgeStale,
  addMapping,
  removeMapping,
  getMappings,
  getMappingsForDevice,
  recordDataReceived,
  getRtl433Status,
};
