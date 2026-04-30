#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# RTL433-UI – Home Assistant add-on entry point
# Reads config from /data/options.json written by the HA supervisor.
# Uses plain bash + jq — no bashio/with-contenv/s6 dependency.
# ─────────────────────────────────────────────────────────────────────────────

echo "[rtl433-ui] Starting... node=$(node --version 2>/dev/null || echo 'NOT FOUND')"

OPTIONS="/data/options.json"

if [ ! -f "${OPTIONS}" ]; then
    echo "[rtl433-ui] WARNING: ${OPTIONS} not found, using defaults"
    echo "{}" > "${OPTIONS}"
fi

export MQTT_URL=$(jq --raw-output '.mqtt_url // "mqtt://core-mosquitto:1883"' "${OPTIONS}")
export MQTT_USERNAME=$(jq --raw-output '.mqtt_username // ""' "${OPTIONS}")
export MQTT_PASSWORD=$(jq --raw-output '.mqtt_password // ""' "${OPTIONS}")
export MQTT_TOPIC_PREFIX=$(jq --raw-output '.mqtt_topic_prefix // "rtl_433"' "${OPTIONS}")
export MQTT_COMMAND_TOPIC=$(jq --raw-output '.mqtt_command_topic // "rtl_433/command"' "${OPTIONS}")
export PORT="3000"
export MAPPINGS_FILE="/data/mappings.json"
export SETTINGS_FILE="/data/settings.json"

echo "[rtl433-ui] MQTT broker:   ${MQTT_URL}"
echo "[rtl433-ui] Events topic:  ${MQTT_TOPIC_PREFIX}/+/events"
echo "[rtl433-ui] Listening on:  port ${PORT}"

cd /app
exec node server/index.js

