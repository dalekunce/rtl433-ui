'use strict';
const mqtt         = require('mqtt');
const { EventEmitter } = require('events');
const config       = require('./config');

const emitter  = new EventEmitter();
let client     = null;
let connected  = false;

function _subscribe() {
  const topic = `${config.mqttTopicPrefix}/+/events`;
  client.subscribe(topic, { qos: 0 }, err => {
    if (err) console.error(`[mqtt] Subscribe error: ${err.message}`);
    else     console.log(`[mqtt] Subscribed to ${topic}`);
  });
}

function connect() {
  console.log(`[mqtt] Connecting to ${config.mqttUrl}`);

  const opts = {
    clientId:        `rtl433-ui-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 5_000,
    connectTimeout:  10_000,
  };
  if (config.mqttUsername) opts.username = config.mqttUsername;
  if (config.mqttPassword) opts.password = config.mqttPassword;

  client = mqtt.connect(config.mqttUrl, opts);

  client.on('connect', () => {
    connected = true;
    console.log('[mqtt] Connected');
    _subscribe();
    emitter.emit('status', 'connected');
  });

  client.on('reconnect', () => {
    console.log('[mqtt] Reconnecting…');
  });

  client.on('error', err => {
    console.error(`[mqtt] Error: ${err.message}`);
  });

  client.on('close', () => {
    connected = false;
    emitter.emit('status', 'disconnected');
  });

  client.on('message', (topic, payload) => {
    try {
      const data = JSON.parse(payload.toString());
      emitter.emit('data', data);
    } catch { /* skip non-JSON */ }
  });
}

function reconnect() {
  console.log('[mqtt] Reconnecting with new settings…');
  if (client) {
    client.end(true);
    client = null;
  }
  connected = false;
  connect();
}

function publish(topic, value, opts = {}) {
  if (!connected || !client || !topic) return;
  client.publish(topic, String(value), { retain: opts.retain === true, qos: 0 });
}

function getStatus() {
  return connected ? 'connected' : 'disconnected';
}

connect();

module.exports = { publish, getStatus, reconnect, on: emitter.on.bind(emitter) };

