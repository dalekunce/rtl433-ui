ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ── Node.js 20 LTS ───────────────────────────────────────────────────────────
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
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
