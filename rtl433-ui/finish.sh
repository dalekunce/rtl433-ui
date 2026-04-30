#!/usr/bin/with-contenv bashio
# Called by s6 when the rtl433-ui service exits.
# $1 = exit code, $2 = signal number (or -1 if exited normally)
bashio::log.warning "RTL433-UI service exited (code=${1}, signal=${2})"
