# Oficina de Agentes

Oficina local donde cada robot es una consola tmux corriendo `claude` con tu suscripción. Sin dependencias ni build: solo Node y tmux.

## Edificio: varias oficinas con un solo código

Esta carpeta es el **código** (uno solo). Cada **oficina** es una carpeta de datos con su carpeta de trabajo, su puerto y su sesión de tmux, así una oficina con mucho trabajo no se mezcla con otra.

```sh
bin/office create nr --workspace ~/nr-fabi          # registra la oficina (elige puerto y sesión libres)
bin/office start nr                                 # arranca su daemon en segundo plano
bin/office ls                                       # todas las oficinas: estado, URL, robots, bandeja
bin/office open nr                                  # la abre en el navegador
bin/office lobby                                    # página del edificio en http://127.0.0.1:4700
bin/office stop nr | restart nr | logs nr [-f]      # --all en vez del nombre para todas
bin/office ctl nr libre "resume el README"          # daemon/ctl.mjs contra esa oficina
```

- Registro y datos: `~/.agent-office/oficinas/<nombre>/` (`office.json` con puerto y sesión, `daemon.log`, y el estado de la oficina). `AGENT_OFFICE_HOME` cambia `~/.agent-office`.
- `--data <carpeta>` adopta una oficina que ya existía sin mover sus datos (por ejemplo, un `runs/` viejo).
- `--port`, `--session` y `--max` (tope de robots) son opcionales.
- Detener una oficina no cierra sus robots: siguen en tmux y se reconectan al arrancarla otra vez.
- Los hooks de los robots (`office-settings.json`) se generan en la carpeta de datos al arrancar, con la ruta real de `hooks/office-hook.sh`: el código se puede clonar en cualquier carpeta.
- El edificio lee el estado de cada oficina de sus archivos (no gasta cuota) y puede iniciarlas o detenerlas.

Sin el edificio también funciona como antes: `node daemon/daemon.mjs` usa `runs/` junto al código. Variables: `OFFICE_DATA` (carpeta de datos), `OFFICE_WORKSPACE` (fija la carpeta de trabajo), `OFFICE_MAX_ROBOTS` (default 3), `OFFICE_APPROVAL=1` (el daemon retiene Bash/Write/Edit hasta aprobar), `OFFICE_PORT`, `OFFICE_SESSION`. El daemon no arranca si su carpeta de datos ya tiene un daemon vivo (candado `daemon.lock`), ni si la sesión de tmux pertenece a otra oficina viva (opción `@office_port` de la sesión).

La primera vez, si la oficina no tiene carpeta de trabajo, la página la pide y la guarda en `config.json` de sus datos; se cambia desde el chip «carpeta · …» con la oficina vacía.

En lo que sigue, `runs/` significa la carpeta de datos de la oficina.

Qué hace el MVP:

- **Nuevo encargo**: skill (con autocompletado de tus skills) + argumentos, o tarea libre. Modo de permisos por robot.
- **Robots**: entran por la puerta y trabajan en uno de los 8 escritorios; sus subagentes aparecen alrededor del escritorio (hasta 7 visibles, el resto como «+N»).
- **Rutinas** (se guardan en `runs/routines.json`):
  - *Vigilar PRs*: en un repo (`gh pr list`) o en toda la organización (`gh search prs`), con filtro de búsqueda de GitHub (`author:karol`, `review-requested:@me`, `label:hotfix`…). Lanza una skill o una tarea libre, más instrucciones adicionales, solo por cada PR nuevo o con commits nuevos. Variables: `{url}` `{number}` `{repo}` `{head}` `{base}` `{title}` `{author}` `{local}` (carpeta del repo en el workspace). Sin cupo, el PR queda pendiente para el siguiente chequeo.
  - *Tarea programada*: cada N minutos lanza un robot con instrucciones libres y un archivo de memoria en `runs/routines/<id>/memoria.md`. Opcionalmente puede delegar en otros robots vía `POST /api/robots`. Gasta cuota en cada ejecución; si la anterior sigue en la oficina, se salta.
- **Persistencia**: robots y bandeja se guardan en `runs/office-state.json`; al reiniciar el daemon se reconectan los robots cuya ventana tmux siga abierta (la conversación se reconstruye desde el transcript).
- **Adjuntos**: en el chat del robot y en Nuevo encargo se puede pegar (Ctrl+V), arrastrar o elegir archivos. Se guardan en `runs/adjuntos/<robot>/` (máx. 20 MB, se borran a los 7 días) y el mensaje le indica al robot las rutas para abrirlos con Read.
- **Inspector**: conversación (transcript), chat que llega a la consola con `tmux paste-buffer -p` (los saltos de línea no parten el mensaje), consola en vivo, botón para abrirla en Terminal, tokens, Aprobar/Rechazar cuando pide permiso, Dar de baja.
- **Ciclo**: un `.md` escrito en el workspace aparece como hoja en el escritorio y se entrega en tu bandeja al terminar. Ningún robot se va solo: al terminar queda con el cartel LISTO y su conversación hasta que lo des de baja (✕ sobre el robot o «Despedir terminados»). Los terminados no cuentan para el tope de robots a la vez. Cada robot muestra quién lo lanzó (tú, una rutina, la terminal o la API). Si el turno termina en pregunta, el robot levanta la mano.
- **Nombre de la oficina**: clic en *ponle nombre* junto al título (Enter guarda, Esc cancela). Es estético: sirve para distinguir varias oficinas en el navegador, porque aparece en el encabezado, en el título de la pestaña y en el favicon (inicial y color derivados del nombre). Se guarda en `runs/config.json` (`name`).
- **Celebraciones y alertas**: al entregar un documento salta confeti sobre la bandeja. Si es un review con `## Hallazgos Criticos` que trae hallazgos (`###`), no hay confeti: el robot muestra el cartel rojo «⚠ N críticos», el documento lleva la etiqueta en la bandeja y se enciende una luz roja giratoria en tu escritorio. La luz sigue encendida hasta que abras el review o lo marques como visto.
- **Salas de rutina**: los robots que lanza una rutina (o que delega una rutina de agenda) se sientan en una sala temporal con el nombre de la rutina, debajo de los escritorios; la sala desaparece cuando se va su último robot.
- **Espera de respuesta**: un robot con una pregunta muestra un contador; a los 2 min baila y a los 3 min hace fila frente a tu escritorio (por orden de llegada). Al responderle vuelve a su escritorio o sala.
- **Uso y estado Claude**: lee `/usage` en una consola tmux aparte (`<sesión>:_status`, no gasta cuota) y suma por semana los tokens de las sesiones que lanzó la oficina, incluidos sus subagentes.
- **Salas de épica** (paso 5, se guardan en `runs/salas.json`): una sala por épica o tarea de Jira, con nombre, clave y carpeta de documentos opcional (ej. `TASK/WALLET`). Comparten dos archivos en `runs/salas/<id>/`:
  - `CONTEXT.md`: alcance, decisiones y estado verificado. Cada robot que entra lo lee primero y lo corrige en su lugar cuando verifica algo durable. No se entrega en la bandeja.
  - `HILO.md`: el hilo de la sala. Lo que dice cada robot al cerrar su turno se publica solo; tú escribes desde el panel (opcionalmente enviándolo a los robots de la sala, lo que gasta cuota). Un robot puede publicar a mitad de turno con `curl -X POST ".../api/salas/<id>/hilo?from=$OFFICE_ROBOT" --data-binary @archivo`.
  - Los robots de la sala se sientan en una sala temporal debajo de los escritorios, igual que los de una rutina. Cerrar la sala exige darlos de baja antes; los archivos quedan en el disco.
  - Sin herramientas MCP propias por ahora: los robots usan Read/Edit sobre esos archivos y `curl` contra el daemon.
- **Sala de descanso** (donde estaban las salas Git y Jira del paso 4, que no se usaban): robots que solo son animación, sin consola ni cuota, toman café, charlan, juegan ping-pong y rotan; hay más cuando hay poco trabajo. Un clic en uno abre «Nuevo encargo» con su nombre y, al lanzarlo, ese robot sale del descanso hacia su escritorio.

Limitaciones conocidas: los tokens de los subagentes no se suman todavía; al reconectar un robot se pierden las líneas de herramientas de su conversación (el transcript solo trae lo que dijo).

---

## Paso 1: prueba técnica

Validó, sin interfaz gráfica, que se puede manejar el `claude` de la suscripción desde tmux y recibir sus eventos estructurados. Prototipo visual: https://claude.ai/artifact/SWpyyC7W4wZpDiZ4DB6GkC

## Piezas

| Archivo | Qué hace |
|---|---|
| `bin/office` | El edificio: crea, arranca, detiene y lista oficinas; sirve la página del edificio (`edificio/index.html`). |
| `office-settings.json` (en los datos) | Hooks que se cargan **solo** en los robots (`claude --settings …`). Tus sesiones normales no los ven. Lo genera el daemon. |
| `hooks/office-hook.sh` | Reenvía el JSON del hook al daemon. Sale sin hacer nada si no existe `OFFICE_ROBOT` o si el daemon no responde. |
| `daemon/daemon.mjs` | Lanza robots en la sesión tmux `office`, imprime eventos, sigue transcripts, suma tokens y (opcional) retiene permisos. Sin dependencias. |
| `daemon/ctl.mjs` | Control desde la terminal: `launch`, `say`, `approve`, `deny`, `kill`, `state`. |
| `runs/events-YYYY-MM-DD.jsonl` | JSON crudo de cada hook, para estudiar qué campos llegan. Local, contiene comandos y rutas. |

## Cómo correrla

Terminal 1, el daemon:

```sh
cd "TRANSVERSAL/agent-office"
node daemon/daemon.mjs                    # aprobaciones apagadas
OFFICE_APPROVAL=1 node daemon/daemon.mjs  # Bash/Write/Edit esperan approve|deny
OFFICE_PERMISSION_MODE=default node daemon/daemon.mjs  # fija el modo de permisos de los robots
```

Terminal 2, el control:

```sh
node daemon/ctl.mjs launch rex "/review-deep <ruta-repo> <base> <rama> --dry-run"
tmux attach -t office:rex                  # ver la consola viva (Ctrl-b d para salir sin cerrarla)
node daemon/ctl.mjs say rex "resume en 3 líneas lo que encontraste"
node daemon/ctl.mjs state
node daemon/ctl.mjs kill rex
```

## Resultados de la prueba (2026-10-28)

Robots corridos: `rex` (`/review-deep … --dry-run` sobre bff-integrator #23, 2.8 min), `bolt` (tarea libre con subagente Explore, 24 s, más un mensaje de seguimiento), `kiro` (aprobaciones) y `milo` (permiso en consola).

- [x] Llegan `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStop`, `Notification` y `Stop`, todos con `session_id` y `transcript_path`.
- [x] **Subagentes**: las herramientas usadas dentro de un subagente disparan los mismos hooks con `agent_id` y `agent_type` (ej. `Explore`). `SubagentStop` trae `agent_transcript_path`.
- [x] Transcript seguible; `Stop` además trae `last_assistant_message` (llega antes de que el texto final aparezca en el JSONL: usarlo para el globo).
- [x] `say` vía `tmux send-keys` entra como turno nuevo de la misma sesión, con el contexto previo.
- [x] `Notification` llega en dos casos: `"Claude needs your permission"` (~6 s después de que aparece el menú de permisos) y `"Claude is waiting for your input"` (~60 s de inactividad).
- [x] Con `OFFICE_APPROVAL=1`: `approve` deja seguir; un `mv` aprobado se convierte en deny por la lista prohibida y el robot recibe "Comando prohibido por la oficina".
- [x] **El deny de `settings.local.json` gana sobre un `allow` del hook** (probado con `claude -p` y un hook que siempre responde allow: el `mv` quedó bloqueado). La lista del daemon es una segunda barrera, no la única.
- [x] `--dry-run` no escribió nada: `rex` no usó Write/Edit y no se crearon archivos en `reviews/`.

### Hallazgos que cambian el diseño

1. **`ANTHROPIC_API_KEY` en el entorno hace que `claude` use la API en vez de la suscripción** (`claude -p` falló con "Invalid API key"). El daemon lanza los robots con `env -u ANTHROPIC_API_KEY`; verificado que el proceso del robot no la tiene.
2. **`Stop` no significa "encargo terminado"**: los subagentes corren en segundo plano, así que `Stop` llega mientras siguen trabajando. El resultado vuelve como un `UserPromptSubmit` que empieza con `<agent-message from="…">` y luego llega otro `Stop`. LISTO = `Stop` sin subagentes con tipo pendientes.
3. **Ayudantes internos sin `agent_type`**: aparecen `SubagentStop` vacíos tras cada turno y hasta un `Bash: true` ("No-op; next step is not obvious"). La oficina debe ignorarlos y no retener sus permisos.
4. **Los robots heredan el modo de permisos del usuario** (`auto`): en ese modo nunca levantan la mano. Se agregó `OFFICE_PERMISSION_MODE` para fijarlo al lanzar.
5. **Interrumpir con Esc no dispara `Stop`**: el estado "interrumpido" hay que tomarlo del transcript o de la `Notification` de inactividad.
6. **Tokens**: el `/review-deep --dry-run` consumió ~8 k de salida y ~2 M de lectura de caché en el hilo principal; los subagentes van en su propio transcript y todavía no se suman.

## Seguridad

- No se usa `--dangerously-skip-permissions` ni modo bypass: los permisos y `deny` del workspace aplican igual.
- El daemon escucha solo en `127.0.0.1`.
- Para la prueba usar `--dry-run`: un review real escribe en `reviews/` y altera los contadores de `Seguimiento/devs/`.
