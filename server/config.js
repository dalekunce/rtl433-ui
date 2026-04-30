'use strict';
const path = require('path');

// Load .env if present (simple parser — no extra dependency needed)
const fs = require('fs');
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

module.exports = {
  port:            parseInt(process.env.PORT                  || '3000', 10),
  mqttUrl:         process.env.MQTT_URL                       || 'mqtt://localhost:1883',
  rtl433Bin:       process.env.RTL433_BIN                     || 'rtl_433',
  rtl433Args:      (process.env.RTL433_ARGS                   || '-F json -M utc -M level').split(/\s+/).filter(Boolean),
  mappingsFile:    process.env.MAPPINGS_FILE                  || path.join(__dirname, '../config/mappings.json'),
  forgetAfterMs:   parseInt(process.env.FORGET_AFTER_SECONDS  || '0', 10) * 1000,
};
