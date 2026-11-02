#!/usr/bin/env bash
# Moves the Model API key from the owner's macOS Keychain to the VM's /etc/closer/env (mode 600) over
# ssh stdin. The key never appears on a command line, in a file on the Mac, or in the terminal.
#   bash deploy/gce/push_key.sh PROJECT_ID ZONE NAME
set -euo pipefail
PROJECT="${1:?usage: push_key.sh PROJECT_ID ZONE NAME}"; ZONE="${2:?zone}"; NAME="${3:?name}"
key="$(security find-generic-password -a "$USER" -s closer-meta-model-api -w)"
[ -n "$key" ] || { echo "no key in the Keychain (see scripts/with-key.sh)" >&2; exit 66; }
printf '%s' "$key" | gcloud compute ssh "$NAME" --zone "$ZONE" --project "$PROJECT" --command \
  'sudo bash -c '\''umask 077; k="$(cat)"; grep -v "^MODEL_API_KEY=" /etc/closer/env > /etc/closer/env.new || true; printf "MODEL_API_KEY=%s\n" "$k" >> /etc/closer/env.new; mv /etc/closer/env.new /etc/closer/env; chmod 600 /etc/closer/env; systemctl restart closer; sleep 2; systemctl is-active closer'\'''
