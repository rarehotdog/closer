#!/usr/bin/env bash
# Ships the committed HEAD to the VM and checks that the public /version shows the same sha.
#   bash deploy/gce/deploy.sh PROJECT_ID ZONE NAME DOMAIN
set -euo pipefail
PROJECT="${1:?usage: deploy.sh PROJECT_ID ZONE NAME DOMAIN}"; ZONE="${2:?zone}"; NAME="${3:?name}"; DOMAIN="${4:?domain}"
cd "$(git rev-parse --show-toplevel)"
git diff --quiet && git diff --cached --quiet || { echo "commit first: deploys ship HEAD only" >&2; exit 1; }
SHA="$(git rev-parse HEAD)"
TGZ="$(mktemp -d)/closer-$SHA.tgz"
git archive --format=tar.gz -o "$TGZ" HEAD
G=(--zone "$ZONE" --project "$PROJECT")
gcloud compute scp "$TGZ" deploy/gce/install_remote.sh "$NAME:/tmp/" "${G[@]}"
gcloud compute ssh "$NAME" "${G[@]}" --command "sudo bash /tmp/install_remote.sh $DOMAIN $SHA"
echo "waiting for https://$DOMAIN …"
for i in $(seq 1 30); do
  got="$(curl -fsS "https://$DOMAIN/api/version" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).sha)}catch{}})' || true)"
  if [ "$got" = "$SHA" ]; then echo "OK https://$DOMAIN serves $SHA"; exit 0; fi
  sleep 5
done
echo "not serving $SHA yet (first TLS certificate can take a minute; if the key is missing run push_key.sh)" >&2
exit 2
