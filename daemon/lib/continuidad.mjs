// Oficina de Agentes · cuentas desde la oficina y continuidad cuando una cuenta se queda sin cuota.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
// - Cuentas: API para registrar, renombrar, quitar e iniciar sesión (ventana tmux _login-<id>).
// - Continuidad: un robot que choca con el límite pasa a otra cuenta (misma sesión, --resume), pregunta o espera.
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_BIN, now, robots, run, SESSION, WORKSPACE } from './base.mjs';
import { broadcast, configView, emit, limitPolicy } from './estado.mjs';
import { readConfig } from './carpeta.mjs';
import { log, setState } from './persistencia.mjs';
import { markLost, openResumed } from './consola.mjs';
import { setLimitHook } from './transcript.mjs';
import { ensureSession, launching, say } from './tmux.mjs';
import { claudeStatus } from './uso.mjs';
import { readBody, send } from './http.mjs';
import {
  accountName,
  accounts,
  accountTmuxEnv,
  activeAccount,
  authStatusAsync,
  clearExhausted,
  expandHome,
  ID_RE,
  linksOf,
  normAccount,
  pickAccount,
  PRINCIPAL,
  principalDir,
  quotaReadings,
  saveAccounts,
  setupAccountDir,
  weekUsed
} from './cuentas.mjs';
import { exhaustedIds, markExhausted, setActive, syncActive } from './limites.mjs';
import { parseLimit } from './limite-texto.mjs';

/* ---------- cuando una cuenta se queda sin cuota ---------- */
const CONTINUE_MSG = 'Se te acabó la cuota en la otra cuenta; sigue exactamente donde quedaste.';
const FRESH_MS = 15 * 60e3; // an old line (a reconnect that replays the transcript) is not news
const idOf = v =>
  String(v ?? '')
    .trim()
    .toLowerCase();
const keyOf = r => r.account || PRINCIPAL;
const labelOf = id => accountName(id) || 'Principal';

function onRateLimit(r, e) {
  if (r.restoring) return;
  const at = Date.parse(e.timestamp) || Date.now();
  if (Date.now() - at > FRESH_MS) return;
  const text =
    (e.message?.content || [])
      .map(c => c.text || '')
      .join(' ')
      .trim() || 'rate_limit';
  if (r.limit && r.limit.text === text) return; // the same notice twice
  const info = parseLimit(text, at);
  markExhausted(keyOf(r), { kind: info.kind, until: info.until, at: new Date(at).toISOString(), text });
  r.limit = { kind: info.kind, resetsText: info.resetsText, until: info.until, text, at: new Date(at).toISOString() };
  log(r, 'sys', `Sin cuota (${info.kind === 'week' ? 'límite semanal' : 'límite de 5 horas'}): ${text}`);
  r.lastEventAt = now();
  if (info.kind === 'week') syncActive();
  emit(r);
  decide(r).catch(err => {
    log(r, 'sys', `No pude pasarlo a otra cuenta: ${err.message}`);
    markLost(r);
  });
}
setLimitHook(onRateLimit);

// Another account with quota, never an exhausted one nor the robot's own.
const nextAccountFor = r =>
  pickAccount(quotaReadings(readConfig().quotaAcc), Date.now(), { skip: [...new Set([...exhaustedIds(), keyOf(r)])], strict: true });

async function decide(r) {
  const policy = limitPolicy();
  const next = policy === 'wait' ? null : nextAccountFor(r);
  if (policy === 'switch' && next) return switchTo(r, next.id);
  if (policy === 'ask' && next) {
    r.limit.pending = true;
    r.limit.options = [{ id: next.id || PRINCIPAL, nombre: labelOf(next.id) }];
    log(r, 'sys', `Te pregunta si sigue en ${labelOf(next.id)} o espera la renovación.`);
    setState(r, 'input');
    emit(r);
    return;
  }
  if (policy !== 'wait') log(r, 'sys', 'Ninguna otra cuenta tiene cuota: espera a la renovación.');
  wait(r);
}

function wait(r) {
  if (!r.limit) return;
  r.limit.waiting = true;
  r.limit.pending = false;
  r.limit.options = [];
  r.limit.checkedAt = Date.now();
  if (r.state !== 'done') setState(r, 'done');
  log(r, 'sys', `En espera: seguirá solo cuando se renueve la cuota${r.limit.resetsText ? ` (${r.limit.resetsText})` : ''}.`);
  emit(r);
}

// Reopens the SAME session on another account: closes the console and opens it again with --resume.
async function switchTo(r, id) {
  const text = r.limit?.text || '';
  const from = labelOf(r.account);
  const to = normAccount(id === PRINCIPAL ? '' : id);
  launching.add(r.name); // the console check must not take the gap for a fallen console
  try {
    await run('tmux', ['kill-window', '-t', `${SESSION}:${r.name}`]).catch(() => {});
    r.account = to;
    r.hold = null;
    r.ask = null;
    r.needsPermission = false;
    await openResumed(r, CONTINUE_MSG);
  } finally {
    launching.delete(r.name);
  }
  log(r, 'sys', `Pasó de ${from} a ${labelOf(to)} por límite (${text})`);
  r.limit = null;
  setState(r, 'working');
  emit(r);
}

// What the user chose on a robot that asked: follow on the other account or wait.
async function limitAction(r, body) {
  if (!r.limit) throw new Error('Ese robot no está sin cuota.');
  if (body.action === 'esperar') {
    wait(r);
    return;
  }
  if (body.action !== 'cambiar') throw new Error('Acción desconocida.');
  const id = idOf(body.account || r.limit.options?.[0]?.id);
  const to = id === PRINCIPAL ? '' : id;
  if (!accounts().some(a => a.id === (id || PRINCIPAL))) throw new Error('Esa cuenta no está registrada.');
  if ((to || PRINCIPAL) === keyOf(r)) throw new Error('Ya está en esa cuenta.');
  await switchTo(r, to || PRINCIPAL);
}

// Robots waiting for the renewal pick up on their own: «continúa». With a known reset it is that hour; without it,
// when a /usage reading shows the account back below its limit (the hourly reading, or one asked here every 20 min).
let refreshedAt = 0;
const resuming = new Set();
async function tick() {
  const waiting = [...robots.values()].filter(r => r.limit?.waiting && !r.consoleLost && !resuming.has(r.name));
  if (!waiting.length) return;
  if (waiting.some(r => !r.limit.until) && Date.now() - refreshedAt > 20 * 60e3) {
    refreshedAt = Date.now();
    claudeStatus(true).catch(() => {});
  }
  for (const r of waiting) {
    // An exhausted notice expires by itself at its reset; a /usage reading below 100 % removes it earlier.
    if (exhaustedIds().includes(keyOf(r))) continue;
    resuming.add(r.name);
    try {
      r.limit = null;
      log(r, 'sys', 'Se renovó la cuota: retoma solo.');
      setState(r, 'working');
      emit(r);
      await say(r, 'continúa');
    } catch (err) {
      log(r, 'sys', `No pude retomarlo: ${err.message}`);
    } finally {
      resuming.delete(r.name);
    }
  }
}
setInterval(() => {
  tick().catch(() => {});
}, Number(process.env.OFFICE_LIMIT_TICK_MS) || 30e3);

/* ---------- cuentas desde la oficina ---------- */
const loginWindow = id => `_login-${id}`;
const pendingLogin = new Set(); // ids whose login window the office opened
const authCache = new Map(); // id -> { at, value }
const AUTH_TTL = 20e3;
const tilde = p => p.replace(os.homedir(), '~');
const registered = () =>
  accounts()
    .filter(a => !a.principal)
    .map(({ id, nombre, dir }) => ({ id, nombre, dir }));

async function authOf(acc, fresh) {
  const c = authCache.get(acc.id);
  if (c && !fresh && Date.now() - c.at < AUTH_TTL) return c.value;
  const value = await authStatusAsync(acc);
  authCache.set(acc.id, { at: Date.now(), value });
  return value;
}
async function windows() {
  try {
    return new Set((await run('tmux', ['list-windows', '-t', SESSION, '-F', '#{window_name}'])).stdout.split('\n'));
  } catch {
    return new Set();
  }
}
// `claude auth login` in its own window: no office hooks, no API key. Claude opens the browser by itself.
async function openLogin(acc) {
  await ensureSession();
  const win = loginWindow(acc.id);
  await run('tmux', ['kill-window', '-t', `${SESSION}:${win}`]).catch(() => {});
  await run('tmux', [
    'new-window',
    '-d',
    '-t',
    `${SESSION}:`,
    '-n',
    win,
    '-c',
    WORKSPACE,
    ...accountTmuxEnv(acc.principal ? '' : acc.id),
    'env',
    '-u',
    'ANTHROPIC_API_KEY',
    ...(acc.principal ? ['-u', 'CLAUDE_CONFIG_DIR'] : []),
    CLAUDE_BIN,
    'auth',
    'login'
  ]);
  pendingLogin.add(acc.id);
  authCache.delete(acc.id);
}
async function accountRow(acc, open, fresh) {
  const q = quotaReadings(readConfig().quotaAcc)[acc.id];
  const ex = exhaustedIds().includes(acc.id);
  return {
    id: acc.id,
    nombre: acc.nombre,
    dir: tilde(acc.dir),
    principal: !!acc.principal,
    session: await authOf(acc, fresh),
    weekPct: weekUsed(q),
    weekEnd: q?.weekEnd || null,
    exhausted: ex,
    links: acc.principal ? null : linksOf(acc),
    login: open.has(loginWindow(acc.id))
  };
}
const cleanName = v =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
const changed = () => broadcast({ type: 'config', config: configView() });

async function cuentasApi(req, res, url, parts) {
  if (parts[0] !== 'api' || (parts[1] !== 'cuentas' && parts[1] !== 'cuenta-activa')) return false;
  const m = req.method;
  if (parts[1] === 'cuenta-activa') {
    if (m !== 'POST') return false;
    const id = idOf((await readBody(req)).id);
    if (id && id !== PRINCIPAL && !registered().some(a => a.id === id)) return send(res, 404, { error: 'Esa cuenta no está registrada.' });
    setActive(id === PRINCIPAL ? '' : id);
    return send(res, 200, { ok: true, active: activeAccount() || PRINCIPAL });
  }
  if (!parts[2]) {
    if (m === 'GET') {
      const open = await windows();
      const fresh = url.searchParams.get('fresh') === '1';
      const cuentas = await Promise.all(accounts().map(a => accountRow(a, open, fresh)));
      return send(res, 200, { cuentas, active: activeAccount() || PRINCIPAL, policy: limitPolicy() });
    }
    if (m === 'POST') {
      const b = await readBody(req);
      const id = idOf(b.id);
      if (!ID_RE.test(id) || ['principal', 'auto'].includes(id))
        return send(res, 400, { error: 'El id va en minúsculas, números y guiones (máx. 20); «principal» y «auto» están reservados.' });
      if (accounts().some(a => a.id === id)) return send(res, 409, { error: `Ya existe la cuenta «${id}».` });
      const dir = path.resolve(expandHome(b.dir) || path.join(os.homedir(), `.claude-${id}`));
      if (dir === principalDir()) return send(res, 400, { error: 'Esa es la carpeta de la cuenta principal; elige otra.' });
      const clash = accounts().find(a => a.dir === dir);
      if (clash) return send(res, 409, { error: `Esa carpeta ya es la cuenta «${clash.id}».` });
      const nombre = cleanName(b.nombre) || id;
      const actions = setupAccountDir(dir);
      saveAccounts([...registered(), { id, nombre, dir }]);
      const acc = accounts().find(a => a.id === id);
      let loginError = '';
      try {
        await openLogin(acc);
      } catch (e) {
        loginError = e.message;
      }
      changed();
      return send(res, 201, { ok: true, id, dir: tilde(dir), actions, loginError });
    }
    return false;
  }
  const acc = accounts().find(a => a.id === parts[2]);
  if (!acc) return send(res, 404, { error: 'Esa cuenta no está registrada.' });
  const action = parts[3] || '';
  if (m === 'GET' && action === 'sesion') {
    // Polled while the user authorizes in the browser; when the session shows up the login window goes away.
    const session = await authOf(acc, true);
    const open = await windows();
    if (session.loggedIn && open.has(loginWindow(acc.id))) {
      await run('tmux', ['kill-window', '-t', `${SESSION}:${loginWindow(acc.id)}`]).catch(() => {});
      pendingLogin.delete(acc.id);
      open.delete(loginWindow(acc.id));
    }
    return send(res, 200, { session, login: open.has(loginWindow(acc.id)) });
  }
  if (m === 'POST' && action === 'login') {
    await openLogin(acc);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && action === 'renombrar') {
    if (acc.principal) return send(res, 409, { error: 'La cuenta principal no se renombra.' });
    const nombre = cleanName((await readBody(req)).nombre);
    if (!nombre) return send(res, 400, { error: 'Escribe un nombre.' });
    saveAccounts(registered().map(a => (a.id === acc.id ? { ...a, nombre } : a)));
    changed();
    return send(res, 200, { ok: true, nombre });
  }
  if (m === 'DELETE' && !action) {
    if (acc.principal) return send(res, 409, { error: 'La cuenta principal no se puede quitar.' });
    const users = [...robots.values()].filter(r => r.account === acc.id).map(r => r.name);
    if (users.length) return send(res, 409, { error: `La usan ${users.join(', ')}: despídelos o espera a que terminen.` });
    saveAccounts(registered().filter(a => a.id !== acc.id)); // the folder is never touched
    clearExhausted(acc.id);
    authCache.delete(acc.id);
    changed();
    return send(res, 200, { ok: true });
  }
  return false;
}

export { cuentasApi, limitAction };
