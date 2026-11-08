#!/bin/sh
set -e

DATA_DIR="${PERSIST_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

# Initialize .dev.vars if not present
if [ ! -f .dev.vars ]; then
  touch .dev.vars
fi

# Helper to sync environment variables into .dev.vars
set_var() {
  key="$1"
  val="$2"
  if [ -n "$val" ]; then
    if grep -q "^${key}=" .dev.vars; then
      sed -i "s|^${key}=.*|${key}=${val}|" .dev.vars
    else
      echo "${key}=${val}" >> .dev.vars
    fi
  fi
}

# Inject environment variables
set_var "APP_SECRET" "${APP_SECRET:-change-this-secret-before-deploy}"
set_var "PUBLIC_BASE_URL" "${PUBLIC_BASE_URL}"
set_var "SMTP_HOST" "${SMTP_HOST}"
set_var "SMTP_PORT" "${SMTP_PORT}"
set_var "SMTP_USER" "${SMTP_USER}"
set_var "SMTP_PASS" "${SMTP_PASS}"
set_var "SMTP_FROM" "${SMTP_FROM}"
set_var "EMAIL_WHITELIST" "${EMAIL_WHITELIST}"

# Run local D1 database migrations automatically
echo "==> Applying local D1 database migrations..."
CI=true npx wrangler d1 migrations apply fluxgate-db --local --persist-to "$DATA_DIR"

# Launch local worker server
PORT="${PORT:-80}"
echo "==> Starting service on 0.0.0.0:${PORT} (persisting data to ${DATA_DIR})..."
exec npx wrangler dev \
  --local \
  --ip 0.0.0.0 \
  --port "$PORT" \
  --persist-to "$DATA_DIR" \
  --show-interactive-dev-session=false
