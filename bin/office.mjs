#!/usr/bin/env node
// Edificio de oficinas: un solo código (esta carpeta) y varias oficinas, cada una con su carpeta de datos,
// su puerto y su sesión de tmux. Así una oficina con mucho trabajo no se mezcla ni compite con otra.
//
//   office ls                                   oficinas registradas y si están corriendo
//   office create <nombre> --workspace <dir>    registra una oficina nueva (puerto y sesión libres)
//         [--port N] [--session S] [--data <dir>] [--max N]
//   office start <nombre…> | --all              arranca el daemon en segundo plano
//   office stop <nombre…> | --all               lo detiene (los robots siguen vivos en tmux)
//   office restart <nombre…> | --all
//   office logs <nombre> [-f]                   salida del daemon
//   office open <nombre>                        abre la oficina en el navegador
//   office ctl <nombre> <comando…>              daemon/ctl.mjs contra esa oficina
//   office lobby [stop]                         página del edificio (http://127.0.0.1:4700)
//
// Registro: ~/.agent-office/oficinas/<nombre>/office.json (AGENT_OFFICE_HOME cambia ~/.agent-office).
// Los datos de la oficina viven en esa misma carpeta, salvo que office.json diga otra en «data»
// (así se adopta una oficina existente sin mover su runs/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = path.join(ROOT, 'daemon', 'daemon.mjs');
const HOME = path.resolve(process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), '.agent-office'));
const OFFICES = path.join(HOME, 'oficinas');
const LOBBY_FILE = path.join(HOME, 'lobby.json');
const LOBBY_PORT = Number(process.env.AGENT_OFFICE_LOBBY_PORT || 4700);
const FIRST_PORT = 4777;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const die = msg => { console.error(msg); process.exit(1); };
const expandHome = p => String(p || '').trim().replace(/^~(?=$|\/)/, os.homedir());
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isTempDoc = p => /^(\/private)?\/(tmp|var\/folders)\//.test(String(p)) || /\/scratchpad\//.test(String(p));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/* ---------- registro ---------- */
function load(name) {
  const dir = path.join(OFFICES, name);
  const cfg = readJson(path.join(dir, 'office.json'));
  if (!cfg) return null;
  const data = path.resolve(cfg.data ? expandHome(cfg.data) : dir);
  return { ...cfg, name, dir, data, log: path.join(dir, 'daemon.log') };
}
function all() {
  let names = [];
  try { names = fs.readdirSync(OFFICES).filter(n => fs.existsSync(path.join(OFFICES, n, 'office.json'))); } catch { /* sin edificio */ }
  return names.sort().map(load).filter(Boolean);
}
function mustLoad(name) {
  const o = load(name);
  if (!o) die(`No existe la oficina «${name}». Mira las registradas con: office ls`);
  return o;
}
// Pid del daemon que corre sobre esa carpeta de datos (el daemon escribe daemon.lock al arrancar).
function running(o) {
  const lock = readJson(path.join(o.data, 'daemon.lock'));
  return lock && alive(lock.pid) ? lock : null;
}
function portBusy(port) {
  return new Promise(resolve => {
    const s = net.createServer().once('error', () => resolve(true)).once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '127.0.0.1');
  });
}
async function freePort(taken) {
  for (let p = FIRST_PORT; p < FIRST_PORT + 200; p++) if (!taken.has(p) && p !== LOBBY_PORT && !(await portBusy(p))) return p;
  die('No encontré un puerto libre entre 4777 y 4976.');
}
// Lo que muestra el edificio de cada oficina, leído de sus archivos: no gasta nada ni depende de que esté corriendo.
function summary(o) {
  const cfg = readJson(path.join(o.data, 'config.json')) || {};
  const state = readJson(path.join(o.data, 'office-state.json')) || {};
  const robots = state.robots || [];
  const count = s => robots.filter(r => s.includes(r.state)).length;
  const lock = running(o);
  return {
    name: o.name, title: cfg.name || o.name, port: o.port, session: o.session, data: o.data, workspace: cfg.workspace || null,
    running: !!lock, pid: lock?.pid || null, url: `http://127.0.0.1:${o.port}`,
    robots: robots.length, working: count(['working', 'walking', 'delegating']), need: count(['input']), done: count(['done']),
    // Igual que la bandeja de la oficina: los archivos de carpetas temporales no cuentan como nuevos.
    inbox: (state.inbox || []).filter(i => i.status !== 'visto' && !isTempDoc(i.path)).length
  };
}

/* ---------- comandos ---------- */
async function create(name, opts) {
  if (!NAME_RE.test(name || '')) die('Nombre inválido: usa minúsculas, números y guiones (máx. 30), p. ej. «nr» o «legacy».');
  if (load(name)) die(`La oficina «${name}» ya existe.`);
  const others = all();
  const port = opts.port ? Number(opts.port) : await freePort(new Set(others.map(o => o.port)));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) die(`Puerto inválido: ${opts.port}`);
  if (others.some(o => o.port === port)) die(`El puerto ${port} ya es de la oficina «${others.find(o => o.port === port).name}».`);
  const session = opts.session || `office-${name}`;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(session)) die(`Sesión de tmux inválida: «${session}».`);
  if (others.some(o => o.session === session)) die(`La sesión ${session} ya es de la oficina «${others.find(o => o.session === session).name}».`);
  const dir = path.join(OFFICES, name);
  const data = opts.data ? path.resolve(expandHome(opts.data)) : dir;
  const owner = others.find(o => o.data === data);
  if (owner) die(`La carpeta de datos ${data} ya es de la oficina «${owner.name}».`);
  if (opts.data && !fs.existsSync(data)) die(`No existe la carpeta de datos ${data}.`);
  let workspace = null;
  if (opts.workspace) {
    workspace = path.resolve(expandHome(opts.workspace));
    if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) die(`No existe la carpeta de trabajo ${workspace}.`);
  }
  const prevCfg = readJson(path.join(data, 'config.json'));
  if (!workspace && !prevCfg?.workspace) die('Falta --workspace <carpeta>: la carpeta donde trabajarán los robots de esta oficina.');

  fs.mkdirSync(dir, { recursive: true });
  const cfg = { port, session, ...(opts.data ? { data } : {}), ...(opts.max ? { maxRobots: Number(opts.max) } : {}), createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'office.json'), JSON.stringify(cfg, null, 2) + '\n');
  // La carpeta de trabajo vive en config.json de los datos (la misma que se cambia desde la página).
  if (workspace) {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ ...(prevCfg || {}), workspace, ...(prevCfg?.name ? {} : { name: name.toUpperCase() }) }, null, 2));
  }
  console.log(`Oficina «${name}» registrada: puerto ${port}, sesión tmux ${session}`);
  console.log(`  datos: ${data}`);
  console.log(`  carpeta de trabajo: ${workspace || prevCfg.workspace}`);
  console.log(`Arráncala con: office start ${name}`);
}

async function start(o) {
  const lock = running(o);
  if (lock) return console.log(`${o.name}: ya está corriendo (pid ${lock.pid}) · http://127.0.0.1:${lock.port}`);
  if (await portBusy(o.port)) return console.log(`${o.name}: el puerto ${o.port} está ocupado por otro programa; no la arranco.`);
  fs.mkdirSync(o.data, { recursive: true });
  const env = { ...process.env, OFFICE_DATA: o.data, OFFICE_PORT: String(o.port), OFFICE_SESSION: o.session };
  // La carpeta de trabajo sale de config.json; una OFFICE_WORKSPACE heredada de tu terminal la pisaría.
  delete env.OFFICE_WORKSPACE;
  // Si arrancas el edificio desde una sesión de Claude Code, que sus variables no lleguen a los robots.
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  if (o.maxRobots) env.OFFICE_MAX_ROBOTS = String(o.maxRobots); else delete env.OFFICE_MAX_ROBOTS;
  if (o.approval) env.OFFICE_APPROVAL = '1'; else delete env.OFFICE_APPROVAL;
  const out = fs.openSync(o.log, 'a');
  fs.writeSync(out, `\n=== ${new Date().toISOString()} office start ${o.name} ===\n`);
  const child = spawn(process.execPath, [DAEMON], { cwd: ROOT, env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (!alive(child.pid)) break;
    if (running(o) && (await portBusy(o.port))) return console.log(`${o.name}: corriendo (pid ${child.pid}) · http://127.0.0.1:${o.port}`);
  }
  console.log(`${o.name}: no arrancó. Últimas líneas de ${o.log}:`);
  console.log(fs.readFileSync(o.log, 'utf8').split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
}

async function stop(o) {
  const lock = running(o);
  if (!lock) return console.log(`${o.name}: no está corriendo.`);
  process.kill(lock.pid, 'SIGTERM');
  for (let i = 0; i < 40 && alive(lock.pid); i++) await sleep(125);
  console.log(alive(lock.pid) ? `${o.name}: no se detuvo (pid ${lock.pid}).` : `${o.name}: detenida. Sus robots siguen en tmux (tmux attach -t ${o.session}).`);
}

function ls() {
  const list = all().map(summary);
  if (!list.length) return console.log(`No hay oficinas en ${OFFICES}. Crea una con: office create <nombre> --workspace <carpeta>`);
  const rows = [['OFICINA', 'ESTADO', 'URL', 'TMUX', 'ROBOTS', 'TE NECESITAN', 'BANDEJA', 'CARPETA DE TRABAJO']].concat(list.map(s => [
    s.name, s.running ? `corriendo` : 'detenida', s.url, s.session, String(s.robots), String(s.need), String(s.inbox),
    (s.workspace || '—').replace(os.homedir(), '~')
  ]));
  const w = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd());
  const lobby = readJson(LOBBY_FILE);
  if (lobby && alive(lobby.pid)) console.log(`\nEdificio: http://127.0.0.1:${lobby.port}`);
}

const targets = args => {
  if (args.includes('--all')) return all();
  if (!args.length) die('Indica la oficina (o --all). Mira las registradas con: office ls');
  return args.map(mustLoad);
};

/* ---------- edificio (lobby) ---------- */
function lobbyServe(port) {
  const page = path.join(ROOT, 'edificio', 'index.html');
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  // Solo desde la propia página del edificio: otra web abierta en tu navegador no puede crear ni encender oficinas.
  const sameOrigin = req => !req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}` || req.headers.origin === `http://localhost:${port}`;
  const self = (...a) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...a], { encoding: 'utf8', env: process.env });
  const readBody = req => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e5) reject(new Error('Cuerpo demasiado grande')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON inválido')); } });
  });
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'POST' && url.pathname === '/api/offices') {
        if (!sameOrigin(req)) return send(res, 403, { error: 'Origen no permitido' });
        // Misma validación que la consola: se delega en «office create» (nombre, carpeta, puerto y sesión libres).
        const b = await readBody(req);
        const name = String(b.name || '').trim().toLowerCase();
        const args = ['create', name, '--workspace', String(b.workspace || '').trim()];
        if (b.max) args.push('--max', String(Number(b.max) || 3));
        const c = self(...args);
        if (c.status !== 0) return send(res, 400, { error: (c.stderr || c.stdout).trim() || 'No se pudo crear la oficina' });
        let output = c.stdout.trim();
        if (b.start !== false) { const st = self('start', name); output += '\n' + (st.stdout + st.stderr).trim(); }
        return send(res, 200, { output, office: summary(load(name)) });
      }
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(page, 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/offices') return send(res, 200, { offices: all().map(summary) });
      const m = url.pathname.match(/^\/api\/offices\/([a-z0-9-]+)\/(start|stop)$/);
      if (req.method === 'POST' && m) {
        if (!sameOrigin(req)) return send(res, 403, { error: 'Origen no permitido' });
        const o = load(m[1]);
        if (!o) return send(res, 404, { error: 'No existe esa oficina' });
        const r = self(m[2], o.name);
        return send(res, r.status === 0 ? 200 : 500, { output: (r.stdout + r.stderr).trim(), office: summary(o) });
      }
      send(res, 404, { error: 'Ruta desconocida' });
    } catch (e) { send(res, 500, { error: e.message }); }
  }).listen(port, '127.0.0.1');
}

async function lobby(sub) {
  const cur = readJson(LOBBY_FILE);
  const on = cur && alive(cur.pid);
  if (sub === 'stop') {
    if (!on) return console.log('El edificio no está corriendo.');
    process.kill(cur.pid, 'SIGTERM');
    return console.log('Edificio detenido. Las oficinas siguen corriendo.');
  }
  if (on) return console.log(`El edificio ya está en http://127.0.0.1:${cur.port}`);
  if (await portBusy(LOBBY_PORT)) die(`El puerto ${LOBBY_PORT} está ocupado (cámbialo con AGENT_OFFICE_LOBBY_PORT).`);
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(path.join(HOME, 'lobby.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__lobby-serve', String(LOBBY_PORT)], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.writeFileSync(LOBBY_FILE, JSON.stringify({ pid: child.pid, port: LOBBY_PORT }));
  console.log(`Edificio en http://127.0.0.1:${LOBBY_PORT}`);
}

/* ---------- main ---------- */
const [cmd, ...args] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--') && a !== '--all') flags[a.slice(2)] = args[i + 1]?.startsWith('--') ? true : args[++i];
  else pos.push(a);
}

switch (cmd) {
  case 'ls': case 'status': case undefined: ls(); break;
  case 'create': await create(pos[0], flags); break;
  case 'start': for (const o of targets(pos)) await start(o); break;
  case 'stop': for (const o of targets(pos)) await stop(o); break;
  case 'restart': for (const o of targets(pos)) { await stop(o); await start(o); } break;
  case 'logs': {
    const o = mustLoad(pos[0]);
    if (args.includes('-f')) spawn('tail', ['-n', '40', '-f', o.log], { stdio: 'inherit' });
    else console.log(fs.existsSync(o.log) ? fs.readFileSync(o.log, 'utf8').split('\n').slice(-60).join('\n') : 'Sin log todavía.');
    break;
  }
  case 'open': { const o = mustLoad(pos[0]); spawn('open', [`http://127.0.0.1:${o.port}`], { stdio: 'ignore', detached: true }).unref(); break; }
  case 'ctl': {
    const o = mustLoad(args[0]);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'daemon', 'ctl.mjs'), ...args.slice(1)], { stdio: 'inherit', env: { ...process.env, OFFICE_PORT: String(o.port) } });
    process.exitCode = r.status ?? 1;
    break;
  }
  case 'lobby': await lobby(pos[0]); break;
  case '__lobby-serve': lobbyServe(Number(pos[0]) || LOBBY_PORT); break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}
