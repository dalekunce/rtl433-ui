ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ── Node.js from Debian bookworm's official packages ─────────────────────────
# Reliable: no external downloads, no GPG keys, no architecture detection.
# Debian bookworm ships Node.js 18 LTS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

# ── Application ───────────────────────────────────────────────────────────────
WORKDIR /app

# Install production dependencies first (layer-cached when source changes)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY server/   ./server/
COPY frontend/ ./frontend/

# Ensure the persistent-data directory exists
RUN mkdir -p /data

# ── Entry point via s6-overlay ────────────────────────────────────────────────
# HA base images run s6 as PID 1. We must NOT override CMD — instead place
# the run script in the s6 services directory so s6 manages it.
COPY run.sh /etc/services.d/rtl433-ui/run
COPY finish.sh /etc/services.d/rtl433-ui/finish
RUN chmod a+x /etc/services.d/rtl433-ui/run \
              /etc/services.d/rtl433-ui/finish
