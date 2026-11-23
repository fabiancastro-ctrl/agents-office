import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNS, run, WORKSPACE } from './base.mjs';

/* ---------- cambios de un robot ----------
   Qué archivos tocó cada robot y cómo están en git, sin preguntarle (no gasta tokens). La lista sale de sus Edit/Write
   (r.files) y la carpeta de su consola (r.gitCwd) suma lo que cambió por otros medios (sed, mv, un script). Git se
   consulta solo cuando abres el bloque en su panel, no en cada evento. */

const FILES_MAX = 300;
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function trackFile(r, tool, file) {
  if (!EDIT_TOOLS.includes(tool) || !file) return false;
  const p = path.resolve(String(file));
  if (p.startsWith(RUNS + path.sep)) return false; // memoria de rutinas, adjuntos, estado de la oficina
  r.files ||= [];
  const i = r.files.indexOf(p);
  if (i === r.files.length - 1 && i >= 0) return false;
  if (i >= 0) r.files.splice(i, 1);
  r.files.push(p);
  if (r.files.length > FILES_MAX) r.files.splice(0, r.files.length - FILES_MAX);
  return true;
}

// Robots guardados antes de esta función: su lista sale del transcript (una sola vez, al arrancar).
function filesFromTranscript(file) {
  const out = [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"') || !/"(Write|Edit|MultiEdit|NotebookEdit)"/.test(line)) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    for (const c of o.message?.content || []) {
      if (c?.type === 'tool_use' && EDIT_TOOLS.includes(c.name)) {
        const p = c.input?.file_path || c.input?.notebook_path;
        if (p) {
          const a = path.resolve(p);
          const i = out.indexOf(a);
          if (i >= 0) out.splice(i, 1);
          out.push(a);
        }
      }
    }
  }
  return out.filter(p => !p.startsWith(RUNS + path.sep)).slice(-FILES_MAX);
}

const git = async (cwd, args) => (await run('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout;
const tops = new Map(); // carpeta → raíz del repo ('' si no es git)
async function topOf(dir) {
  if (tops.has(dir)) return tops.get(dir);
  let top = '';
  let d = dir;
  while (d && !fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  } // un archivo borrado o una carpeta que ya no existe
  try {
    top = (await git(d, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    top = '';
  }
  tops.set(dir, top);
  return top;
}

// La ruta real (git da /private/var/… donde el robot escribió /var/…); si el archivo ya no existe, la de su carpeta.
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    /* borrado */
  }
  try {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  } catch {
    return p;
  }
}

const STATUS = {
  M: 'modificado',
  A: 'nuevo',
  '?': 'nuevo',
  D: 'borrado',
  R: 'renombrado',
  C: 'copiado',
  U: 'en conflicto',
  T: 'modificado'
};
const shown = p => (WORKSPACE && p.startsWith(WORKSPACE + path.sep) ? path.relative(WORKSPACE, p) : p.replace(os.homedir(), '~'));

async function repoChanges(top) {
  const [branch, status, numstat] = await Promise.all([
    git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => ''),
    git(top, ['diff', '--numstat', '-z', 'HEAD']).catch(() => '')
  ]);
  const pending = new Map(); // ruta absoluta → { status, add, del }
  const parts = status.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2),
      rel = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // -z: la ruta de origen va en la entrada siguiente
    const k = xy === '??' ? '?' : xy.includes('U') ? 'U' : xy[1] !== ' ' ? xy[1] : xy[0];
    pending.set(path.join(top, rel), { status: STATUS[k] || 'modificado', add: null, del: null });
  }
  // numstat -z: «add\tdel\truta\0» o, en un renombre, «add\tdel\t\0origen\0destino\0»
  const ns = numstat.split('\0');
  for (let i = 0; i < ns.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(ns[i]);
    if (!m) continue;
    let rel = m[3];
    if (!rel) {
      rel = ns[i + 2];
      i += 2;
    }
    const p = path.join(top, rel || '');
    const x = pending.get(p) || { status: 'modificado' };
    x.add = m[1] === '-' ? null : Number(m[1]);
    x.del = m[2] === '-' ? null : Number(m[2]);
    pending.set(p, x);
  }
  for (const [p, x] of pending)
    if (x.status === 'nuevo' && x.add == null) {
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.size < 2e6) x.add = fs.readFileSync(p, 'utf8').split('\n').length - 1 || 1;
      } catch {
        /* binario o ya no está */
      }
    }
  return { branch: branch.trim(), pending };
}

async function robotChanges(r) {
  const files = r.files || [];
  const byTop = new Map(); // raíz → archivos del robot ahí
  const outside = [];
  for (const f0 of files) {
    const f = real(f0);
    const top = await topOf(path.dirname(f));
    if (!top) {
      outside.push(f);
      continue;
    }
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top).push(f);
  }
  const cwdTop = r.gitCwd ? await topOf(r.gitCwd) : '';
  if (cwdTop && !byTop.has(cwdTop)) byTop.set(cwdTop, []);
  const repos = [];
  for (const [top, mine] of byTop) {
    const { branch, pending } = await repoChanges(top);
    const own = new Set(mine);
    const row = p => {
      const x = pending.get(p);
      return {
        path: p,
        shown: path.relative(top, p),
        status: x ? x.status : 'sin cambios pendientes',
        add: x?.add ?? null,
        del: x?.del ?? null,
        pending: !!x
      };
    };
    const others = [...pending.keys()].filter(p => !own.has(p)).sort();
    repos.push({
      top,
      name: shown(top),
      branch,
      files: mine.slice().reverse().map(row), // lo último que tocó, primero
      others: others.slice(0, 40).map(row),
      othersMore: Math.max(0, others.length - 40),
      pending: pending.size
    });
  }
  return {
    repos,
    outside: outside
      .slice()
      .reverse()
      .map(p => ({ path: p, shown: shown(p) })),
    total: files.length
  };
}

// Abrir en el editor: un archivo con cambios sin commit se abre como diff contra HEAD; uno nuevo, limpio o fuera de git, tal cual.
const CODE_APP = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
async function editorBin() {
  if (process.env.OFFICE_EDITOR) return process.env.OFFICE_EDITOR;
  try {
    return (await run('/bin/sh', ['-lc', 'command -v code'])).stdout.trim() || (fs.existsSync(CODE_APP) ? CODE_APP : '');
  } catch {
    return fs.existsSync(CODE_APP) ? CODE_APP : '';
  }
}

async function allowedPath(r, p) {
  const abs = real(path.resolve(String(p || '')));
  if ((r.files || []).some(f => real(f) === abs)) return abs;
  // también lo que cambió en el repo de su consola o en un repo donde editó (lo que el bloque muestra como «otros cambios»)
  const top = await topOf(path.dirname(abs));
  if (!top) return null;
  const tops2 = new Set([r.gitCwd ? await topOf(r.gitCwd) : '']);
  for (const f of r.files || []) tops2.add(await topOf(path.dirname(real(f))));
  return tops2.has(top) ? abs : null;
}

async function openChange(r, p) {
  const abs = await allowedPath(r, p);
  if (!abs) return { status: 403, error: 'Ese archivo no es de los cambios de este robot.' };
  const ed = await editorBin();
  const top = await topOf(path.dirname(abs));
  let headCopy = '';
  if (top) {
    const rel = path.relative(top, abs);
    const changed = (await git(top, ['status', '--porcelain=v1', '--', rel]).catch(() => '')).trim();
    if (changed && !changed.startsWith('??') && !changed.startsWith('A')) {
      const head = await git(top, ['show', `HEAD:${rel}`]).catch(() => null);
      if (head != null) {
        const dir = path.join(os.tmpdir(), 'agent-office-diff', r.name);
        fs.mkdirSync(dir, { recursive: true });
        headCopy = path.join(dir, `HEAD · ${path.basename(abs)}`);
        fs.writeFileSync(headCopy, head);
      }
    }
  }
  const exists = fs.existsSync(abs);
  if (!exists && !headCopy) return { status: 404, error: 'El archivo ya no existe y no está en el último commit.' };
  if (ed) {
    const args = headCopy && exists ? ['--diff', headCopy, abs] : [exists ? abs : headCopy];
    await run(ed, args);
    return { status: 200, mode: headCopy && exists ? 'diff' : 'archivo' };
  }
  await run('open', [exists ? abs : headCopy]); // sin VS Code: el programa que el Mac tenga para ese tipo de archivo
  return { status: 200, mode: 'archivo' };
}

export { filesFromTranscript, openChange, robotChanges, trackFile };
