'use strict';
const path = require('path');
const fs   = require('fs');

// Load .env if present (simple parser — no extra dependency needed)
const envFile = path.join(__dirname, '../.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

const settingsFile = process.env.SETTINGS_FILE
  || path.join(__dirname, '../config/settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch { /* ignore corrupt file */ }
  return {};
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
  return next;
}

const base = {
  port:          parseInt(process.env.PORT                  || '3000', 10),
  mqttUrl:       process.env.MQTT_URL                       || 'mqtt://localhost:1883',
  mqttUsername:  process.env.MQTT_USERNAME                  || '',
  mqttPassword:  process.env.MQTT_PASSWORD                  || '',
  rtl433Bin:     process.env.RTL433_BIN                     || '/opt/homebrew/bin/rtl_433',
  rtl433Args:    (process.env.RTL433_ARGS                   || '-F json -M utc -M level').split(/\s+/).filter(Boolean),
  mappingsFile:  process.env.MAPPINGS_FILE                  || path.join(__dirname, '../config/mappings.json'),
  forgetAfterMs: parseInt(process.env.FORGET_AFTER_SECONDS  || '0', 10) * 1000,
};

// Runtime settings override base (saved via /api/config)
const overrides = loadSettings();
const config = { ...base, ...overrides };

module.exports = { ...config, saveSettings, loadSettings };

