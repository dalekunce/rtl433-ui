'use strict';
const mqtt   = require('mqtt');
const config = require('./config');

let client    = null;
let connected = false;

function connect() {
  console.log(`[mqtt] Connecting to ${config.mqttUrl}`);

  client = mqtt.connect(config.mqttUrl, {
    clientId:        `rtl433-ui-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 5_000,
    connectTimeout:  10_000,
  });

  client.on('connect', () => {
    connected = true;
    console.log('[mqtt] Connected');
  });

  client.on('reconnect', () => {
    console.log('[mqtt] Reconnecting…');
  });

  client.on('error', err => {
    console.error(`[mqtt] Error: ${err.message}`);
  });

  client.on('close', () => {
    connected = false;
  });
}

/**
 * Publish a single scalar value to its mapped MQTT topic.
 * Does nothing if the broker is unavailable or the field is not mapped.
 *
 * @param {string} topic   - MQTT topic string
 * @param {*}      value   - the field value (converted to string for publishing)
 */
function publish(topic, value) {
  if (!connected || !client || !topic) return;
  client.publish(topic, String(value), { retain: false, qos: 0 });
}

function getStatus() {
  return connected ? 'connected' : 'disconnected';
}

connect();

module.exports = { publish, getStatus };
