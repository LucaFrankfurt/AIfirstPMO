#!/bin/sh
#
# The public demo instance: wipe, seed, serve, repeat.
#
# A demo everybody can sign in to needs a way back to a known state, and the
# CLI's `restore` deliberately refuses to run against a live database — putting
# a snapshot under a running server is how you get a half-restored one. So the
# reset owns the process rather than the other way round: this script starts
# the server, waits, stops it, and starts the next one on a fresh database.
#
# Doing it here rather than from a sidecar is the point. A sidecar that
# restarts its neighbour needs the Docker socket, and handing a container the
# socket to make a demo tidy is handing it the host.
#
# The cost is honest and small: a few seconds of downtime per reset, on an
# instance whose entire purpose is being disposable.
#
# Set on the service:
#   KOLIBRI_DEMO_RESET_SECONDS   how long a generation lasts (default 24h)
#   KOLIBRI_DEMO_EMAIL/PASSWORD  the account the landing page prints
#
set -eu

RESET_SECONDS="${KOLIBRI_DEMO_RESET_SECONDS:-86400}"
DATA_DIR="${KOLIBRI_DATA_DIR:-/data}"
# Where the application is. `/app` in the image; overridable so this script can
# be run against a checkout, which is the only way it gets tested before it is
# the thing keeping a public demo alive.
APP_DIR="${KOLIBRI_APP_DIR:-/app}"
NODE_FLAGS="--experimental-sqlite --disable-warning=ExperimentalWarning"

say() { echo "[demo] $*"; }

# Stop the child cleanly when the platform stops us, rather than letting the
# container die with a half-written database behind it.
child=""
shutdown() {
  say "stopping"
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null || true
  [ -n "$child" ] && wait "$child" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

while :; do
  say "wiping ${DATA_DIR}"
  # The database and its write-ahead files, and every upload. Not the directory
  # itself: it is the volume mount point.
  rm -f "${DATA_DIR}"/kolibri.sqlite "${DATA_DIR}"/kolibri.sqlite-* || true
  rm -rf "${DATA_DIR}"/uploads/* || true

  say "seeding"
  # shellcheck disable=SC2086
  node $NODE_FLAGS "${APP_DIR}/packages/server/src/seed.ts"

  say "starting the server"
  # shellcheck disable=SC2086
  node $NODE_FLAGS "${APP_DIR}/packages/server/src/index.ts" &
  child=$!

  # Wait for it to answer before writing anything over the API, and give up
  # rather than hang if it never does — a generation that never came up should
  # end and be retried, not sit there looking healthy.
  ready=""
  i=0
  while [ "$i" -lt 60 ]; do
    if wget -qO- "http://127.0.0.1:${PORT:-4000}/api/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
    i=$((i + 1))
  done

  if [ -z "$ready" ]; then
    say "the server never became healthy — restarting this generation"
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    sleep 5
    continue
  fi

  # The parts of a lived-in workspace the seed cannot create — a channel and a
  # direct conversation, written over the public API as the people in them.
  # Optional: a demo with an empty Chat screen is a worse demo, not a broken
  # one, so a failure here is logged and the generation carries on.
  if [ -f "${APP_DIR}/scripts/demo-extras.mjs" ]; then
    say "seeding the conversation"
    KOLIBRI_URL="http://127.0.0.1:${PORT:-4000}" \
      node "${APP_DIR}/scripts/demo-extras.mjs" || say "demo-extras failed — carrying on without it"
  fi

  say "up; this generation lasts ${RESET_SECONDS}s"

  # `sleep` in the background and `wait` on both, so a TERM from the platform
  # is handled now rather than at the end of the window.
  sleep "$RESET_SECONDS" &
  timer=$!
  wait "$timer" 2>/dev/null || true

  say "resetting"
  kill -TERM "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  child=""
done
