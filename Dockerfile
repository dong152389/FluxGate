FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies required for healthcheck
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --omit=dev && npm install -g tsx

# Copy application source and assets
COPY tsconfig.json ./
COPY public ./public
COPY src ./src
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=80

EXPOSE 80

ENTRYPOINT ["./docker-entrypoint.sh"]
