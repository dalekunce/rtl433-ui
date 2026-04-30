#!/usr/bin/with-contenv bashio
# ─────────────────────────────────────────────────────────────────────────────
# RTL433-UI – Home Assistant add-on entry point (s6 managed service)
# ─────────────────────────────────────────────────────────────────────────────

# Write directly to stdout first — visible even before bashio is ready
echo "[rtl433-ui] run.sh executing, node=$(node --version 2>/dev/null || echo 'NOT FOUND')"

bashio::log.info "RTL433-UI starting up…"

MQTT_URL=$(bashio::config 'mqtt_url')
MQTT_USERNAME=$(bashio::config 'mqtt_username')
MQTT_PASSWORD=$(bashio::config 'mqtt_password')
MQTT_TOPIC_PREFIX=$(bashio::config 'mqtt_topic_prefix')
MQTT_COMMAND_TOPIC=$(bashio::config 'mqtt_command_topic')

export MQTT_URL
export MQTT_USERNAME
export MQTT_PASSWORD
export MQTT_TOPIC_PREFIX
export MQTT_COMMAND_TOPIC
export PORT="3000"

export MAPPINGS_FILE="/data/mappings.json"
export SETTINGS_FILE="/data/settings.json"

bashio::log.info "MQTT broker:      ${MQTT_URL}"
bashio::log.info "Events topic:     ${MQTT_TOPIC_PREFIX}/+/events"
bashio::log.info "Node.js version:  $(node --version)"

cd /app
exec node server/index.js

