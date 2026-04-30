ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ── System deps + rtl_433 from OBS ───────────────────────────────────────────
# rtl-sdr provides the kernel/udev rules and librtlsdr; rtl_433 is the decoder.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        gnupg \
        libusb-1.0-0 \
        rtl-sdr \
    && echo "deb http://download.opensuse.org/repositories/home:/merbanan/Debian_12/ /" \
        > /etc/apt/sources.list.d/rtl_433.list \
    && curl -fsSL \
        "https://download.opensuse.org/repositories/home:/merbanan/Debian_12/Release.key" \
        | gpg --dearmor > /etc/apt/trusted.gpg.d/rtl_433.gpg \
    && apt-get update \
    && apt-get install -y --no-install-recommends rtl_433 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 LTS ───────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

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

# ── Entry point ───────────────────────────────────────────────────────────────
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
