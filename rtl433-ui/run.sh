#!/usr/bin/with-contenv bashio
# ─────────────────────────────────────────────────────────────────────────────
# RTL433-UI – Home Assistant add-on entry point
# Requires the rtl_433 add-on (pbkhrv/rtl_433-hass-addons) to be running
# and publishing device events to MQTT.
# ─────────────────────────────────────────────────────────────────────────────

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

# Store mappings and browser-saved settings in /data so they survive
# add-on restarts and updates (HA mounts /data as a persistent volume).
export MAPPINGS_FILE="/data/mappings.json"
export SETTINGS_FILE="/data/settings.json"

bashio::log.info "Starting RTL433-UI on port ${PORT}"
bashio::log.info "MQTT broker: ${MQTT_URL}"
bashio::log.info "Subscribing to: ${MQTT_TOPIC_PREFIX}/+/events"

cd /app
exec node server/index.js

