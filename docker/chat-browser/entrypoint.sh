#!/bin/bash
set -Eeuo pipefail
umask 077

healthcheck() {
  timeout 2s xdpyinfo -display :99 >/dev/null 2>&1 &&
    curl --fail --silent --max-time 2 http://127.0.0.1:9222/json/version >/dev/null &&
    nc -z -w 2 127.0.0.1 5900 >/dev/null 2>&1 &&
    nc -z -w 2 127.0.0.1 9223 >/dev/null 2>&1
}

if [[ $# -eq 1 && "$1" == '--healthcheck' ]]; then
  healthcheck
  exit $?
fi

status() {
  printf '%s\n' "$1"
}

if [[ $# -ne 0 || "$(id -u)" != '1000' || "$(id -g)" != '1000' ]]; then
  status CHAT_BROWSER_INVALID_RUNTIME
  exit 1
fi

sandbox_args=()
case "${CHAT_BROWSER_DISABLE_SANDBOX:-false}" in
  false) ;;
  true)
    # Explicit operator opt-in, permitted only with the isolated sidecar deployment contract.
    sandbox_args+=(--no-sandbox)
    status CHAT_BROWSER_SANDBOX_DISABLED_BY_CONFIGURATION
    ;;
  *)
    status CHAT_BROWSER_INVALID_SANDBOX_CONFIGURATION
    exit 1
    ;;
esac

if [[ ! -d /profile || ! -w /profile || -L /profile ]]; then
  status CHAT_BROWSER_PROFILE_NOT_WRITABLE
  exit 1
fi

if ! mkdir -p /profile/home /profile/config /profile/chromium \
  /tmp/chat-browser-runtime /tmp/chromium-cache; then
  status CHAT_BROWSER_DIRECTORY_SETUP_FAILED
  exit 1
fi

# Private, ephemeral logs can contain browsing details and are never sent to Docker stdout.
runtime_directory=/tmp/chat-browser-runtime
pids=()
browser_pid=''

cleanup() {
  local exit_code=$?
  local child_pid
  local attempt
  trap - EXIT TERM INT

  # Give Chromium time to flush its own profile while its display is still available.
  if [[ -n "$browser_pid" ]] && kill -0 "$browser_pid" 2>/dev/null; then
    kill -TERM "$browser_pid" 2>/dev/null || true
    for ((attempt = 0; attempt < 100; attempt++)); do
      kill -0 "$browser_pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
  for child_pid in "${pids[@]}"; do
    kill -TERM "$child_pid" 2>/dev/null || true
  done
  for ((attempt = 0; attempt < 20; attempt++)); do
    local running=false
    for child_pid in "${pids[@]}"; do
      if kill -0 "$child_pid" 2>/dev/null; then running=true; fi
    done
    [[ "$running" == true ]] || break
    sleep 0.1
  done
  for child_pid in "${pids[@]}"; do
    kill -KILL "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  done
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 0' TERM INT

Xvfb :99 -screen 0 1280x900x24 -nolisten tcp -ac >"$runtime_directory/display.log" 2>&1 &
pids+=("$!")
display_ready=false
display_deadline=$((SECONDS + 15))
while ((SECONDS < display_deadline)); do
  if timeout 2s xdpyinfo -display :99 >/dev/null 2>&1; then
    display_ready=true
    break
  fi
  kill -0 "${pids[0]}" 2>/dev/null || break
  sleep 0.2
done
if [[ "$display_ready" != true ]]; then
  status CHAT_BROWSER_DISPLAY_START_FAILED
  exit 1
fi

# Start an ordinary headed browser on Google Chat. Login is performed by the user.
# The backend attaches CDP only after the user closes the interactive login lease.
chromium \
  --user-data-dir=/profile/chromium \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  --disable-default-apps \
  --disable-background-networking \
  --disable-sync \
  --window-size=1280,900 \
  --window-position=0,0 \
  "${sandbox_args[@]}" \
  https://chat.google.com >"$runtime_directory/chromium.log" 2>&1 &
browser_pid=$!
pids+=("$browser_pid")

# VNC has no public listener or independent login. Romka's authenticated, leased WS
# gateway is the only supported access path. Clipboard and remote commands are disabled.
x11vnc -display :99 -rfbport 5900 -listen 0.0.0.0 -noipv6 \
  -forever -shared -nopw -noxdamage -safer -nocmds -nosel -norc \
  >"$runtime_directory/vnc.log" 2>&1 &
pids+=("$!")

# Chromium retains its loopback binding. Never expose this bridge to a host port.
socat TCP4-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP4:127.0.0.1:9222 \
  >"$runtime_directory/cdp.log" 2>&1 &
pids+=("$!")

ready=false
startup_deadline=$((SECONDS + 40))
while ((SECONDS < startup_deadline)); do
  for child_pid in "${pids[@]}"; do
    if ! kill -0 "$child_pid" 2>/dev/null; then
      status CHAT_BROWSER_PROCESS_START_FAILED
      exit 1
    fi
  done
  if healthcheck; then
    ready=true
    break
  fi
  sleep 0.2
done
if [[ "$ready" != true ]]; then
  status CHAT_BROWSER_START_TIMEOUT
  exit 1
fi
status CHAT_BROWSER_READY

# Any essential child exiting makes the whole sidecar restartable by Docker.
wait -n "${pids[@]}" || true
status CHAT_BROWSER_PROCESS_EXITED
exit 1
