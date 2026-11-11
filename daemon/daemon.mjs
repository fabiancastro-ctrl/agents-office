#!/usr/bin/env node
// Daemon de la Oficina de Agentes (MVP local).
// - Lanza robots como ventanas tmux corriendo `claude` con la suscripcion del usuario.
// - Recibe los hooks de Claude Code y mantiene el estado de cada robot.
// - Sigue el transcript JSONL de cada robot (texto que dice, tokens, interrupciones).
// - Sirve la oficina (web/) y le empuja los cambios por Server-Sent Events.
// Sin dependencias: solo modulos de Node.

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web');
// Carpeta donde trabajan los robots (y de donde salen las skills del proyecto). Se elige en la primera
// ejecución desde la página y se guarda en runs/config.json; OFFICE_WORKSPACE manda si está definida.
let WORKSPACE = null;
const PORT = Number(process.env.OFFICE_PORT || 4777);
// Sesión de tmux donde viven los robots. Cada oficina del mismo equipo necesita la suya (y su puerto),
// o se pisarían las ventanas de los robots y la consola de /usage.
const SESSION = process.env.OFFICE_SESSION || 'office';
if (!/^[A-Za-z0-9_-]{1,40}$/.test(SESSION)) {
  console.error(`OFFICE_SESSION inválido: «${SESSION}». Usa solo letras, números, guion o guion bajo (sin puntos ni dos puntos).`);
  process.exit(1);
}
// Carpeta de datos de ESTA oficina (estado, bandeja, rutinas, salas, eventos, adjuntos). El código es uno solo
// y cada oficina del edificio trae la suya: `office start <nombre>` la pasa en OFFICE_DATA. Sin ella, runs/ junto al código.
const RUNS = path.resolve(process.env.OFFICE_DATA || path.join(ROOT, 'runs'));
const LEGACY_RUNS = RUNS === path.join(ROOT, 'runs');
// Hooks de los robots: se generan en la carpeta de datos con la ruta real de hooks/office-hook.sh,
// así el código se puede mover o clonar sin editar rutas a mano.
const SETTINGS = path.join(RUNS, 'office-settings.json');
// Tope de robots trabajando a la vez: todos gastan de la misma cuota de la suscripcion.
// Se ajusta desde la oficina (− / +) y se guarda en office-state.json.
let maxRobots = Number(process.env.OFFICE_MAX_ROBOTS || 3);
const MAX_ROBOTS_LIMIT = 20;
const APPROVAL = process.env.OFFICE_APPROVAL === '1';
const HOLD_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Nunca se responde "allow" a estos comandos aunque se aprueben. Los deny de settings
// igual ganan sobre el allow del hook (verificado en el paso 1); esta lista es una segunda barrera.
const NEVER_ALLOW = [/\brm\s+-[a-z]*r/i, /\bmv\s/, /\bgit\s+push\b/, /--force\b/, /--no-verify\b/, /\bgit\s+commit\b.*--amend\b/];
const APPROVAL_TIMEOUT_MS = 9 * 60 * 1000;
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
const NAMES = ['rex', 'nova', 'bolt', 'atlas', 'pixel', 'kiro', 'lumo', 'zeta', 'orbi', 'juno', 'milo', 'vega', 'ciro', 'indi', 'brio'];
const ROUTINE_TICK_MS = 15000;
const TIMELINE_MAX = 600;
const ATTACH_DIR = path.join(RUNS, 'adjuntos');
const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
const ATTACH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

fs.mkdirSync(RUNS, { recursive: true });
{
  const hook = { type: 'command', command: path.join(ROOT, 'hooks', 'office-hook.sh') };
  const ev = (timeout, matcher) => [{ ...(matcher ? { matcher } : {}), hooks: [{ ...hook, timeout }] }];
  const settings = { hooks: {
    SessionStart: ev(10), UserPromptSubmit: ev(10), PreToolUse: ev(600, '*'), PostToolUse: ev(10, '*'),
    SubagentStop: ev(10), Notification: ev(10), Stop: ev(10)
  } };
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}
// Una copia de la carpeta = una oficina: dos daemons sobre el mismo runs/ se pisarían el estado y la bandeja.
const LOCK_FILE = path.join(RUNS, 'daemon.lock');
try {
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  let alive = false;
  try { process.kill(lock.pid, 0); alive = lock.pid !== process.pid; } catch { /* proceso muerto: candado viejo */ }
  if (alive) {
    console.error(`Esta oficina ya está corriendo (pid ${lock.pid}, puerto ${lock.port}, datos en ${RUNS}).`);
    console.error('Para otra oficina usa el edificio: bin/office create <nombre> --workspace <carpeta> y bin/office start <nombre>.');
    process.exit(1);
  }
} catch { /* sin candado */ }
fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: PORT, session: SESSION }));
process.on('exit', () => {
  try { flushConvs(); } catch { /* el daemon se va igual */ }
  try { if (JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch { /* ya no está */ }
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
const CONFIG_FILE = path.join(RUNS, 'config.json');
const EVENTS_FILE = path.join(RUNS, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);

const robots = new Map();
const pending = new Map();
const inbox = [];
const clients = new Set();
let colorSeq = 0;

const trunc = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const now = () => new Date().toISOString();

function console_(robot, kind, text = '') {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`${t} [${robot}] ${kind.padEnd(12)} ${text}`);
}

function describeTool(tool, input = {}) {
  if (tool === 'Bash') return `Bash: ${trunc(input.command, 140)}`;
  if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(tool)) return `${tool}: ${input.file_path ?? ''}`;
  if (tool === 'Grep' || tool === 'Glob') return `${tool}: ${trunc(input.pattern, 100)}`;
  if (tool === 'Agent' || tool === 'Task') return `${tool}: ${input.subagent_type ?? ''} ${trunc(input.description, 80)}`;
  if (tool === 'Skill') return `Skill: ${input.skill ?? ''} ${trunc(input.args, 80)}`;
  return tool;
}

/* ---------- estado ---------- */

function usage(r) {
  const s = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of r.msgUsage.values()) {
    s.in += u.input_tokens || 0;
    s.out += u.output_tokens || 0;
    s.cacheRead += u.cache_read_input_tokens || 0;
    s.cacheWrite += u.cache_creation_input_tokens || 0;
  }
  return s;
}

function view(r, withLog = false) {
  const v = {
    name: r.name, kind: r.kind, skill: r.skill, label: r.label, color: r.color,
    state: r.state, place: r.place, subs: r.subs, pendingSubs: r.pendingSubs,
    bubble: r.bubble, activity: r.activity, tool: r.tool || '', needsPermission: r.needsPermission,
    hold: r.hold, ask: r.ask || null, request: requestOf(r), docs: r.docs, usage: usage(r), sessionId: r.sessionId, origin: r.origin, inputAt: r.inputAt, critical: criticalOf(r), title: r.title || '',
    permissionMode: r.permissionMode, startedAt: r.startedAt, timeline: r.timeline || [], lastEventAt: r.lastEventAt || null
  };
  if (withLog) v.log = r.log.slice(-150);
  return v;
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

function emit(r) { broadcast({ type: 'robot', robot: view(r) }); saveState(); }

// Solo se pueden ver/mostrar archivos que la oficina registro como documento (bandeja o robots).
const TEXT_DOC = /\.(md|markdown|html?|txt|csv|json|ya?ml|svg|drawio|mmd)$/i;
function knownDoc(p) {
  if (!p) return null;
  const abs = path.resolve(WORKSPACE, String(p));
  const known = inbox.some(i => i.path === abs) || [...robots.values()].some(r => r.docs.some(d => d.path === abs))
    || salas.some(s => contextPath(s) === abs || threadPath(s) === abs);
  return known ? abs : null;
}

function configView() { return { maxRobots, maxRobotsLimit: MAX_ROBOTS_LIMIT, approval: APPROVAL, name: officeName, session: SESSION }; }

/* ---------- uso de tokens de toda la oficina, por semana ---------- */
// Se calcula desde los transcripts de las sesiones que lanzó la oficina (el hook SessionStart queda en
// runs/events-*.jsonl), incluidos sus subagentes. Así sobrevive a reinicios del daemon y no cuenta dos veces.
const officeSessions = new Map(); // sessionId -> { transcript, robot }
function registerSession(e) {
  if (e.session_id && e.transcript_path && !officeSessions.has(e.session_id)) officeSessions.set(e.session_id, { transcript: e.transcript_path, robot: e.robot });
}
function loadSessions() {
  for (const f of fs.readdirSync(RUNS).filter(f => /^events.*\.jsonl$/.test(f))) {
    for (const line of fs.readFileSync(path.join(RUNS, f), 'utf8').split('\n')) {
      if (!line.includes('"SessionStart"')) continue;
      try { registerSession(JSON.parse(line)); } catch { /* linea cortada */ }
    }
  }
}

// Lunes (hora local) de la semana del instante dado, como AAAA-MM-DD.
function weekOf(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const usageCache = new Map(); // archivo -> { size, msgs: Map(id -> { at, u }) }
function fileUsage(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  const c = usageCache.get(file);
  if (c && c.size === size) return c.msgs;
  const msgs = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (e.type !== 'assistant' || !m?.id || !m.usage) continue;
    // Un mensaje llega en varias lineas con el mismo id; la ultima trae el usage final.
    msgs.set(m.id, { at: msgs.get(m.id)?.at || e.timestamp, u: m.usage });
  }
  usageCache.set(file, { size, msgs });
  return msgs;
}

function officeUsage() {
  const weeks = new Map();
  for (const [sid, s] of officeSessions) {
    const files = [s.transcript];
    const subDir = path.join(s.transcript.replace(/\.jsonl$/, ''), 'subagents');
    try { files.push(...fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl')).map(f => path.join(subDir, f))); } catch { /* sin subagentes */ }
    for (const f of files) {
      const msgs = fileUsage(f);
      if (!msgs) continue;
      for (const { at, u } of msgs.values()) {
        const k = weekOf(at);
        let w = weeks.get(k);
        if (!w) weeks.set(k, w = { week: k, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() });
        w.in += u.input_tokens || 0;
        w.out += u.output_tokens || 0;
        w.cacheRead += u.cache_read_input_tokens || 0;
        w.cacheWrite += u.cache_creation_input_tokens || 0;
        w.sessions.add(sid);
      }
    }
  }
  return [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week)).slice(0, 8).map(w => ({ ...w, sessions: w.sessions.size }));
}

/* ---------- estado de la suscripción (/usage) ---------- */
// Una consola tmux aparte (_status, sin hooks de la oficina) donde se abre /usage y se lee la pantalla.
// Mirar /usage no envía mensajes al modelo, así que no gasta cuota.
const STATUS_WIN = `${SESSION}:_status`;
const wait = ms => new Promise(r => setTimeout(r, ms));
let statusCache = null, statusPending = null;

async function capturePane(target) { return (await run('tmux', ['capture-pane', '-p', '-t', target])).stdout; }

async function readClaudeStatus() {
  await ensureSession();
  let windows = [];
  try { windows = (await run('tmux', ['list-windows', '-t', SESSION, '-F', '#{window_name}'])).stdout.split('\n'); } catch { /* sin sesion */ }
  const fresh = !windows.includes('_status');
  if (fresh) {
    await run('tmux', ['new-window', '-d', '-t', `${SESSION}:`, '-n', '_status', '-c', WORKSPACE, 'env', '-u', 'ANTHROPIC_API_KEY', 'claude']);
    await run('tmux', ['resize-window', '-t', STATUS_WIN, '-x', '120', '-y', '80']).catch(() => {});
    await wait(6000);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await run('tmux', ['send-keys', '-t', STATUS_WIN, 'Escape']);
    await wait(300);
    await run('tmux', ['send-keys', '-t', STATUS_WIN, '-l', '/usage']);
    await wait(700);
    await run('tmux', ['send-keys', '-t', STATUS_WIN, 'Enter']);
    for (let i = 0; i < 20; i++) {
      await wait(500);
      const text = await capturePane(STATUS_WIN);
      if (/\d+% used/.test(text) && /Resets/.test(text)) {
        await wait(800); // deja terminar de pintar la lista
        const full = await capturePane(STATUS_WIN);
        await run('tmux', ['send-keys', '-t', STATUS_WIN, 'Escape']).catch(() => {});
        return parseClaudeStatus(full);
      }
    }
    await wait(3000); // la consola pudo no estar lista todavia
  }
  throw new Error(`No se pudo leer /usage. Abre la consola con: tmux attach -t ${STATUS_WIN}`);
}

// /usage sale en inglés: se traducen las frases conocidas; lo que no se reconoce se deja tal cual.
const MONTHS = { Jan: 'ene', Feb: 'feb', Mar: 'mar', Apr: 'abr', May: 'may', Jun: 'jun', Jul: 'jul', Aug: 'ago', Sep: 'sep', Oct: 'oct', Nov: 'nov', Dec: 'dic' };
const USAGE_ES = [
  [/^Current session$/, 'Sesión actual'],
  [/^Current week \(all models\)$/, 'Semana actual (todos los modelos)'],
  [/^Current week \((.+)\)$/, 'Semana actual ($1)'],
  [/^Resets (\w{3}) (\d+) at (.+)$/, (m, mon, d, rest) => `Se reinicia el ${d} ${MONTHS[mon] || mon} a las ${rest}`],
  [/^Resets (.+)$/, 'Se reinicia a las $1'],
  [/What's contributing to your usage\?/, '¿Qué está consumiendo tu uso?'],
  [/Approximate · sessions on this machine only/, 'Aproximado · solo sesiones de este equipo'],
  [/Last 24h · shares overlap/, 'Últimas 24 h · los porcentajes se solapan'],
  [/Give "(.+)" subagents a cheaper model/, 'Usar un modelo más barato para los subagentes de "$1"'],
  [/Start fresh when you switch tasks · run \/clear/, 'Empezar de cero al cambiar de tarea · usar /clear'],
  [/Run fewer sessions at once · up to (\d+) at once/, 'Correr menos sesiones a la vez · hasta $1 simultáneas'],
  [/Trim (.+) · (\S+) tokens per request/, 'Recortar $1 · $2 tokens por pedido'],
  [/^(\s*)Skills(\s+)% of usage/, '$1Skills$2% del uso'],
  [/^(\s*)Subagents(\s+)% of usage/, '$1Subagentes$2% del uso'],
  [/^(\s*)Loops(\s+)every(\s+)runs(\s+)tokens(\s+)per run last run/, '$1Bucles$2cada$3veces$4tokens$5por vez última'],
  [/\bdynamic\b/, 'dinámico'],
  [/\b(\d+)([mhd]) ago\b/, 'hace $1$2']
];
const toSpanish = line => USAGE_ES.reduce((l, [re, to]) => l.replace(re, to), line);

function parseClaudeStatus(text) {
  const lines = text.split('\n').map(l => l.trimEnd());
  const clean = lines.map(l => l.trim());
  const limits = [];
  clean.forEach((l, i) => {
    const m = l.match(/(\d+)% used/);
    if (m) limits.push({ title: toSpanish(clean[i - 1] || ''), pct: Number(m[1]), resets: /^Resets/.test(clean[i + 1] || '') ? toSpanish(clean[i + 1]) : '' });
  });
  const start = clean.findIndex(l => /^What's contributing/.test(l));
  const detail = start < 0 ? '' : lines.slice(start).filter(l => l.trim() && !/^\s*(Esc to|f to fix)/.test(l)).map(toSpanish).join('\n');
  return { limits, detail, at: now() };
}

async function claudeStatus(refresh) {
  if (statusCache && !refresh && Date.now() - Date.parse(statusCache.at) < 60_000) return statusCache;
  statusPending ||= readClaudeStatus().then(s => (statusCache = s)).finally(() => { statusPending = null; });
  return statusPending;
}

/* ---------- carpeta de trabajo ---------- */
const expandHome = p => String(p || '').trim().replace(/^~(?=$|\/)/, os.homedir());

function initialWorkspace() {
  if (process.env.OFFICE_WORKSPACE) return path.resolve(expandHome(process.env.OFFICE_WORKSPACE));
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).workspace || null; } catch { /* sin config */ }
  // Instalaciones de antes de esta opción: ya tenían estado y usaban la carpeta de dos niveles arriba.
  if (LEGACY_RUNS && fs.existsSync(path.join(RUNS, 'office-state.json'))) return saveWorkspace(path.resolve(ROOT, '../..'));
  return null;
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(patch) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
}
function saveWorkspace(ws) {
  saveConfig({ workspace: ws });
  return ws;
}
// Nombre de la oficina: solo estético, para distinguir varias oficinas (una por workspace) en el navegador.
const OFFICE_NAME_MAX = 40;
let officeName = String(readConfig().name || '').slice(0, OFFICE_NAME_MAX);

// Claude Code pide confirmar la confianza la primera vez que se abre en una carpeta (o en una superior);
// mientras no se acepte, un robot quedaría detenido en esa pregunta.
function trustAccepted(ws) {
  let projects = {};
  try { projects = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).projects || {}; } catch { return null; }
  for (let d = ws; ; d = path.dirname(d)) {
    if (projects[d]?.hasTrustDialogAccepted) return true;
    if (d === path.dirname(d)) return false;
  }
}

function workspaceInfo(raw) {
  const ws = path.resolve(expandHome(raw));
  const st = fs.statSync(ws, { throwIfNoEntry: false });
  const info = { path: ws, exists: !!st, isDir: !!st?.isDirectory() };
  if (!info.isDir) return info;
  info.claudeMd = fs.existsSync(path.join(ws, 'CLAUDE.md'));
  info.projectSkills = listSkills(ws).length - listSkills(os.tmpdir()).length; // sin contar las de ~/.claude
  info.trusted = trustAccepted(ws);
  info.insideOffice = ws === ROOT || ws.startsWith(ROOT + path.sep);
  return info;
}

function setupView() {
  return { workspace: WORKSPACE, fromEnv: !!process.env.OFFICE_WORKSPACE, suggestion: path.resolve(ROOT, '../..') };
}

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
        name: r.name, kind: r.kind, skill: r.skill, label: r.label, prompt: r.prompt, color: r.color, place: r.place,
        permissionMode: r.permissionMode, sessionId: r.sessionId, transcript: r.transcript, startedAt: r.startedAt, state: r.state, docs: r.docs,
        leaveWhenDone: r.leaveWhenDone, origin: r.origin, inputAt: r.inputAt, critical: criticalOf(r), title: r.title || '', request: r.request, timeline: r.timeline, lastEventAt: r.lastEventAt
      }))
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  }, 500);
}

async function restore() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  inbox.push(...(saved.inbox || []).map(i => ({ status: 'nuevo', ...i })));
  if (!process.env.OFFICE_MAX_ROBOTS && Number.isInteger(saved.maxRobots)) maxRobots = saved.maxRobots;
  colorSeq = saved.colorSeq || 0;
  let windows = [];
  try { windows = (await run('tmux', ['list-windows', '-t', SESSION, '-F', '#{window_name}'])).stdout.split('\n'); } catch { /* sin sesion */ }
  const used = new Set();
  for (const s of saved.robots || []) {
    if (!windows.includes(s.name)) continue;
    const place = s.place?.type === 'room' ? s.place : s.place?.type === 'desk' && !used.has(s.place.idx) ? s.place : null;
    const r = {
      ...s, place, offset: 0, partial: '', msgUsage: new Map(), alive: true, subs: [], pendingSubs: 0, bubble: '', activity: '',
      needsPermission: false, hold: null, log: [], restoring: true
    };
    r.docs = s.docs || (s.doc ? [{ path: s.doc, at: s.startedAt, delivered: false, updated: false }] : []);
    if (!r.place) r.place = freeDesk();
    if (!r.place) continue;
    if (r.place.type === 'desk') used.add(r.place.idx);
    if (r.state === 'input') r.inputAt ||= now();
    r.transcript ||= path.join(os.homedir(), '.claude/projects', WORKSPACE.replace(/\//g, '-'), `${r.sessionId}.jsonl`);
    if (['walking', 'delegating'].includes(r.state)) r.state = 'working';
    r.timeline = Array.isArray(s.timeline) && s.timeline.length ? s.timeline : [{ at: s.startedAt || now(), s: r.state }];
    robots.set(r.name, r);
    loadConv(r);
    pumpTranscript(r); // desde el inicio para el uso de tokens; al log solo entra lo posterior a lo guardado
    r.muteUntil = 0;
    r.restoring = false;
    log(r, 'sys', 'Reconectado tras reiniciar la oficina');
    console_(r.name, 'reconectado', r.label);
  }
}

// «Background command "X" completed (exit code 0)» → «✓ Terminó: X». Se muestra como globo «Aviso de su consola».
function taskNote(p) {
  const tag = k => (new RegExp(`<${k}>([\\s\\S]*?)</${k}>`).exec(p) || [])[1]?.trim() || '';
  const sum = tag('summary'), status = tag('status');
  const what = /"([^"]+)"/.exec(sum)?.[1];
  const ok = !/fail|error|killed|exit code [1-9]/i.test(sum + ' ' + status);
  if (what) return `${ok ? '✓ Terminó' : '✗ Falló'}: ${what}${ok ? '' : ` (${status || sum})`}`;
  return sum || status || 'Tarea en segundo plano sin detalle';
}

function log(r, kind, text) {
  if (r.muteUntil && r.linePos <= r.muteUntil) return;
  const entry = { kind, text: String(text ?? ''), at: now() };
  r.log.push(entry);
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
function saveConv(r) { convDirty.add(r.name); if (!convTimer) convTimer = setTimeout(flushConvs, 2000); }
function flushConvs() {
  clearTimeout(convTimer); convTimer = null;
  if (!convDirty.size) return;
  try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch { return; }
  for (const name of convDirty) {
    const r = robots.get(name);
    if (!r) continue;
    try { fs.writeFileSync(convFile(name), JSON.stringify({ sessionId: r.sessionId, offset: Math.max(r.offset - Buffer.byteLength(r.partial || ''), r.muteUntil || 0), log: r.log })); } catch { /* disco lleno o sin permisos: se reintenta con el próximo mensaje */ }
  }
  convDirty.clear();
}
function loadConv(r) {
  try {
    const c = JSON.parse(fs.readFileSync(convFile(r.name), 'utf8'));
    if (c.sessionId && c.sessionId !== r.sessionId) return;
    if (Array.isArray(c.log)) r.log = c.log.slice(-400);
    if (Number.isInteger(c.offset)) r.muteUntil = c.offset;
  } catch { /* sin conversación guardada: se reconstruye desde el transcript */ }
}

function setState(r, state) {
  if (r.state === state) return;
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

/* ---------- ciclo de vida del turno ---------- */

function finishTurn(r, lastMessage) {
  if (lastMessage) r.bubble = trunc(lastMessage, 140);
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
    emit(r);
    return;
  }
  // Ningún robot se va solo: queda con el cartel LISTO y su conversación hasta que lo des de baja.
  setState(r, 'done');
  emit(r);
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

// Indicaciones que la oficina le suma a cada robot nuevo: los mensajes para enviar van en una cita (>) para que la
// oficina les ponga «📋 Copiar»; al copiar se convierten al formato del chat, así que el robot escribe Markdown normal.
const ROBOT_HINTS = 'Trabajas dentro de la Oficina de Agentes, que muestra tus respuestas en una página web. Cuando te pidan redactar un mensaje para enviar a otra persona (Google Chat, WhatsApp, Slack, correo), entrega el texto del mensaje completo dentro de una cita Markdown (cada línea empieza con «> »), sin comentarios tuyos adentro; lo que quieras decirme a mí va fuera de la cita. Dentro de la cita usa Markdown normal (**negrita**, _cursiva_, listas con -, enlaces): la oficina lo convierte al formato del chat al copiarlo. Si son varios mensajes, usa una cita por mensaje.';

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

async function removeRobot(r, reason) {
  deliver(r); // si se da de baja con documentos sin entregar, no se pierden
  r.alive = false;
  try { await run('tmux', ['kill-window', '-t', `${SESSION}:${r.name}`]); } catch { /* ya cerrada */ }
  const u = usage(r);
  console_(r.name, 'salio', `${reason} · tokens out=${u.out} cache_read=${u.cacheRead}`);
  robots.delete(r.name);
  convDirty.delete(r.name);
  try { fs.unlinkSync(convFile(r.name)); } catch { /* no tenía */ }
  broadcast({ type: 'left', name: r.name });
  saveState();
}

/* ---------- transcript ---------- */

function pumpTranscript(r) {
  if (!r.transcript) return;
  let size;
  try { size = fs.statSync(r.transcript).size; } catch { return; }
  if (size <= r.offset) return;
  const fd = fs.openSync(r.transcript, 'r');
  const buf = Buffer.alloc(size - r.offset);
  fs.readSync(fd, buf, 0, buf.length, r.offset);
  fs.closeSync(fd);
  let pos = r.offset - Buffer.byteLength(r.partial);
  r.offset = size;
  const lines = (r.partial + buf.toString('utf8')).split('\n');
  r.partial = lines.pop();
  for (const line of lines) {
    pos += Buffer.byteLength(line) + 1;
    r.linePos = pos; // log() no repite lo que ya estaba en la conversación guardada
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    onTranscript(r, e);
  }
}

function onTranscript(r, e) {
  if (e.isSidechain) return;
  if (e.type === 'assistant' && e.message) {
    // Un mensaje llega en varias lineas con el mismo id; la ultima trae el usage final.
    if (e.message.id && e.message.usage) r.msgUsage.set(e.message.id, e.message.usage);
    for (const c of e.message.content || []) {
      if (c.type === 'text' && c.text.trim()) {
        log(r, 'agent', c.text.trim());
        r.bubble = trunc(c.text, 140);
        emit(r);
      }
    }
  }
  if (e.type === 'user' && e.message) {
    const content = e.message.content;
    const text = typeof content === 'string' ? content : (content || []).map(c => c.text || '').join(' ');
    // Esc no dispara Stop: la interrupcion solo se ve en el transcript.
    if (/\[Request interrupted/.test(text) && !r.restoring) {
      log(r, 'sys', 'Interrumpido');
      r.needsPermission = false;
      setState(r, 'idle');
      emit(r);
    }
  }
}

setInterval(() => { for (const r of robots.values()) pumpTranscript(r); }, 1000);

/* ---------- hooks ---------- */

function hold(r, body) {
  const id = crypto.randomBytes(3).toString('hex');
  r.hold = { id, tool: describeTool(body.tool_name, body.tool_input) };
  setState(r, 'input');
  emit(r);
  log(r, 'sys', `Pide permiso: ${r.hold.tool}`);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id);
      r.hold = null;
      emit(r);
      resolve(null);
    }, APPROVAL_TIMEOUT_MS);
    pending.set(id, {
      r, tool: body.tool_name, input: body.tool_input,
      decide: d => { clearTimeout(timer); pending.delete(id); r.hold = null; resolve(d); }
    });
  });
}

// Cuestionarios (AskUserQuestion): la oficina retiene el hook y te muestra las preguntas con sus opciones.
// Lo que respondas vuelve como `answers` en updatedInput y el robot lo recibe como si contestaras en su consola.
// «Responder en la consola», el reinicio de la oficina o el tiempo límite sueltan el hook y la consola muestra su menú.
function askHold(r, body) {
  const id = crypto.randomBytes(3).toString('hex');
  const questions = body.tool_input.questions.slice(0, 8).map(q => ({
    question: String(q.question ?? ''), header: trunc(q.header, 30), multiSelect: !!q.multiSelect,
    options: (q.options || []).slice(0, 10).map(o => ({ label: String(o.label ?? ''), description: trunc(o.description, 300) }))
  }));
  r.ask = { id, questions, at: now() };
  r.inputAt = now();
  setState(r, 'input');
  log(r, 'sys', `Te hizo ${questions.length === 1 ? 'una pregunta' : `${questions.length} preguntas`} con opciones`);
  emit(r);
  return new Promise(resolve => {
    const release = (out, note) => { clearTimeout(timer); pending.delete(id); if (r.ask?.id === id) r.ask = null; if (robots.get(r.name) === r) { if (note) log(r, 'sys', note); emit(r); } resolve(out); };
    const timer = setTimeout(() => release(null, 'Las preguntas pasaron a su consola (nadie respondió en la oficina)'), APPROVAL_TIMEOUT_MS);
    pending.set(id, { r, ask: true, input: body.tool_input, release });
  });
}

function answerAsk(r, id, answers, toConsole) {
  const p = pending.get(id);
  if (!p?.ask || p.r !== r) return false;
  if (toConsole) { p.release(null, 'Responderás las preguntas en su consola'); return true; }
  const clean = {};
  for (const q of r.ask?.questions || []) {
    const a = String(answers?.[q.question] ?? '').trim();
    if (!a) throw new Error(`Falta responder: ${q.header || q.question}`);
    clean[q.question] = a.slice(0, 2000);
  }
  log(r, 'user', Object.entries(clean).map(([q, a]) => `**${q}** → ${a}`).join('\n'));
  setState(r, 'working');
  p.release({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Respondido desde la oficina', updatedInput: { ...p.input, answers: clean } } });
  return true;
}

function decide(id, decision) {
  const p = pending.get(id);
  if (!p || p.ask) return false;
  let d = decision === 'allow' ? 'allow' : 'deny';
  let reason = `Decidido desde la oficina (${d})`;
  if (d === 'allow' && p.tool === 'Bash' && NEVER_ALLOW.some(rx => rx.test(p.input?.command || ''))) {
    d = 'deny';
    reason = 'Comando prohibido por la oficina';
  }
  p.decide({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d, permissionDecisionReason: reason } });
  log(p.r, 'sys', `Permiso ${d === 'allow' ? 'aprobado' : 'denegado'}${reason.startsWith('Comando') ? ' (comando prohibido)' : ''}`);
  setState(p.r, 'working');
  emit(p.r);
  return true;
}

function subFor(r, body) {
  if (!body.agent_id || !body.agent_type) return null;
  let s = r.subs.find(x => x.id === body.agent_id);
  if (!s) {
    s = r.subs.find(x => !x.id && x.status === 'running' && x.type === body.agent_type) || r.subs.find(x => !x.id && x.status === 'running');
    if (s) s.id = body.agent_id;
  }
  return s;
}

async function onHook(name, body) {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({ at: now(), robot: name, ...body }) + '\n');
  if (body.hook_event_name === 'SessionStart') registerSession({ robot: name, ...body });
  const r = robots.get(name);
  if (!r) return null; // robot que la oficina no lanzo: no se toca
  r.lastEventAt = now(); // la UI marca «sin actividad» a un robot ocupado que lleva mucho sin eventos
  if (body.session_id) r.sessionId = body.session_id;
  if (body.transcript_path && r.transcript !== body.transcript_path) {
    r.transcript = body.transcript_path;
    r.offset = 0;
    r.partial = '';
  }
  const internalHelper = body.agent_id && !body.agent_type;
  const sub = subFor(r, body);

  switch (body.hook_event_name) {
    case 'SessionStart':
      log(r, 'sys', `Sesión ${body.source ?? ''} · modelo ${body.model ?? ''}`);
      break;

    case 'UserPromptSubmit': {
      const p = String(body.prompt ?? '');
      if (p.startsWith('<agent-message')) log(r, 'sub', 'Un subagente entregó su resultado');
      // Claude Code le avisa al robot cuando termina algo que dejó en segundo plano: no lo escribiste tú.
      else if (/^\s*<task-notification>/.test(p)) log(r, 'bg', taskNote(p));
      else log(r, 'user', p);
      r.needsPermission = false;
      setState(r, 'working');
      break;
    }

    case 'PreToolUse': {
      if (internalHelper) break;
      const what = describeTool(body.tool_name, body.tool_input);
      if (sub) {
        sub.activity = what;
        emit(r);
      } else {
        r.activity = what;
        r.tool = body.tool_name; // la web anima al robot según la herramienta que usa
        r.needsPermission = false;
        log(r, 'tool', what);
        if (body.tool_name === 'Agent' || body.tool_name === 'Task') {
          const type = body.tool_input?.subagent_type || 'general-purpose';
          r.subs.push({ id: null, type, desc: trunc(body.tool_input?.description, 60), status: 'running', activity: '' });
          r.pendingSubs++;
          setState(r, 'delegating');
        } else if (r.state !== 'delegating') {
          setState(r, 'working');
        }
        emit(r);
      }
      if (!sub && body.tool_name === 'AskUserQuestion' && Array.isArray(body.tool_input?.questions)) return askHold(r, body);
      if (APPROVAL && HOLD_TOOLS.has(body.tool_name)) return hold(r, body);
      break;
    }

    case 'PostToolUse': {
      if (internalHelper) break;
      if (['Write', 'Edit', 'MultiEdit'].includes(body.tool_name)) trackDoc(r, body.tool_name, body.tool_input?.file_path);
      if (!sub && r.tool) { r.tool = ''; emit(r); } // entre herramientas, el robot piensa
      break;
    }

    case 'SubagentStop': {
      if (!body.agent_type) break; // ayudante interno de Claude Code
      const s = sub || r.subs.find(x => x.status === 'running');
      if (s && s.status === 'running') {
        s.status = 'done';
        s.activity = '';
        r.pendingSubs = Math.max(0, r.pendingSubs - 1);
        log(r, 'sub', `${s.type} terminó`);
      }
      if (r.pendingSubs === 0 && r.state === 'delegating') setState(r, 'working');
      emit(r);
      break;
    }

    case 'Notification': {
      const msg = String(body.message ?? '');
      if (/permission/i.test(msg)) {
        r.needsPermission = true;
        log(r, 'sys', 'Pide permiso en su consola');
        setState(r, 'input');
        emit(r);
      }
      break;
    }

    case 'Stop':
      pumpTranscript(r);
      finishTurn(r, body.last_assistant_message);
      break;
  }
  return null; // sin salida: Claude Code sigue su flujo normal
}

/* ---------- adjuntos ---------- */
// Se guardan dentro del workspace para que el robot los abra con Read; se borran a los 7 dias.

function validAttachments(list) {
  return (Array.isArray(list) ? list : [])
    .map(p => path.resolve(WORKSPACE, String(p)))
    .filter(p => p.startsWith(ATTACH_DIR + path.sep) && fs.existsSync(p));
}

function attachmentNote(list) {
  const files = validAttachments(list);
  if (!files.length) return '';
  return ` [Adjuntos: ${files.map(f => path.relative(WORKSPACE, f)).join(', ')} — ábrelos con la herramienta Read]`;
}

function cleanAttachments() {
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* en uso */ }
      } else if (Date.now() - fs.statSync(p).mtimeMs > ATTACH_TTL_MS) {
        fs.unlinkSync(p);
      }
    }
  };
  walk(ATTACH_DIR);
}
cleanAttachments();
setInterval(cleanAttachments, 6 * 60 * 60 * 1000);

/* ---------- tmux ---------- */

async function ensureSession() {
  try {
    await run('tmux', ['has-session', '-t', SESSION]);
  } catch {
    await run('tmux', ['new-session', '-d', '-s', SESSION, '-n', 'lobby', '-c', WORKSPACE]);
  }
  await run('tmux', ['set-option', '-t', SESSION, '@office_port', String(PORT)]).catch(() => {});
}

// Si la sesión de tmux ya es de otra oficina que sigue viva en otro puerto, no arrancar: le robaríamos los robots.
async function guardSession() {
  try { await run('tmux', ['has-session', '-t', SESSION]); } catch { return; } // la sesión se crea al lanzar el primer robot
  let owner = '';
  try { owner = (await run('tmux', ['show-options', '-v', '-t', SESSION, '@office_port'])).stdout.trim(); } catch { /* sin dueño */ }
  if (owner && owner !== String(PORT)) {
    let alive = true;
    try { await fetch(`http://127.0.0.1:${owner}/api/setup`, { signal: AbortSignal.timeout(1500) }); } catch { alive = false; }
    if (alive) {
      console.error(`La sesión de tmux «${SESSION}» ya la usa otra oficina que corre en el puerto ${owner}.`);
      console.error('Arranca esta con otra sesión y otro puerto, por ejemplo: OFFICE_SESSION=office-2 OFFICE_PORT=4778 node daemon/daemon.mjs');
      process.exit(1);
    }
  }
  await run('tmux', ['set-option', '-t', SESSION, '@office_port', String(PORT)]).catch(() => {});
}

async function launch({ kind, skill, args, text, permissionMode, name, origin, label: customLabel, title, leaveWhenDone, attachments, routine, sala: salaId }) {
  // El tope cuenta solo los que trabajan: los que terminaron esperan su baja sin gastar cuota.
  const active = [...robots.values()].filter(x => x.state !== 'done');
  if (active.length >= maxRobots) throw new Error(`Ya hay ${maxRobots} robots trabajando (tope de la cuota). Súbelo con + en la barra o espera a que alguno termine.`);
  name = (name || NAMES.find(n => !robots.has(n)) || `robot-${Date.now() % 1000}`).toLowerCase();
  if (!/^[a-z0-9-]{1,20}$/.test(name)) throw new Error('Nombre inválido: usa minúsculas, números y guiones.');
  if (robots.has(name)) throw new Error(`Ya existe un robot llamado ${name}.`);

  let prompt, label;
  if (kind === 'skill') {
    skill = String(skill || '').replace(/^\//, '').trim();
    if (!/^[a-z0-9:_-]+$/i.test(skill)) throw new Error('Elige una skill válida.');
    prompt = `/${skill} ${args || ''}`.trim();
    label = prompt;
  } else {
    kind = 'libre';
    prompt = String(text || '').trim();
    if (!prompt) throw new Error('Escribe qué necesitas que haga el robot.');
    label = trunc(prompt, 80);
    skill = null;
  }
  if (customLabel) label = trunc(customLabel, 80);
  prompt += attachmentNote(attachments);
  const rt = routine ? routines.find(x => x.id === routine) : null;
  const sala = salaId ? salas.find(x => x.id === salaId) : null;
  if (salaId && !sala) throw new Error('Esa sala de épica no existe.');
  if (sala) prompt += salaPreamble(sala);
  const place = sala ? roomSeat(`sala-${sala.id}`, sala.name, { sala: sala.id }) : rt ? roomSeat(rt.id, rt.name) : freeDesk();
  if (!place) throw new Error('No hay escritorios libres en la oficina.');
  if (permissionMode && !PERMISSION_MODES.has(permissionMode)) throw new Error('Modo de permisos inválido.');

  await ensureSession();
  const sessionId = crypto.randomUUID();
  const r = {
    name, kind, skill, label, title: cleanTitle(title), prompt, color: colorSeq++ % 8, place,
    request: { kind, skill, args: kind === 'skill' ? String(args || '') : '', text: kind === 'libre' ? String(text || '').trim() : '', permissionMode: permissionMode || '' }, permissionMode: permissionMode || '', leaveWhenDone: !!leaveWhenDone,
    origin: trunc(origin || 'Lanzado por la API local sin indicar quién', 200),
    sessionId, transcript: null, offset: 0, partial: '', msgUsage: new Map(), startedAt: now(),
    alive: true, state: 'walking', timeline: [{ at: now(), s: 'walking' }], subs: [], pendingSubs: 0, bubble: '', activity: '',
    needsPermission: false, hold: null, docs: [], log: []
  };
  robots.set(name, r);
  // env -u: si ANTHROPIC_API_KEY esta en el entorno, `claude` la usa en vez del login de la suscripcion.
  const tmuxArgs = ['new-window', '-d', '-t', `${SESSION}:`, '-n', name, '-c', WORKSPACE,
    '-e', `OFFICE_ROBOT=${name}`, '-e', `OFFICE_PORT=${PORT}`,
    'env', '-u', 'ANTHROPIC_API_KEY',
    'claude', '--settings', SETTINGS, '--session-id', sessionId, '--append-system-prompt', ROBOT_HINTS];
  if (permissionMode) tmuxArgs.push('--permission-mode', permissionMode);
  tmuxArgs.push(prompt);
  try {
    await run('tmux', tmuxArgs);
  } catch (e) {
    robots.delete(name);
    throw new Error(`No se pudo abrir la consola: ${e.message}`);
  }
  log(r, 'sys', `Encargo: ${label}`);
  log(r, 'sys', r.origin);
  console_(name, 'lanzado', `${label} · tmux attach -t ${SESSION}:${name}`);
  emit(r);
  return r;
}

async function say(r, text, attachments) {
  const target = `${SESSION}:${r.name}`;
  const buffer = `office-${r.name}`;
  const full = (String(text || '').trim() || 'Te adjunto estos archivos.') + attachmentNote(attachments);
  // paste-buffer -p usa bracketed paste: los saltos de linea llegan como parte del mensaje
  // en vez de enviarlo a medias (send-keys los tomaria como Enter).
  await run('tmux', ['set-buffer', '-b', buffer, full]);
  await run('tmux', ['paste-buffer', '-p', '-d', '-b', buffer, '-t', target]);
  await new Promise(res => setTimeout(res, 300));
  await run('tmux', ['send-keys', '-t', target, 'Enter']);
}

async function pressKey(r, key) {
  // approve = Enter sobre la opcion resaltada ("Yes"); reject = Esc (cancela e interrumpe el turno)
  await run('tmux', ['send-keys', '-t', `${SESSION}:${r.name}`, key === 'approve' ? 'Enter' : 'Escape']);
  r.needsPermission = false;
  log(r, 'sys', key === 'approve' ? 'Aprobaste el permiso desde la oficina' : 'Rechazaste el permiso desde la oficina');
  setState(r, key === 'approve' ? 'working' : 'idle');
  emit(r);
}

async function pane(r) {
  const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', `${SESSION}:${r.name}`]);
  return stdout.replace(/\s+$/, '');
}

async function openConsole(r) {
  const cmd = `tmux attach -t ${SESSION}:${r.name}`;
  await run('osascript', ['-e', `tell application "Terminal" to do script "${cmd}"`, '-e', 'tell application "Terminal" to activate']);
}

function listSkills(ws = WORKSPACE) {
  const out = new Set();
  const dirs = [
    [path.join(ws, '.claude/commands'), true],
    [path.join(ws, '.claude/skills'), false],
    [path.join(os.homedir(), '.claude/commands'), true],
    [path.join(os.homedir(), '.claude/skills'), false]
  ];
  for (const [dir, filesOnly] of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (filesOnly && e.name.endsWith('.md')) out.add(e.name.slice(0, -3));
      if (!filesOnly && !e.name.startsWith('.') && e.name !== 'synced') out.add(e.name);
    }
  }
  return [...out].sort();
}

/* ---------- rutinas ---------- */
// Dos tipos:
// - watch: vigila PRs (un repo o toda la organizacion, con filtro de busqueda de GitHub). El chequeo
//   es deterministico (gh): solo lanza un robot por PR nuevo o con commits nuevos. Sin cambios no gasta cuota.
// - agenda: cada N minutos lanza un robot con instrucciones libres y un archivo de memoria compartido
//   entre ejecuciones. Gasta cuota en cada ejecucion.

const ROUTINES_FILE = path.join(RUNS, 'routines.json');
const ROUTINES_DIR = path.join(RUNS, 'routines');
let routines = [];
try { routines = JSON.parse(fs.readFileSync(ROUTINES_FILE, 'utf8')); } catch { routines = []; }
for (const rt of routines) {
  rt.running = false;
  rt.nextAt = Date.now() + 20000;
  // Formato anterior: solo repo + accion.
  if (!rt.type) { rt.type = 'watch'; rt.source = { scope: 'repo', repo: rt.repo, query: '' }; delete rt.repo; }
}

function saveRoutines() {
  const data = routines.map(({ running, ...rest }) => rest);
  fs.writeFileSync(ROUTINES_FILE, JSON.stringify(data, null, 2));
}

function routineView(rt) {
  return {
    id: rt.id, type: rt.type, name: rt.name, everyMin: rt.everyMin, source: rt.source, onlyNew: rt.onlyNew,
    includeDrafts: rt.includeDrafts, action: rt.action, extra: rt.extra, text: rt.text, delegate: rt.delegate,
    memory: rt.type === 'agenda' ? path.relative(WORKSPACE, memoryPath(rt)) : null, runs: rt.runs || 0,
    permissionMode: rt.permissionMode, paused: rt.paused, running: !!rt.running,
    nextAt: rt.nextAt, lastRun: rt.lastRun, seen: Object.keys(rt.seen || {}).length
  };
}

function emitRoutines() { broadcast({ type: 'routines', routines: routines.map(routineView) }); }

// Indice nombre-de-repo → carpeta local del workspace, para la variable {local}.
let repoIndex = { at: 0, map: new Map() };
async function localRepoPath(nameWithOwner) {
  if (Date.now() - repoIndex.at > 10 * 60000) {
    const map = new Map();
    try {
      const { stdout } = await run('find', [WORKSPACE, '-maxdepth', '3', '-name', '.git', '-type', 'd', '-not', '-path', '*/reviews/*'], { timeout: 30000 });
      for (const g of stdout.split('\n').filter(Boolean)) {
        const dir = path.dirname(g);
        if (!map.has(path.basename(dir))) map.set(path.basename(dir), dir);
      }
    } catch { /* sin indice: {local} queda vacio */ }
    repoIndex = { at: Date.now(), map };
  }
  return repoIndex.map.get(String(nameWithOwner).split('/').pop()) || '';
}

function fillTemplate(s, pr) {
  return String(s || '').replace(/\{(url|number|repo|head|base|title|author|local)\}/g, (_, k) => pr[k] ?? '');
}

function jobFor(rt, pr) {
  const origin = `Lanzado por la rutina «${rt.name}» para ${pr.repo}#${pr.number} (${trunc(pr.title, 60)})`;
  const extra = rt.extra ? `\n\nInstrucciones adicionales: ${fillTemplate(rt.extra, pr)}` : '';
  const base = { permissionMode: rt.permissionMode, origin, leaveWhenDone: true, routine: rt.id };
  if (rt.action.kind === 'skill') return { ...base, kind: 'skill', skill: rt.action.skill, args: fillTemplate(rt.action.args, pr) + extra };
  return { ...base, kind: 'libre', text: fillTemplate(rt.action.text, pr) + extra };
}

async function findPRs(rt) {
  const s = rt.source;
  const query = String(s.query || '').trim();
  const opts = { timeout: 60000 };
  let prs;
  if (s.scope === 'repo') {
    const args = ['pr', 'list', '-R', s.repo, '--state', 'open', '--limit', '50', '--json', 'number,headRefOid,title,url,headRefName,baseRefName,isDraft,author'];
    if (query) args.push('--search', query);
    prs = JSON.parse((await run('gh', args, opts)).stdout).map(p => ({ ...p, repo: s.repo }));
  } else {
    const args = ['search', 'prs', '--owner', s.owner, '--state', 'open', '--limit', '30', '--json', 'number,title,url,repository,isDraft,author'];
    if (query) args.push('--', ...query.split(/\s+/));
    const found = JSON.parse((await run('gh', args, opts)).stdout);
    prs = [];
    // La busqueda no trae ramas ni commit: se piden PR por PR.
    for (const p of found) {
      const repo = p.repository.nameWithOwner;
      const v = JSON.parse((await run('gh', ['pr', 'view', String(p.number), '-R', repo, '--json', 'headRefOid,headRefName,baseRefName'], opts)).stdout);
      prs.push({ ...p, ...v, repo });
    }
  }
  prs = prs.filter(p => rt.includeDrafts || !p.isDraft);
  for (const p of prs) {
    p.key = `${p.repo}#${p.number}`;
    p.head = p.headRefName;
    p.base = p.baseRefName;
    p.author = p.author?.login || '';
    p.local = await localRepoPath(p.repo);
  }
  return prs;
}

async function checkWatch(rt) {
  const prs = await findPRs(rt);
  rt.seen = rt.seen || {};
  // Se olvidan los PRs que ya no aparecen (cerrados o fuera del filtro).
  for (const k of Object.keys(rt.seen)) if (!prs.some(p => p.key === k)) delete rt.seen[k];
  if (rt.onlyNew && !rt.baselined) {
    for (const p of prs) rt.seen[p.key] = p.headRefOid;
    rt.baselined = true;
    return { open: prs.length, changed: 0, dispatched: 0, pending: 0, note: `Línea base: ${prs.length} PRs marcados como vistos; desde ahora solo actúa sobre nuevos o con commits nuevos` };
  }
  const changed = prs.filter(p => rt.seen[p.key] !== p.headRefOid);
  let dispatched = 0, pending = 0, note = null;
  for (const p of changed) {
    try {
      await launch(jobFor(rt, p));
      rt.seen[p.key] = p.headRefOid;
      dispatched++;
    } catch (e) {
      // Sin cupo o sin escritorio: queda sin marcar y se reintenta en el proximo chequeo.
      pending++;
      note = e.message;
    }
  }
  return { open: prs.length, changed: changed.length, dispatched, pending, note };
}

function memoryPath(rt) { return path.join(ROUTINES_DIR, rt.id, 'memoria.md'); }

function agendaPrompt(rt) {
  const mem = memoryPath(rt);
  let p = `${rt.text}\n\n--- Contexto de la rutina «${rt.name}» (ejecución #${rt.runs}, se repite cada ${rt.everyMin} min) ---\n`;
  p += `Memoria entre ejecuciones: ${mem}. Léela al empezar y actualízala al terminar con lo que hiciste (por ejemplo, qué PRs ya procesaste y con qué commit) para no repetir trabajo en la próxima ejecución.`;
  if (rt.delegate) {
    const safeName = rt.name.replace(/['"\\]/g, '');
    p += `\nPara pasarle trabajo a otro robot de la oficina usa: curl -s -X POST http://127.0.0.1:${PORT}/api/robots -H 'Content-Type: application/json' -d '{"kind":"skill","skill":"review-deep","args":"<argumentos>","origin":"Delegado por la rutina ${safeName}","leaveWhenDone":true,"routine":"${rt.id}"}' (o {"kind":"libre","text":"<instrucciones>",...}). Un robot por pedido. Si responde que no hay cupo, anótalo en la memoria para la próxima ejecución.`;
  }
  return p;
}

async function runAgenda(rt) {
  const prev = rt.lastRobot && robots.get(rt.lastRobot);
  if (prev && prev.state !== 'done') return { dispatched: 0, note: `La ejecución anterior (${prev.name}) sigue trabajando; se salta esta` };
  fs.mkdirSync(path.dirname(memoryPath(rt)), { recursive: true });
  if (!fs.existsSync(memoryPath(rt))) fs.writeFileSync(memoryPath(rt), `# Memoria de la rutina «${rt.name}»\n\n`);
  rt.runs = (rt.runs || 0) + 1;
  try {
    const r = await launch({
      kind: 'libre', text: agendaPrompt(rt), label: `Rutina «${rt.name}» #${rt.runs}`, permissionMode: rt.permissionMode,
      origin: `Ejecución #${rt.runs} de la rutina «${rt.name}»`, leaveWhenDone: true, routine: rt.id
    });
    rt.lastRobot = r.name;
    return { dispatched: 1, note: `Lanzó a ${r.name}` };
  } catch (e) {
    rt.runs--;
    return { dispatched: 0, pending: 1, note: e.message };
  }
}

async function checkRoutine(rt) {
  if (rt.running) return;
  rt.running = true;
  emitRoutines();
  try {
    rt.lastRun = { at: now(), ...(rt.type === 'agenda' ? await runAgenda(rt) : await checkWatch(rt)) };
  } catch (e) {
    rt.lastRun = { at: now(), error: trunc(e.stderr || e.message, 240) };
  }
  rt.running = false;
  rt.nextAt = Date.now() + rt.everyMin * 60000;
  saveRoutines();
  emitRoutines();
}

function createRoutine(b) {
  const everyMin = Number(b.everyMin);
  if (!Number.isFinite(everyMin) || everyMin < 1 || everyMin > 1440) throw new Error('La frecuencia debe estar entre 1 y 1440 minutos.');
  if (b.permissionMode && !PERMISSION_MODES.has(b.permissionMode)) throw new Error('Modo de permisos inválido.');
  const rt = {
    id: crypto.randomBytes(4).toString('hex'), type: b.type === 'agenda' ? 'agenda' : 'watch', everyMin,
    permissionMode: b.permissionMode || '', paused: false, lastRun: null, nextAt: Date.now(), running: false
  };
  if (rt.type === 'agenda') {
    rt.text = String(b.text || '').trim();
    if (!rt.text) throw new Error('Escribe las instrucciones de la tarea programada.');
    rt.delegate = !!b.delegate;
    rt.runs = 0;
    rt.name = trunc(b.name || trunc(rt.text, 40), 60);
  } else {
    const s = b.source || {};
    if (s.scope === 'org') {
      const owner = String(s.owner || '').trim();
      if (!/^[\w.-]+$/.test(owner)) throw new Error('Organización inválida, ej. DROPI-SAS.');
      rt.source = { scope: 'org', owner, query: String(s.query || '').trim() };
    } else {
      const repo = String(s.repo || '').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Repositorio inválido: usa owner/nombre, ej. DROPI-SAS/dropi-specs.');
      rt.source = { scope: 'repo', repo, query: String(s.query || '').trim() };
    }
    if (/[`$;|&<>]/.test(rt.source.query)) throw new Error('El filtro solo admite términos de búsqueda de GitHub, ej. author:karol label:hotfix.');
    const a = b.action || {};
    if (a.kind === 'skill') {
      const skill = String(a.skill || '').replace(/^\//, '').trim();
      if (!/^[a-z0-9:_-]+$/i.test(skill)) throw new Error('Elige una skill válida para la rutina.');
      rt.action = { kind: 'skill', skill, args: String(a.args || '').trim() };
    } else {
      const text = String(a.text || '').trim();
      if (!text) throw new Error('Escribe qué debe hacer el robot con cada PR.');
      rt.action = { kind: 'libre', text };
    }
    rt.extra = String(b.extra || '').trim();
    rt.onlyNew = !!b.onlyNew;
    rt.includeDrafts = !!b.includeDrafts;
    rt.seen = {};
    rt.baselined = false;
    const where = rt.source.scope === 'org' ? rt.source.owner : rt.source.repo.split('/')[1];
    rt.name = trunc(b.name || `PRs ${rt.source.query ? rt.source.query + ' ' : ''}en ${where}`, 60);
  }
  routines.push(rt);
  saveRoutines();
  checkRoutine(rt);
  return rt;
}

setInterval(() => {
  if (!WORKSPACE) return;
  for (const rt of routines) if (!rt.paused && !rt.running && Date.now() >= rt.nextAt) checkRoutine(rt);
}, ROUTINE_TICK_MS);

/* ---------- salas de épica ---------- */
// Una sala agrupa a los robots que trabajan sobre una misma épica de Jira. Comparten dos archivos en runs/salas/<id>/:
// - CONTEXT.md: lo que todos deben saber (alcance, decisiones, estado verificado). Lo leen al entrar y lo corrigen
//   cuando aprenden algo durable. Está fuera de la bandeja: editarlo no se entrega como documento.
// - HILO.md: el hilo de la sala. Al cerrar cada turno, lo que dijo el robot se publica solo; tú escribes desde la oficina.

const SALAS_FILE = path.join(RUNS, 'salas.json');
const SALAS_DIR = path.join(RUNS, 'salas');
const THREAD_MAX = 300;
let salas = [];
try { salas = JSON.parse(fs.readFileSync(SALAS_FILE, 'utf8')); } catch { salas = []; }

function saveSalas() { fs.writeFileSync(SALAS_FILE, JSON.stringify(salas, null, 2)); }
function contextPath(s) { return path.join(SALAS_DIR, s.id, 'CONTEXT.md'); }
function threadPath(s) { return path.join(SALAS_DIR, s.id, 'HILO.md'); }

function salaView(s) {
  return { id: s.id, name: s.name, key: s.key, folder: s.folder, context: contextPath(s), threadFile: threadPath(s), thread: s.thread.slice(-150), docs: s.docs, createdAt: s.createdAt };
}
function emitSalas() { broadcast({ type: 'salas', salas: salas.map(salaView) }); }

function writeThreadFile(s) {
  const msgs = s.thread.map(m => `### ${m.from} · ${new Date(m.at).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}\n\n${m.text}\n`);
  fs.writeFileSync(threadPath(s), `# Hilo de la sala «${s.name}»${s.key ? ` (${s.key})` : ''}\n\nMás reciente al final.\n\n${msgs.join('\n')}`);
}

function postThread(s, from, text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('Mensaje vacío.');
  s.thread.push({ id: crypto.randomBytes(4).toString('hex'), from: trunc(from, 40), text: t.slice(0, 12000), at: now() });
  if (s.thread.length > THREAD_MAX) s.thread.splice(0, s.thread.length - THREAD_MAX);
  writeThreadFile(s);
  saveSalas();
  emitSalas();
}

function createSala(b) {
  const name = trunc(b.name, 60);
  if (!name) throw new Error('Ponle nombre a la sala.');
  const key = String(b.key || '').trim().toUpperCase();
  if (key && !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error('Clave de Jira inválida, ej. TECH-2783.');
  let folder = String(b.folder || '').trim();
  if (folder) {
    const abs = path.resolve(WORKSPACE, folder);
    if (!abs.startsWith(WORKSPACE + path.sep) || !fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error('La carpeta de documentos debe existir dentro del workspace.');
    folder = path.relative(WORKSPACE, abs);
  }
  const s = { id: crypto.randomBytes(4).toString('hex'), name, key, folder, thread: [], docs: [], createdAt: now() };
  fs.mkdirSync(path.join(SALAS_DIR, s.id), { recursive: true });
  const initial = String(b.context || '').trim();
  fs.writeFileSync(contextPath(s), initial ? initial + '\n' : `# Contexto de la sala «${name}»${key ? ` (${key})` : ''}\n\n## Alcance\n\n## Decisiones tomadas\n\n## Estado verificado\n\n## Bloqueos y pendientes\n`);
  salas.push(s);
  writeThreadFile(s);
  saveSalas();
  return s;
}

function salaPreamble(s) {
  return `\n\n--- Sala de épica «${s.name}»${s.key ? ` (Jira ${s.key})` : ''} ---
Trabajas en una sala compartida con otros robots y con el coordinador.
1. Antes de empezar lee el contexto compartido: ${contextPath(s)}${s.folder ? `. Los documentos de la épica están en ${path.join(WORKSPACE, s.folder)}` : ''}.
2. Lee el hilo de la sala (${threadPath(s)}) para ver qué hicieron los demás y no repetir trabajo.
3. Si verificas algo durable (decisión, estado, bloqueo, un dato del contexto que estaba mal), corrige CONTEXT.md con Edit en su lugar, sin convertirlo en bitácora, con fecha absoluta en lo que cambies.
4. Lo que respondas al cerrar cada turno se publica solo en el hilo: escríbelo para que lo entienda otro robot que no vio tu conversación.
Para publicar en el hilo a mitad de turno: curl -s -X POST "http://127.0.0.1:${PORT}/api/salas/${s.id}/hilo?from=$OFFICE_ROBOT" -H 'Content-Type: text/plain' --data-binary @<archivo>`;
}

/* ---------- http ---------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > max) { reject(new Error('El archivo supera 20 MB.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(obj == null ? '' : JSON.stringify(obj));
}

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/robot-art.js': 'robot-art.js', '/style.css': 'style.css', '/vendor/marked.min.js': 'vendor/marked.min.js', '/vendor/purify.min.js': 'vendor/purify.min.js' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function robotOr404(res, name) {
  const r = robots.get(name);
  if (!r) send(res, 404, { error: `No hay un robot llamado ${name}.` });
  return r;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/api/setup' && req.method === 'GET') return send(res, 200, setupView());
    if (url.pathname === '/api/setup/check' && req.method === 'POST') return send(res, 200, workspaceInfo((await readBody(req)).workspace));
    if (url.pathname === '/api/setup' && req.method === 'POST') {
      if (process.env.OFFICE_WORKSPACE) return send(res, 409, { error: 'La carpeta viene de OFFICE_WORKSPACE; cámbiala ahí y reinicia la oficina.' });
      if (robots.size) return send(res, 409, { error: 'Da de baja a los robots antes de cambiar la carpeta de trabajo.' });
      const { workspace, create } = await readBody(req);
      if (!String(workspace || '').trim()) return send(res, 400, { error: 'Escribe la ruta de la carpeta.' });
      let info = workspaceInfo(workspace);
      if (!info.exists && create) { fs.mkdirSync(info.path, { recursive: true }); info = workspaceInfo(workspace); }
      if (!info.isDir) return send(res, 400, { error: info.exists ? 'Esa ruta es un archivo, no una carpeta.' : 'Esa carpeta no existe (marca «Crearla si no existe»).' });
      if (info.insideOffice) return send(res, 400, { error: 'Elige una carpeta fuera de la oficina.' });
      const first = !WORKSPACE;
      WORKSPACE = saveWorkspace(info.path);
      repoIndex = { at: 0, map: new Map() };
      console.log(`Carpeta de trabajo: ${WORKSPACE}`);
      if (first) { loadSessions(); await restore(); }
      broadcast({ type: 'setup', setup: setupView(), skills: listSkills() });
      return send(res, 200, { ok: true, ...setupView(), info });
    }
    // Sin carpeta de trabajo solo funcionan la página y la configuración inicial.
    if (!WORKSPACE && parts[0] === 'api' && url.pathname !== '/api/events') return send(res, 409, { error: 'Elige primero la carpeta de trabajo.', setup: true });
    if (!WORKSPACE && url.pathname === '/hook') return send(res, 200, null);
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = path.join(WEB, STATIC[url.pathname]);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'POST' && url.pathname === '/hook') {
      const name = url.searchParams.get('robot') || 'desconocido';
      return send(res, 200, await onHook(name, await readBody(req)));
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', setup: setupView(), robots: [...robots.values()].map(r => view(r, true)), inbox, routines: routines.map(routineView), salas: salas.map(salaView), config: configView(), favorites })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/attachments') {
      if (Number(req.headers['content-length'] || 0) > ATTACH_MAX_BYTES) return send(res, 413, { error: 'El archivo supera 20 MB.' });
      const scope = (url.searchParams.get('scope') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'encargos';
      const safe = path.basename(url.searchParams.get('name') || 'adjunto').replace(/[^\w.-]+/g, '_').slice(-80) || 'adjunto';
      const buf = await readRaw(req, ATTACH_MAX_BYTES);
      if (!buf.length) return send(res, 400, { error: 'Archivo vacío.' });
      const dir = path.join(ATTACH_DIR, scope);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now().toString(36)}-${safe}`);
      fs.writeFileSync(file, buf);
      return send(res, 201, { path: path.relative(WORKSPACE, file), name: safe, size: buf.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      if (body.name !== undefined) {
        officeName = String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, OFFICE_NAME_MAX);
        saveConfig({ name: officeName });
      }
      if (body.maxRobots !== undefined) {
        const n = Number(body.maxRobots);
        if (!Number.isInteger(n) || n < 1 || n > MAX_ROBOTS_LIMIT) return send(res, 400, { error: `El tope debe estar entre 1 y ${MAX_ROBOTS_LIMIT}.` });
        maxRobots = n;
        saveState();
      }
      broadcast({ type: 'config', config: configView() });
      return send(res, 200, configView());
    }
    if (req.method === 'GET' && url.pathname === '/api/usage') return send(res, 200, { weeks: officeUsage() });
    if (req.method === 'GET' && url.pathname === '/api/claude-status') return send(res, 200, await claudeStatus(url.searchParams.get('refresh') === '1'));
    if (req.method === 'GET' && url.pathname === '/api/skills') return send(res, 200, { skills: listSkills() });
    if (req.method === 'POST' && url.pathname === '/api/routines') {
      const rt = createRoutine(await readBody(req));
      emitRoutines();
      return send(res, 201, { ok: true, id: rt.id });
    }
    if (parts[0] === 'api' && parts[1] === 'routines' && parts[2]) {
      const rt = routines.find(x => x.id === parts[2]);
      if (!rt) return send(res, 404, { error: 'Esa rutina no existe.' });
      if (req.method === 'POST' && parts[3] === 'run') { checkRoutine(rt); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && parts[3] === 'pause') {
        rt.paused = !rt.paused;
        if (!rt.paused) rt.nextAt = Date.now();
        saveRoutines(); emitRoutines();
        return send(res, 200, { ok: true, paused: rt.paused });
      }
      if (req.method === 'DELETE' && !parts[3]) {
        routines = routines.filter(x => x !== rt);
        saveRoutines(); emitRoutines();
        return send(res, 200, { ok: true });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/salas') {
      const s = createSala(await readBody(req));
      emitSalas();
      return send(res, 201, { ok: true, id: s.id });
    }
    if (parts[0] === 'api' && parts[1] === 'salas' && parts[2]) {
      const s = salas.find(x => x.id === parts[2]);
      if (!s) return send(res, 404, { error: 'Esa sala no existe.' });
      const inSala = [...robots.values()].filter(r => r.place.sala === s.id);
      if (req.method === 'GET' && parts[3] === 'hilo') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(fs.readFileSync(threadPath(s)));
      }
      if (req.method === 'POST' && parts[3] === 'hilo') {
        // Desde la oficina llega JSON; un robot publica texto plano con ?from=$OFFICE_ROBOT.
        if (String(req.headers['content-type'] || '').startsWith('application/json')) {
          const { text, notify } = await readBody(req);
          postThread(s, 'Coordinador', text);
          // Avisar gasta cuota: cada robot de la sala recibe el mensaje como un turno nuevo.
          if (notify) for (const r of inSala) await say(r, `[Hilo de la sala «${s.name}»] El coordinador escribió:\n${String(text).trim()}`);
          return send(res, 201, { ok: true, notified: notify ? inSala.length : 0 });
        }
        const from = url.searchParams.get('from') || '';
        postThread(s, robots.has(from) ? from : `externo (${trunc(from, 20) || 'sin nombre'})`, (await readRaw(req, 1e6)).toString('utf8'));
        return send(res, 201, { ok: true });
      }
      if (req.method === 'DELETE' && !parts[3]) {
        if (inSala.length) return send(res, 409, { error: `La sala tiene ${inSala.length} robot${inSala.length === 1 ? '' : 's'}; dalos de baja antes de cerrarla.` });
        salas = salas.filter(x => x !== s); // los archivos quedan en runs/salas/<id>/
        saveSalas(); emitSalas();
        return send(res, 200, { ok: true });
      }
    }
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
      favorites = favorites.filter(f => f.id !== parts[2]);
      saveFavorites();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/robots') {
      const r = await launch(await readBody(req));
      return send(res, 201, { ok: true, name: r.name });
    }
    if (parts[0] === 'api' && parts[1] === 'robots' && parts[2]) {
      const r = robotOr404(res, parts[2]);
      if (!r) return;
      const action = parts[3];
      if (req.method === 'POST' && action === 'say') {
        const { text, attachments } = await readBody(req);
        if (!String(text || '').trim() && !validAttachments(attachments).length) return send(res, 400, { error: 'Mensaje vacío.' });
        await say(r, text, attachments);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'permission') {
        const { decision } = await readBody(req);
        await pressKey(r, decision === 'approve' ? 'approve' : 'reject');
        return send(res, 200, { ok: true });
      }
      // Título que le pones tú al robot («Tareas de QA», «Revisando wallet#32 Ramiro»); vacío lo quita.
      if (req.method === 'POST' && action === 'ask') {
        const { id, answers, console: toConsole } = await readBody(req);
        return answerAsk(r, id, answers, !!toConsole) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Esas preguntas ya no están pendientes.' });
      }
      if (req.method === 'POST' && action === 'title') {
        r.title = cleanTitle((await readBody(req)).title);
        emit(r);
        return send(res, 200, { ok: true, title: r.title });
      }
      if (req.method === 'GET' && action === 'pane') return send(res, 200, { text: await pane(r) });
      if (req.method === 'POST' && action === 'console') { await openConsole(r); return send(res, 200, { ok: true }); }
      if (req.method === 'DELETE' && !action) { await removeRobot(r, 'dado de baja'); return send(res, 200, { ok: true }); }
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'decision' && parts[2]) {
      const { decision } = await readBody(req);
      return decide(parts[2], decision) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Ese permiso ya no está pendiente.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/doc') {
      const p = knownDoc(url.searchParams.get('path'));
      if (!p) return send(res, 403, { error: 'Ese archivo no es un documento de la oficina.' });
      if (!fs.existsSync(p)) return send(res, 404, { error: 'El archivo ya no existe en el disco.' });
      const shown = p.startsWith(WORKSPACE + path.sep) ? path.relative(WORKSPACE, p) : p;
      if (!TEXT_DOC.test(p)) return send(res, 200, { path: shown, binary: true });
      return send(res, 200, { path: shown, text: fs.readFileSync(p, 'utf8') });
    }
    if (req.method === 'POST' && url.pathname === '/api/reveal') {
      const p = knownDoc((await readBody(req)).path);
      if (!p || !fs.existsSync(p)) return send(res, 404, { error: 'El archivo ya no existe.' });
      await run('open', ['-R', p]);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/inbox/seen-all') {
      for (const it of inbox) it.status = 'visto';
      emitInbox();
      return send(res, 200, { ok: true });
    }
    if (parts[0] === 'api' && parts[1] === 'inbox' && parts[2]) {
      const idx = inbox.findIndex(x => x.id === parts[2]);
      if (idx < 0) return send(res, 404, { error: 'Ese documento ya no está en la bandeja.' });
      if (req.method === 'POST') {
        const { status } = await readBody(req);
        inbox[idx].status = status === 'nuevo' ? 'nuevo' : 'visto';
      } else if (req.method === 'DELETE') {
        inbox.splice(idx, 1); // archivar: sale de la bandeja, el archivo queda en el disco
      }
      emitInbox();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Ruta desconocida.' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

await guardSession();
WORKSPACE = initialWorkspace();
if (WORKSPACE) { loadSessions(); await restore(); }
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Oficina de Agentes · http://127.0.0.1:${PORT}`);
  console.log(WORKSPACE ? `Carpeta de trabajo: ${WORKSPACE}` : `Primera ejecución: abre http://127.0.0.1:${PORT} para elegir la carpeta de trabajo`);
  console.log(`Sesión de tmux de los robots: ${SESSION} (tmux attach -t ${SESSION})`);
  console.log(`Tope de robots simultáneos: ${maxRobots}`);
  console.log(`Aprobaciones retenidas por el daemon: ${APPROVAL ? 'activas' : 'apagadas (OFFICE_APPROVAL=1)'}`);
  console.log(`Datos de la oficina: ${RUNS}`);
  console.log(`Eventos crudos: ${EVENTS_FILE}\n`);
});
