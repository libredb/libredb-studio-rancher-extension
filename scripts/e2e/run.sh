#!/usr/bin/env bash
# Runs the Cypress end-to-end specs against a running Rancher.
#
# Rancher comes from the environment (TEST_BASE_URL, TEST_USERNAME, TEST_PASSWORD, or
# CATTLE_BOOTSTRAP_PASSWORD for a fresh Rancher), or from a local
# lab: with LAB_ENV pointing at a lab-env.sh that exports RANCHER_URL and LAB_SECRETS, the admin
# user and the password in $LAB_SECRETS/admin.password are used. The package is built when
# dist-pkg has no build of the current version, then served on 127.0.0.1:$PKG_PORT for the run.
#
# Usage: scripts/e2e/run.sh [extra rancher-cypress run arguments]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if [ -n "${LAB_ENV:-}" ]; then
  # shellcheck disable=SC1090
  source "$LAB_ENV"
  export TEST_BASE_URL="${TEST_BASE_URL:-${RANCHER_URL:?LAB_ENV must export RANCHER_URL}/dashboard}"
  export TEST_USERNAME="${TEST_USERNAME:-admin}"
  if [ -z "${TEST_PASSWORD:-}" ]; then
    TEST_PASSWORD="$(cat "${LAB_SECRETS:?LAB_ENV must export LAB_SECRETS}/admin.password")"
    export TEST_PASSWORD
  fi
fi

: "${TEST_BASE_URL:?set TEST_BASE_URL to the Rancher dashboard URL, or LAB_ENV to a lab-env.sh}"
: "${TEST_PASSWORD:=${CATTLE_BOOTSTRAP_PASSWORD:?set TEST_PASSWORD, CATTLE_BOOTSTRAP_PASSWORD for a fresh Rancher, or LAB_ENV}}"
export TEST_PASSWORD
# By default the Rancher under test is already set up, so @rancher/cypress's first-login specs,
# which would change it, are skipped. CI sets TEST_SKIP empty and TEST_ONLY=setup,extensions for a
# fresh Rancher.
export TEST_SKIP="${TEST_SKIP-setup}"
export TEST_ONLY="${TEST_ONLY:-extensions}"

# Rancher answers /ping well before the dashboard stops answering 503, so wait for the dashboard.
ready_timeout="${RANCHER_READY_TIMEOUT:-600}"
deadline=$((SECONDS + ready_timeout))
until [ "$(curl -sk -o /dev/null -w '%{http_code}' "${TEST_BASE_URL%/}/")" = "200" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Rancher's dashboard at $TEST_BASE_URL did not answer 200 within ${ready_timeout}s" >&2
    exit 1
  fi
  sleep 5
done

PKG_PORT="${PKG_PORT:-4500}"
export LIBREDB_PKG_URL="http://127.0.0.1:${PKG_PORT}"

pkg_version="$(node -p "require('./pkg/libredb-studio/package.json').version")"
if [ ! -f "dist-pkg/libredb-studio-${pkg_version}/libredb-studio-${pkg_version}.umd.min.js" ]; then
  yarn build-pkg libredb-studio
fi

# The server runs directly under node, not through yarn, so the trap below stops the server itself.
PORT="$PKG_PORT" node ./node_modules/@rancher/shell/scripts/serve-pkgs >/dev/null 2>&1 &
serve_pid=$!
trap 'kill "$serve_pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -fsS "$LIBREDB_PKG_URL/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "$LIBREDB_PKG_URL/" >/dev/null

yarn -s rancher-cypress run --e2e "$@"
