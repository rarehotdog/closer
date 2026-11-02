#!/usr/bin/env bash
# Creates one small VM for Closer with a static IP and opens ports 80/443. Run once, on the owner's Mac.
# Needs: gcloud signed in, a project with billing. Does not touch any other VM.
#   bash deploy/gce/create_vm.sh PROJECT_ID [ZONE=asia-northeast3-a] [NAME=closer]
set -euo pipefail
PROJECT="${1:?usage: create_vm.sh PROJECT_ID [ZONE] [NAME]}"
ZONE="${2:-asia-northeast3-a}"
NAME="${3:-closer}"
REGION="${ZONE%-*}"
G=(--project "$PROJECT")
if ! gcloud compute addresses describe "$NAME-ip" --region "$REGION" "${G[@]}" >/dev/null 2>&1; then
  gcloud compute addresses create "$NAME-ip" --region "$REGION" "${G[@]}"
fi
IP="$(gcloud compute addresses describe "$NAME-ip" --region "$REGION" "${G[@]}" --format='value(address)')"
if ! gcloud compute firewall-rules describe closer-web "${G[@]}" >/dev/null 2>&1; then
  gcloud compute firewall-rules create closer-web --allow tcp:80,tcp:443 --target-tags closer-web "${G[@]}"
fi
if ! gcloud compute instances describe "$NAME" --zone "$ZONE" "${G[@]}" >/dev/null 2>&1; then
  gcloud compute instances create "$NAME" --zone "$ZONE" --machine-type e2-small \
    --image-family ubuntu-2204-lts --image-project ubuntu-os-cloud --boot-disk-size 20GB \
    --tags closer-web --address "$IP" "${G[@]}"
fi
DOMAIN="${IP//./-}.sslip.io"
echo "VM $NAME · IP $IP · domain $DOMAIN"
echo "Next: bash deploy/gce/deploy.sh $PROJECT $ZONE $NAME $DOMAIN"
