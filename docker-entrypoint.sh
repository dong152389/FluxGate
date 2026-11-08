#!/bin/sh
set -e

echo "==> Starting FluxGate Node.js Service on port ${PORT:-80}..."
exec tsx src/index.ts
