#!/bin/sh
set -eu

CONFIG_PATH="${HIVE_CONFIG:-/data/hive.config.json}"
DATA_DIR="${HIVE_DATA_DIR:-/data}"
GENERATED_DIR="${HIVE_GENERATED_DIR:-/data/generated}"

mkdir -p "$DATA_DIR/logs" "$GENERATED_DIR"

if [ ! -f "$CONFIG_PATH" ]; then
  cat > "$CONFIG_PATH" <<EOF
{
  "listenHost": "${HIVE_LISTEN_HOST:-127.0.0.1}",
  "exportHost": "${HIVE_EXPORT_HOST:-127.0.0.1}",
  "portRangeStart": ${HIVE_PORT_RANGE_START:-10001},
  "portRangeEnd": ${HIVE_PORT_RANGE_END:-10300},
  "dataDir": "$DATA_DIR",
  "generatedDir": "$GENERATED_DIR",
  "databasePath": "$DATA_DIR/state.db",
  "mihomoBin": "${MIHOMO_BIN:-/usr/local/bin/mihomo}",
  "mihomoConfigPath": "$GENERATED_DIR/mihomo.yaml",
  "mihomoPidPath": "$DATA_DIR/mihomo.pid",
  "mihomoLogPath": "$DATA_DIR/logs/mihomo.log",
  "externalController": "${MIHOMO_EXTERNAL_CONTROLLER:-127.0.0.1:9090}",
  "externalControllerSecret": "${MIHOMO_EXTERNAL_CONTROLLER_SECRET:-}",
  "subscriptionUserAgent": "${HIVE_SUBSCRIPTION_USER_AGENT:-Clash.Meta}"
}
EOF
fi

exec "$@"
