#!/bin/sh
# Hook de la Oficina de Agentes: reenvia el JSON del evento al daemon local.
# Solo actua dentro de un robot (OFFICE_ROBOT definido). Si el daemon no
# responde, sale en silencio y Claude Code sigue con su comportamiento normal.

[ -z "$OFFICE_ROBOT" ] && exit 0

PORT="${OFFICE_PORT:-4777}"

# --max-time por debajo del timeout de 600s del hook PreToolUse en office-settings.json
RESP=$(curl -s --max-time 590 -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${PORT}/hook?robot=${OFFICE_ROBOT}") || exit 0

[ -n "$RESP" ] && printf '%s' "$RESP"
exit 0
