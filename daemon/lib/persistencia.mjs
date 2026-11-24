// Oficina de Agentes · guardar y restaurar el estado entre reinicios.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  colorSeq,
  console_,
  inbox,
  maxRobots,
  now,
  robots,
  run,
  RUNS,
  saveJson,
  SESSION,
  setColorSeq,
  setMaxRobots,
  TIMELINE_MAX,
  WORKSPACE
} from './base.mjs';
import { addWait, broadcast, emit } from './estado.mjs';
import { pendingResults, spawnQueue } from './equipo.mjs';
import { criticalOf } from './turno.mjs';
import { markLost } from './consola.mjs';
import { pumpTranscript } from './transcript.mjs';
import { filesFromTranscript } from './cambios.mjs';

/* ---------- persistencia ---------- */
// Se guarda lo minimo para reconectar los robots cuya ventana tmux siga viva tras reiniciar el daemon.
const STATE_FILE = path.join(RUNS, 'office-state.json');
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = {
      colorSeq,
      maxRobots,
      inbox,
      robots: [...robots.values()].map(r => ({
        name: r.name,
        kind: r.kind,
        skill: r.skill,
        label: r.label,
        prompt: r.prompt,
        color: r.color,
        place: r.place,
        permissionMode: r.permissionMode,
        tools: r.tools || [],
        modelPick: r.modelPick || '',
        sessionId: r.sessionId,
        transcript: r.transcript,
        startedAt: r.startedAt,
        state: r.state,
        docs: r.docs,
        leaveWhenDone: r.leaveWhenDone,
        origin: r.origin,
        inputAt: r.inputAt,
        inputKind: r.inputKind || null,
        inputPerm: r.inputPerm || null,
        critical: criticalOf(r),
        title: r.title || '',
        request: r.request,
        look: r.look || null,
        baseColor: r.baseColor,
        timeline: r.timeline,
        lastEventAt: r.lastEventAt,
        parent: r.parent || null,
        spawnReq: r.spawnReq || null,
        reported: !!r.reported,
        note: r.note || '',
        priority: r.priority || null,
        salaNote: r.salaNote || '',
        routine: r.routine || null,
        changed: !!r.changed,
        prompts: r.prompts || 0,
        relevoNext: r.relevoNext || 0,
        repo: r.repo || null,
        bg: r.bg || null,
        files: r.files || [],
        fileAt: r.fileAt || {},
        clashAck: r.clashAck || {},
        gitCwd: r.gitCwd || null
      })),
      spawnQueue,
      pendingResults: [...pendingResults]
    };
    saveJson(STATE_FILE, data, { pretty: true });
  }, 500);
}

async function restore() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return;
  }
  inbox.push(...(saved.inbox || []).map(i => ({ status: 'nuevo', ...i })));
  if (!process.env.OFFICE_MAX_ROBOTS && Number.isInteger(saved.maxRobots)) setMaxRobots(saved.maxRobots);
  setColorSeq(saved.colorSeq || 0);
  spawnQueue.push(...(saved.spawnQueue || []));
  for (const [parent, b] of saved.pendingResults || []) pendingResults.set(parent, b); // se entregan al terminar de restaurar
  let windows = [];
  try {
    windows = (await run('tmux', ['list-windows', '-t', SESSION, '-F', '#{window_name}'])).stdout.split('\n');
  } catch {
    /* sin sesion */
  }
  const used = new Set();
  for (const s of saved.robots || []) {
    // Sin consola: si su sesión de Claude sigue en disco no se pierde, queda «consola caída» para revivirlo.
    const lost = !windows.includes(s.name);
    if (
      lost &&
      !fs.existsSync(s.transcript || path.join(os.homedir(), '.claude/projects', WORKSPACE.replace(/\//g, '-'), `${s.sessionId}.jsonl`))
    )
      continue;
    const place = s.place?.type === 'room' ? s.place : s.place?.type === 'desk' && !used.has(s.place.idx) ? s.place : null;
    const r = {
      ...s,
      place,
      offset: 0,
      partial: '',
      msgUsage: new Map(),
      alive: true,
      subs: [],
      pendingSubs: 0,
      bubble: '',
      activity: '',
      needsPermission: false,
      hold: null,
      log: [],
      restoring: true
    };
    r.docs = s.docs || (s.doc ? [{ path: s.doc, at: s.startedAt, delivered: false, updated: false }] : []);
    if (s.prompts == null) r.prompts = 99; // guardado antes de contar mensajes: no se sabe si le escribiste, así que no se va solo
    if (!r.place) r.place = freeDesk();
    if (!r.place) continue;
    if (r.place.type === 'desk') used.add(r.place.idx);
    if (r.state === 'input') r.inputAt ||= now();
    r.transcript ||= path.join(os.homedir(), '.claude/projects', WORKSPACE.replace(/\//g, '-'), `${r.sessionId}.jsonl`);
    if (['walking', 'delegating'].includes(r.state)) r.state = 'working';
    if (!Array.isArray(s.files)) r.files = filesFromTranscript(r.transcript); // guardado antes de «Cambios»
    r.timeline = Array.isArray(s.timeline) && s.timeline.length ? s.timeline : [{ at: s.startedAt || now(), s: r.state }];
    robots.set(r.name, r);
    loadConv(r);
    pumpTranscript(r); // desde el inicio para el uso de tokens; al log solo entra lo posterior a lo guardado
    r.muteUntil = 0;
    r.restoring = false;
    if (lost) markLost(r);
    else {
      log(r, 'sys', 'Reconectado tras reiniciar la oficina');
      console_(r.name, 'reconectado', r.label);
    }
  }
}

// «Background command "X" completed (exit code 0)» → «✓ Terminó: X». Se muestra como globo «Aviso de su consola».
function taskNote(p) {
  const tag = k => (new RegExp(`<${k}>([\\s\\S]*?)</${k}>`).exec(p) || [])[1]?.trim() || '';
  const sum = tag('summary'),
    status = tag('status');
  const what = /"([^"]+)"/.exec(sum)?.[1];
  const ok = !/fail|error|killed|exit code [1-9]/i.test(sum + ' ' + status);
  if (what) return `${ok ? '✓ Terminó' : '✗ Falló'}: ${what}${ok ? '' : ` (${status || sum})`}`;
  return sum || status || 'Tarea en segundo plano sin detalle';
}

function log(r, kind, text, extra) {
  if (r.muteUntil && r.linePos <= r.muteUntil) return;
  const entry = {
    kind,
    text: String(text ?? ''),
    ...(extra || {}),
    at: extra?.at && !Number.isNaN(Date.parse(extra.at)) ? extra.at : now()
  };
  // Claude guarda el transcript en tandas: un texto puede llegar después de la herramienta que vino luego.
  // Con su hora real se inserta en su lugar, así la conversación queda en el orden en que pasó.
  let k = r.log.length;
  while (k > 0 && r.log[k - 1].at > entry.at) k--;
  r.log.splice(k, 0, entry);
  if (r.log.length > 400) r.log.splice(0, r.log.length - 400);
  saveConv(r);
  broadcast({ type: 'log', name: r.name, entry });
}

// Conversación de cada robot en disco (conversaciones/<robot>.json): al reiniciar la oficina se recupera entera
// (herramientas, avisos, tus respuestas) en vez de reconstruir solo lo que dijo desde el transcript.
// `offset` marca hasta dónde del transcript ya está en el log: lo que llegó con la oficina apagada se suma después.
const CONV_DIR = path.join(RUNS, 'conversaciones');
const convDirty = new Set();
let convTimer = null;
const convFile = name => path.join(CONV_DIR, `${name}.json`);
function saveConv(r) {
  convDirty.add(r.name);
  if (!convTimer) convTimer = setTimeout(flushConvs, 2000);
}
// Al cerrar la oficina se guardan las conversaciones pendientes (antes lo hacía la cabecera; así base.mjs no
// depende de ningún otro módulo y se carga primero).
process.on('exit', () => {
  try {
    flushConvs();
  } catch {
    /* el daemon se va igual */
  }
});
function flushConvs() {
  clearTimeout(convTimer);
  convTimer = null;
  if (!convDirty.size) return;
  try {
    fs.mkdirSync(CONV_DIR, { recursive: true });
  } catch {
    return;
  }
  for (const name of convDirty) {
    const r = robots.get(name);
    if (!r) continue;
    try {
      saveJson(convFile(name), {
        sessionId: r.sessionId,
        offset: Math.max(r.offset - Buffer.byteLength(r.partial || ''), r.muteUntil || 0),
        log: r.log
      });
    } catch {
      /* disco lleno o sin permisos: se reintenta con el próximo mensaje */
    }
  }
  convDirty.clear();
}
function loadConv(r) {
  try {
    const c = JSON.parse(fs.readFileSync(convFile(r.name), 'utf8'));
    if (c.sessionId && c.sessionId !== r.sessionId) return;
    if (Array.isArray(c.log)) r.log = c.log.slice(-400);
    if (Number.isInteger(c.offset)) r.muteUntil = c.offset;
  } catch {
    /* sin conversación guardada: se reconstruye desde el transcript */
  }
}

// Al dejar de esperarte (o al irse mientras esperaba) se anota cuánto esperó y por qué.
function endWait(r) {
  if (r.state !== 'input' || !r.inputAt) return;
  addWait(r.name, r.inputAt, r.inputKind || 'respuesta', r.inputPerm || '');
  r.inputKind = r.inputPerm = null;
}
// «Bash: git push origin x» → «Bash: git push»; «Edit: /ruta/a.go» → «Edit».
const permKey = t => {
  const m = String(t || '').match(/^([\w.-]+)(?::\s*(.*))?$/s);
  if (!m) return 'Permiso';
  return m[1] === 'Bash' && m[2] ? `Bash: ${m[2].trim().split(/\s+/).slice(0, 2).join(' ')}` : m[1];
};
function setState(r, state) {
  if (r.state === state) return;
  endWait(r);
  if (state === 'input') {
    r.inputKind = r.hold || r.needsPermission ? 'permiso' : r.ask ? 'pregunta' : 'respuesta';
    r.inputPerm = r.hold ? permKey(r.hold.tool) : r.needsPermission ? permKey(r.tool) : null;
  }
  r.state = state;
  r.inputAt = state === 'input' ? now() : null; // desde cuándo espera tu respuesta (la web cuenta el tiempo)
  // Historial de estados para la línea de tiempo de la oficina (acotado: un robot largo no crece sin fin).
  (r.timeline ||= []).push({ at: now(), s: state });
  if (r.timeline.length > TIMELINE_MAX) r.timeline.splice(0, r.timeline.length - TIMELINE_MAX);
  emit(r);
}

function freeDesk() {
  const used = new Set([...robots.values()].filter(r => r.place.type === 'desk').map(r => r.place.idx));
  // Sin limite: si no hay escritorio libre, la oficina agrega uno (y una fila nueva en el mapa).
  for (let i = 0; ; i++) if (!used.has(i)) return { type: 'desk', idx: i };
}

// Los robots de una rutina (o de una sala de épica) se sientan en una sala temporal con su nombre
// (la web la dibuja mientras tenga robots). extra marca de qué sala de épica es, si aplica.
function roomSeat(room, name, extra = {}) {
  const used = new Set([...robots.values()].filter(r => r.place.type === 'room' && r.place.room === room).map(r => r.place.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return { type: 'room', room, name, slot, ...extra };
}

export { convDirty, convFile, endWait, flushConvs, freeDesk, log, restore, roomSeat, saveState, setState, taskNote };
