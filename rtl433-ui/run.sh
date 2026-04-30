#!/usr/bin/with-contenv bashio
# ─────────────────────────────────────────────────────────────────────────────
# RTL433-UI – Home Assistant add-on entry point
# Requires the rtl_433 add-on (pbkhrv/rtl_433-hass-addons) to be running
# and publishing device events to MQTT.
# ─────────────────────────────────────────────────────────────────────────────

bashio::log.info "RTL433-UI starting up…"

# Read config values — use bashio::config with || fallback to handle
# edge cases where bashio returns non-zero for empty-string values.
MQTT_URL=$(bashio::config 'mqtt_url' 2>/dev/null || echo 'mqtt://core-mosquitto:1883')
MQTT_USERNAME=$(bashio::config 'mqtt_username' 2>/dev/null || echo '')
MQTT_PASSWORD=$(bashio::config 'mqtt_password' 2>/dev/null || echo '')
MQTT_TOPIC_PREFIX=$(bashio::config 'mqtt_topic_prefix' 2>/dev/null || echo 'rtl_433')
MQTT_COMMAND_TOPIC=$(bashio::config 'mqtt_command_topic' 2>/dev/null || echo 'rtl_433/command')

# Strip surrounding quotes that bashio sometimes leaves in
MQTT_URL="${MQTT_URL//\"/}"
MQTT_USERNAME="${MQTT_USERNAME//\"/}"
MQTT_PASSWORD="${MQTT_PASSWORD//\"/}"
MQTT_TOPIC_PREFIX="${MQTT_TOPIC_PREFIX//\"/}"
MQTT_COMMAND_TOPIC="${MQTT_COMMAND_TOPIC//\"/}"

export MQTT_URL
export MQTT_USERNAME
export MQTT_PASSWORD
export MQTT_TOPIC_PREFIX
export MQTT_COMMAND_TOPIC
export PORT="3000"

# Store mappings and browser-saved settings in /data so they survive
# add-on restarts and updates (HA mounts /data as a persistent volume).
export MAPPINGS_FILE="/data/mappings.json"
export SETTINGS_FILE="/data/settings.json"

bashio::log.info "MQTT broker:      ${MQTT_URL}"
bashio::log.info "Events topic:     ${MQTT_TOPIC_PREFIX}/+/events"
bashio::log.info "Command topic:    ${MQTT_COMMAND_TOPIC}"
bashio::log.info "Listening on:     port ${PORT}"

# Verify node is available before handing off
if ! command -v node >/dev/null 2>&1; then
  bashio::log.fatal "node binary not found — Docker build may have failed"
  exit 1
fi

bashio::log.info "Node.js version:  $(node --version)"

cd /app
exec node server/index.js

