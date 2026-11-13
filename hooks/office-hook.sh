#!/bin/sh
# Hook de la Oficina de Agentes: reenvia el JSON del evento al daemon local.
# Solo actua dentro de un robot (OFFICE_ROBOT definido). Si el daemon no
# responde, sale en silencio y Claude Code sigue con su comportamiento normal.

[ -z "$OFFICE_ROBOT" ] && exit 0

PORT="${OFFICE_PORT:-4777}"

# --max-time por debajo del timeout del hook en office-settings.json: 600 s el general y 8 h el de las
# preguntas («ask»), que la oficina puede retener hasta que contestes.
MAX=590; VIA=""
[ "$1" = "ask" ] && MAX=28700 && VIA="&via=ask"
RESP=$(curl -s --max-time "$MAX" -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${PORT}/hook?robot=${OFFICE_ROBOT}${VIA}") || exit 0

[ -n "$RESP" ] && printf '%s' "$RESP"
exit 0
