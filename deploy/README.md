# Deploy and live runs

## Live runs on the owner's Mac (no key in chat, files or shell history)

1. **Store the key once.** The owner types the key at a hidden prompt:
   `security add-generic-password -a "$USER" -s closer-meta-model-api -T "" -w`
2. **Run the live scripts.** Anyone at that Mac, Antigravity included, can now run:
   - `npm run live:check`: the model list plus one Spark intent call, about $0.004.
   - `npm run live:check -- --image ./outfit.jpg`: adds one Spark photo call and one SAM call, about $0.04.
   - `npm run live:ablation`: 12 Spark calls, about $0.05.
   - `npm run live:ui`: a local server in real mode.
3. **Approve each run.** Every run asks macOS for permission: "security wants to use closer-meta-model-api". The owner clicks Allow. Do not click Always Allow; asking each time keeps the owner in the loop.
4. **What the scripts save.** Results go to `.data/live_check.json` and `.data/intent_ablation.json`, which hold statuses, timings and code checks only.

## GCE VM with automatic HTTPS (sslip.io, no domain purchase)

This uses a VM that is separate from any other project's VM.

1. **Create the VM, once.** It is an e2-small with a static IP, ports 80 and 443 open, and Ubuntu 22.04.
   `bash deploy/gce/create_vm.sh PROJECT_ID asia-northeast3-a closer`
   The script prints the domain, for example `34-64-1-2.sslip.io`.
2. **Ship the committed HEAD.** This installs Node 22 and Caddy the first time, writes the systemd unit and keeps `/etc/closer/env` (mode 600) between releases.
   `bash deploy/gce/deploy.sh PROJECT_ID asia-northeast3-a closer DOMAIN`
3. **Move the key into the VM, once and after every key change.** The key goes from the Keychain over ssh stdin to `/etc/closer/env`.
   `bash deploy/gce/push_key.sh PROJECT_ID asia-northeast3-a closer`
4. **Check the release.** `https://DOMAIN/version` must show the same sha as `git rev-parse HEAD`. `deploy.sh` checks this for you.
5. **Get the admin token.** It is generated on the VM:
   `gcloud compute ssh closer --zone asia-northeast3-a --project PROJECT_ID --command "sudo grep ADMIN /etc/closer/env"`
   Keep it in a password manager. Do not paste it into chat or docs.

**Data.** It lives in `/var/lib/closer/closer.db` on the VM's boot disk. A new release does not touch it.

**Visitor cap.** The first install writes `CLOSER_VISITOR_DAY_USD=3` and `CLOSER_APP_TOTAL_USD=20` into `/etc/closer/env`, so a judge opening the public link can use the sentence reader and the photo flow on the sample closet (about three photo runs per day in total). Without the visitor line the cap is $0 and visitors see "Replay & ledger mode"; the tap-to-lock, 60-day review and Discover flows still work, because they make no model calls. To change a cap: edit the line on the VM, then run `deploy.sh` again (it restarts the service). The visitor cap is $0 from 2026-11-19 00:00 KST whatever the line says.

**Costs.** An e2-small and a static IP are billed while they exist. To stop everything:
`gcloud compute instances delete closer --zone asia-northeast3-a --project PROJECT_ID`, then
`gcloud compute addresses delete closer-ip --region asia-northeast3 --project PROJECT_ID`.

**Container.** `docker build --build-arg BUILD_SHA=$(git rev-parse HEAD) -t closer .` builds the image from `Dockerfile`: node:22-slim, runtime dependencies only (`npm ci --omit=dev --ignore-scripts`), the sha written to `BUILD_SHA` so `/version` shows it; `.dockerignore` keeps `.git`, `node_modules`, `.data`, `.env*` and `deploy/` out. `docker run --rm -p 8787:8787 -v closer-data:/data closer` serves mock mode on http://localhost:8787. The ledger and photos live in the `/data` volume (`CLOSER_DB_PATH=/data/closer.db`), and the image sets `CLOSER_HOST=0.0.0.0` because outside a container the server binds 127.0.0.1 only. For real mode add `--env-file` with `CLOSER_MODE=real`, `MODEL_API_KEY`, `CLOSER_ADMIN_TOKEN` and the cap lines from the VM recipe; the key never goes on a shared command line or into the image.

**What has been verified.**
- Checked: script syntax; the key move on a test file (the key is replaced and the file stays mode 600); the server reading `BUILD_SHA` in an unpacked archive.
- Checked (11/4, a machine without a Docker daemon): the container recipe step by step outside Docker. A copy of the tree filtered by `.dockerignore`, `npm ci --omit=dev --ignore-scripts`, a `BUILD_SHA` file, then `web/server.ts` started with the image's environment answered `/api/version` with that sha, served `/`, `/today`, `/closet/3d`, the three.js vendor file and `/api/ws/demo-rc1/view`, and was reachable on a non-loopback address (what `docker -p` needs); without `CLOSER_HOST` it stays loopback-only.
- Not run yet: `docker build` itself, and the gcloud and apt steps, which need the owner's account.
