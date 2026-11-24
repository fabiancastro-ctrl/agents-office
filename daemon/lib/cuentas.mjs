// Oficina de Agentes · cuentas de Claude registradas.
// Sin dependencias del daemon: lo usan el daemon (para lanzar cada robot con su cuenta) y bin/office.mjs
// (`office cuenta add|ls|rm`). Una cuenta es una carpeta de configuración de Claude Code (CLAUDE_CONFIG_DIR);
// la principal es la de siempre (~/.claude) y está implícita. El registro vive en el edificio, así que lo comparten
// todas las oficinas: <AGENT_OFFICE_HOME>/cuentas.json.
import { execFileSync } from 'node:child_process';
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
const accountName = id => accountOf(id)?.nombre || '';
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
function authStatus(acc, bin = process.env.OFFICE_CLAUDE_BIN || 'claude') {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CONFIG_DIR;
  if (!acc.principal) env.CLAUDE_CONFIG_DIR = acc.dir;
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
  accountOf,
  accounts,
  accountTmuxEnv,
  AUTO,
  authStatus,
  claudeJsonOf,
  expandHome,
  FILE,
  hasMany,
  ID_RE,
  linksOf,
  normAccount,
  normAccountPick,
  PRINCIPAL,
  principalDir,
  saveAccounts,
  setupAccountDir
};
