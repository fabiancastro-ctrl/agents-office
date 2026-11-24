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

**Desde el edificio** (`office lobby` y abrir http://127.0.0.1:4700): botón **Nueva oficina** arriba a la derecha, o la puerta de la planta baja. Pide:

- *Nombre*: minúsculas, números y guiones (`finance`, `soporte`…). Será también su sesión tmux: `office-<nombre>`.
- *Carpeta de trabajo*: ruta completa o con `~`. Tiene que existir.
- *Robots a la vez*: tope de robots trabajando simultáneamente (default 3; se cambia después desde la oficina).
- *Iniciarla al crearla*: si se desmarca, queda registrada y detenida, con su botón **Iniciar**.

Si algo falla (nombre repetido o inválido, carpeta que no existe) el error aparece dentro del formulario y no se crea nada. Si sale bien, el piso nuevo se construye arriba del edificio (con andamios).

**Desde la consola**:

```sh
office create finance --workspace ~/dropicode-Diagrams/dropi-finance   # registra: elige puerto y sesión tmux libres
office start finance                                                  # arranca su daemon en segundo plano
office open finance                                                   # la abre en el navegador
```

`create` acepta además `--port 4790`, `--session office-fin` y `--max 4`. En los dos casos el nombre visible de la oficina (el que sale en su página y en el edificio) se cambia con un clic en el encabezado de la oficina.

## El edificio

`office lobby` levanta la página del edificio en http://127.0.0.1:4700. Es una fachada que se lee de un vistazo:

- **Cada piso es una oficina**, del más antiguo (abajo) al más nuevo (arriba), con su letrero: número de piso, puerto, nombre y estado.
- **Cada ventana es un puesto**: iluminada con el robot adentro si trabaja (violeta si está con subagentes), parpadeando en rojo con «?» si te necesita, con cartel LISTO (o «⚠N» si un review trae críticos) si terminó, y, si el puesto está libre, con la luz encendida y su interior a la vista (escritorio con monitor, planta, estante o lámpara). Pasar el mouse por una ventana dice qué robot es y qué hace.
- **Miniatura en vivo**: bajo el letrero de cada piso encendido hay una fila de caras mini, una por robot, con su glifo de estado (`?` te necesita, `●` trabaja y brilla, `◆` subagentes, `✓` listo, `z` en espera) y un borde rojo (P0) o ámbar (P1) si tiene prioridad. Sale del mismo resumen que lee el edificio y se refresca cada 5 s.
- **Un piso detenido baja las persianas.** Si le quedan robots vivos en tmux, se ven como siluetas ámbar (parpadean si están trabajando) y el letrero dice «N sin supervisión».
- **Ambiente**: cada piso lleva una marquesina con el color de su oficina; al fondo hay una ciudad cuyas ventanas se encienden según la hora; en la calle pasan autos y hay una banca con un gato. Cuando una oficina lanza un robot, se le ve entrar caminando por la puerta del edificio.
- **El ascensor** sube al piso más alto donde alguien te necesita, y la antena de la azotea parpadea en rojo; si nadie te necesita, el ascensor espera en planta baja.
- **La planta baja** tiene la recepción, la puerta para crear oficinas y el buzón con el total de documentos nuevos de todas las bandejas.
- **El cielo** cambia con la hora (día, atardecer, noche con luna y faroles encendidos).
- **Clic en un piso** abre su panel: números, carpeta, sesión tmux y datos, y los botones Abrir oficina, Detener, Cerrar y despedir, Iniciar (y reconectar), Despedir robots y Eliminar oficina.

El edificio lee los archivos de cada oficina y mira tmux: no gasta cuota. Solo acepta acciones desde su propia página.

## Eliminar oficinas

Desde el edificio: clic en el piso → **Eliminar oficina** → escribir el nombre para confirmar → **Demoler piso**. El piso se agrieta, se derrumba y los de arriba bajan a ocupar el hueco. Desde la consola:

```sh
office rm finance          # pregunta: escribe el nombre para confirmar
office rm finance --yes    # sin preguntar
```

Qué pasa al eliminar:

- Se **despiden todos sus robots** por la oficina (sus documentos pendientes pasan antes a la bandeja); los que estén trabajando se cortan. Si la oficina estaba detenida con robots vivos en tmux, se inicia un momento para despedirlos en orden. Después se cierra su sesión de tmux.
- La carpeta de la oficina en `~/.agent-office/oficinas/<nombre>` (registro, estado, bandeja, rutinas, salas, log) **va a la Papelera de macOS** como `agent-office-<nombre>-<fecha>`: nada se borra para siempre, se recupera arrastrándola de vuelta.
- Si la oficina fue **adoptada** con `--data` (como `legacy`), sus datos se quedan donde estaban; solo se quita del edificio.
- Los documentos que escribieron los robots en la **carpeta de trabajo** no se tocan nunca.

## Uso diario

```sh
office ls                       # todas las oficinas: estado, URL, sesión tmux, robots, te necesitan, bandeja
office lobby                    # página del edificio en http://127.0.0.1:4700 (office lobby stop la apaga)
office start nr | --all         # arrancar una o todas
office stop nr | --all          # pausar: apaga la oficina; los robots siguen vivos en tmux
office stop nr --despedir       # cerrar de verdad: da de baja a todos sus robots y apaga la oficina
office rm nr                    # eliminar: despide, apaga y manda la oficina a la Papelera
office restart nr               # tras actualizar el código del daemon
office logs nr                  # últimas líneas del daemon (office logs nr -f para seguirlo)
office ctl nr libre "resume el README"           # encargos desde la terminal (ver daemon/ctl.mjs)
office cuenta add b --dir ~/.claude-b --nombre "Dropi nueva"   # registrar otra cuenta de Claude (ver «Dos cuentas»)
office cuenta ls                # cuentas registradas: carpeta, enlaces OK/faltan y si tiene sesión iniciada
office cuenta rm b              # la quita del registro (no toca su carpeta)
tmux attach -t office-nr                         # ver las consolas de los robots (Ctrl-b d sale sin cerrarlas)
```

- **Dos cuentas de Claude**: el registro vive en el edificio (`~/.agent-office/cuentas.json`, `AGENT_OFFICE_HOME` lo cambia) y lo comparten todas las oficinas; la principal (`~/.claude`) está implícita. `cuenta add` crea la carpeta de la cuenta y la enlaza a `~/.claude` en `settings.json`, `skills/`, `agents/`, `projects/` (así la memoria y los transcripts son los mismos) y, si existen allí, `CLAUDE.md`, `commands/` y `plugins/`. Lo que ya hubiera en la carpeta con esos nombres se renombra a `<nombre>.antes-oficina`; nunca se borra. Después inicia sesión una vez: `CLAUDE_CONFIG_DIR=<carpeta> claude auth login`. Cada robot se lanza con la cuenta que elijas en el selector **Cuenta** de «Nuevo encargo» y de las rutinas (aparece solo si hay más de una; «Automática» elige la de más cuota libre); sin elegir, usa la principal como siempre.

- **Detener no despide a nadie (pausa)**: cada robot es una consola de `claude` en tmux, no un proceso de la oficina, así que sigue vivo y se reconecta solo (estado, escritorio y conversación) al arrancar la oficina otra vez. Sirve para reiniciar tras actualizar el código sin perder trabajo. Ojo: un robot que estaba trabajando **sigue trabajando y gastando cuota** aunque no lo veas; uno terminado o esperando no gasta nada.
- **Cerrar de verdad**: `office stop nr --despedir` (o **Cerrar y despedir** en el edificio) da de baja a cada robot por la oficina, que primero entrega sus documentos pendientes a la bandeja, y cierra la sesión de tmux. Si la oficina estaba detenida, la inicia un momento para eso. No se puede deshacer: un robot que estaba trabajando se corta.
- **Robots sin supervisión**: si una oficina está detenida y le quedan robots vivos en tmux, `office ls` lo avisa (y cuántos están trabajando) y el edificio marca la tarjeta en ámbar con **Iniciar y reconectar** o **Despedir robots**.
- **Reiniciar el Mac** cierra tmux y con él a todos los robots: esos no se recuperan.
- **Cabecera en una fila**: a la izquierda la marca, el nombre de la oficina y «● conectado»; al centro **Nuevo encargo**, **Bandeja** (con su contador) y 🔎; a la derecha el tope «Robots a la vez» y **☰ Más**. El menú **Más** junta Rutinas, 🌙 Cierre, 📌 Para enviar (tecla P), Uso Claude (con los tokens de la semana), 🩺 Salud (con la carpeta de trabajo) y ⚙ Ajustes (tecla V). Se cierra al hacer clic afuera o con Esc. 🚪 «en la puerta» y «Despedir listos» aparecen solo cuando hay algo.
- **Columna derecha con pestañas**: **Robots** (las tarjetas por urgencia; las secciones vacías no se muestran), **Salas** (lista compacta con estado, caras y avance, con los colores de las notas del corcho; clic entra a la sala) y **Rutinas** (activas, pausadas y su próxima ejecución; clic abre la rutina). Cada pestaña lleva un contador, en ámbar si algo ahí te necesita (un robot, una sala o una rutina con error). La pestaña elegida se recuerda en este navegador.
- **⚙ Ajustes** (menú Más o tecla V): lo que cambia cómo se ve la oficina: estilo, tema claro u oscuro, tamaño del texto, contraste, HD, 2.5D, compacta, avisos y sonido.
- **Avisos**: en la oficina, el botón *Avisos* (en «⚙ Ajustes») activa sonido y notificación del sistema cuando un robot te necesita o lleva 10 min sin actividad. El título de la pestaña siempre muestra cuántos te necesitan.
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
- **Solo local**: cada oficina y el edificio atienden únicamente peticiones a `127.0.0.1`/`localhost` en su puerto y rechazan (403) las que vienen de otra página: un sitio abierto en tu navegador no puede lanzar robots, escribirles ni aprobarles permisos. La página de la oficina y los robots (que llaman con `curl`, sin `Origin`) pasan; cada rechazo queda en el registro como «rechazada».
- **La oficina apareció detenida**: su registro (`office logs <nombre>`) dice cómo terminó. «office stop … · desde: el edificio / office stop en la terminal / office restart / office rm» = la detuvo el edificio; «se detiene: recibió SIGTERM» (u otra señal) = la detuvieron con una señal; «se cayó por un error» = un error, con su detalle; siempre cierra con «oficina detenida (código de salida N)». Si no hay ninguna de esas líneas, la mataron sin aviso (`kill -9`, el sistema).
- **Un robot no se mueve en la página**: revisa que el daemon esté corriendo (`office ls`) y su consola (`tmux attach -t <sesión>`).
- **«detenida · N vivos en tmux»** en `office ls`: la oficina está apagada pero sus robots no. `office start <nombre>` los reconecta; `office stop <nombre> --despedir` los da de baja.

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
- **Cuestionarios**: cuando un robot te hace preguntas con opciones (una o varias a la vez, de opción única o múltiple), la oficina las retiene y las muestra en su tarjeta de «Te necesitan» y en su panel; «Otra respuesta…» deja escribir. Lo que respondas le llega como si contestaras en su consola. «Responder en la consola» las suelta y la consola muestra su menú de siempre (también pasa si nadie responde en 9 minutos o si reinicias la oficina).
- **Copiar**: cada mensaje del robot tiene «📋 Copiar» arriba a la derecha para copiarlo entero, y además sus citas (`>`), bloques de código y lo que viene después de una línea `---` tienen su propio botón para copiar solo esa parte. Copia dos versiones a la vez: HTML limpio (Google Chat, Slack y correo pegan listas, negritas, código y enlaces de verdad) y texto en formato de chat para WhatsApp y lo demás (`*negrita*`, `_cursiva_`, `~tachado~`, listas con `•` y enlaces como «texto (url)»). A cada robot nuevo la oficina le indica (con `--append-system-prompt`) que entregue los mensajes para enviar dentro de una cita, así siempre tienen el botón.
- **Mientras no estabas**: si sales de la pestaña más de 10 minutos, al volver ves un solo resumen: quién terminó (y con cuántos críticos), quién te necesita, quién entró o se fue, quién lleva rato sin actividad y documentos nuevos. Cada nombre abre su robot.
- **Lanzar otro igual y frecuentes**: el panel de cada robot (y la tarjeta de los terminados) tiene «↻ Lanzar otro igual», que abre «Nuevo encargo» con lo mismo que le pediste para que solo cambies el PR o los argumentos. «★ Frecuente» (o «★ Guardar como frecuente» en el formulario) lo deja como acceso rápido arriba de «Nuevo encargo»; se guardan por oficina en `frecuentes.json` de su carpeta de datos.
- **Robots**: cada uno se viste según su trabajo (gorra e inspector con lupa en reviews y auditorías, portapapeles en documentación, casco en rutinas) y en ciertas fechas se pone gorro de temporada (Navidad en diciembre, bruja a fines de octubre, cono de fiesta en Año Nuevo). En su panel, «🎨 Apariencia» deja elegirle color (16: los 8 de siempre más lavanda, rubí, hoja, cobalto, oro, perla, acero y naranja), antena (4), visor (6: clásico, banda, ojos redondos, cíclope, gafas y pantalla LED) y accesorio (10: nada, audífonos, gorra, corbatín, flor, lazo, bufanda, gorro de lana, corbata e insignia); «Restablecer» vuelve al de su nombre. El aspecto por nombre sale solo de las opciones originales, así nadie cambia de cara al sumar opciones; si sumas más en `web/robot-art.js`, sube también los topes de `POST /api/robots/<n>/look` en `daemon/lib/http.mjs`.
- **Estilo de la oficina**: el selector «Estilo» de la barra cambia el mapa entre Moderna (la de siempre), Garaje, Nave, Biblioteca y Cafetería. Se guarda en la configuración de cada oficina, así NR y Legacy pueden verse distintas en cualquier navegador.
- **La oficina crece con el trabajo**: cada tarea terminada (cada vez que un robot entrega lo que le pediste) suma. Las plantas cuentan las tareas **de la semana de tu cuota**: a las 10, 40, 120 y 300 aparecen plantas nuevas por la oficina y las de siempre crecen y florecen. Cuando la cuota semanal se renueva, la cuenta vuelve a 0 y pasa el **cambio de materas**: las plantas se levantan, se marchitan y brotan chiquitas en materas de otro color (cada semana uno distinto); la animación sale una vez por renovación en cada navegador. En tu escritorio aparece un trofeo cada 10 tareas (los trofeos sí cuentan el total) y la pizarra de la sala de descanso cuenta las de hoy (pasa el mouse por la pizarra para ver el nivel). Se guarda en `estadisticas.json`, en la carpeta de datos.
- **Escritorio según el contexto**: los LED del pecho del robot miden qué tan lleno tiene el contexto (1 verde, 2 ámbar desde el 50 %, 3 rojos desde el 75 %; sin dato parpadean de adorno), y el escritorio se desordena: hojas, taza y una bola de papel desde el 25 %, post-its en el monitor desde el 50 % y papeles en el piso desde el 75 %. Pasa el mouse por el robot o su escritorio para ver el porcentaje. Al darlo de baja se va con una caja con sus cosas.
- **Michi**: la gata de la oficina pasea entre escritorios y se echa a dormir junto a los robots que llevan mucho trabajando.
- **De un vistazo**: el robot que te espera lleva un anillo a los pies (y su tarjeta un borde) que pasa de ámbar a naranja a los 5 min y a rojo a los 15. La cara del robot cambia según su estado: mira a su monitor si trabaja, feliz al terminar, «?» cuando te pregunta y una gota de sudor si lleva rato sin actividad o terminó con críticos. El segundo monitor de su escritorio muestra qué hace (código, terminal, leer, buscar, web o subagentes). El ícono de la pestaña lleva un círculo rojo con cuántos te necesitan.
- **Vista compacta**: el botón «Vista compacta» esconde el mapa y deja métricas, un mini mapa (una tira con los escritorios y quién está en cada uno, con el color de su estado; clic abre el robot) y tarjetas en columnas (te necesitan · trabajando · listos). Se recuerda en el navegador.
- **Tema claro**: «tema claro» / «tema oscuro» arriba a la derecha. El mapa sigue siendo la oficina de noche en los dos. Se recuerda en el navegador.
- **Avatares en el chat**: cada globo de un robot lleva su cabeza (color y accesorio), también en las salas de épica donde hablan varios.
- **Atajos de teclado** (no actúan mientras escribes): `J`/`K` siguiente/anterior robot, `S` siguiente que te espera, `A`/`D` aprobar/denegar el permiso (y pasa solo al siguiente que espera), `R` escribirle, `F` seguirlo en el mapa, `/` buscar, `P` para enviar, `+`/`−`/`0` zoom, `N` nuevo encargo, `B` bandeja, `Esc` cerrar, `?` ayuda.
- **Un robot puede pedir robots nuevos**: si le dices «repártelo en robots» (en vez de «con agentes»), le pide a la oficina robots independientes, cada uno con su consola y su contexto (`POST /api/robots/<robot>/encargos`, máximo 6). Tú los apruebas desde su ventana: puedes corregir cada encargo o desmarcar alguno. Entran si hay cupo y los demás esperan en la puerta (con ✕ para quitarlos). Los hijos salen con el mismo diseño que el padre (color, antena, visor y accesorio), pero **flotan con un propulsor** en vez de piernas, así se distinguen de él a simple vista, y se **llaman por lo que hacen**: del título del encargo sale su nombre («Revisión de los puertos» → `revision-puertos`, sin tildes ni palabras vacías; si se repite, `-2`). El padre puede proponer el nombre con `"nombre"` en cada encargo y tú lo corriges al aprobar. Los nombres quedan fijos desde la petición (sin chocar con los que ya están) y **la respuesta a su petición se los dice al padre** («se llamarán: puertos (Puertos), …»), así los reconoce por nombre y por tarea; si al aprobar cambias alguno, se le aclara junto con sus primeros resultados, sin mensaje aparte. En la sala, el **«Reparto»** dice quién es quién (`` `puertos` · Puertos · trabajando ``): se ve en el tablero y en `REPARTO.md` de la sala, y la oficina lo actualiza cuando cada uno entra, entrega o se va. No va en `CONTEXT.md`, que es de los robots: si la oficina lo reescribiera mientras un robot lo edita, su edición fallaría y tendría que releerlo. Los hijos lo reciben copiado en su encargo (ellos mismos salen como «tú»), así también conocen a sus hermanos. Cuando los hijos terminan su primer encargo, su respuesta final le llega al padre **sin esperar a los hermanos**: si el padre está libre, enseguida (tras una pausa de 20 s que junta a los que terminan casi a la vez, `OFFICE_RESULT_DEBOUNCE_MS`); si está ocupado (en un turno, esperando un permiso o tu respuesta), los que terminen mientras tanto se guardan y le llegan **juntos en un solo mensaje** al acabar su turno, en vez de abrirle un turno por cada hijo. Si reinicias la oficina, los resultados guardados no se pierden; el hijo se queda con LISTO por si quieres seguir con él aparte. **Sala de equipo**: al aprobarlos, el padre se muda con sus hijos a una sala «Equipo de <robot> · <tarea>», así se ve en el mapa que trabajan en lo mismo. Comparten su `CONTEXT.md`, donde la oficina deja el objetivo, el reparto y el `contexto` que el padre mande en la petición (lo que ya averiguó y todos deben saber), y el hilo de la sala, donde queda lo que cada uno dice al cerrar su turno. Si el padre ya estaba en una sala (de épica o de equipo), los hijos entran a esa y el reparto nuevo se agrega a su `CONTEXT.md`; lo mismo si un hijo pide robots. Cuando todos los hijos entregaron su resultado te llega el aviso «El equipo de <robot> terminó» y la sala queda en verde con «✓ terminó» (vuelve a «en curso» si entra más trabajo). Los hijos se quedan con LISTO hasta que los despides, uno por uno o todos los que ya entregaron con **«👋 Despedir a los que entregaron»** en la cabecera de la sala (dos clics; aparece solo si hay alguno); si el padre queda solo, vuelve caminando a un escritorio y la sala se cierra. Toda sala que se cierra (sola o a mano) pasa al **archivo** («🚪 Salas cerradas»), desde donde abres su contexto y su hilo, o la borras con «🗑 Borrar» (dos clics: sale del archivo y su carpeta va a la Papelera, de donde se recupera); sus archivos quedan en `runs/salas/<id>/`. **Vista de sala**: los robots que están en una sala no se dibujan en la oficina, que queda solo con los escritorios; si alguno de adentro te necesita, todo el cuarto «Salas de épica» late en ámbar y la fila de esa sala se rellena con un aviso («⚠ integrations-s pide permiso», «te pregunta», «espera tu respuesta», «pide robots»; si son varios, «⚠ 2 te necesitan») que con un clic abre al robot sin entrar a la sala. La sala aparece en «Salas de épica» con la cara del robot que la armó (con su color y apariencia, aunque ya se haya ido; un 📖 si es una sala de épica que creaste tú, y el aro de la cara dice su estado), cuántos robots tiene y, si alguno te necesita, en ámbar con «⚠ N te necesita». Al entrar a una sala el robot camina hasta el cuarto «Salas de épica» y ahí desaparece; al salir (o al despedirlo) aparece en ese cuarto y camina a su escritorio o a la puerta. Clic en la sala y el mapa pasa a mostrar solo esa sala con sus robots; «← Oficina» o Esc vuelven. Si mientras estás en una sala un robot de afuera (en la oficina o en otra sala) te necesita, la sala **brilla en rojo** y la cabecera dice «🔴 <robot> te necesita afuera»; con clic lo abres sin salir de la sala. Por dentro la sala tiene el piso del color del robot que la armó y, **con 7 robots o más, una mesa redonda grande**: los robots alrededor, a la misma distancia uno de otro (los de arriba de pie tras el borde, los de los costados y abajo delante); la mesa se calcula en píxeles con el ancho de tu pantalla (los robots miden lo mismo en cualquiera), así que crece hacia abajo si son muchos, y los nombres se cortan con «…» al ancho de su puesto (completos al pasar el mouse). Hasta 6 robots tiene una **mesa común** con los robots alrededor (entran y salen caminando por la puerta de la sala; cada uno llega con su **portátil** en las manos y lo deja en la mesa frente a su puesto (en la fila de arriba se ve la tapa por detrás, con el logo encendido mientras trabaja; en la de abajo, la pantalla con código), y se va con él; los de la fila de abajo llevan el globo bajo su nombre para no tapar la mesa; en la sala los globos nunca tapan la cabecera, el tablero ni se salen por abajo: cada uno mide lo que cabe entre dos puestos (completo al pasar el mouse) y, si la sala es baja, los de arriba pasan debajo del robot) y un **tablero** con el porqué de la sala (quién la armó, para qué y cómo repartió el trabajo), el **gasto del equipo** (lo de todos los que pasaron por la sala, también los que ya se fueron, con sus subagentes, desde que se armó; sale de los transcripts y no gasta cuota), su `CONTEXT.md` (se refresca cada 15 s; «Ver todo» lo abre completo) y las últimas notas del hilo como post-its. El tablero es compacto para que nada quede tapado: el porqué va en una línea (clic para verlo completo), el reparto y el gasto en una fila de chips (el detalle al pasar el mouse), el contexto siempre tiene espacio y las notas van en una franja que se desplaza (tus notas y las últimas 8 del hilo; clic en una abre el mensaje completo en el hilo); cuando alguien escribe en el hilo, un **sobrecito vuela** de él (o de la puerta) al tablero y ahí aparece su post-it. Con **«📌 Nota»** pegas notas tuyas en el tablero (hasta 4, × para quitarlas): son solo para ti, no van al hilo, ni a `CONTEXT.md`, ni a los robots, y no gastan tokens. El **avance del equipo** («2/5 entregaron», con barra) se ve en el tablero, en la sala de la lista «Salas de épica» y en su tarjeta, sin entrar; cuenta a los hijos que entregaron aunque ya los hayas despedido. «Hilo y contexto» abre su hilo y su `CONTEXT.md`. Al recargar la página sigues en la sala (va en la dirección, `#sala=<id>`). Solo funciona dentro de la oficina: las instrucciones y las variables `OFFICE_ROBOT`/`OFFICE_PORT` se pasan a cada robot al lanzarlo, y Claude fuera de la oficina no cambia.
- **Preguntas con opciones** (AskUserQuestion): tienen su propio hook de 8 h, así que puedes contestarlas en la oficina cuando vuelvas («Responder en la consola» las suelta antes). Los permisos retenidos siguen con 9 minutos. Ojo: reiniciar la oficina suelta las preguntas pendientes a la consola del robot, y los robots lanzados antes de este cambio siguen con 9 minutos.
- **Aviso de cuota**: antes de lanzar un robot, aprobar los que pide otro o retomar una tarea, si algún límite de tu suscripción va en 80 % o más, la oficina te pregunta si seguir.
- **🧹 Compactar**: cuando un robot pasa el 75 % de contexto y no está en medio de algo, su ventana y su tarjeta muestran un botón que le manda `/compact`. Al compactar (con el botón, a mano o automático), el medidor del pecho baja enseguida al contexto que quedó y la conversación lo anota («de 109.5 k a 12.6 k tokens»).
- **🗒 Notas**: una nota tuya por robot («esperando respuesta de Ramiro»), en la tarjeta, la nube del mapa, un post-it en su escritorio y el archivo de despedidos.
- **🗄 Archivo de despedidos**: el archivador de «Tu escritorio» (con un contador) o la tecla `H` abren la lista de los robots despedidos con «📝 Despedir con su resumen», con su super resumen, su título, su nota y cuándo se fueron, con un filtro. En cada uno: «↻ Retomar» (abre su resumen con la caja para escribirle qué sigue al robot nuevo), «Ver resumen» y «Quitar» (lo saca de la lista y manda su `.md` de `docs/resumenes-robots/` a la Papelera, de donde se recupera). Los relevados por contexto llevan la etiqueta «🔁 relevo» y «🧹 Limpiar relevos (N)», junto al filtro, los quita a todos de una vez (dos clics; sus resúmenes también van a la Papelera): son automáticos y su robot siguió con el mismo nombre y el resumen.
- **📝 Despedir con su resumen y retomar**: «📝 Despedir con su resumen» le pide al robot un super resumen (objetivo, qué hizo, en qué quedó, qué falta, qué espera y de quién, rutas clave) y lo despide al recibirlo. «Dar de baja» es solo eso: se va sin resumen, sin documento y sin entrar al archivo. Queda como documento en `docs/resumenes-robots/` de la carpeta de trabajo (aparte del resto de docs, se puede borrar cuando quieras: el archivo de despedidos guarda su propia copia para retomar) y en el archivo de despedidos. Desde el buscador lo abres y «↻ Retomar con este resumen» lanza un robot nuevo solo con ese resumen y tu instrucción (no con toda su conversación): si necesita más, se lo das tú o lo busca en los documentos y la memoria. Un robot LISTO sin actividad hace más de 2 h queda dormido (z z z) y su tarjeta sugiere «📝 Resumen y despedir».
- **💥 Consola caída y reanudar**: si la ventana tmux de un robot desaparece (se cerró tmux, la cerraron o se cayó), la oficina lo detecta en unos 10 s y no lo borra, ni siquiera al reiniciarse: queda en gris con «💥 se cayó» en el mapa y en «Te necesitan». «↻ Reanudar» (uno por uno, no hay «reanudar a todos») le abre otra consola con su misma sesión de Claude (`--resume`) y recuerda todo. Los agentes o tareas que tenía en segundo plano sí se cortan: pídele que los relance.
- **Conversación en orden y sin ruido**: los mensajes del robot se ordenan por su hora real (Claude guarda la sesión en tandas). Lo que dice antes de seguir usando herramientas («Ahora reviso…») sale chico como **avance**; su respuesta final, normal y con 📌, Pasar y Copiar. Los comandos que escribes en su consola también aparecen: `!comando` (terminal) con su salida, en rojo si falla, y los comandos de Claude (`/context`, `/compact`, `/model`…) con su resultado.
- **Gasto por robot**: cada tarjeta muestra «18 % sem.»: la parte del gasto de la **oficina** en la semana de tu cuota (desde que se renovó: la misma ventana del empleado de la semana, así los dos cuadran) que lleva ese robot (con sus subagentes). No es el límite de tu suscripción, que Claude no da por robot. La nube y el panel dicen además cuánto lleva en la semana y en la última hora. «Gasto» = entrada + salida + caché escrita, como los KPI. **🔥 Se disparó** (aviso único y la tarjeta en rojo) si gastó más de 1,5 M tokens en la última hora (en NR el 95 % de las horas de un robot quedan bajo 1,65 M) o lleva más del 25 % de la semana cuando la oficina ya pasó de 5 M. Se recalcula cada minuto sobre los transcripts y no gasta cuota.
- **⬇ Exportar conversación**: en la ventana de un robot (y en el archivo, para los que ya se fueron) guarda toda su conversación en `docs/conversaciones-robots/` de tu carpeta de trabajo, por si un resumen falla o queda corto. Sale del transcript completo de Claude (la oficina solo guarda los últimos 400 eventos): tus mensajes y los suyos con hora, los avances marcados aparte de sus respuestas, las herramientas como «usó N herramientas», sin recordatorios del sistema ni salidas de comandos, y la sesión para `claude --resume`. Si el transcript ya no está, usa lo que guardó la oficina y le agrega su resumen. Se abre al terminar.
- **🧾 Cambios (no gasta cuota)**: en la ventana de un robot, los archivos que tocó (sus Edit/Write y los de sus subagentes), agrupados por repo o worktree con su rama, y para cada uno si sigue sin commit (modificado, nuevo, borrado, con sus +/−) o ya está en un commit. Debajo, los otros cambios sin commit del mismo repo, por si cambió algo con `sed`, `mv` o un script. Git se consulta al abrir el bloque y con «↻», no en cada evento. Clic en un archivo: si tiene cambios lo abre en VS Code como diff contra el último commit; si no, tal cual (otro editor: `OFFICE_EDITOR`). Solo abre archivos de ese robot o de sus repos. A los robots de antes de esta función se les reconstruye la lista desde su transcript al arrancar.
- **👑 Empleado de la semana**: en tu escritorio cuelga el cuadro del robot que más tokens gastó desde que se renovó tu cuota semanal (con sus subagentes, esté o no en la oficina). Se reinicia en el mismo momento que la cuota: la hora sale de la pantalla de `/usage` y se guarda en la configuración de la oficina; si nunca se leyó, cuenta desde el lunes 00:00. Si ese robot sigue en la oficina lleva el **accesorio secreto**: corona con un fuego, o con **dos fuegos** si además es el que más gastó en la sesión actual de 5 h. No gasta cuota (cuentas sobre los transcripts, una vez por minuto). Clic en el cuadro abre al robot.
- **Detalles del mapa (no gastan cuota)**: los hijos flotantes dejan una **estela** de humo y chispas al moverse; de tarde y de noche se enciende la **lámpara** de cada escritorio ocupado; en tu escritorio cuelga un **reloj de la cuota** con la cuenta regresiva a la renovación semanal (la misma hora del cambio de materas; en ámbar la última hora); el editor de **🎨 Apariencia** trae un probador con el robot en grande que da una vuelta en cada cambio; y hay un estilo nuevo, **Bosque** (pasto, madera, árboles, hongos, tronco y luciérnagas de noche).
- **Edificio, más vida**: cuando le llega algo a la bandeja de alguna oficina, un **robot en bicicleta** pasa por la calle y deja un paquete en el buzón; cuando se renueva tu cuota hay **fuegos artificiales** sobre el edificio (una vez por renovación y por navegador; doble clic al letrero del techo los repite); y **cada piso se ve con el estilo de su oficina** (garaje, nave, biblioteca, cafetería o bosque), con su ícono en la placa.
- **🚀 Easter egg del edificio**: doble clic al ascensor. Tiembla, despega como cohete dejando humo, cruza el cielo y se estrella contra un edificio de la ciudad (a un lado, nunca sobre el edificio de oficinas) con un «¡BUM!»; luego el ingeniero, un robot blanco con barba, sale de la recepción, sube por una escalera, lo repara («¡Como nuevo! 👍») y vuelve. Solo dibujo: no toca ninguna oficina.
- **Vida de la oficina (no gasta cuota)**: un robot con LISTO hace rato va de vez en cuando por **café** a la sala de descanso con su taza humeante y vuelve (si le escribes, regresa enseguida); cuando un robot entrega un documento, lo lleva un **robotito cartero** desde su puesto hasta tu bandeja, y el robot sigue en lo suyo; la **pizarra** de la sala de descanso muestra en barras las tareas de cada día de la semana de la cuota (hoy en amarillo); la **cafetera** muestra con su jarra cuánto te queda de la cuota semanal (de `/usage`, que la oficina relee cada hora mientras la tengas abierta; es un comando local y no gasta tokens): llena al empezar la semana, ámbar con poco, vacía y en rojo cerca del límite. En las salas, la **pizarra de la pared** junta un garabato por cada mensaje del hilo, que se dibuja solo.
- **⟳ Detector de bucles**: si un robot (o uno de sus subagentes) usa la misma herramienta con los mismos datos 4 veces seguidas, se marca con ⟳ en el mapa y en su tarjeta y te avisa una vez: suele ser gasto sin avance. Se apaga cuando cambia de acción, le escribes o cierra su turno. Puede ser una espera a propósito (un sondeo): en ese caso, ignóralo. No gasta nada: compara los avisos de herramientas que ya llegan (`OFFICE_LOOP_N` cambia el 4).
- **🔁 Relevo por contexto** (`daemon/lib/relevo.mjs`): con mucho contexto cada turno relee todo y gasta tokens. Al cerrar turno con 300 k o más (`OFFICE_RELEVO_K`, en miles) la tarjeta y el panel ofrecen «🔁 Relevar (312 k)» y «Seguir así» (no vuelve a ofrecer hasta 100 k más). Relevar le pide un super resumen (incluye lo que esperaba en segundo plano y cómo relanzarlo), lo da de baja y entra un robot nuevo con el mismo nombre, título, aspecto, nota, padre y sala que arranca solo con ese resumen (`POST /api/robots/<robot>/relevar` y `/seguir-sin-relevo`). Además, un robot en espera (turno cerrado y tareas de fondo vivas) con 150 k o más (`OFFICE_RELEVO_ESPERA_K`) durante 45 min (`OFFICE_RELEVO_ESPERA_MIN`) se releva solo, porque la caché de Claude dura 1 h y retomar después reescribe todo el contexto. No se ofrece con subagentes, permiso, pregunta, robots pedidos ni en rutinas. `OFFICE_RELEVO_TICK_MS` cambia la revisión (60 s).
- **Historial de la cuota**: en «Uso Claude», «Tu cuota semana a semana» muestra el % más alto que marcó `/usage` en cada semana (últimas 16; la en curso punteada, ámbar desde 70 %, rojo desde 90 %).
- **Tiempo esperándote**: la métrica «esperándote hoy» suma cuánto pasaron los robots esperando un permiso, una pregunta o tu respuesta (ámbar desde 20 min, rojo desde 1 h; las esperas abiertas siguen sumando). Al hacer clic, «Uso Claude» muestra los últimos 7 días, quién esperó más hoy y los permisos que más hicieron esperar, para decidir si darlos fijos en `permissions.allow`. Una espera de menos de 3 s no cuenta. Lo calcula el daemon (`estadisticas.json`); no gasta tokens.
- **Legibilidad**: arriba, «Aa» cambia el tamaño del texto de tarjetas, métricas, paneles y globos del mapa (100, 115, 130 y 145 %; Mayús + clic lo achica), y «contraste» activa el alto contraste (textos y bordes más marcados, globos blancos con letra negra). Se guarda en tu navegador. Los globos que se salen por un costado del mapa se corren hacia adentro.
- **⏳ En espera**: si un robot cierra su turno dejando algo corriendo de fondo (una shell con `run_in_background` que vigila un CI, un `Monitor`, un despertador de `/loop` o un cron), no queda LISTO: lleva un ticket pequeño ⏳ y su tarjeta pasa a «⏳ En espera» con lo que espera («Esperar los checks del PR 233 (shell de fondo)»). Sale de la espera cuando Claude Code avisa que eso terminó (el aviso trae el mismo `tool_use_id`; también cuenta si llega a mitad de un turno, cuando Claude lo guarda como entrada interna del transcript), cuando la shell murió sin aviso (cada 2 min la oficina revisa con `lsof` si algún proceso sigue escribiendo su archivo de salida), cuando vence (el tiempo del Monitor o del despertador; 12 h como máximo) o con una sesión nueva. Al reiniciar la oficina, lo pendiente se reconstruye leyendo el transcript de cada robot, así cuentan también las tareas lanzadas antes. Los avisos intermedios de un Monitor no lo sacan. «Despedir listos» y el «Cierre del día» no lo cuentan como listo, y puede ir al café como cualquier robot que terminó.
- **🌙 Cierre del día**: el botón «🌙 Cierre» junta lo que queda abierto: quién te espera, quién terminó (con «Despedir» uno por uno o «👋 Despedir a los N listos», dos clics y sin resumen; los que tienen hijos trabajando se quedan), quién sigue trabajando, las salas en curso con su avance y tus notas, y tus pendientes (bandeja sin leer, «para enviar», encargos en la puerta). Sale de lo que la oficina ya sabe; no gasta tokens.
- **⎇ Filtro por repo**: cada tarjeta dice en qué repo trabaja el robot. Sale de lo que edita o crea y, si no, de la carpeta de su consola: un repo de primer nivel del workspace con `.git`, o `<repo>` en `worktrees/<tarea>/<repo>`. Con robots en más de un repo aparecen chips arriba de las tarjetas para filtrar; los de otros repos se atenúan en el mapa y el filtro se recuerda en el navegador.
- **🩺 Oficina (salud, limpieza y respaldo)**: el botón «🩺 oficina» de arriba avisa si algo falla y abre un panel. **Salud**: sesión de tmux, Claude Code instalado (solo verifica que exista, no lo ejecuta), hooks, carpeta de trabajo, consola de cada robot y su último hook, última lectura de `/usage` y espacio usado. Cada aviso dice qué hacer. **Limpieza**: lleva a la Papelera lo que tenga más de 3, 7, 14 o 30 días: eventos crudos (antes guarda sus `SessionStart` en `sesiones.jsonl`, de donde sale el uso por semana), conversaciones y adjuntos de robots que ya no están, respaldos de conversaciones y carpetas de salas sueltas. Nunca toca lo de hoy, a un robot de la oficina, las salas abiertas o archivadas, las rutinas ni las estadísticas. Se hace a mano (dos clics) o sola una vez por semana. **Respaldo**: «⬇ Descargar» guarda en un `.json` las rutinas, encargos frecuentes, «para enviar», nombre, estilo y tope de la oficina, y la apariencia de los robots presentes. «⬆ Importar» deja elegir qué partes suma (no borra nada; las rutinas llegan en pausa). Nada de esto gasta tokens.
- **🕐 Horas de trabajo**: en «Uso Claude», una gráfica de 24 horas muestra a qué hora trabajan los robots y a qué hora te esperan (últimos 14 días; la oficina lo anota cada minuto). La casilla «Registrar las horas de trabajo» la apaga: deja de anotar y la gráfica se esconde.
- **🎄 Temporadas**: además del gorro de los robots, la oficina se decora sola: luces y arbolito en diciembre, confeti en Año Nuevo, calabazas a fines de octubre y globos en el aniversario de la oficina (la fecha de creación de `office.json`). Solo es visual.
- **🔗 Enlaces directos**: `…/#robot=<nombre>` abre la oficina en ese robot y `…/#sala=<id>` en esa sala (también si cambias la dirección con la página abierta). «🔗 Copiar enlace» en el panel de cada robot y de cada sala. Solo funcionan en este computador (la oficina es solo local).
- **⬇ Exportar sala**: en el panel de una sala abierta o en cada sala cerrada del archivo, guarda la sala completa (porqué, reparto, contexto e hilo) en `docs/salas/` de tu carpeta de trabajo, para compartirla.
- **🏆 Muro de la fama**: la lupa 🔍 del cuadro del empleado de la semana abre los últimos 4 (esta semana y las 3 anteriores), calculados de los transcripts al abrirlo.
- **🎖 Antigüedad**: los robots con más de un día en la oficina llevan una medalla en el pecho; con más de una semana, de oro.
- **🔊 Sonido** (en «⚙ Ajustes», apagado por defecto): un «pop» al llegar un documento, una campanita cuando alguien te necesita (si «Avisos» está apagado, para no repetir) y una fanfarria cuando un equipo termina. Generados por el navegador: sin archivos ni tokens.
- **🎬 Modo cine** (tecla `C`): solo el mapa, a pantalla completa, sin barra, métricas ni tarjetas; `C` o `Esc` salen. Ideal para una segunda pantalla.
- **Edificio vivo**: en el lobby, la pantalla de cada robot que trabaja brilla en el color de su oficina y parpadea; una oficina encendida sin nadie trabajando se ve más apagada, y el letrero del techo cuenta los robots que trabajan en todo el edificio.
- **Medidor de contexto según el modelo**: los Claude 5 (Opus/Sonnet) tienen 1 M de tokens de ventana y Haiku o los anteriores 200 k; el porcentaje y la nube del robot lo dicen («5 % · 52 k de 1 M»).
- **Escribirle a un robot**: Enter envía y Shift+Enter hace salto de línea (también en el editor grande). La caja crece sola mientras escribes y se puede estirar; «⤢ Expandir» abre un editor casi a pantalla completa para respuestas o contextos largos. Autocompletado: `/` sugiere skills y comandos de Claude (`/compact`, `/context`…); al escribir, sugiere tickets y PRs que ya aparecieron en la oficina (`INT-40`, `nr-specs#138`) y los repos de la carpeta de trabajo. Tab o clic eligen, Esc cierra.
- **Rutinas** (botón «Rutinas»): tres tipos. **Vigilar PRs** (un repo o toda la organización) lanza un robot cuando un PR es nuevo, tiene commits nuevos, lo aprueban, piden cambios, tiene comentario o review nuevo o falla un check (por comentarios, máximo un robot por PR cada 30 min). **Tarea programada** lanza un robot con tus instrucciones y una memoria entre ejecuciones. **⏰ Despertador** espera a que un PR se apruebe, se mergee, tenga cambios pedidos, un comentario o checks verdes/rojos, a que un ticket de Nexus cambie de estado o se complete, o a una hora; entonces te avisa, le escribe a un robot (si se fue, lo retoma con su resumen; si su consola se cayó, lo revive), retoma un resumen del archivo o lanza un robot nuevo. Se cumple una vez y queda pausado. Horarios: cada N minutos (con horario laboral opcional), a una hora en los días que elijas, o una sola vez. Cada rutina se puede editar, duplicar y tiene historial con los robots que lanzó y lo que gastaron. «👁 Probar sin gastar» muestra qué haría ahora. Hay plantillas listas y el botón «⏰ Despiértame cuando…» en la ventana del robot (toma el PR o ticket de su nota) y «⏰ Retomar cuando…» en el archivo. Vigilar y el despertador no gastan cuota (gh y Nexus por API; el token de Nexus sale del entorno o de `~/.zshrc`); solo gasta el robot que despiertan o lanzan. La tarea programada gasta en cada ejecución.
- **Modo HD** (botón «HD» en «⚙ Ajustes», se guarda en el navegador): robots con volumen, cristal y brillo en el visor, juntas, sombra al piso y microanimaciones (respiran, la antena se mece, teclean al redactar y el monitor se refleja en el visor). Las animaciones se pausan con la pestaña oculta.
- **Zoom del mapa**: botones `− + ⤢` arriba a la derecha, `⌘`/`Ctrl` + rueda o pellizco en el trackpad; arrastra el piso para moverte. «📍 Seguir en el mapa» en la ventana del robot (o `Mayús` + clic sobre él) hace que la cámara lo siga. Solo en la vista 2D.
- **Cola de los que te esperan**: en la ventana de un robot, una barra dice cuántos te esperan (del que más lleva al más nuevo) con «Siguiente ›».
- **Buscar** (`/`): busca en las conversaciones de todos los robots de la oficina y en las salas, también en el hilo y el `CONTEXT.md` de las salas cerradas; clic en un resultado abre la conversación en ese mensaje (o el archivo de la sala cerrada). También busca en los **robots que ya se fueron**: al darlos de baja se guarda su resumen (encargo, título, sus mensajes y los tuyos, sin herramientas, y sus documentos) en `despedidos.json`, los últimos 200; con el buscador vacío ves los que se fueron hace poco.
- **Ver al lado**: en la ventana de un robot, «⇆ Ver al lado…» abre otro robot a la izquierda para leer y escribirle a los dos a la vez (`⇄` los intercambia).
- **📌 Para enviar**: el 📌 de un mensaje del robot lo guarda en `para-enviar.json`, en la carpeta de datos de la oficina, para pegarlo después en Google Chat o Slack (sigue aunque el robot se vaya); «✓ Enviado» lo quita.
- **↪ Pasar**: manda un mensaje de un robot a otro, citado y con quién lo dijo, más lo que quieras que haga con él.
- **Título del robot**: le pones un título («Tareas de QA», «Revisando wallet#32 Ramiro») al lanzarlo en «Nuevo encargo» o después con «✎ Ponle un título» en su panel. Sale en su tarjeta, al pasar el mouse sobre él en el mapa y en su ventana del edificio. Si no le pones uno, se sugiere a partir del encargo (por ejemplo «review-deep · dropi-tools#52»), en cursiva; «✓ Usar» lo guarda. Desde la terminal: `curl -s -X POST http://127.0.0.1:<puerto>/api/robots/<robot>/title -H 'Content-Type: application/json' -d '{"title":"Tareas de QA"}'`.
- **Inspector**: conversación (transcript) estilo chat, con tus mensajes a la derecha y los del robot a la izquierda en su color; las herramientas que usa se ven agrupadas en una línea que se despliega, todas o ocultas (selector «Herramientas», se recuerda en el navegador), chat que llega a la consola con `tmux paste-buffer -p` (los saltos de línea no parten el mensaje), consola en vivo, botón para abrirla en Terminal, tokens, Aprobar/Rechazar cuando pide permiso, Dar de baja.
- **Ciclo**: un `.md` escrito en el workspace aparece como hoja en el escritorio y se entrega en tu bandeja al terminar. Ningún robot se va solo: al terminar queda con el cartel LISTO y su conversación hasta que lo des de baja (✕ sobre el robot o «Despedir terminados»). La excepción son las **rutinas sin cambios**: un robot de rutina que cierra su turno sin haber cambiado nada (no editó archivos fuera de la memoria de la rutina, no hizo commit ni push, no comentó ni editó en GitHub o Nexus, no usó una herramienta MCP que crea, edita o envía), sin documentos, sin tareas de fondo ni hijos y sin que le escribieras después del encargo, queda 45 s con el cartel LISTO y se da de baja solo, con lo que dijo como resumen en el archivo; en el historial de la rutina sale como «sin cambios». Ante la duda cuenta como cambio y el robot se queda (`OFFICE_NO_CHANGE_GRACE_MS` cambia la espera). Los terminados no cuentan para el tope de robots a la vez. Cada robot muestra quién lo lanzó (tú, una rutina, la terminal o la API). Si el turno termina en pregunta, el robot levanta la mano.
- **Oficina llena → la puerta**: si lanzas un encargo (o un robot en una sala) con la oficina en el tope, no da error: queda **en la puerta** y entra solo, en orden, cuando un robot termina o se va. «🚪 N en la puerta» en la barra lo muestra; en «Nuevo encargo» ves la fila y sacas cualquiera con ✕. Si subes el tope con +, entra de inmediato. La fila se guarda con el estado de la oficina. Las rutinas y los `curl` de robots no se encolan (reciben el error de siempre y reintentan solos).
- **Nombre de la oficina**: clic en *ponle nombre* junto al título (Enter guarda, Esc cancela). Es estético: sirve para distinguir varias oficinas en el navegador, porque aparece en el encabezado, en el título de la pestaña y en el favicon (inicial y color derivados del nombre). Se guarda en `runs/config.json` (`name`).
- **Celebraciones y alertas**: al entregar un documento salta confeti sobre la bandeja. Si es un review con `## Hallazgos Criticos` que trae hallazgos (`###`), no hay confeti: el robot muestra el cartel rojo «⚠ N críticos», el documento lleva la etiqueta en la bandeja y se enciende una luz roja giratoria en tu escritorio. La luz sigue encendida hasta que abras el review o lo marques como visto.
- **Salas de rutina**: los robots que lanza una rutina (o que delega una rutina de agenda) se sientan en una sala temporal con el nombre de la rutina, debajo de los escritorios; la sala desaparece cuando se va su último robot.
- **Espera de respuesta**: un robot con una pregunta muestra un contador; a los 2 min baila y a los 3 min hace fila frente a tu escritorio (por orden de llegada). Al responderle vuelve a su escritorio o sala.
- **Uso y estado Claude**: lee `/usage` en una consola tmux aparte (`<sesión>:_status`, no gasta cuota) y suma por semana los tokens de las sesiones que lanzó la oficina, incluidos sus subagentes.
- **Reagrupar en salas**: en la ventana de un robot, «🚪 Mudar a una sala…» lo lleva a una sala abierta (o lo devuelve a un escritorio); lo de la sala le llega con su próximo mensaje, sin gastar un turno. Una sala cerrada se reabre desde el archivo («↩ Reabrir») con su contexto, hilo, notas y reparto, y ya no se cierra sola. El relevo por contexto retiene la sala mientras entra el robot nuevo: aunque el que coordina quede solo un momento, la sala no se cierra ni lo manda a su escritorio.
- **Salas de épica** (paso 5, se guardan en `runs/salas.json`): una sala por épica o tarea de Jira, con nombre, clave y carpeta de documentos opcional (ej. `TASK/WALLET`). Comparten dos archivos en `runs/salas/<id>/`:
  - `CONTEXT.md`: alcance, decisiones y estado verificado. Cada robot que entra lo lee primero y lo corrige en su lugar cuando verifica algo durable. No se entrega en la bandeja.
  - `HILO.md`: el hilo de la sala. Lo que dice cada robot al cerrar su turno se publica solo; tú escribes desde el panel (opcionalmente enviándolo a los robots de la sala, lo que gasta cuota). Un robot puede publicar a mitad de turno con `curl -X POST ".../api/salas/<id>/hilo?from=$OFFICE_ROBOT" --data-binary @archivo`.
  - Los robots de la sala se sientan en una sala temporal debajo de los escritorios, igual que los de una rutina. Cerrar la sala exige darlos de baja antes; los archivos quedan en el disco.
  - Sin herramientas MCP propias por ahora: los robots usan Read/Edit sobre esos archivos y `curl` contra el daemon.
- **Sala de descanso** (donde estaban las salas Git y Jira del paso 4, que no se usaban): robots que solo son animación, sin consola ni cuota, toman café, charlan, juegan ping-pong y rotan; hay de 2 a 7, más cuando hay poco trabajo. Un clic en uno abre «Nuevo encargo» con su nombre y, al lanzarlo, ese robot sale del descanso hacia su escritorio.

Limitaciones conocidas: los tokens de los subagentes no se suman todavía; al reconectar un robot se pierden las líneas de herramientas de su conversación (el transcript solo trae lo que dijo).

---

## Paso 1: prueba técnica

Validó, sin interfaz gráfica, que se puede manejar el `claude` de la suscripción desde tmux y recibir sus eventos estructurados. Prototipo visual: https://claude.ai/artifact/SWpyyC7W4wZpDiZ4DB6GkC

## Piezas

| Archivo | Qué hace |
|---|---|
| `bin/office` | El edificio: crea, arranca, detiene, elimina y lista oficinas; sirve la página del edificio (`edificio/index.html`) con su API (`GET/POST /api/offices`, `POST /api/offices/<nombre>/start|stop|delete`). |
| `web/robot-art.js` | Dibujo de los robots (antena, visor, accesorios), compartido por la oficina y el edificio. |
| `office-settings.json` (en los datos) | Hooks que se cargan **solo** en los robots (`claude --settings …`). Tus sesiones normales no los ven. Lo genera el daemon. |
| `hooks/office-hook.sh` | Reenvía el JSON del hook al daemon. Sale sin hacer nada si no existe `OFFICE_ROBOT` o si el daemon no responde. |
| `daemon/daemon.mjs` | Una oficina: lanza robots en su sesión tmux, sirve la página, sigue transcripts, suma tokens y (opcional) retiene permisos. Sin dependencias. Solo arranca: carga los módulos de `daemon/lib/` en orden y abre el servidor. |
| `daemon/lib/*.mjs` | El código del daemon, un módulo ES por tema, con sus `import`/`export` explícitos: `base` (configuración, rutas, sesión; no depende de ningún otro), `estado` (robots y lo que va a la página), `uso` (tokens, gasto por robot, empleado de la semana, `/usage`), `carpeta`, `persistencia`, `equipo` (robots que lanza un robot: cola, nombres, resultados), `turno` (ciclo del turno, frecuentes, fijados, archivo), `exportar`, `consola`, `transcript`, `hooks`, `adjuntos`, `tmux` (lanzar y escribirle a un robot), `rutinas`, `salas` y `http`. Cada módulo trae sus rutas de la API junto a su código (`rutinasApi`, `salasApi`, `frecuentesApi`, `fijadosApi`, `despedidosApi`, `puertaApi`, `equipoRobotApi`); `http.mjs` las llama en orden y se queda con lo general (configuración, página, eventos, documentos, bandeja y las rutas de cada robot). Una ruta de módulo devuelve `send(...)`, que da `true`: así `http.mjs` sabe que ya atendió. Lo que el daemon hace al arrancar (revisar la sesión, preparar los datos y los hooks, tomar el candado, escuchar señales) está en `boot()` de `base`, y solo lo llama `daemon.mjs`: así cualquier módulo se puede importar suelto en una prueba. Reglas: una variable compartida solo la reasigna su módulo (los demás usan su función `set…` o cambian la lista en su lugar con `replaceList`), y lo que corre al cargar un módulo solo puede usar `base` o lo suyo, porque los módulos se importan entre sí en ciclo. |
| `daemon/ctl.mjs` | Control desde la terminal: `skill`, `libre`, `say`, `approve`, `reject`, `pane`, `kill` (con el edificio: `office ctl <oficina> …`). |
| `web/` | La página de la oficina (`index.html`, `style.css`, `robot-art.js`). |
| `web/app/*.js` | El código de la página, un archivo por tema (`02-mapa`, `05-rutinas`, `12-panel`, `16-eventos`…). El daemon los sirve unidos en orden de nombre como `/app.js`, dentro de una sola función: comparten variables y funciones como si fueran un archivo, así que un archivo puede usar lo de otro sin importarlo. Ojo con el orden solo en lo que corre al cargar la página (fuera de una función): ahí una `const` o `let` de un archivo con número mayor todavía no existe; las `function` sí se ven desde cualquiera. Para un tema nuevo, crea el archivo con el número que le toca. |
| `test/` | Pruebas sin gastar cuota. Integración, contra una oficina aislada y un Claude falso: `node --test --test-concurrency=1 test/office.test.mjs` (necesita tmux). Unitarias, que importan los módulos de `daemon/lib/` sueltos (una décima de segundo): `node --test --test-force-exit test/unit.test.mjs`. |
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

## Gasto de tokens de la oficina

La oficina procura no gastar cuota por su cuenta. Lo visual (mapa, salas, animaciones, plantas, nombres de los hijos) y lo que ella organiza (hilo de las salas, avisos, archivo, gasto por robot, empleado de la semana) corre en el daemon y en tu navegador, sin Claude. Lo que sí gasta es lo que se le escribe a un robot, y se mantiene al mínimo:

- **Instrucciones de cada robot** (`ROBOT_HINTS`, van en cada llamada a la API, en caché): sin relleno, unos 500 tokens. El ahorro va en lo repetitivo, nunca en lo que cambia la calidad del trabajo del robot.
- **Al aprobar los robots que pide un robot** no se le escribe al padre (eso le abriría un turno): la ruta del `CONTEXT.md` de su sala ya se la dio la respuesta de su petición.
- **Resultados de los hijos**: enseguida si el padre está libre; los que llegan mientras trabaja, juntos al terminar su turno (un turno, no uno por hijo). Nadie espera a sus hermanos.
- **Al entrar a una sala**, el `CONTEXT.md` va copiado en el encargo (si mide hasta 8000 caracteres), así el robot no gasta una vuelta en leerlo, junto con los últimos 5 mensajes del hilo para que no repita trabajo.
- **Arranque liviano**: cada robot se lanza sin las herramientas que no usa y que viajan en cada llamada (Artifact, Workflow, SendFeedback, ShareOnboardingGuide): la base baja de ~40 k a ~24 k tokens (medido con `/context`). `OFFICE_ROBOT_DISALLOWED` cambia la lista (`''` = ninguna); `OFFICE_ROBOT_STRICT_MCP=1` además deja fuera los conectores MCP de tu cuenta (~2,7 k más, pero el robot no los podrá usar). Excepción por robot: con `tools: ["artifact"]` (casilla «📄 Con Artifact» en Nuevo encargo, o `"herramientas": ["artifact"]` en un pedido de robots) ese robot conserva Artifact, ArtifactComments y ArtifactData (~10 k tokens más por llamada); el campo sobrevive a revivir, relevo y retomar. Cómo pedir robots está en `daemon/robots-equipo.md`, que el robot lee solo cuando le piden repartir trabajo.
- **Robot frío** (más de 55 min sin actividad, `OFFICE_COLD_MS`): su caché venció y escribirle le hace pagar toda su conversación de nuevo. «Despedir con su resumen» entonces no lo despierta: la oficina arma el resumen (objetivo, nota, lo último que dijo, documentos, archivos que tocó y su sesión) y lo despide; el botón dice «(sin tokens)».
- **Hilo de sala**: lo que escribes despierta solo a los que nombras con `@nombre` (o a todos si marcas «Despertar ya»); a los demás les llega pegado a su próximo mensaje, sin turno aparte. Lo mismo al mudar un robot a una sala.
- **Tarea programada con condición**: «Lanzar solo si cambia» corre un comando antes (sin tokens) y solo lanza el robot si su salida cambió desde la vez anterior.
- Lo que sí gasta y decides tú: escribirle a un robot, «Despertar ya» en el hilo, «Despedir con su resumen» de un robot activo, los despertadores que le escriben a un robot y las rutinas.

## Tareas futuras

### Cualquier IA y cualquier modelo

Hoy la oficina funciona solo con **Claude Code**. Cada robot es `claude` corriendo en tmux. El estado sale de los hooks de Claude Code (`PreToolUse`, `Stop`, `UserPromptSubmit`…), lo que dice y los tokens salen de su transcript JSONL, y la cuota sale de `/usage`. La idea es que también se pueda colocar otra IA con CLI (u otro modelo) y que la oficina siga corriendo **sin romperse por lo que esa herramienta no tenga**.

- **Adaptador por herramienta**: un módulo por CLI (`daemon/lib/ia/<nombre>.mjs`) que diga cómo lanzarla, cómo traducir sus eventos a los de la oficina (trabajando, esperando permiso, pregunta, terminó), cómo leer su transcript y cómo mandarle un mensaje. El de Claude Code sería el primero y el que viene por defecto.
- **Capacidades declaradas**: cada adaptador dice qué sabe hacer (hooks, permisos retenidos, preguntas con opciones, subagentes, tokens, cuota, `/clear`, `/compact`). Lo que falte se apaga solo, sin errores. Por ejemplo, sin cuota no salen la cafetera ni el reloj ni el historial. Sin hooks, el estado se deduce de la consola (inactiva = esperando). Sin tokens, el gasto queda en «—» y esa IA no entra al empleado de la semana.
- **Elegir IA y modelo por robot**: al contratar o en su apariencia, con la IA y el modelo por defecto de la oficina en `.office.json`. Se ve en la tarjeta del robot.
- **Lo visual no cambia**: mapa, salas, pizarras, edificio y rutinas no dependen de la IA. Los robots pedidos por otro robot y las salas de equipo funcionarían igual si la herramienta puede llamar a la API de la oficina (`curl` a `OFFICE_PORT`).
- **Pruebas**: un CLI falso sin hooks ni cuota, para comprobar que la oficina arranca, muestra al robot y no truena.
