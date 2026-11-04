# Deploy and live runs

## Live runs on the owner's Mac (no key in chat, files or shell history)

1. **Store the key once.** The owner types the key at a hidden prompt:
   `security add-generic-password -a "$USER" -s closer-meta-model-api -T "" -w`
2. **Run the live scripts.** Anyone at that Mac, Antigravity included, can now run:
   - `npm run live:check`: the model list plus one Spark intent call, about $0.004.
   - `npm run live:check -- --image ./outfit.jpg`: adds one Spark photo call and one SAM call, about $0.04.
   - `npm run live:ablation`: 12 Spark calls, about $0.05.
   - `npm run live:ui`: a local server in real mode. It sets `CLOSER_VISITOR_DAY_USD=3`, so the sample closets on `/today` and `/` can make live calls (about 84 photo runs a day at the plan estimates, shared by every visitor copy). Without that line the visitor cap is $0: the sentence path holds with `CALL_CAP_REACHED` and the banner says "Replay & ledger mode".
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

**What has been verified.**
- Checked: script syntax; the key move on a test file (the key is replaced and the file stays mode 600); the server reading `BUILD_SHA` in an unpacked archive.
- Not run yet: the gcloud and apt steps themselves, which need the owner's account.
