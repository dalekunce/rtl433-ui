#!/usr/bin/with-contenv bashio
# ─────────────────────────────────────────────────────────────────────────────
# RTL433-UI – Home Assistant add-on entry point
#
# bashio is provided by the HA base image and reads /data/options.json
# (written by HA from the user's add-on Configuration tab).
# ─────────────────────────────────────────────────────────────────────────────

MQTT_URL=$(bashio::config 'mqtt_url')
MQTT_USERNAME=$(bashio::config 'mqtt_username')
MQTT_PASSWORD=$(bashio::config 'mqtt_password')
RTL433_ARGS=$(bashio::config 'rtl433_args')

export MQTT_URL
export MQTT_USERNAME
export MQTT_PASSWORD
export RTL433_BIN="/usr/bin/rtl_433"
export RTL433_ARGS
export PORT="3000"

# Store mappings and browser-saved settings in /data so they survive
# add-on restarts and updates (HA mounts /data as a persistent volume).
export MAPPINGS_FILE="/data/mappings.json"
export SETTINGS_FILE="/data/settings.json"

bashio::log.info "Starting RTL433-UI on port ${PORT}"
bashio::log.info "MQTT broker: ${MQTT_URL}"
bashio::log.info "rtl_433 args: ${RTL433_ARGS}"

cd /app
exec node server/index.js

