'use strict';
const express      = require('express');
const store        = require('./store');
const mqttClient   = require('./mqtt');
const rtl433proc   = require('./rtl433proc');
const config       = require('./config');

const router = express.Router();
router.use(express.json());

// GET /api/status
router.get('/status', (_req, res) => {
  res.json({
    mqtt:    mqttClient.getStatus(),
    rtl433:  store.getRtl433Status(),
  });
});

// POST /api/frequency  { frequency: '433.92M' }
// Restarts the local rtl_433 subprocess with the new frequency AND publishes
// an MQTT command so external rtl_433 instances also retune.
router.post('/frequency', (req, res) => {
  const { frequency } = req.body ?? {};
  // Accept formats like 433.92M, 315M, 868M, 915M
  if (!frequency || !/^[\d.]+[MkKgG]$/.test(String(frequency))) {
    return res.status(400).json({ error: 'Invalid frequency (e.g. "433.92M")' });
  }
  const freq = String(frequency);
  // Retune local subprocess
  rtl433proc.setFrequency(freq);
  // Also publish MQTT command for any external rtl_433 instances
  const cmd = JSON.stringify({ cmd: 'set_freq', freq });
  mqttClient.publish(config.mqttCommandTopic, cmd);
  res.json({ ok: true, frequency: freq });
});

// ── rtl_433 subprocess endpoints ─────────────────────────────────────────────

// GET /api/rtl433/status
router.get('/rtl433/status', (_req, res) => {
  res.json(rtl433proc.getStatus());
});

// GET /api/rtl433/config  — returns current config file text
router.get('/rtl433/config', (_req, res) => {
  res.type('text/plain').send(rtl433proc.readConfig());
});

// POST /api/rtl433/config  — save config text and restart subprocess
router.post('/rtl433/config', express.text({ type: '*/*', limit: '512kb' }), (req, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  rtl433proc.writeConfig(text);
  rtl433proc.restart();
  res.json({ ok: true });
});

// POST /api/rtl433/start
router.post('/rtl433/start', (_req, res) => {
  rtl433proc.start();
  res.json({ ok: true });
});

// POST /api/rtl433/stop
router.post('/rtl433/stop', (_req, res) => {
  rtl433proc.stop();
  res.json({ ok: true });
});

// POST /api/rtl433/restart
router.post('/rtl433/restart', (_req, res) => {
  rtl433proc.restart();
  res.json({ ok: true });
});

// GET /api/devices
router.get('/devices', (_req, res) => {
  res.json(store.getDevices());
});

// GET /api/mappings
router.get('/mappings', (_req, res) => {
  res.json(store.getMappings());
});

// POST /api/mappings  { model, id, field, topic }
router.post('/mappings', (req, res) => {
  const { model, id, field, topic } = req.body ?? {};
  if (!model || !field || !topic) {
    return res.status(400).json({ error: '`model`, `field`, and `topic` are required' });
  }
  // Sanitise topic — must not contain wildcards
  if (/[#+]/.test(topic)) {
    return res.status(400).json({ error: 'MQTT topic must not contain wildcard characters (# or +)' });
  }
  store.addMapping(model, id, field, topic);
  res.json({ ok: true });
});

// DELETE /api/mappings  { model, id, field }
router.delete('/mappings', (req, res) => {
  const { model, id, field } = req.body ?? {};
  if (!model || !field) {
    return res.status(400).json({ error: '`model` and `field` are required' });
  }
  store.removeMapping(model, id, field);
  res.json({ ok: true });
});

// DELETE /api/devices  { model, id }
router.delete('/devices', (req, res) => {
  const { model, id } = req.body ?? {};
  if (!model) return res.status(400).json({ error: '`model` is required' });
  const removed = store.forgetDevice(model, id);
  res.json({ ok: true, removed });
});

// POST /api/publish  { topic, value }
// Immediately publishes a test message to the given MQTT topic.
router.post('/publish', (req, res) => {
  const { topic, value, retain } = req.body ?? {};
  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ error: '`topic` is required' });
  }
  if (/[#+]/.test(topic)) {
    return res.status(400).json({ error: 'MQTT topic must not contain wildcard characters (# or +)' });
  }
  mqttClient.publish(topic, value ?? '', { retain: retain === true });
  res.json({ ok: true });
});

// GET /api/config
// Returns current runtime config (never returns password value).
router.get('/config', (_req, res) => {
  res.json({
    mqttUrl:      config.mqttUrl,
    mqttUsername: config.mqttUsername,
    mqttHasPassword: !!config.mqttPassword,
  });
});

// POST /api/config  { mqttUrl, mqttUsername, mqttPassword }
// Saves settings and reconnects MQTT with new credentials.
router.post('/config', (req, res) => {
  const { mqttUrl, mqttUsername, mqttPassword } = req.body ?? {};

  if (mqttUrl !== undefined) {
    if (typeof mqttUrl !== 'string' || !mqttUrl.startsWith('mqtt')) {
      return res.status(400).json({ error: '`mqttUrl` must start with mqtt:// or mqtts://' });
    }
    config.mqttUrl = mqttUrl;
  }
  if (mqttUsername !== undefined) config.mqttUsername = String(mqttUsername);
  if (mqttPassword !== undefined) config.mqttPassword = String(mqttPassword);

  const patch = {};
  if (mqttUrl      !== undefined) patch.mqttUrl      = config.mqttUrl;
  if (mqttUsername !== undefined) patch.mqttUsername = config.mqttUsername;
  if (mqttPassword !== undefined) patch.mqttPassword = config.mqttPassword;
  config.saveSettings(patch);

  mqttClient.reconnect();
  res.json({ ok: true });
});

module.exports = router;
