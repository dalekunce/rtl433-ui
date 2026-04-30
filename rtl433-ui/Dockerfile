ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ── System packages ────────────────────────────────────────────────────────────
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm jq \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && node --version

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
RUN chmod a+x /run.sh

ENTRYPOINT ["/run.sh"]

