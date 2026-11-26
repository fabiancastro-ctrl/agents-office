// Oficina de Agentes · «Cuaderno»: la memoria compartida de la oficina.
// Una carpeta de Markdown por oficina (<datos>/memoria/): notas/ aprobadas, propuestas/ a la espera de Fabian, INDICE.md y
// lecturas.json (cuántas veces se leyó cada nota). Este módulo es solo lógica de archivos y texto: no conoce robots, HTTP ni
// la página (eso es de cuaderno.mjs), así que se prueba sin levantar nada. Todas las funciones aceptan la carpeta como parámetro.
import fs from 'node:fs';
import path from 'node:path';
import { RUNS, saveJson } from './base.mjs';

const MEMORIA_DIR = path.join(RUNS, 'memoria');
const REVIEW_MONTHS = 3; // default `revisar:` = creada + 3 months (decision of 2026-11-24)
const MAX_BODY = 2000; // one fact per note: short on purpose
const MAX_RESULTS = 8;

const FIELDS = ['titulo', 'tema', 'alcance', 'autor', 'creada', 'revisar'];

// Lowercase, no accents: the base of every comparison (search, duplicates).
const norm = s =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const STOP = new Set(
  'de la el los las un una y o en a que se con por para del al es lo su sus como mas no si ya the of and to in for on with'.split(' ')
);
const words = s =>
  norm(s)
    .split(/[^a-z0-9ñ]+/)
    .filter(w => w.length >= 3 && !STOP.has(w));

const pad = n => String(n).padStart(2, '0');
// Local calendar day (YYYY-MM-DD): `revisar` is a date, not an instant.
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// creada + n months, clamping the day (Nov 30 + 3 months = Feb 28).
function addMonths(day, n = REVIEW_MONTHS) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(y, m - 1 + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return localDay(new Date(t.getFullYear(), t.getMonth(), Math.min(d, last)));
}

const ALCANCE_RE = /^(oficina|sala:[\w-]+|repo:[\w.-]+)$/;

/* ---------- format ---------- */

// «---\nclave: valor\n---\ncuerpo». A trailing « # comment» on a value is dropped (the plan's example has them).
function parseNote(text) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  let body = raw;
  if (m) {
    body = m[2];
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([a-z]+):\s*(.*)$/);
      if (kv && FIELDS.includes(kv[1])) meta[kv[1]] = kv[2].replace(/\s+#(\s.*)?$/, '').trim();
    }
  }
  return { meta, body: body.trim() };
}

function serializeNote(meta, body) {
  const head = FIELDS.filter(k => meta[k]).map(k => `${k}: ${String(meta[k]).replace(/\s+/g, ' ').trim()}`);
  return `---\n${head.join('\n')}\n---\n${String(body).trim()}\n`;
}

// Fills the gaps of a note (creation day, review day) and checks what must be right. Returns { meta, body } or throws.
function normalizeNote(text, { autor, today = localDay() } = {}) {
  const { meta, body } = parseNote(text);
  if (!meta.titulo) throw new Error('Falta «titulo:» en la nota.');
  if (!body) throw new Error('La nota no tiene texto.');
  if (body.length > MAX_BODY)
    throw new Error(`La nota es muy larga (${body.length} caracteres; máximo ${MAX_BODY}). Una nota, un solo hecho.`);
  meta.alcance = (meta.alcance || 'oficina').trim();
  if (!ALCANCE_RE.test(meta.alcance)) throw new Error('«alcance:» debe ser «oficina», «sala:<id>» o «repo:<nombre>».');
  meta.autor ||= autor || 'Fabian';
  if (meta.creada && !DAY_RE.test(meta.creada)) throw new Error('«creada:» debe ser una fecha AAAA-MM-DD.');
  meta.creada ||= today;
  if (meta.revisar && !DAY_RE.test(meta.revisar)) throw new Error('«revisar:» debe ser una fecha AAAA-MM-DD.');
  meta.revisar ||= addMonths(meta.creada);
  meta.tema ||= '';
  return { meta, body };
}

// The note a robot proposes from separate fields (what `office memoria proponer` sends).
function buildNote({ titulo, tema, alcance, autor, hecho, porque, cuando }, today = localDay()) {
  const lines = [String(hecho ?? '').trim()];
  if (porque) lines.push(`**Por qué:** ${String(porque).trim()}`);
  if (cuando) lines.push(`**Cuándo aplica:** ${String(cuando).trim()}`);
  return normalizeNote(serializeNote({ titulo, tema, alcance: alcance || 'oficina', autor, creada: today }, lines.join('\n')), { today });
}

/* ---------- what a note must never contain ---------- */

// Credentials, customer-looking contact data and private URLs. Conservative and simple on purpose: a false positive
// costs the robot one rephrase; a false negative puts a secret in everyone's prompt.
const SECRET_RES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'una llave privada'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, 'una API key'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, 'un token de GitHub'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'una llave de AWS'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'una API key de Google'],
  [/\bxox[abprs]-[0-9A-Za-z-]{10,}/, 'un token de Slack'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, 'un JWT'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i, 'un token Bearer'],
  // «password: abc12345»: the value must look like a secret (8+ characters with a digit), not «token: expira».
  [
    /\b(?:password|passwd|pwd|contrase[nñ]a|clave|secret|secreto|token|api[_-]?key|apikey)\b["']?\s*[:=]\s*["']?(?=[^\s"']*\d)[^\s"']{8,}/i,
    'una contraseña o un token'
  ]
];
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
// Public hosts a note may link to. Anything else with a scheme is rejected (gitea, nexus, internal tools are private).
const PUBLIC_HOSTS = [
  'github.com',
  'githubusercontent.com',
  'anthropic.com',
  'claude.com',
  'mozilla.org',
  'nodejs.org',
  'npmjs.com',
  'wikipedia.org',
  'stackoverflow.com',
  'go.dev',
  'golang.org'
];
const publicHost = h => PUBLIC_HOSTS.some(p => h === p || h.endsWith(`.${p}`));
const PRIVATE_BARE_RE =
  /\b[\w.-]+\.(?:dropi\.co|moimolcp\.com|internal|local|corp)\b|\blocalhost\b|\b127\.0\.0\.1\b|\b(?:10\.\d+|192\.168)\.\d+\.\d+\b/i;

// Reasons (in Spanish, shown to the robot) why this text cannot enter the notebook. [] = clean.
function forbidden(text) {
  const t = String(text ?? '');
  const why = [];
  for (const [re, what] of SECRET_RES) if (re.test(t)) why.push(`trae ${what}`);
  if (EMAIL_RE.test(t)) why.push('trae un correo');
  for (const m of t.matchAll(/https?:\/\/([^\s/:?#)>\]"']+)/gi))
    if (!publicHost(m[1].toLowerCase())) {
      why.push(`trae una URL no pública (${m[1]})`);
      break;
    }
  if (!why.some(w => w.startsWith('trae una URL')) && PRIVATE_BARE_RE.test(t)) why.push('trae una dirección privada');
  return [...new Set(why)];
}

/* ---------- store ---------- */

const notesDir = (dir = MEMORIA_DIR) => path.join(dir, 'notas');
const proposalsDir = (dir = MEMORIA_DIR) => path.join(dir, 'propuestas');
const readsFile = (dir = MEMORIA_DIR) => path.join(dir, 'lecturas.json');

const slug = s =>
  norm(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '') || 'nota';

function uniqueId(folder, base) {
  let id = base,
    n = 2;
  while (fs.existsSync(path.join(folder, `${id}.md`))) id = `${base}-${n++}`;
  return id;
}

function readEntries(folder, today) {
  let files = [];
  try {
    files = fs.readdirSync(folder).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    const id = f.slice(0, -3);
    let text;
    try {
      text = fs.readFileSync(path.join(folder, f), 'utf8');
    } catch {
      continue;
    }
    const { meta, body } = parseNote(text);
    // A hand-written note may miss fields: the title falls back to the file name and the review day to creada + 3 months.
    const revisar = DAY_RE.test(meta.revisar || '') ? meta.revisar : DAY_RE.test(meta.creada || '') ? addMonths(meta.creada) : '';
    out.push({
      id,
      titulo: meta.titulo || id.replace(/-/g, ' '),
      tema: meta.tema || '',
      alcance: meta.alcance || 'oficina',
      autor: meta.autor || '',
      creada: meta.creada || '',
      revisar,
      vencida: !!revisar && revisar < today,
      cuerpo: body
    });
  }
  return out;
}
const listNotes = (dir = MEMORIA_DIR, today = localDay()) => readEntries(notesDir(dir), today);
const listProposals = (dir = MEMORIA_DIR, today = localDay()) => readEntries(proposalsDir(dir), today);
const readNoteText = (folder, id) => {
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    return fs.readFileSync(path.join(folder, `${id}.md`), 'utf8');
  } catch {
    return null;
  }
};

// One line per approved note: title — tema — file.
const indexText = notes =>
  `# Índice del cuaderno\n\nGenerado por la oficina; no se edita a mano. Una línea por nota aprobada: título — tema — archivo.\n\n${notes
    .map(n => `- ${n.titulo} — ${n.tema || 'sin tema'} — notas/${n.id}.md`)
    .join('\n')}${notes.length ? '\n' : ''}`;
function writeIndex(dir = MEMORIA_DIR) {
  if (!fs.existsSync(notesDir(dir))) return;
  const file = path.join(dir, 'INDICE.md');
  const text = indexText(listNotes(dir));
  try {
    if (fs.readFileSync(file, 'utf8') === text) return;
  } catch {
    /* no existía */
  }
  fs.writeFileSync(file, text);
}

// Notes that look like the candidate: at least two shared words (or all of the shorter one) in title + tema, and half of the shorter side.
function similar(notes, candidate) {
  const a = new Set(words(`${candidate.titulo} ${candidate.tema}`));
  if (!a.size) return [];
  const out = [];
  for (const n of notes) {
    const b = new Set(words(`${n.titulo} ${n.tema}`));
    const shared = [...a].filter(w => b.has(w)).length;
    const small = Math.min(a.size, b.size);
    if (small && shared >= Math.min(2, small) && shared / small >= 0.5) out.push({ id: n.id, titulo: n.titulo, shared });
  }
  return out.sort((x, y) => y.shared - x.shared).map(({ id, titulo }) => ({ id, titulo }));
}

// Word search over title, tema and body (no case, no accents). With several words, at least half must appear; title and
// tema weigh double. Best first, at most MAX_RESULTS.
function search(notes, q, limit = MAX_RESULTS) {
  const qs = [...new Set(words(q))];
  if (!qs.length) return [];
  const need = Math.ceil(qs.length / 2);
  const scored = [];
  for (const n of notes) {
    const head = norm(`${n.titulo} ${n.tema}`),
      body = norm(n.cuerpo);
    let score = 0,
      hits = 0;
    for (const w of qs) {
      const inHead = head.includes(w),
        inBody = body.includes(w);
      if (inHead || inBody) hits++;
      score += (inHead ? 2 : 0) + (inBody ? 1 : 0);
    }
    if (hits >= need) scored.push({ n, score });
  }
  return scored
    .sort((x, y) => y.score - x.score || x.n.titulo.localeCompare(y.n.titulo))
    .slice(0, limit)
    .map(s => s.n);
}

/* ---------- reads (cheap groundwork for «which notes does nobody read») ---------- */

// lecturas.json: { notas: { id: times }, robots: { name: { since, ids: [id…] } } }. `since` is the robot's startedAt, so a
// new robot with a recycled name starts from zero.
// view() asks for this on every robot update, so the parsed file is cached by its mtime and size.
const readsCache = new Map();
function readReads(dir = MEMORIA_DIR) {
  const file = readsFile(dir);
  try {
    const s = fs.statSync(file);
    const key = `${s.mtimeMs}:${s.size}`;
    const hit = readsCache.get(file);
    if (hit?.key === key) return hit.value;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = { notas: j.notas || {}, ultima: j.ultima || {}, robots: j.robots || {} };
    readsCache.set(file, { key, value });
    return value;
  } catch {
    return { notas: {}, ultima: {}, robots: {} };
  }
}
function recordReads(ids, robot, since, dir = MEMORIA_DIR, today = localDay()) {
  if (!ids.length) return 0;
  const j = structuredClone(readReads(dir)); // never mutate the cached copy
  for (const id of ids) {
    j.notas[id] = (j.notas[id] || 0) + 1;
    j.ultima[id] = today; // last read day (lecturas.json written before this field existed simply has none)
  }
  let n = 0;
  if (robot) {
    const r = j.robots[robot]?.since === since ? j.robots[robot] : (j.robots[robot] = { since, ids: [] });
    r.ids = [...new Set([...r.ids, ...ids])];
    n = r.ids.length;
  }
  fs.mkdirSync(dir, { recursive: true });
  saveJson(readsFile(dir), j);
  return n;
}
// How many distinct notes this robot read since it started.
const robotReads = (robot, since, dir = MEMORIA_DIR) => {
  const r = readReads(dir).robots[robot];
  return r && r.since === since ? r.ids.length : 0;
};

const STALE_READ_DAYS = 60; // a note nobody read for this long is a candidate to archive
const PROPOSAL_DAYS = 30; // a proposal waiting this long is surfaced in the health report
const dayNumber = day => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400e3);
// Whole days between two YYYY-MM-DD days (null when either is not a day).
const daysBetween = (from, to) => (DAY_RE.test(from || '') && DAY_RE.test(to || '') ? dayNumber(to) - dayNumber(from) : null);
// Days since the note was last read; without a read date it counts from its creation. null = unknown.
const daysUnread = (note, lastRead, today = localDay()) => daysBetween(lastRead || note.creada, today);
// True when the note has gone `limit` days or more without being read.
const isUnread = (note, lastRead, today = localDay(), limit = STALE_READ_DAYS) => {
  const d = daysUnread(note, lastRead, today);
  return d !== null && d >= limit;
};

// Health of the notebook folder, from the raw files: notes that do not parse, notes missing fields, INDICE.md out of sync
// and proposals waiting too long. Read-only; the caller decides what to fix.
function healthReport(dir = MEMORIA_DIR, today = localDay()) {
  const out = { notes: 0, proposals: 0, unparseable: [], incomplete: [], indexStale: false, oldProposals: [] };
  const scan = (folder, kind) => {
    let files = [];
    try {
      files = fs.readdirSync(folder).filter(f => f.endsWith('.md'));
    } catch {
      return;
    }
    for (const f of files.sort()) {
      const id = f.slice(0, -3);
      let text;
      try {
        text = fs.readFileSync(path.join(folder, f), 'utf8');
      } catch {
        out.unparseable.push(`${kind}/${id}`);
        continue;
      }
      kind === 'notas' ? out.notes++ : out.proposals++;
      const { meta, body } = parseNote(text);
      if (!/^---\n[\s\S]*?\n---/.test(text.replace(/\r\n/g, '\n')) || !Object.keys(meta).length || !body) {
        out.unparseable.push(`${kind}/${id}`);
        continue;
      }
      const missing = ['titulo', 'creada', 'revisar'].filter(k => (k === 'titulo' ? !meta.titulo : !DAY_RE.test(meta[k] || '')));
      if (missing.length) out.incomplete.push({ id: `${kind}/${id}`, missing });
      if (kind === 'propuestas') {
        const age = daysBetween(meta.creada, today);
        if (age !== null && age >= PROPOSAL_DAYS) out.oldProposals.push({ id, days: age });
      }
    }
  };
  scan(notesDir(dir), 'notas');
  scan(proposalsDir(dir), 'propuestas');
  if (fs.existsSync(notesDir(dir))) {
    try {
      out.indexStale = fs.readFileSync(path.join(dir, 'INDICE.md'), 'utf8') !== indexText(listNotes(dir, today));
    } catch {
      out.indexStale = out.notes > 0;
    }
  }
  return out;
}

// Backup payload: every note and proposal as raw text, by id.
function exportAll(dir = MEMORIA_DIR) {
  const read = folder => {
    const o = {};
    try {
      for (const f of fs.readdirSync(folder).filter(x => x.endsWith('.md')))
        o[f.slice(0, -3)] = fs.readFileSync(path.join(folder, f), 'utf8');
    } catch {
      /* no folder */
    }
    return o;
  };
  return { notas: read(notesDir(dir)), propuestas: read(proposalsDir(dir)) };
}
// Restore ADDS: an id that already exists is kept as it is. Returns how many files were written.
function importAll(data, dir = MEMORIA_DIR) {
  let n = 0;
  for (const [kind, folder] of [
    ['notas', notesDir(dir)],
    ['propuestas', proposalsDir(dir)]
  ]) {
    for (const [id, text] of Object.entries(data?.[kind] || {})) {
      if (!/^[\w-]+$/.test(id) || typeof text !== 'string' || fs.existsSync(path.join(folder, `${id}.md`))) continue;
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `${id}.md`), text);
      n++;
    }
  }
  if (n) writeIndex(dir);
  return n;
}

/* ---------- mutations ---------- */

// A robot proposes a note. Throws { motivos } when it carries something forbidden. Returns { id, parecidas }.
function propose(fields, { dir = MEMORIA_DIR, today = localDay() } = {}) {
  const { meta, body } = buildNote(fields, today);
  const motivos = forbidden(serializeNote(meta, body));
  if (motivos.length) throw Object.assign(new Error(`La nota ${motivos.join(' y ')}.`), { motivos });
  fs.mkdirSync(proposalsDir(dir), { recursive: true });
  const id = uniqueId(proposalsDir(dir), slug(meta.titulo));
  fs.writeFileSync(path.join(proposalsDir(dir), `${id}.md`), serializeNote(meta, body));
  const parecidas = similar([...listNotes(dir, today), ...listProposals(dir, today).filter(p => p.id !== id)], meta);
  return { id, parecidas };
}

// Validates a whole note text typed by a person (edit before approving, edit of an approved note).
function checkText(text, { autor, today = localDay() } = {}) {
  const { meta, body } = normalizeNote(text, { autor, today });
  const motivos = forbidden(serializeNote(meta, body));
  if (motivos.length) throw Object.assign(new Error(`La nota ${motivos.join(' y ')}.`), { motivos });
  return serializeNote(meta, body);
}

// Moves a proposal to notas/ (optionally with the edited text). Fabian's approval: it enters INDICE.md.
function approve(id, text, { dir = MEMORIA_DIR, today = localDay() } = {}) {
  const orig = readNoteText(proposalsDir(dir), id);
  if (orig == null) throw Object.assign(new Error('Esa propuesta ya no está.'), { status: 404 });
  const final = checkText(text ?? orig, { today });
  fs.mkdirSync(notesDir(dir), { recursive: true });
  const nid = uniqueId(notesDir(dir), id);
  fs.writeFileSync(path.join(notesDir(dir), `${nid}.md`), final);
  fs.rmSync(path.join(proposalsDir(dir), `${id}.md`));
  writeIndex(dir);
  return nid;
}

function editNote(id, text, { dir = MEMORIA_DIR, today = localDay() } = {}) {
  if (readNoteText(notesDir(dir), id) == null) throw Object.assign(new Error('Esa nota ya no está.'), { status: 404 });
  fs.writeFileSync(path.join(notesDir(dir), `${id}.md`), checkText(text, { today }));
  writeIndex(dir);
}

// New review day = today + 3 months, same text.
function renewNote(id, { dir = MEMORIA_DIR, today = localDay() } = {}) {
  const orig = readNoteText(notesDir(dir), id);
  if (orig == null) throw Object.assign(new Error('Esa nota ya no está.'), { status: 404 });
  const { meta, body } = parseNote(orig);
  editNote(id, serializeNote({ ...meta, revisar: addMonths(today) }, body), { dir, today });
}

const notePath = (kind, id, dir = MEMORIA_DIR) =>
  /^[\w-]+$/.test(id) && fs.existsSync(path.join(kind === 'nota' ? notesDir(dir) : proposalsDir(dir), `${id}.md`))
    ? path.join(kind === 'nota' ? notesDir(dir) : proposalsDir(dir), `${id}.md`)
    : null;

export {
  addMonths,
  approve,
  buildNote,
  checkText,
  daysUnread,
  editNote,
  exportAll,
  forbidden,
  healthReport,
  importAll,
  indexText,
  isUnread,
  PROPOSAL_DAYS,
  STALE_READ_DAYS,
  listNotes,
  listProposals,
  localDay,
  MEMORIA_DIR,
  norm,
  normalizeNote,
  notePath,
  parseNote,
  propose,
  readReads,
  recordReads,
  renewNote,
  robotReads,
  search,
  serializeNote,
  similar,
  writeIndex
};
