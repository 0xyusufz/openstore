#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE=${OPENSTORE_TESTNET_ENV_FILE:-"$SCRIPT_DIR/.env.testnet"}
PROJECT_ARGS=
if [ -n "${OPENSTORE_TESTNET_PROJECT:-}" ]; then
  PROJECT_ARGS="--project-name"
fi

if [ ! -f "$ENV_FILE" ]; then
  printf '%s\n' "Missing $ENV_FILE; copy .env.example to .env.testnet and fill local values." >&2
  exit 2
fi

compose() {
  if [ -n "$PROJECT_ARGS" ]; then
    docker compose --project-name "$OPENSTORE_TESTNET_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  else
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  fi
}

usage() {
  cat <<'EOF'
Usage: testnet.sh <start|stop|restart|status|logs|reset> [service]

Environment:
  OPENSTORE_TESTNET_ENV_FILE  Override the local .env.testnet path.

reset is destructive and requires the explicit --yes argument:
  testnet.sh reset --yes
EOF
}

command_name=${1:-}
case "$command_name" in
  start)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    compose up -d
    ;;
  stop)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    compose stop
    ;;
  restart)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    compose restart
    ;;
  status)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    compose ps
    ;;
  logs)
    if [ "$#" -eq 1 ]; then
      compose logs --no-log-prefix
    elif [ "$#" -eq 2 ]; then
      compose logs --no-log-prefix "$2"
    else
      usage >&2
      exit 2
    fi
    ;;
  reset)
    [ "${2:-}" = "--yes" ] && [ "$#" -eq 2 ] || {
      printf '%s\n' "reset removes all testnet containers and named volumes; rerun as: testnet.sh reset --yes" >&2
      exit 2
    }
    compose down -v
    ;;
  -h|--help)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
