# Oficina de Agentes

Oficina local donde cada robot es una consola tmux corriendo `claude` con tu suscripción. Sin dependencias ni build: solo Node y tmux.

## Requisitos

- macOS o Linux con **Node 18+** y **tmux** (`brew install node tmux`).
- **Claude Code** (`claude`) instalado y con sesión iniciada en tu suscripción. Los robots se lanzan sin `ANTHROPIC_API_KEY` para que usen la suscripción y no la API.
- Opcional: **gh** con sesión iniciada, para las rutinas que vigilan PRs.
- Sin `npm install` ni build: todo el código está en esta carpeta.

## Instalación

```sh
git clone https://gitea.dex.moimolcp.com/Fabi/agent-office.git ~/nr-fabi/agent-office
cd ~/nr-fabi/agent-office
chmod +x bin/office bin/office.mjs hooks/office-hook.sh
```

Para escribir `office` desde cualquier carpeta, agrega un alias a `~/.zshrc` y abre una terminal nueva:

```sh
echo 'alias office="$HOME/nr-fabi/agent-office/bin/office"' >> ~/.zshrc
```

En el resto de esta guía, `office` es ese alias. **Sin alias** funciona igual: entra a esta carpeta y usa `bin/office` (`cd ~/nr-fabi/agent-office && bin/office ls`), o la ruta completa `~/nr-fabi/agent-office/bin/office` desde cualquier carpeta.

## Crear oficinas

Una **oficina** es un grupo de robots que trabajan sobre una **carpeta de trabajo** (donde se abren las consolas de `claude` y de donde salen las skills del proyecto). Cada oficina tiene su puerto, su sesión de tmux y su carpeta de datos, así una oficina con mucho trabajo no se mezcla con otra. El código es uno solo para todas.

Hay dos formas, equivalentes (el botón usa por dentro el mismo `office create`, con las mismas validaciones):

**Desde el edificio** (`office lobby` y abrir http://127.0.0.1:4700): botón **Nueva oficina** (arriba a la derecha o la tarjeta punteada al final). Pide:

- *Nombre*: minúsculas, números y guiones (`finance`, `soporte`…). Será también su sesión tmux: `office-<nombre>`.
- *Carpeta de trabajo*: ruta completa o con `~`. Tiene que existir.
- *Robots a la vez*: tope de robots trabajando simultáneamente (default 3; se cambia después desde la oficina).
- *Iniciarla al crearla*: si se desmarca, queda registrada y detenida, con su botón **Iniciar**.

Si algo falla (nombre repetido o inválido, carpeta que no existe) el error aparece dentro del formulario y no se crea nada.

**Desde la consola**:

```sh
office create finance --workspace ~/dropicode-Diagrams/dropi-finance   # registra: elige puerto y sesión tmux libres
office start finance                                                  # arranca su daemon en segundo plano
office open finance                                                   # la abre en el navegador
```

`create` acepta además `--port 4790`, `--session office-fin` y `--max 4`. En los dos casos el nombre visible de la oficina (el que sale en su página y en el edificio) se cambia con un clic en el encabezado de la oficina.

## Uso diario

```sh
office ls                       # todas las oficinas: estado, URL, sesión tmux, robots, te necesitan, bandeja
office lobby                    # página del edificio en http://127.0.0.1:4700 (office lobby stop la apaga)
office start nr | --all         # arrancar una o todas
office stop nr | --all          # detener (los robots siguen vivos en tmux)
office restart nr               # tras actualizar el código del daemon
office logs nr                  # últimas líneas del daemon (office logs nr -f para seguirlo)
office ctl nr libre "resume el README"           # encargos desde la terminal (ver daemon/ctl.mjs)
tmux attach -t office-nr                         # ver las consolas de los robots (Ctrl-b d sale sin cerrarlas)
```

- **El edificio** muestra cada oficina con sus robots trabajando, los que te necesitan, los listos y la bandeja, con botones Abrir, Iniciar y Detener, y el botón Nueva oficina. Lee los archivos de cada oficina: no gasta cuota. Solo acepta acciones desde su propia página (otra web abierta en tu navegador no puede crear ni encender oficinas).
- **Detener no despide a nadie**: los robots siguen en tmux y se reconectan solos al arrancar la oficina otra vez.
- **Avisos**: en la oficina, el botón *Avisos* activa sonido y notificación del sistema cuando un robot te necesita o lleva 10 min sin actividad. El título de la pestaña siempre muestra cuántos te necesitan.
- **Después de reiniciar el Mac** los daemons no arrancan solos: `office start --all` (y `office lobby`).

## Actualizar el código

```sh
cd ~/nr-fabi/agent-office && git pull
office restart --all     # solo si cambió daemon/; si cambió solo web/, basta recargar la página
```

## Adoptar una oficina que ya existía

Si una oficina vieja (una copia de agent-office con su `runs/`) sigue en uso, se registra apuntando a sus datos, sin moverlos ni copiarlos. Primero detén su daemon viejo (Ctrl-C en su terminal) y usa su mismo puerto y su misma sesión, así sus robots vivos se reconectan:

```sh
office create legacy --data ~/dropicode-Diagrams/TRANSVERSAL/agent-office/runs --port 4777 --session office
office start legacy
```

La carpeta de trabajo se toma del `config.json` de esos datos. Desde ahí, la copia vieja del código ya no se usa (su `runs/` sí).

## Dónde queda cada cosa

| Qué | Dónde |
|---|---|
| Código (uno solo) | esta carpeta |
| Registro de cada oficina | `~/.agent-office/oficinas/<nombre>/office.json` (puerto, sesión, `data` si adoptó otra carpeta) |
| Datos de cada oficina | `~/.agent-office/oficinas/<nombre>/`, o la carpeta de `--data`: estado, bandeja, rutinas, salas, adjuntos, eventos, `config.json` (carpeta de trabajo y nombre) |
| Log del daemon | `~/.agent-office/oficinas/<nombre>/daemon.log` |
| Hooks de los robots | `office-settings.json` en los datos; el daemon lo genera al arrancar con la ruta real de `hooks/office-hook.sh` |

`AGENT_OFFICE_HOME` cambia `~/.agent-office` y `AGENT_OFFICE_LOBBY_PORT` el puerto del edificio (4700).

## Problemas comunes

- **«Esta oficina ya está corriendo»**: ya hay un daemon sobre esos datos (`office ls` lo muestra). Si murió mal, `office start` limpia el candado viejo solo.
- **«el puerto … está ocupado por otro programa»**: algo más usa ese puerto (por ejemplo, el daemon viejo de una oficina adoptada). Detenlo o crea la oficina con otro `--port`.
- **«La sesión de tmux … ya la usa otra oficina»**: dos oficinas no pueden compartir sesión tmux; usa otra `--session`.
- **La oficina no arranca**: `office logs <nombre>` muestra el error.
- **Un robot no se mueve en la página**: revisa que el daemon esté corriendo (`office ls`) y su consola (`tmux attach -t <sesión>`).

## Modo manual (sin el edificio)

Sigue funcionando: `node daemon/daemon.mjs` usa `runs/` junto al código. Variables: `OFFICE_DATA` (carpeta de datos), `OFFICE_WORKSPACE` (fija la carpeta de trabajo y omite la pregunta de la primera vez), `OFFICE_MAX_ROBOTS` (default 3), `OFFICE_APPROVAL=1` (el daemon retiene Bash/Write/Edit hasta aprobar), `OFFICE_PORT`, `OFFICE_SESSION`. El daemon no arranca si su carpeta de datos ya tiene un daemon vivo (candado `daemon.lock`), ni si la sesión de tmux pertenece a otra oficina viva (opción `@office_port` de la sesión).

Si la oficina no tiene carpeta de trabajo, la página la pide la primera vez y la guarda en `config.json` de sus datos; se cambia desde el chip «carpeta · …» con la oficina vacía.

## Qué hace la oficina

En lo que sigue, `runs/` significa la carpeta de datos de la oficina.

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
| `bin/office` | El edificio: crea, arranca, detiene y lista oficinas; sirve la página del edificio (`edificio/index.html`) con su API (`GET/POST /api/offices`, `POST /api/offices/<nombre>/start|stop`). |
| `office-settings.json` (en los datos) | Hooks que se cargan **solo** en los robots (`claude --settings …`). Tus sesiones normales no los ven. Lo genera el daemon. |
| `hooks/office-hook.sh` | Reenvía el JSON del hook al daemon. Sale sin hacer nada si no existe `OFFICE_ROBOT` o si el daemon no responde. |
| `daemon/daemon.mjs` | Una oficina: lanza robots en su sesión tmux, sirve la página, sigue transcripts, suma tokens y (opcional) retiene permisos. Sin dependencias. |
| `daemon/ctl.mjs` | Control desde la terminal: `skill`, `libre`, `say`, `approve`, `reject`, `pane`, `kill` (con el edificio: `office ctl <oficina> …`). |
| `web/` | La página de la oficina. |
| `events-YYYY-MM-DD.jsonl` (en los datos) | JSON crudo de cada hook, para estudiar qué campos llegan. Local, contiene comandos y rutas. |

## Control desde la terminal

```sh
office ctl nr skill review-deep "<ruta-repo> origin/production origin/<rama> --dry-run"
office ctl nr libre "resume en 3 líneas el README"
office ctl nr say <robot> "resume en 3 líneas lo que encontraste"
office ctl nr approve <robot>      # o reject: responde el permiso que pidió en su consola
office ctl nr pane <robot>         # texto actual de su consola
office ctl nr kill <robot>         # darlo de baja
```

Sin el edificio: `OFFICE_PORT=4778 node daemon/ctl.mjs …`.

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
