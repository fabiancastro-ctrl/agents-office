// Oficina de Agentes · cuentas de Claude registradas.
// Sin dependencias del daemon: lo usan el daemon (para lanzar cada robot con su cuenta) y bin/office.mjs
// (`office cuenta add|ls|rm`). Una cuenta es una carpeta de configuración de Claude Code (CLAUDE_CONFIG_DIR);
// la principal es la de siempre (~/.claude) y está implícita. El registro vive en el edificio, así que lo comparten
// todas las oficinas: <AGENT_OFFICE_HOME>/cuentas.json.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.resolve(process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), '.agent-office'));
const FILE = path.join(HOME, 'cuentas.json');
const PRINCIPAL = 'principal';
const AUTO = 'auto';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;

const expandHome = p =>
  String(p || '')
    .trim()
    .replace(/^~(?=$|\/)/, os.homedir());
// Carpeta de la cuenta principal. OFFICE_PRINCIPAL_DIR existe para las pruebas y para quien la tenga en otro sitio.
const principalDir = () => path.resolve(expandHome(process.env.OFFICE_PRINCIPAL_DIR || path.join(os.homedir(), '.claude')));

// What every account shares with the principal one (symlinks into the principal folder). The first group is always
// linked; the second only when the principal folder has it.
const SHARED_ALWAYS = ['settings.json', 'skills', 'agents', 'projects'];
const SHARED_IF_PRESENT = ['CLAUDE.md', 'commands', 'plugins'];
const SHARED_DIRS = new Set(['skills', 'agents', 'projects']);

/* ---------- registry ---------- */
let cache = { sig: null, list: [] };
function readFile() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.cuentas) ? raw.cuentas : [];
  const seen = new Set([PRINCIPAL]);
  const out = [];
  for (const x of items) {
    const id = String(x?.id ?? '')
      .trim()
      .toLowerCase();
    if (!ID_RE.test(id) || seen.has(id) || !x?.dir) continue;
    seen.add(id);
    out.push({ id, nombre: String(x.nombre || id).slice(0, 40), dir: path.resolve(expandHome(x.dir)) });
  }
  return out;
}
// Registered accounts, principal first. The file is re-read whenever it changes (mtime + size), so a running daemon
// notices `office cuenta add|rm` without restarting.
function accounts() {
  let sig = 'none';
  try {
    const st = fs.statSync(FILE);
    sig = `${st.mtimeMs}:${st.size}`;
  } catch {
    /* no registry yet */
  }
  if (sig !== cache.sig) cache = { sig, list: readFile() };
  return [{ id: PRINCIPAL, nombre: 'Principal', dir: principalDir(), principal: true }, ...cache.list];
}
function saveAccounts(list) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
  cache = { sig: null, list: [] };
}
const hasMany = () => accounts().length > 1;
const idOf = v =>
  String(v ?? '')
    .trim()
    .toLowerCase();
// Account of a robot: '' = principal; an id that is not registered is dropped (back to the principal).
const normAccount = v => {
  const id = idOf(v);
  return id && id !== PRINCIPAL && accounts().some(a => a.id === id) ? id : '';
};
// What the user can choose: normAccount plus 'auto' (resolved at launch by the quota).
const normAccountPick = v => (idOf(v) === AUTO && hasMany() ? AUTO : normAccount(v));
const accountOf = id => accounts().find(a => a.id === (normAccount(id) || PRINCIPAL));
// What a form or a request can carry until launch: like normAccountPick, but an explicit "principal" survives (it is
// not the same as «Por defecto», which follows the active account). '' means «Por defecto».
const normAccountInput = v => (idOf(v) === PRINCIPAL ? PRINCIPAL : normAccountPick(v));
// For a child or an item that may carry its own choice: an explicit "principal" stays principal; an empty or unknown one inherits `fallback`.
const inheritAccount = (v, fallback = '') => (idOf(v) === PRINCIPAL ? PRINCIPAL : normAccountPick(v) || fallback || '');
const accountName = id => accountOf(id)?.nombre || '';
// Weekly % used of one saved reading ({ weekPct, weekPctAt, weekEnd } from config.quotaAcc), or null when never read.
// A reading taken before the last renewal of the week no longer counts: the quota is back to 0.
function weekUsed(q, t = Date.now()) {
  const at = Number(q?.weekPctAt) || 0;
  if (!Number.isFinite(q?.weekPct) || !at) return null;
  let end = Number(q.weekEnd) || 0;
  if (end) {
    while (end <= t) end += 7 * 86400e3;
    if (at < end - 7 * 86400e3) return 0;
  }
  return q.weekPct;
}
// «Automática» never picks an account above this weekly % while another one is below it.
const AUTO_MAX_PCT = 95;
// The account with the most free weekly quota according to the last readings: { id ('' = principal), used } or null.
// Ties go to the first registered, the principal. `skip` = account ids to leave out (exhausted, the current one).
// Accounts above AUTO_MAX_PCT only win when nothing else is left, unless `strict` (then an account never read counts
// as available and "nothing" is null).
function pickAccount(readings, t = Date.now(), { skip = [], strict = false } = {}) {
  const cands = accounts()
    .filter(a => !skip.includes(a.id))
    .map(a => ({ id: a.principal ? '' : a.id, used: weekUsed(readings?.[a.id], t) }));
  const least = list => list.reduce((b, c) => (!b || c.used < b.used ? c : b), null);
  const known = cands.filter(c => c.used !== null);
  const under = least(known.filter(c => c.used < AUTO_MAX_PCT));
  if (under) return under;
  if (strict) return cands.find(c => c.used === null) || null;
  return least(known);
}
// «Automática»: pickAccount, or '' (principal) when there is nothing to go by.
const autoAccount = (readings, t = Date.now(), opts) => pickAccount(readings, t, opts)?.id ?? '';

/* ---------- active account and exhausted accounts (shared by every office of the building) ---------- */
// <AGENT_OFFICE_HOME>/cuenta-activa.json: { id, principalOut, principalEnd, exhausted: { <account id|'principal'>: { kind, until, at, text } } }.
// «Active» = the account that launches with «Por defecto» use. Exhausted = out of quota until `until` (ms) or, when
// unknown, until the next /usage reading shows it below 100 %.
const ACTIVE_FILE = path.join(HOME, 'cuenta-activa.json');
function readActive() {
  try {
    const j = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}
function writeActive(patch) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${ACTIVE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...readActive(), ...patch }, null, 2) + '\n');
  fs.renameSync(tmp, ACTIVE_FILE);
}
// '' = principal. A removed account falls back to the principal.
function activeAccount() {
  const id = idOf(readActive().id);
  return id && id !== PRINCIPAL && accounts().some(a => a.id === id) ? id : '';
}
function exhaustedMap(t = Date.now()) {
  const out = {};
  for (const [k, v] of Object.entries(readActive().exhausted || {})) if (!v.until || v.until > t) out[k] = v;
  return out;
}
const isExhausted = (key, t = Date.now()) => !!exhaustedMap(t)[key || PRINCIPAL];
function markExhausted(key, info) {
  writeActive({ exhausted: { ...(readActive().exhausted || {}), [key || PRINCIPAL]: info } });
}
function clearExhausted(key, kind) {
  const ex = { ...(readActive().exhausted || {}) };
  const k = key || PRINCIPAL;
  if (!ex[k] || (kind && ex[k].kind !== kind)) return false;
  delete ex[k];
  writeActive({ exhausted: ex });
  return true;
}
/* ---------- quota readings (shared by every office of the building) ---------- */
// <AGENT_OFFICE_HOME>/cuota.json: { <account id|'principal'>: { sessionEnd, weekEnd, weekPct, weekPctAt, history } }.
// The same shape as config.quotaAcc[id]; whichever office reads /usage for an account writes it here, so every office
// sees the quota of the account in use.
const QUOTA_FILE = path.join(HOME, 'cuota.json');
const HISTORY_WEEKS = 16;
function readQuotaFile() {
  try {
    const j = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {}; // missing or corrupt: treated as empty
  }
}
// Modification time of cuota.json (0 when absent): what the daemon polls to follow another office's readings.
function quotaFileStamp() {
  try {
    return fs.statSync(QUOTA_FILE).mtimeMs;
  } catch {
    return 0;
  }
}
// Max per week key, last HISTORY_WEEKS weeks.
function mergeHistory(a, b) {
  const h = {};
  for (const src of [a, b])
    for (const [k, v] of Object.entries(src && typeof src === 'object' ? src : {})) if (Number.isFinite(v)) h[k] = Math.max(h[k] ?? 0, v);
  return Object.fromEntries(Object.entries(h).sort().slice(-HISTORY_WEEKS));
}
// Two readings of one account: the newer weekPctAt wins (the newer sessionEnd when neither has one); histories merge.
function mergeReading(a, b) {
  const ok = r => r && typeof r === 'object';
  if (!ok(a) && !ok(b)) return undefined;
  if (!ok(a)) a = {};
  if (!ok(b)) b = {};
  const at = r => Number(r.weekPctAt) || 0;
  const se = r => Number(r.sessionEnd) || 0;
  const bNewer = at(a) || at(b) ? at(b) >= at(a) : se(b) >= se(a);
  const out = { ...(bNewer ? { ...a, ...b } : { ...b, ...a }) };
  const history = mergeHistory(a.history, b.history);
  if (Object.keys(history).length) out.history = history;
  return out;
}
function mergeReadings(a = {}, b = {}) {
  const out = {};
  for (const id of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) out[id] = mergeReading(a?.[id], b?.[id]);
  return out;
}
// Per-account readings: the global file merged with this office's own (config.quotaAcc), newest reading wins.
const quotaReadings = (local = {}) => mergeReadings(readQuotaFile(), local);
function saveQuotaReading(id, q) {
  fs.mkdirSync(HOME, { recursive: true });
  const all = readQuotaFile();
  all[id || PRINCIPAL] = mergeReading(all[id || PRINCIPAL], q);
  const tmp = `${QUOTA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  fs.renameSync(tmp, QUOTA_FILE);
}
// Extra tmux args that point a robot at its account folder. The principal runs exactly as before (no variable).
const accountTmuxEnv = id => {
  const a = normAccount(id) ? accountOf(id) : null;
  return a ? ['-e', `CLAUDE_CONFIG_DIR=${a.dir}`] : [];
};
// The .claude.json that holds the trust of folders: ~/.claude.json for the principal, <dir>/.claude.json for the rest.
const claudeJsonOf = id => {
  const a = normAccount(id) ? accountOf(id) : null;
  return a ? path.join(a.dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
};

/* ---------- links ---------- */
// What an account folder should link to, given the principal folder: [{ name, target }].
function expectedLinks(pdir) {
  const items = [...SHARED_ALWAYS];
  for (const n of SHARED_IF_PRESENT) if (fs.existsSync(path.join(pdir, n))) items.push(n);
  return items.map(name => ({ name, target: path.join(pdir, name) }));
}
function linkState(dest, target) {
  let st;
  try {
    st = fs.lstatSync(dest);
  } catch {
    return 'missing';
  }
  if (!st.isSymbolicLink()) return 'real';
  try {
    return path.resolve(path.dirname(dest), fs.readlinkSync(dest)) === path.resolve(target) ? 'ok' : 'wrong';
  } catch {
    return 'wrong';
  }
}
// Never deletes: whatever sits where a link should go is renamed to <name>.antes-oficina (numbered if that exists).
function moveAside(dest) {
  let to = `${dest}.antes-oficina`;
  for (let i = 2; fs.existsSync(to) || isLink(to); i++) to = `${dest}.antes-oficina-${i}`;
  fs.renameSync(dest, to);
  return to;
}
const isLink = p => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
// Creates the account folder if needed and links what it shares. Idempotent. Returns what it did per item.
function setupAccountDir(dir, pdir = principalDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const actions = [];
  for (const { name, target } of expectedLinks(pdir)) {
    // Shared folders must exist on the principal side or the link would dangle; settings.json is never invented.
    if (SHARED_DIRS.has(name)) fs.mkdirSync(target, { recursive: true });
    else if (!fs.existsSync(target)) {
      actions.push({ name, did: 'sin origen' });
      continue;
    }
    const dest = path.join(dir, name);
    const state = linkState(dest, target);
    if (state === 'ok') {
      actions.push({ name, did: 'ya estaba' });
      continue;
    }
    let moved = null;
    if (state === 'real' || state === 'wrong') moved = moveAside(dest);
    fs.symlinkSync(target, dest);
    actions.push({ name, did: 'enlazado', moved: moved ? path.basename(moved) : null });
  }
  return actions;
}
// Link health of a registered account: { ok: [...], missing: [...] }.
function linksOf(acc, pdir = principalDir()) {
  const ok = [],
    missing = [];
  for (const { name, target } of expectedLinks(pdir)) (linkState(path.join(acc.dir, name), target) === 'ok' ? ok : missing).push(name);
  return { ok, missing };
}

/* ---------- login state (no quota spent) ---------- */
// `claude auth status` prints JSON and never calls the model. Without ANTHROPIC_API_KEY, because with it set Claude
// reports the API key instead of the subscription.
const authEnv = acc => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CONFIG_DIR;
  if (!acc.principal) env.CLAUDE_CONFIG_DIR = acc.dir;
  return env;
};
const authFields = j => ({
  loggedIn: !!j.loggedIn,
  authMethod: j.authMethod || '',
  orgName: j.orgName || '',
  subscriptionType: j.subscriptionType || ''
});
// Same as authStatus without blocking the daemon (the office calls it while serving the page).
function authStatusAsync(acc, bin = process.env.OFFICE_CLAUDE_BIN || 'claude') {
  return new Promise(resolve => {
    execFile(bin, ['auth', 'status'], { env: authEnv(acc), encoding: 'utf8', timeout: 20000 }, (err, stdout) => {
      try {
        resolve(authFields(JSON.parse(String(stdout || ''))));
      } catch {
        resolve({ loggedIn: false, error: 'no se pudo consultar' });
      }
    });
  });
}
function authStatus(acc, bin = process.env.OFFICE_CLAUDE_BIN || 'claude') {
  const env = authEnv(acc);
  try {
    const out = execFileSync(bin, ['auth', 'status'], { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out);
    return { loggedIn: !!j.loggedIn, authMethod: j.authMethod || '', orgName: j.orgName || '', subscriptionType: j.subscriptionType || '' };
  } catch (e) {
    // `auth status` exits non-zero when nobody is logged in but still prints the JSON.
    try {
      const j = JSON.parse(String(e.stdout || ''));
      return {
        loggedIn: !!j.loggedIn,
        authMethod: j.authMethod || '',
        orgName: j.orgName || '',
        subscriptionType: j.subscriptionType || ''
      };
    } catch {
      return { loggedIn: false, error: 'no se pudo consultar' };
    }
  }
}

export {
  accountName,
  activeAccount,
  AUTO_MAX_PCT,
  authStatusAsync,
  clearExhausted,
  exhaustedMap,
  isExhausted,
  markExhausted,
  normAccountInput,
  pickAccount,
  quotaFileStamp,
  quotaReadings,
  readActive,
  saveQuotaReading,
  writeActive,
  accountOf,
  accounts,
  accountTmuxEnv,
  AUTO,
  authStatus,
  autoAccount,
  claudeJsonOf,
  expandHome,
  FILE,
  hasMany,
  inheritAccount,
  ID_RE,
  linksOf,
  normAccount,
  normAccountPick,
  PRINCIPAL,
  principalDir,
  saveAccounts,
  setupAccountDir,
  weekUsed
};
