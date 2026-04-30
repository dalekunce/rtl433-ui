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
- **Multi-band scanner** — scan 433 / 315 / 868 / 915 MHz bands to find active frequencies
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

### Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `mqtt_url` | `mqtt://core-mosquitto:1883` | MQTT broker URL (`mqtt://` or `mqtts://`) |
| `mqtt_username` | *(blank)* | MQTT username (leave blank if no auth) |
| `mqtt_password` | *(blank)* | MQTT password |
| `rtl433_args` | `-F json -M utc -M level` | Extra arguments passed to rtl_433. Add `-d 0` to select a specific dongle. |

The UI is accessible from the **HA sidebar** via ingress (no extra port needed), or directly on port 3000.

Settings changed via the in-app ⚙️ gear button are saved to `/data/settings.json` and survive add-on restarts and updates.

---

## macOS / Local Installation

### Requirements

- macOS with [Homebrew](https://brew.sh)
- RTL-SDR dongle
- Node.js ≥ 18

### Setup

```bash
git clone https://github.com/dalekunce/rtl433-ui
cd rtl433-ui
./setup.sh        # installs rtl-sdr, rtl_433, mosquitto, npm deps
./start.sh        # starts Mosquitto + the UI
open http://localhost:3000
```

Or manually:

```bash
brew install rtl-sdr rtl_433 mosquitto
brew services start mosquitto
npm install
npm start
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
| `RTL433_BIN` | `rtl_433` | Path to rtl_433 binary |
| `RTL433_ARGS` | `-F json -M utc -M level` | rtl_433 arguments |
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
