#!/usr/bin/env bash
# Runs one command with MODEL_API_KEY set only for that command, read from the macOS Keychain.
# The key never goes into a file, the shell history, the terminal output or a chat.
#
# One-time setup by the owner (type the key at the hidden prompt; -T "" makes macOS ask every time):
#   security add-generic-password -a "$USER" -s closer-meta-model-api -T "" -w
# Then, e.g.:  bash scripts/with-key.sh node scripts/live_check.ts --live
# macOS shows "security wants to use … closer-meta-model-api". Click Allow (not Always Allow).
# Linux fallback: a file readable only by you at ~/.config/closer/model_api_key (chmod 600).
set -euo pipefail
SERVICE="closer-meta-model-api"
if [ "$#" -eq 0 ]; then echo "usage: bash scripts/with-key.sh <command> [args…]" >&2; exit 64; fi
key=""
if command -v security >/dev/null 2>&1; then
  key="$(security find-generic-password -a "$USER" -s "$SERVICE" -w 2>/dev/null || true)"
elif [ -f "$HOME/.config/closer/model_api_key" ]; then
  perm="$(stat -c '%a' "$HOME/.config/closer/model_api_key" 2>/dev/null || stat -f '%Lp' "$HOME/.config/closer/model_api_key")"
  if [ "$perm" != "600" ]; then echo "~/.config/closer/model_api_key must be chmod 600" >&2; exit 65; fi
  key="$(tr -d '\r\n' < "$HOME/.config/closer/model_api_key")"
fi
if [ -z "$key" ]; then
  echo "No key found. Store it once with:" >&2
  echo "  security add-generic-password -a \"\$USER\" -s $SERVICE -T \"\" -w" >&2
  exit 66
fi
MODEL_API_KEY="$key" exec "$@"
