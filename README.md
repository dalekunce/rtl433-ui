# RTL433-UI

Live web dashboard and MQTT topic mapper for RTL-SDR receivers, powered by [rtl_433](https://github.com/merbanan/rtl_433).

Receive 433 MHz (and 315 / 868 / 915 MHz) RF signals from weather stations, door sensors, utility meters, garage door openers, and hundreds of other devices — then view them live in a browser and publish individual fields to any MQTT topic.

---

## Features

- **Live device dashboard** — each detected device gets a card showing all reported fields, signal strength (RSSI), and last-seen time
- **Field-level MQTT mapping** — map any field (temperature, humidity, battery, …) to any MQTT topic with one click
- **Home Assistant auto-discovery** — publish HA MQTT discovery payloads for all mapped sensors with one button
- **Binary sensor support** — `battery_ok`, `alarm`, `tamper` automatically publish to `homeassistant/binary_sensor/…`
- **Utility meter support** — ERT/AMR gas, water, and electric meters detected automatically with correct HA Energy Dashboard `state_class`
- **Persistent band scanner** — continuously scan 433 / 315 / 868 / 915 MHz bands with live packet-count bars; 30s / 1m / 5m window per band
- **Bundled rtl_433** — the binary is included in the add-on image; no separate rtl_433 add-on needed
- **rtl_433 subprocess control** — start, stop, restart, and upload a custom config file from the Settings panel
- **Server log panel** — real-time and buffered server logs visible in the sidebar; expandable to full height
- **Sparklines** — per-field value history charts inside each device card
- **RSSI filter** — hide low-signal (distant neighbour) devices
- **Pin / ignore / label devices** — pin important devices to the top, hide neighbours, rename anything
- **Raw stream** — live JSON packet stream with click-to-highlight card linking
- **Settings UI** — configure MQTT broker URL and credentials from the browser without restarting

---

## Home Assistant Add-on

### Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**
2. Click the **⋮** menu (top right) → **Repositories**
3. Add: `https://github.com/dalekunce/rtl433-ui`
4. Find **RTL433-UI** in the store and click **Install**

### Requirements

- An RTL-SDR dongle plugged into your Home Assistant host
- The [Mosquitto broker](https://github.com/home-assistant/addons/tree/master/mosquitto) add-on (or any MQTT broker)

> **No separate rtl_433 add-on required.** The binary is bundled in the RTL433-UI image.

### Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `mqtt_url` | `mqtt://core-mosquitto:1883` | MQTT broker URL (`mqtt://` or `mqtts://`) |
| `mqtt_username` | *(blank)* | MQTT username (leave blank if no auth) |
| `mqtt_password` | *(blank)* | MQTT password |
| `mqtt_topic_prefix` | `rtl_433` | Topic prefix rtl_433 publishes to |
| `mqtt_command_topic` | `rtl_433/command` | Topic for sending commands to rtl_433 |

Without any configuration, the add-on starts rtl_433 scanning all four ISM bands (433.92 / 868 / 315 / 915 MHz) with all 191 device protocols enabled. Drop a custom `rtl_433.conf` in via the Settings panel to override gain, protocols, or frequencies.

---

## macOS / Local Installation

### Requirements

- macOS with [Homebrew](https://brew.sh)
- RTL-SDR dongle
- Node.js ≥ 18

### Setup

```bash
git clone https://github.com/dalekunce/rtl433-ui
cd rtl433-ui/rtl433-ui
brew install rtl-sdr rtl_433 mosquitto
brew services start mosquitto
npm install
npm start
open http://localhost:3000
```

### Configuration

Copy `.env.example` to `.env` and edit as needed:

```bash
cp .env.example .env
```

Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `MQTT_URL` | `mqtt://localhost:1883` | MQTT broker URL |
| `MQTT_USERNAME` | *(blank)* | MQTT username |
| `MQTT_PASSWORD` | *(blank)* | MQTT password |
| `RTL433_BIN` | `rtl_433` | Path or name of the rtl_433 binary |
| `FORGET_AFTER_SECONDS` | `0` | Remove devices unseen for N seconds (0 = never) |

---

## MQTT topic mapping

Click **Map →** on any field row to assign it a MQTT topic. Template shortcuts:

- **Flat**: `rtl433/{model}/{id}/{field}` — simple and clean
- **HA state**: `homeassistant/sensor/rtl433_{model}_{id}/{field}/state` — ready for manual HA config
- **HA auto-discovery ✦**: generates and publishes a full HA discovery payload, then saves the state topic

After mapping, values are published automatically each time the device transmits.

---

## Supported hardware

Any RTL-SDR dongle supported by `librtlsdr`:
- RTL2832U chipset (most common — R820T2 tuner)
- RTL-SDR Blog V3 / V4
- Nooelec NESDR series

Devices decoded by rtl_433 include: weather stations, door/window sensors, motion sensors, smoke detectors, water leak detectors, gas/water/electric utility meters (ERT/AMR/SCMPlus), temperature probes, soil moisture sensors, tire pressure sensors, garage door openers, and [hundreds more](https://triq.org/rtl_433/SUPPORTED_DEVICES.html).

---

## License

MIT

---

## Built on the shoulders of giants

RTL433-UI is a thin UI layer. All the hard work is done by these excellent open-source projects:

| Project | Role |
|---------|------|
| [rtl_433](https://github.com/merbanan/rtl_433) by Benjamin Larsson et al. | RF decoder — identifies hundreds of 433/315/868/915 MHz devices and outputs JSON |
| [librtlsdr / rtl-sdr](https://github.com/osmocom/rtl-sdr) by Osmocom | Userspace driver for RTL2832U-based SDR dongles |
| [MQTT.js](https://github.com/mqttjs/MQTT.js) | Node.js MQTT client used to connect to the broker and publish field values |
| [Eclipse Mosquitto](https://mosquitto.org) | Lightweight MQTT broker (used locally on macOS; HA users can use the [Mosquitto add-on](https://github.com/home-assistant/addons/tree/master/mosquitto)) |
| [Express](https://expressjs.com) | HTTP server and REST API |
| [ws](https://github.com/websockets/ws) | WebSocket server for pushing live device data to the browser |
| [Home Assistant](https://www.home-assistant.io) | Target platform for the add-on; MQTT auto-discovery format defined by HA |
| [Home Assistant Add-on SDK](https://developers.home-assistant.io/docs/add-ons) | Base Docker images (`ghcr.io/home-assistant/*-base-debian`) and `bashio` shell helpers |
