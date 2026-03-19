#!/usr/bin/env bash
set -euo pipefail

declare -a pids=()

shutdown() {
  trap - INT TERM EXIT

  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done

  wait || true
}

start_service() {
  local name="$1"
  local port="$2"
  local dir="$3"

  echo "[render] starting ${name} on port ${port}"
  (
    cd "${dir}"
    PORT="${port}" node index.js
  ) &
  pids+=("$!")
}

trap shutdown INT TERM EXIT

export PORT="${PORT:-10000}"
export USER_SERVICE_URL="${USER_SERVICE_URL:-http://127.0.0.1:3001}"
export POST_SERVICE_URL="${POST_SERVICE_URL:-http://127.0.0.1:3002}"
export JOB_SERVICE_URL="${JOB_SERVICE_URL:-http://127.0.0.1:3003}"
export AUTH_SERVICE_URL="${AUTH_SERVICE_URL:-http://127.0.0.1:3004}"
export CHAT_SERVICE_URL="${CHAT_SERVICE_URL:-http://127.0.0.1:3005}"

start_service "auth-service" "3004" "/app/services/auth-service"
start_service "user-service" "3001" "/app/services/user-service"
start_service "post-service" "3002" "/app/services/post-service"
start_service "job-service" "3003" "/app/services/job-service"
start_service "chat-service" "3005" "/app/services/chat-service"

echo "[render] starting api-gateway on port ${PORT}"
(
  cd /app/api-gateway
  PORT="${PORT}" node index.js
) &
pids+=("$!")

wait -n "${pids[@]}"
exit $?
