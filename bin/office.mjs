#!/usr/bin/env node
// Edificio de oficinas: un solo código (esta carpeta) y varias oficinas, cada una con su carpeta de datos,
// su puerto y su sesión de tmux. Así una oficina con mucho trabajo no se mezcla ni compite con otra.
//
//   office ls                                   oficinas registradas y si están corriendo
//   office create <nombre> --workspace <dir>    registra una oficina nueva (puerto y sesión libres)
//         [--port N] [--session S] [--data <dir>] [--max N]
//   office start <nombre…> | --all              arranca el daemon en segundo plano
//   office stop <nombre…> | --all               lo detiene (los robots siguen vivos en tmux)
//         [--despedir]                          …y antes da de baja a todos sus robots
//   office restart <nombre…> | --all
//   office rm <nombre> [--yes]                  elimina la oficina: despide sus robots y la manda a la Papelera
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
const die = msg => {
  console.error(msg);
  process.exit(1);
};
const expandHome = p =>
  String(p || '')
    .trim()
    .replace(/^~(?=$|\/)/, os.homedir());
const readJson = f => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const isTempDoc = p => /^(\/private)?\/(tmp|var\/folders)\//.test(String(p)) || /\/scratchpad\//.test(String(p));
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/* ---------- tmux ---------- */
const tmux = (...a) => spawnSync('tmux', a, { encoding: 'utf8' });
// Ventanas de robots vivas en la sesión de la oficina (sin «lobby» ni «_status»). Solo si la sesión es de
// esta oficina: el daemon marca la suya con @office_port.
function liveRobots(o) {
  if (tmux('has-session', '-t', o.session).status !== 0) return [];
  const owner = tmux('show-options', '-t', o.session, '-v', '@office_port');
  if (owner.status === 0 && owner.stdout.trim() && Number(owner.stdout.trim()) !== o.port) return [];
  const names = tmux('list-windows', '-t', o.session, '-F', '#{window_name}')
    .stdout.split('\n')
    .filter(n => n && n !== 'lobby' && n !== '_status');
  // Claude Code muestra «esc to interrupt» mientras trabaja: es la forma de saberlo sin el daemon.
  return names.map(name => ({
    name,
    busy: /esc to interrupt/i.test(tmux('capture-pane', '-p', '-t', `${o.session}:${name}`).stdout || '')
  }));
}

/* ---------- registro ---------- */
function load(name) {
  const dir = path.join(OFFICES, name);
  const cfg = readJson(path.join(dir, 'office.json'));
  if (!cfg) return null;
  const data = path.resolve(cfg.data ? expandHome(cfg.data) : dir);
  return { ...cfg, name, dir, data, dataExternal: !!cfg.data, log: path.join(dir, 'daemon.log') };
}
function all() {
  let names = [];
  try {
    names = fs.readdirSync(OFFICES).filter(n => fs.existsSync(path.join(OFFICES, n, 'office.json')));
  } catch {
    /* sin edificio */
  }
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
    const s = net
      .createServer()
      .once('error', () => resolve(true))
      .once('listening', () => s.close(() => resolve(false)));
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
  // Detenida pero con robots vivos en tmux: siguen trabajando (y gastando cuota) sin que nadie los vea.
  const orphans = lock ? [] : liveRobots(o);
  const robotList = robots.map(r => ({
    name: r.name,
    color: r.color || 0,
    state: r.state,
    critical: r.critical || 0,
    title: r.title || '',
    request: r.request || null,
    skill: r.skill || null,
    look: r.look || null,
    label: r.label || '',
    room: r.place?.type === 'room' ? (r.place.sala ? 'sala' : 'rutina') : ''
  }));
  return {
    name: o.name,
    title: cfg.name || o.name,
    createdAt: o.createdAt || null,
    adopted: !!o.dataExternal,
    maxRobots: state.maxRobots || o.maxRobots || 3,
    robotList,
    orphanList: orphans,
    port: o.port,
    session: o.session,
    data: o.data,
    workspace: cfg.workspace || null,
    running: !!lock,
    pid: lock?.pid || null,
    url: `http://127.0.0.1:${o.port}`,
    robots: robots.length,
    working: count(['working', 'walking', 'delegating']),
    need: count(['input']),
    done: count(['done']),
    // Igual que la bandeja de la oficina: los archivos de carpetas temporales no cuentan como nuevos.
    inbox: (state.inbox || []).filter(i => i.status !== 'visto' && !isTempDoc(i.path)).length,
    orphans: orphans.length,
    orphansBusy: orphans.filter(r => r.busy).length,
    // Para el edificio: el estilo de la oficina (su piso se ve igual) y cuándo se renovó su cuota (fuegos artificiales).
    mapTheme: cfg.mapTheme || 'moderna',
    repotAt: (readJson(path.join(o.data, 'estadisticas.json')) || {}).repotAt || null
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
  if (others.some(o => o.session === session))
    die(`La sesión ${session} ya es de la oficina «${others.find(o => o.session === session).name}».`);
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
  const cfg = {
    port,
    session,
    ...(opts.data ? { data } : {}),
    ...(opts.max ? { maxRobots: Number(opts.max) } : {}),
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dir, 'office.json'), JSON.stringify(cfg, null, 2) + '\n');
  // La carpeta de trabajo vive en config.json de los datos (la misma que se cambia desde la página).
  if (workspace) {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(
      path.join(data, 'config.json'),
      JSON.stringify({ ...(prevCfg || {}), workspace, ...(prevCfg?.name ? {} : { name: name.toUpperCase() }) }, null, 2)
    );
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
  if (o.maxRobots) env.OFFICE_MAX_ROBOTS = String(o.maxRobots);
  else delete env.OFFICE_MAX_ROBOTS;
  if (o.approval) env.OFFICE_APPROVAL = '1';
  else delete env.OFFICE_APPROVAL;
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

// via: quién la detiene, para su registro (si un día aparece detenida, ahí se ve si fue el edificio, la terminal o
// un reinicio; si no hay línea «office stop», no fue el edificio).
async function stop(o, despedir = false, via = 'office stop en la terminal') {
  if (despedir) await dismissAll(o);
  const lock = running(o);
  if (!lock) {
    if (!despedir) console.log(`${o.name}: no está corriendo.`);
  } else {
    try {
      fs.appendFileSync(
        o.log,
        `\n=== ${new Date().toISOString()} office stop ${o.name} · desde: ${via}${despedir ? ' · despidiendo a sus robots' : ''} ===\n`
      );
    } catch {
      /* sin registro */
    }
    process.kill(lock.pid, 'SIGTERM');
    for (let i = 0; i < 40 && alive(lock.pid); i++) await sleep(125);
    if (alive(lock.pid)) return console.log(`${o.name}: no se detuvo (pid ${lock.pid}).`);
    const left = liveRobots(o).length;
    console.log(
      `${o.name}: detenida.${left ? ` ${left === 1 ? 'Su robot sigue' : `Sus ${left} robots siguen`} en tmux y se reconecta${left === 1 ? '' : 'n'} al iniciarla (para despedir${left === 1 ? 'lo' : 'los'}: office stop ${o.name} --despedir).` : ''}`
    );
  }
  // Cerrar de verdad: también la sesión de tmux (consola de /usage incluida), si es de esta oficina.
  if (despedir && tmux('has-session', '-t', o.session).status === 0) {
    const owner = tmux('show-options', '-t', o.session, '-v', '@office_port').stdout.trim();
    if (!owner || Number(owner) === o.port) {
      tmux('kill-session', '-t', o.session);
      console.log(`${o.name}: sesión tmux ${o.session} cerrada.`);
    }
  }
}

// Da de baja a todos los robots por la API del daemon, que entrega sus documentos pendientes a la bandeja
// antes de cerrar cada ventana. Si la oficina está detenida, la arranca un momento para eso.
async function dismissAll(o) {
  const live = liveRobots(o);
  if (!live.length) return console.log(`${o.name}: no tiene robots vivos.`);
  if (!running(o)) {
    console.log(`${o.name}: la inicio un momento para despedir a sus robots con la entrega de sus documentos…`);
    await start(o);
  }
  for (const r of live) {
    let ok = false;
    if (running(o)) {
      try {
        ok = (await fetch(`http://127.0.0.1:${o.port}/api/robots/${encodeURIComponent(r.name)}`, { method: 'DELETE' })).ok;
      } catch {
        /* daemon caído */
      }
    }
    // Ventana que el daemon no conoce (o daemon caído): se cierra directo.
    if (!ok) ok = tmux('kill-window', '-t', `${o.session}:${r.name}`).status === 0;
    console.log(`  ${r.name}: ${ok ? 'despedido' : 'no se pudo despedir'}${r.busy ? ' (estaba trabajando)' : ''}`);
  }
}

// Eliminar no borra nada para siempre: la carpeta de la oficina (registro, estado, bandeja, log) va a la
// Papelera de macOS, de donde se recupera. Una oficina adoptada con --data deja sus datos donde estaban.
// Los documentos que escribieron los robots en la carpeta de trabajo nunca se tocan.
async function rm(o, yes) {
  if (!yes) {
    if (!process.stdin.isTTY) die(`Para eliminar «${o.name}» sin preguntar, agrega --yes.`);
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    const ans = (
      await rl.question(`Se despiden todos los robots de «${o.name}» y la oficina va a la Papelera.\nEscribe su nombre para confirmar: `)
    ).trim();
    rl.close();
    if (ans !== o.name) die('No coincide: no se eliminó nada.');
  }
  if (running(o) || liveRobots(o).length) await stop(o, true, 'office rm (eliminar la oficina)');
  const trash = fs.existsSync(path.join(os.homedir(), '.Trash')) ? path.join(os.homedir(), '.Trash') : path.join(HOME, 'papelera');
  fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `agent-office-${o.name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  try {
    fs.renameSync(o.dir, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(o.dir, dest, { recursive: true });
    fs.rmSync(o.dir, { recursive: true }); // otro disco: copiar y quitar
  }
  console.log(`${o.name}: eliminada. Su carpeta quedó en la Papelera: ${dest}`);
  if (o.dataExternal) console.log(`  Sus datos adoptados siguen en ${o.data} (no se tocaron).`);
}

function ls() {
  const list = all().map(summary);
  if (!list.length) return console.log(`No hay oficinas en ${OFFICES}. Crea una con: office create <nombre> --workspace <carpeta>`);
  const rows = [['OFICINA', 'ESTADO', 'URL', 'TMUX', 'ROBOTS', 'TE NECESITAN', 'BANDEJA', 'CARPETA DE TRABAJO']].concat(
    list.map(s => [
      s.name,
      s.running ? 'corriendo' : s.orphans ? `detenida · ${s.orphans} vivo${s.orphans === 1 ? '' : 's'} en tmux` : 'detenida',
      s.url,
      s.session,
      String(s.robots),
      String(s.need),
      String(s.inbox),
      (s.workspace || '—').replace(os.homedir(), '~')
    ])
  );
  const w = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  for (const r of rows)
    console.log(
      r
        .map((c, i) => c.padEnd(w[i]))
        .join('  ')
        .trimEnd()
    );
  for (const s of list.filter(x => x.orphans)) {
    console.log(
      `\n⚠ ${s.name} está detenida pero tiene ${s.orphans} robot${s.orphans === 1 ? '' : 's'} vivo${s.orphans === 1 ? '' : 's'} en tmux${s.orphansBusy ? `, ${s.orphansBusy} trabajando (gastando cuota sin que lo veas)` : ''}.`
    );
    console.log(`  Reconéctalos: office start ${s.name}   ·   o despídelos: office stop ${s.name} --despedir`);
  }
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
  const sameOrigin = req =>
    !req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}` || req.headers.origin === `http://localhost:${port}`;
  const self = (...a) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...a], { encoding: 'utf8', env: process.env });
  const readBody = req =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', c => {
        raw += c;
        if (raw.length > 1e5) reject(new Error('Cuerpo demasiado grande'));
      });
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(new Error('JSON inválido'));
        }
      });
    });
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      // Solo local, como cada oficina: a 127.0.0.1/localhost en su puerto y sin peticiones desde otra página.
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      const origin = req.headers.origin;
      if (!hosts.has(String(req.headers.host || '')) || (origin && !hosts.has(origin.replace(/^https?:\/\//, ''))))
        return send(res, 403, { error: 'Solo local: petición rechazada.' });
      try {
        if (req.method === 'POST' && url.pathname === '/api/offices') {
          if (!sameOrigin(req)) return send(res, 403, { error: 'Origen no permitido' });
          // Misma validación que la consola: se delega en «office create» (nombre, carpeta, puerto y sesión libres).
          const b = await readBody(req);
          const name = String(b.name || '')
            .trim()
            .toLowerCase();
          const args = ['create', name, '--workspace', String(b.workspace || '').trim()];
          if (b.max) args.push('--max', String(Number(b.max) || 3));
          const c = self(...args);
          if (c.status !== 0) return send(res, 400, { error: (c.stderr || c.stdout).trim() || 'No se pudo crear la oficina' });
          let output = c.stdout.trim();
          if (b.start !== false) {
            const st = self('start', name);
            output += '\n' + (st.stdout + st.stderr).trim();
          }
          return send(res, 200, { output, office: summary(load(name)) });
        }
        if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(page, 'utf8'), 'text/html; charset=utf-8');
        if (req.method === 'GET' && url.pathname === '/robot-art.js')
          return send(res, 200, fs.readFileSync(path.join(ROOT, 'web', 'robot-art.js'), 'utf8'), 'text/javascript; charset=utf-8');
        if (req.method === 'GET' && url.pathname === '/api/offices') return send(res, 200, { offices: all().map(summary) });
        const del = url.pathname.match(/^\/api\/offices\/([a-z0-9-]+)\/delete$/);
        if (req.method === 'POST' && del) {
          if (!sameOrigin(req)) return send(res, 403, { error: 'Origen no permitido' });
          const b = await readBody(req);
          if (b.confirm !== del[1]) return send(res, 400, { error: 'Escribe el nombre exacto de la oficina para confirmar.' });
          if (!load(del[1])) return send(res, 404, { error: 'No existe esa oficina' });
          const r = self('rm', del[1], '--yes');
          return send(res, r.status === 0 ? 200 : 500, { output: (r.stdout + r.stderr).trim() });
        }
        const m = url.pathname.match(/^\/api\/offices\/([a-z0-9-]+)\/(start|stop)$/);
        if (req.method === 'POST' && m) {
          if (!sameOrigin(req)) return send(res, 403, { error: 'Origen no permitido' });
          const o = load(m[1]);
          if (!o) return send(res, 404, { error: 'No existe esa oficina' });
          const r = self(
            m[2],
            o.name,
            ...(m[2] === 'stop'
              ? ['--via', 'el edificio (botón Detener)', ...(url.searchParams.get('despedir') === '1' ? ['--despedir'] : [])]
              : [])
          );
          return send(res, r.status === 0 ? 200 : 500, { output: (r.stdout + r.stderr).trim(), office: summary(o) });
        }
        send(res, 404, { error: 'Ruta desconocida' });
      } catch (e) {
        send(res, 500, { error: e.message });
      }
    })
    .listen(port, '127.0.0.1');
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
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__lobby-serve', String(LOBBY_PORT)], {
    detached: true,
    stdio: ['ignore', out, out]
  });
  child.unref();
  fs.writeFileSync(LOBBY_FILE, JSON.stringify({ pid: child.pid, port: LOBBY_PORT }));
  console.log(`Edificio en http://127.0.0.1:${LOBBY_PORT}`);
}

/* ---------- main ---------- */
const [cmd, ...args] = process.argv.slice(2);
const BOOL_FLAGS = new Set(['despedir', 'yes']);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--all') pos.push(a);
  else if (BOOL_FLAGS.has(a.slice(2))) flags[a.slice(2)] = true;
  else if (a.startsWith('--')) flags[a.slice(2)] = args[i + 1] === undefined || args[i + 1].startsWith('--') ? true : args[++i];
  else pos.push(a);
}

switch (cmd) {
  case 'ls':
  case 'status':
  case undefined:
    ls();
    break;
  case 'create':
    await create(pos[0], flags);
    break;
  case 'start':
    for (const o of targets(pos)) await start(o);
    break;
  case 'stop':
    for (const o of targets(pos)) await stop(o, !!flags.despedir, typeof flags.via === 'string' ? flags.via : undefined);
    break;
  case 'rm':
    await rm(mustLoad(pos[0]), !!flags.yes);
    break;
  case 'restart':
    for (const o of targets(pos)) {
      await stop(o, false, 'office restart');
      await start(o);
    }
    break;
  case 'logs': {
    const o = mustLoad(pos[0]);
    if (args.includes('-f')) spawn('tail', ['-n', '40', '-f', o.log], { stdio: 'inherit' });
    else console.log(fs.existsSync(o.log) ? fs.readFileSync(o.log, 'utf8').split('\n').slice(-60).join('\n') : 'Sin log todavía.');
    break;
  }
  case 'open': {
    const o = mustLoad(pos[0]);
    spawn('open', [`http://127.0.0.1:${o.port}`], { stdio: 'ignore', detached: true }).unref();
    break;
  }
  case 'ctl': {
    const o = mustLoad(args[0]);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'daemon', 'ctl.mjs'), ...args.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, OFFICE_PORT: String(o.port) }
    });
    process.exitCode = r.status ?? 1;
    break;
  }
  case 'lobby':
    await lobby(pos[0]);
    break;
  case '__lobby-serve':
    lobbyServe(Number(pos[0]) || LOBBY_PORT);
    break;
  default:
    console.log(
      fs
        .readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(1, 17)
        .map(l => l.replace(/^\/\/ ?/, ''))
        .join('\n')
    );
}
