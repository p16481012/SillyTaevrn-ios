#!/usr/bin/env bash
# Compatibility entry point; Windows and macOS use the same Node implementation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/prepare-ios.mjs" "$@"
