#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:3210}"
EXPECTED_SHA="${2:-}"

echo "[1/4] Checking /api/version at ${BASE_URL}..."
VERSION_JSON="$(curl -fsSL "${BASE_URL}/api/version")"
REMOTE_SHA="$(node -e 'const v = JSON.parse(process.argv[1]); process.stdout.write(String(v.sha || ""));' "${VERSION_JSON}")"
REMOTE_MODE="$(node -e 'const v = JSON.parse(process.argv[1]); process.stdout.write(String(v.mode || ""));' "${VERSION_JSON}")"
DEMO_HASH_1="$(node -e 'const v = JSON.parse(process.argv[1]); process.stdout.write(String(v.demoRc1StateHash || ""));' "${VERSION_JSON}")"
echo "  sha=${REMOTE_SHA} mode=${REMOTE_MODE} demoRc1StateHash=${DEMO_HASH_1}"

if [[ -n "${EXPECTED_SHA}" && "${REMOTE_SHA}" != "${EXPECTED_SHA}" ]]; then
  echo "FAIL: remote sha (${REMOTE_SHA}) != expected (${EXPECTED_SHA})" >&2
  exit 1
fi

echo "[2/4] Checking read-only guard on /api/ws/demo-rc1/availability..."
WRITE_RES="$(curl -sS -X POST "${BASE_URL}/api/ws/demo-rc1/availability" \
  -H 'Content-Type: application/json' \
  -d '{"itemId":"B2","state":"LAUNDRY","eventId":"smoke-ro-1","expectedRevision":0}')"
RO_CODE="$(node -e 'const r = JSON.parse(process.argv[1]); process.stdout.write(String(r.code || ""));' "${WRITE_RES}")"
if [[ "${RO_CODE}" != "SCOPE_DENIED" ]]; then
  echo "FAIL: expected SCOPE_DENIED on demo-rc1 write, got ${RO_CODE}" >&2
  exit 1
fi

if [[ "${REMOTE_MODE}" == "real" ]]; then
  echo "  Checking unauthenticated /api/ws/owner/view returns HTTP 403 in real mode..."
  OWNER_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE_URL}/api/ws/owner/view")"
  if [[ "${OWNER_CODE}" != "403" ]]; then
    echo "FAIL: expected HTTP 403 on unauthenticated /api/ws/owner/view in real mode, got ${OWNER_CODE}" >&2
    exit 1
  fi
fi

echo "[3/4] Checking /today, /closet, /discover, /w/demo-rc1 HTTP 200..."
for path in / /today /closet /discover /w/demo-rc1 /version; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE_URL}${path}")"
  if [[ "${code}" != "200" ]]; then
    echo "FAIL: GET ${path} returned HTTP ${code}" >&2
    exit 1
  fi
done

echo "[4/4] Re-reading /api/ws/demo-rc1/view stateHash..."
VIEW_JSON="$(curl -fsSL "${BASE_URL}/api/ws/demo-rc1/view")"
DEMO_HASH_2="$(node -e 'const v = JSON.parse(process.argv[1]); process.stdout.write(String(v.stateHash || ""));' "${VIEW_JSON}")"
if [[ "${DEMO_HASH_1}" != "${DEMO_HASH_2}" ]]; then
  echo "FAIL: demo-rc1 stateHash drifted (${DEMO_HASH_1} vs ${DEMO_HASH_2})" >&2
  exit 1
fi

echo "OK: smoke check completed for ${BASE_URL} (sha=${REMOTE_SHA})"
