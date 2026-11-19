// Oficina de Agentes · ciclo de vida del turno, frecuentes, fijados y archivo de despedidos.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inbox, now, replaceList, robots, RUNS, trunc, WORKSPACE } from './base.mjs';
import { broadcast, bumpStats, emit, view } from './estado.mjs';
import { log, saveState, setState } from './persistencia.mjs';
import { maybeFlush, pendingResults, reportToParent } from './equipo.mjs';
import { removeRobot } from './consola.mjs';
import { checkRelevo, finishRelevo } from './relevo.mjs';
import { emitSalas, postThread, salas, saveSalas } from './salas.mjs';
import { readBody, send } from './http.mjs';

/* ---------- ciclo de vida del turno ---------- */

const SUMMARY_ASK = '[Oficina] Te vamos a despedir. Responde SOLO con un super resumen en Markdown (máximo 25 líneas) para que otro robot, '
  + 'sin tu contexto, pueda retomar la tarea: objetivo, qué hiciste, en qué quedaste, qué falta, qué estabas esperando (de quién o de qué), '
  + 'y repos, ramas, PRs, archivos y documentos clave con su ruta. Sin saludos ni preguntas. No uses herramientas.';
function finishTurn(r, lastMessage) {
  if (lastMessage) r.bubble = trunc(lastMessage, 140);
  if (r.relevoPending && r.pendingSubs <= 0 && String(lastMessage ?? '').trim()) { // su relevo: se guarda, se va y entra otro con su nombre
    r.summaryPending = false; r.relevoPending = false;
    finishRelevo(r, lastMessage).catch(e => log(r, 'sys', `No se pudo lanzar el robot de relevo: ${e.message}`));
    return;
  }
  if (r.summaryPending && r.pendingSubs <= 0 && String(lastMessage ?? '').trim()) { // su resumen: se guarda y se va
    r.summaryPending = false;
    removeRobot(r, 'despedido con su resumen', lastMessage);
    return;
  }
  r.activity = '';
  r.tool = '';
  if (r.pendingSubs > 0) { setState(r, 'delegating'); emit(r); return; }
  // En una sala de épica, lo que dijo al cerrar el turno queda en el hilo para los demás robots.
  const sala = r.place.sala && salas.find(s => s.id === r.place.sala);
  if (sala && String(lastMessage ?? '').trim()) postThread(sala, r.name, lastMessage);
  // Los documentos se entregan al terminar cada turno, aunque el robot quede esperando una respuesta.
  deliver(r);
  // Un turno que termina en pregunta queda esperando tu respuesta: no se va.
  if (/\?\s*[`*_)\]]*\s*$/.test(String(lastMessage ?? '').trim())) {
    setState(r, 'input');
    checkRelevo(r);
    emit(r);
    return;
  }
  // Ningún robot se va solo: queda con el cartel LISTO y su conversación hasta que lo des de baja.
  if (r.state !== 'done') bumpStats(r);
  reportToParent(r, lastMessage);
  setState(r, 'done');
  checkRelevo(r); // con mucho contexto, ofrece el relevo
  emit(r);
  // Cerró su turno: si le guardé resultados de sus hijos mientras trabajaba, le llegan ahora, todos juntos.
  if (pendingResults.has(r.name)) setTimeout(() => maybeFlush(r.name), 1500);
}

// Entrega a la bandeja todos los documentos del robot que aun no entrego (o que cambio despues de entregarlos).
function deliver(r) {
  const pending = r.docs.filter(d => !d.delivered);
  if (!pending.length) return;
  const items = pending.map(d => ({
    id: crypto.randomBytes(4).toString('hex'), path: d.path, robot: r.name, label: r.label, sessionId: r.sessionId,
    at: now(), status: 'nuevo', updated: !!d.updated, critical: countCriticals(d.path)
  }));
  for (const d of pending) { d.delivered = true; d.updated = false; }
  // Un documento actualizado reemplaza su entrada anterior en la bandeja.
  for (const it of items) {
    const old = inbox.findIndex(x => x.path === it.path);
    if (old >= 0) inbox.splice(old, 1);
    inbox.unshift(it);
  }
  log(r, 'sys', `Entregó ${items.length} documento${items.length === 1 ? '' : 's'} en tu bandeja: ${items.map(i => path.basename(i.path)).join(', ')}`);
  broadcast({ type: 'deliver', name: r.name, items });
  emitInbox();
  emit(r);
}

// Hallazgos críticos de un review: los `###` bajo «## Hallazgos Criticos» (con o sin tilde) hasta la siguiente sección.
function countCriticals(file) {
  if (!/\.(md|markdown)$/i.test(file)) return 0;
  let text;
  try { if (fs.statSync(file).size > 2e6) return 0; text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  let inSection = false, n = 0;
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) inSection = /^##\s+(hallazgos\s+cr[ií]ticos|critical\s+findings)\b/i.test(line);
    else if (inSection && /^###\s/.test(line)) n++;
  }
  return n;
}

// Críticos del robot = los de sus entregas que siguen sin ver en la bandeja (de este robot, no de uno anterior
// con el mismo nombre). Al abrir el review, marcarlo visto o archivarlo, el cartel ⚠ del robot se quita;
// si lo vuelve a entregar corregido, cuenta lo nuevo.
// Lo que se le encargó al robot, para «Lanzar otro igual». Los robots de antes de guardarlo se deducen del prompt.
function requestOf(r) {
  if (r.request) return r.request;
  const p = String(r.prompt || '').replace(/ \[Adjuntos: [^\]]*\]$/, '');
  const m = /^\/([a-z0-9:_-]+)\s*([\s\S]*)$/i.exec(p);
  return m ? { kind: 'skill', skill: m[1], args: m[2], text: '', permissionMode: r.permissionMode || '' }
    : { kind: 'libre', skill: null, args: '', text: p, permissionMode: r.permissionMode || '' };
}

// Encargos frecuentes: atajos guardados en Nuevo encargo (por oficina, en su carpeta de datos).
const FAV_FILE = path.join(RUNS, 'frecuentes.json');
let favorites = [];
try { favorites = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')); } catch { /* sin frecuentes */ }
function saveFavorites() { fs.writeFileSync(FAV_FILE, JSON.stringify(favorites, null, 2)); broadcast({ type: 'favorites', favorites }); }
// «Para enviar»: mensajes de robots que fijaste para pegarlos después en Google Chat o Slack. Guardan el texto,
// así siguen aunque el robot se vaya.
const PIN_FILE = path.join(RUNS, 'para-enviar.json');
let pins = [];
try { pins = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')); } catch { /* sin fijados */ }
function savePins() { fs.writeFileSync(PIN_FILE, JSON.stringify(pins, null, 2)); broadcast({ type: 'pins', pins }); }

// Indicaciones que la oficina le suma a cada robot nuevo: los mensajes para enviar van en una cita (>) para que la
// oficina les ponga «📋 Copiar»; al copiar se convierten al formato del chat, así que el robot escribe Markdown normal.
// Va como --append-system-prompt en cada robot (viaja en cada llamada a la API, en caché). Sin relleno, pero sin
// quitar nada que cambie la calidad de lo que hace el robot.
const ROBOT_HINTS = 'Trabajas dentro de la Oficina de Agentes, que muestra tus respuestas en una página web. '
  + 'Si te piden redactar un mensaje para otra persona (Google Chat, WhatsApp, Slack, correo), entrégalo completo dentro de una cita Markdown (cada línea empieza con «> »), una cita por mensaje y sin comentarios tuyos adentro; lo que quieras decirme a mí va fuera. '
  + 'Dentro de la cita usa Markdown normal (**negrita**, _cursiva_, listas con -, enlaces): la oficina lo convierte al formato del chat al copiarlo. '
  + 'Esos mensajes los firmo yo: primera persona del singular (yo hice, revisé, encontré, necesito), nunca en plural (hicimos, revisamos), y sin mencionar a Claude ni a la IA salvo que te lo pida; el plural solo vale cuando de verdad incluye al destinatario o a su equipo ("necesitamos validar juntos"). '
  + 'Si te piden repartir trabajo en ROBOTS (robots nuevos, independientes, otras consolas), no uses subagentes: pídeselos a la oficina con un archivo JSON '
  + '{"contexto":"lo que ya averiguaste y sirve a todos: decisiones, datos verificados, qué no repetir","encargos":[{"nombre":"una o dos palabras de lo que hace, ej. puertos-wallet","titulo":"título corto","encargo":"qué debe hacer"}]} (máximo 6) '
  + 'enviado con: curl -s -X POST "http://127.0.0.1:$OFFICE_PORT/api/robots/$OFFICE_ROBOT/encargos" -H "Content-Type: application/json" --data-binary @<archivo>. '
  + 'Cada robot nuevo arranca sin tu conversación: el encargo debe ser autosuficiente (objetivo, repos y rutas, documentos de entrada, restricciones, qué entregar y en qué formato). '
  + 'El usuario los aprueba en la oficina; tú y ellos quedan en una sala cuyo CONTEXT.md recibe ese contexto (la respuesta del curl te da su ruta). '
  + 'Sigue con tu trabajo: cada resultado te llega como mensaje «[Oficina] Resultado…» (los que terminen mientras trabajas te llegan juntos al terminar tu turno); intégralos. '
  + 'Si te piden agentes o subagentes, usa la herramienta de agentes como siempre.';

const cleanTitle = t => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

function criticalOf(r) {
  const since = Date.parse(r.startedAt || '') || 0;
  return inbox.reduce((n, i) => n + (i.robot === r.name && i.status !== 'visto' && (Date.parse(i.at) || 0) >= since ? i.critical || 0 : 0), 0);
}

function emitInbox() {
  broadcast({ type: 'inbox', inbox });
  for (const r of robots.values()) {
    const c = criticalOf(r);
    if (c !== r.critShown) { r.critShown = c; broadcast({ type: 'robot', robot: view(r) }); }
  }
  saveState();
}

// Que cuenta como documento: Write de estos tipos; Edit solo en Markdown (para no contar cada archivo de codigo).
const DOC_WRITE = /\.(md|markdown|html?|txt|csv|json|ya?ml|pdf|png|jpe?g|gif|svg|drawio|mmd|docx|xlsx|pptx)$/i;
const DOC_EDIT = /\.(md|markdown)$/i;
function trackDoc(r, tool, file) {
  if (!file) return;
  const p = path.resolve(file);
  if (p.startsWith(RUNS + path.sep)) return; // memoria de rutinas, adjuntos, estado de la oficina
  const isDoc = tool === 'Write' ? DOC_WRITE.test(p) : DOC_EDIT.test(p);
  if (!isDoc) return;
  const d = r.docs.find(x => x.path === p);
  if (!d) r.docs.push({ path: p, at: now(), delivered: false, updated: false });
  else if (d.delivered) { d.delivered = false; d.updated = true; }
  else return;
  const sala = r.place.sala && salas.find(s => s.id === r.place.sala);
  if (sala && !sala.docs.some(x => x.path === p)) { sala.docs.push({ path: p, robot: r.name, at: now() }); saveSalas(); emitSalas(); }
  log(r, 'doc', p.startsWith(WORKSPACE + path.sep) ? path.relative(WORKSPACE, p) : p);
  emit(r);
}

// Archivo de despedidos: al dar de baja a un robot se guarda su resumen (encargo, título, documentos y sus
// mensajes y los tuyos, sin herramientas) para encontrarlo después con el buscador. Se guardan los últimos 200.
const ARCH_FILE = path.join(RUNS, 'despedidos.json');
const ARCH_MAX = 200;
let archive = [];
try { archive = JSON.parse(fs.readFileSync(ARCH_FILE, 'utf8')); } catch { /* sin despedidos */ }
const normText = t => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Super resumen de lo que hacía: el que escribió el robot al despedirlo con «📝 Despedir con su resumen» o, si no,
// uno que arma la oficina con el encargo, tu nota, su último mensaje y sus documentos. Queda como documento en
// docs/resumenes-robots/ de la carpeta de trabajo (a mano, aparte del resto de docs y fácil de borrar) y es lo
// único que recibe el robot que retome la tarea.
const sumDir = () => path.join(WORKSPACE || RUNS, 'docs', 'resumenes-robots');

// Rutas de la API: encargos frecuentes. Las llama http.mjs en orden; devuelven algo (true) si atendieron la petición.
async function frecuentesApi(req, res, url, parts) {
    if (req.method === 'POST' && url.pathname === '/api/favorites') {
      const b = await readBody(req);
      const kind = b.kind === 'libre' ? 'libre' : 'skill';
      const f = { id: crypto.randomBytes(3).toString('hex'), name: trunc(String(b.name || '').trim(), 40), kind,
        skill: kind === 'skill' ? String(b.skill || '').replace(/^\//, '').trim() : null, args: kind === 'skill' ? String(b.args || '') : '',
        text: kind === 'libre' ? String(b.text || '') : '', permissionMode: b.permissionMode || '', title: cleanTitle(b.title) };
      if (kind === 'skill' ? !f.skill : !f.text.trim()) return send(res, 400, { error: 'Llena el encargo antes de guardarlo.' });
      f.name ||= f.title || (kind === 'skill' ? trunc(`/${f.skill} ${f.args}`.trim(), 40) : trunc(f.text, 40));
      favorites.push(f); if (favorites.length > 30) favorites.shift();
      saveFavorites();
      return send(res, 201, { ok: true, favorite: f });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'favorites' && parts[2]) {
      replaceList(favorites, favorites.filter(f => f.id !== parts[2]));
      saveFavorites();
      return send(res, 200, { ok: true });
    }
}

// Rutas de la API: mensajes fijados. Las llama http.mjs en orden; devuelven algo (true) si atendieron la petición.
async function fijadosApi(req, res, url, parts) {
    if (req.method === 'POST' && url.pathname === '/api/pins') {
      const b = await readBody(req);
      const text = String(b.text || '').slice(0, 60000), robot = trunc(String(b.robot || '').trim(), 40);
      if (!text.trim() || !robot) return send(res, 400, { error: 'Falta el mensaje.' });
      const at = String(b.at || new Date().toISOString());
      const dup = pins.find(p => p.robot === robot && p.at === at);
      if (dup) return send(res, 200, { ok: true, pin: dup });
      const p = { id: crypto.randomBytes(4).toString('hex'), robot, title: trunc(String(b.title || ''), 80), at, text, pinnedAt: new Date().toISOString() };
      pins.push(p); if (pins.length > 100) pins.shift();
      savePins();
      return send(res, 201, { ok: true, pin: p });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'pins' && parts[2]) {
      replaceList(pins, pins.filter(p => p.id !== parts[2]));
      savePins();
      return send(res, 200, { ok: true });
    }
}

export { ARCH_FILE, ARCH_MAX, archive, cleanTitle, criticalOf, deliver, emitInbox, favorites, fijadosApi, finishTurn, frecuentesApi, normText, pins, requestOf, ROBOT_HINTS, saveFavorites, savePins, sumDir, SUMMARY_ASK, trackDoc };
