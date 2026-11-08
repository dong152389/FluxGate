FROM node:22-bookworm-slim

# Install dependencies required by workerd on Linux ARM64 / AMD64
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install all dependencies including devDependencies (wrangler and typescript are required at runtime)
RUN npm ci

# Copy project files
COPY tsconfig.json wrangler.jsonc worker-configuration.d.ts ./
COPY migrations ./migrations
COPY public ./public
COPY src ./src
COPY docker-entrypoint.sh ./

# Make entrypoint script executable
RUN chmod +x docker-entrypoint.sh

# Directory for SQLite/D1 and KV persistent storage
ENV PERSIST_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 80

ENTRYPOINT ["./docker-entrypoint.sh"]
