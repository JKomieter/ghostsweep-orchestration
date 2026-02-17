# ── Build stage ──
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ── Production stage ──
FROM node:20-slim

# Install Python and Maigret directly (no Docker-in-Docker needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && python3 -m venv /opt/maigret \
    && /opt/maigret/bin/pip install maigret \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/maigret/bin:$PATH"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Create reports directory for Maigret output
RUN mkdir -p /app/reports

EXPOSE 8080
ENV PORT=8080

CMD ["node", "--import", "./dist/instrumentation.js", "dist/index.js"]
