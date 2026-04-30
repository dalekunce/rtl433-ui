ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ── Node.js 22 LTS — official binary, no APT repo needed ─────────────────────
ENV NODE_VERSION=22.14.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && ARCH="$(uname -m)" \
    && case "${ARCH}" in \
         x86_64)  NODE_ARCH="x64"    ;; \
         aarch64) NODE_ARCH="arm64"  ;; \
         armv7l)  NODE_ARCH="armv7l" ;; \
         *) echo "Unsupported architecture: ${ARCH}" && exit 1 ;; \
       esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
       | tar -xJ --strip-components=1 -C /usr/local \
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

# ── Entry point ───────────────────────────────────────────────────────────────
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
