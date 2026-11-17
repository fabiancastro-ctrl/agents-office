// Oficina de Agentes · salas de épica y de equipo.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { now, PORT, replaceList, robots, RUNS, trunc, WORKSPACE } from './base.mjs';
import { broadcast, emit } from './estado.mjs';
import { freeDesk, log, roomSeat, saveState } from './persistencia.mjs';
import { spawnQueue } from './equipo.mjs';
import { removeRobot } from './consola.mjs';
import { say } from './tmux.mjs';
import { readBody, readRaw, send } from './http.mjs';

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
  return { id: s.id, name: s.name, key: s.key, folder: s.folder, context: contextPath(s), threadFile: threadPath(s), thread: s.thread.slice(-150), docs: s.docs, createdAt: s.createdAt, auto: !!s.auto, owner: s.owner || null, color: Number.isInteger(s.color) ? s.color : null, purpose: s.purpose || '', done: !!s.done, spend: s.spend || 0,
    roster: (s.roster || []).map(e => ({ name: e.name, title: e.title || '', state: rosterState(e), owner: !!e.owner })) };
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
  const id = /^[0-9a-f]{8}$/.test(String(b.id || '')) && !salas.some(x => x.id === b.id) ? b.id : crypto.randomBytes(4).toString('hex');
  const s = { id, name, key, folder, thread: [], docs: [], createdAt: now() };
  fs.mkdirSync(path.join(SALAS_DIR, s.id), { recursive: true });
  const initial = String(b.context || '').trim();
  fs.writeFileSync(contextPath(s), initial ? initial + '\n' : `# Contexto de la sala «${name}»${key ? ` (${key})` : ''}\n\n## Alcance\n\n## Decisiones tomadas\n\n## Estado verificado\n\n## Bloqueos y pendientes\n`);
  salas.push(s);
  writeThreadFile(s);
  saveSalas();
  return s;
}

// Sala de equipo: cuando un robot pide robots y tú los apruebas. Si el padre ya está en una sala (de épica o de equipo),
// los hijos entran a esa; si no, se crea una con su objetivo y el reparto en CONTEXT.md y el padre se muda a ella.
// Las salas de equipo (auto) se cierran solas cuando no queda nadie ni nadie esperando para entrar; sus archivos quedan.
function teamSala(r, items, context, salaId) {
  const team = items.map(it => `- ${it.title || trunc(it.text.replace(/\s+/g, ' '), 80)}`).join('\n');
  const stamp = now().slice(0, 16).replace('T', ' ');
  const cur = r.place.sala && salas.find(s => s.id === r.place.sala);
  if (cur) {
    if (context) fs.appendFileSync(contextPath(cur), `\n## Contexto que mandó ${r.name} al lanzar más robots (${stamp})\n\n${context}\n`);
    if (cur.done) { cur.done = false; saveSalas(); emitSalas(); } // entra más trabajo: el equipo vuelve a estar en curso
    return { sala: cur, created: false };
  }
  const goal = r.title || r.label || 'su encargo';
  const s = createSala({ id: salaId, name: `Equipo de ${r.name} · ${goal}`, context: `# Contexto del equipo de ${r.name}\n\n_Sala creada por la oficina el ${stamp} cuando ${r.name} pidió robots. La comparten ${r.name} y los robots que lanzó._\n\n`
    + `## Objetivo\n\n${goal}\n\n## Contexto que mandó ${r.name}\n\n${context || '_Sin contexto adicional: está en cada encargo._'}\n\n`
    + '## Decisiones tomadas\n\n## Estado verificado\n\n## Bloqueos y pendientes\n' });
  s.auto = true;
  s.owner = r.name;
  s.color = r.color; // el piso de la sala lleva el color de quien la armó
  s.purpose = `${r.name} armó este equipo para «${trunc(goal, 120)}» y repartió: ${items.map(it => it.title || trunc(it.text.replace(/\s+/g, ' '), 40)).join(', ')}`;
  saveSalas();
  r.place = roomSeat(`sala-${s.id}`, s.name, { sala: s.id });
  log(r, 'sys', `Se mudó a la sala «${s.name}» con su equipo`);
  emit(r);
  saveState();
  emitSalas();
  s.roster = [{ name: r.name, title: r.title || '', owner: true, sessionId: r.sessionId }];
  return { sala: s, created: true };
}
// «Reparto»: quién es quién (nombre · tarea · estado), para el padre, los hijos y tú. Vive en REPARTO.md de la sala y
// en salaView (el tablero lo dibuja de ahí), NO en CONTEXT.md: si la oficina reescribiera CONTEXT.md mientras un robot
// lo edita, su edición fallaría y tendría que releerlo (una vuelta más de tokens). A los hijos les llega copiado en su
// encargo (salaPreamble). Las salas viejas que lo tenían en CONTEXT.md lo pierden de ahí una sola vez.
function rosterState(e) {
  if (e.owner) return robots.has(e.name) ? 'coordina' : 'se fue';
  const live = robots.get(e.name);
  if (live) return live.reported ? 'entregó' : 'trabajando';
  if (spawnQueue.some(q => q.id === e.qid)) return 'esperando cupo';
  return e.dropped ? 'no se lanzó' : 'se fue';
}
const rosterPath = s => path.join(SALAS_DIR, s.id, 'REPARTO.md');
const rosterLines = (s, me) => (s.roster || []).map(e => `- \`${e.name}\` · ${e.title || 'sin título'} · ${e.name === me ? 'tú' : rosterState(e)}`).join('\n');
function writeRoster(s) {
  if (!s?.roster?.length) return;
  try { fs.writeFileSync(rosterPath(s), `# Reparto de la sala «${s.name}»\n\n_Lo mantiene la oficina: no lo edites._\n\n${rosterLines(s)}\n`); } catch { /* sin carpeta */ }
  if (!s.rosterMoved) { // sala de antes: su «## Reparto» salía en CONTEXT.md; se quita una vez y no se vuelve a tocar
    try {
      const f = contextPath(s), txt = fs.readFileSync(f, 'utf8'), re = /\n?## Reparto\n[\s\S]*?(?=\n## |$)/;
      if (re.test(txt)) fs.writeFileSync(f, txt.replace(re, ''));
    } catch { /* sin archivo */ }
    s.rosterMoved = true;
    saveSalas();
  }
  emitSalas(); // el tablero lo dibuja de salaView
}
const rosterOf = name => salas.filter(s => s.roster?.some(e => e.name === name));
function closeEmptyTeamSalas() {
  const keep = s => !s.auto || [...robots.values()].some(r => r.place.sala === s.id) || spawnQueue.some(q => q.sala === s.id);
  if (salas.every(keep)) return;
  for (const s of salas.filter(x => !keep(x))) archiveSala(s, 'se fue todo el equipo');
  salas = salas.filter(keep);
  saveSalas(); emitSalas();
}
// Equipo terminado: todos los hijos que siguen en la sala ya entregaron su resultado y nadie espera para entrar.
// Te avisa una vez y la sala queda marcada en verde hasta que entre más trabajo.
function checkTeamDone(kid) {
  const s = kid.place.sala && salas.find(x => x.id === kid.place.sala);
  if (!s?.auto || s.done) return;
  const kids = [...robots.values()].filter(x => x.place.sala === s.id && x.parent);
  if (!kids.length || spawnQueue.some(q => q.sala === s.id) || kids.some(x => !x.reported)) return;
  s.done = true;
  saveSalas(); emitSalas();
  const p = robots.get(s.owner);
  if (p) log(p, 'sys', `Su equipo terminó: ${kids.length} de ${kids.length} entregaron`);
  broadcast({ type: 'notice', text: `El equipo de ${s.owner} terminó: ${kids.length} de ${kids.length} entregaron. ${p ? `${s.owner} ya tiene sus resultados: revísalo.` : ''}`.trim() });
}
// Si en una sala de equipo queda solo quien la armó, vuelve caminando a un escritorio y la sala pasa al archivo.
function ownerBackIfAlone() {
  for (const s of salas) {
    if (!s.auto) continue;
    const inSala = [...robots.values()].filter(r => r.place.sala === s.id);
    if (inSala.length !== 1 || inSala[0].name !== s.owner || spawnQueue.some(q => q.sala === s.id)) continue;
    const o = inSala[0];
    o.place = freeDesk();
    log(o, 'sys', `Se quedó solo en «${s.name}»: volvió a su escritorio y la sala pasó al archivo`);
    broadcast({ type: 'notice', text: `${o.name} se quedó solo en su sala: volvió a su escritorio. La sala «${s.name}» quedó en el archivo con su contexto y su hilo.` });
    emit(o);
    saveState();
  }
}
// Papelera: lo que borras desde la oficina (resúmenes de despedidos, salas cerradas) va a la de macOS, de donde se
// recupera; sin ella, a runs/papelera. OFFICE_TRASH la cambia (las pruebas usan una temporal). null si no existía.
function toTrash(src, label) {
  if (!src || !fs.existsSync(src)) return null;
  const trash = process.env.OFFICE_TRASH || (fs.existsSync(path.join(os.homedir(), '.Trash')) ? path.join(os.homedir(), '.Trash') : path.join(RUNS, 'papelera'));
  fs.mkdirSync(trash, { recursive: true });
  const ext = fs.statSync(src).isDirectory() ? '' : path.extname(src);
  const dest = path.join(trash, `${label}-${now().slice(0, 19).replace(/[:T]/g, '-')}${ext}`);
  try { fs.renameSync(src, dest); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true }); // otro disco: copiar y quitar
  }
  return dest;
}
// Salas cerradas (a mano o solas): se guardan para abrir su contexto y su hilo desde el archivo.
const SALAS_ARCH_FILE = path.join(RUNS, 'salas-archivo.json');
let salasArchive = [];
try { salasArchive = JSON.parse(fs.readFileSync(SALAS_ARCH_FILE, 'utf8')); } catch { salasArchive = []; }
function archiveSala(s, reason) {
  salasArchive.unshift({ id: s.id, name: s.name, key: s.key || '', purpose: s.purpose || '', owner: s.owner || null, auto: !!s.auto, color: Number.isInteger(s.color) ? s.color : null,
    context: contextPath(s), threadFile: threadPath(s), messages: s.thread.length, docs: s.docs.length, createdAt: s.createdAt, closedAt: now(), reason });
  salasArchive = salasArchive.slice(0, 300);
  fs.writeFileSync(SALAS_ARCH_FILE, JSON.stringify(salasArchive, null, 2));
}

// Lo que recibe un robot al entrar a una sala. El CONTEXT.md va copiado aquí (si es razonable): leerlo con una
// herramienta costaría lo mismo más una vuelta extra con todo su contexto. El hilo NO se lee entero: puede ser largo.
const SALA_CTX_INLINE = 8000;
// Buscador: en las salas cerradas busca en su nombre y porqué, su CONTEXT.md y su hilo (HILO.md), sin tildes ni
// mayúsculas. Devuelve por sala hasta 4 trozos que coinciden, con el archivo para abrirlo.
const normQ = t => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function searchClosedSalas(q) {
  const qn = normQ(q).trim();
  if (qn.length < 2) return [];
  const out = [];
  for (const s of salasArchive) {
    const hits = [];
    const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    for (const part of read(s.threadFile).split(/\n(?=### )/).slice(1)) { // mensajes del hilo: «### quién · fecha»
      const [head, ...body] = part.split('\n');
      const text = body.join('\n').trim();
      if (normQ(text).includes(qn)) hits.push({ where: 'hilo', who: head.replace(/^###\s*/, ''), text: text.slice(0, 600), path: s.threadFile });
    }
    for (const par of read(s.context).split(/\n\s*\n/)) if (normQ(par).includes(qn) && !/^# /.test(par)) hits.push({ where: 'contexto', text: par.trim().slice(0, 600), path: s.context });
    if (hits.length || normQ(`${s.name} ${s.purpose} ${s.key}`).includes(qn)) out.push({ id: s.id, name: s.name, purpose: s.purpose || '', closedAt: s.closedAt, color: s.color, context: s.context, threadFile: s.threadFile, hits: hits.slice(0, 4), more: Math.max(0, hits.length - 4) });
  }
  return out;
}
function salaPreamble(s, me) {
  let ctx = '';
  try { ctx = fs.readFileSync(contextPath(s), 'utf8').trim(); } catch { /* sin archivo */ }
  const inline = ctx && ctx.length <= SALA_CTX_INLINE;
  const last = s.thread.slice(-5).map(m => `· ${m.from}: ${trunc(m.text.replace(/\s+/g, ' '), 600)}`).join('\n');
  const team = rosterLines(s, me);
  return `\n\n--- Sala «${s.name}»${s.key ? ` (Jira ${s.key})` : ''}: la compartes con otros robots ---
Contexto compartido: ${contextPath(s)}${s.folder ? ` · documentos en ${path.join(WORKSPACE, s.folder)}` : ''}${inline ? ` (copia, no hace falta leerlo):\n${ctx}\n` : ' (léelo antes de empezar).\n'}${team ? `Quién es quién en la sala (nombre · tarea · estado al entrar tú; al día en ${rosterPath(s)}):\n${team}\n` : ''}${last ? `Lo último del hilo (para no repetir trabajo; más atrás en ${threadPath(s)}):\n${last}\n` : ''}- Si confirmas algo durable que falte o esté mal en el contexto (decisión, estado, bloqueo), corrígelo con Edit en su lugar, sin volverlo bitácora, con fecha absoluta.
- Tu respuesta final de cada turno se publica sola en el hilo: escríbela para que la entienda otro robot que no vio tu conversación. Para publicar a mitad de turno: curl -s -X POST "http://127.0.0.1:${PORT}/api/salas/${s.id}/hilo?from=$OFFICE_ROBOT" -H 'Content-Type: text/plain' --data-binary @<archivo>
--- fin de la sala ---`;
}

// Rutas de la API: salas abiertas y cerradas. Las llama http.mjs en orden; devuelven algo (true) si atendieron la petición.
async function salasApi(req, res, url, parts) {
    if (req.method === 'GET' && url.pathname === '/api/salas-cerradas') return url.searchParams.get('q') ? send(res, 200, { results: searchClosedSalas(url.searchParams.get('q')) }) : send(res, 200, { salas: salasArchive });
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'salas-cerradas' && parts[2]) {
      // Borra una sala cerrada: sale del archivo y su carpeta (CONTEXT.md, HILO.md) va a la Papelera, de donde se recupera.
      const e = salasArchive.find(x => x.id === parts[2]);
      if (!e) return send(res, 404, { error: 'Esa sala ya no está en el archivo.' });
      if (salas.some(x => x.id === e.id)) return send(res, 409, { error: 'Esa sala está abierta otra vez: ciérrala primero.' });
      const dir = path.dirname(e.context);
      const moved = dir.startsWith(SALAS_DIR + path.sep) ? toTrash(dir, `sala-${e.id}`) : null;
      replaceList(salasArchive, salasArchive.filter(x => x !== e));
      fs.writeFileSync(SALAS_ARCH_FILE, JSON.stringify(salasArchive, null, 2));
      return send(res, 200, { ok: true, papelera: moved });
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
      // «Despedir equipo»: da de baja (sin resumen) a los hijos de la sala que ya entregaron su resultado. Los que siguen
      // trabajando y el padre se quedan; si el padre queda solo, vuelve a su escritorio y la sala pasa al archivo.
      if (req.method === 'POST' && parts[3] === 'despedir-equipo') {
        const done = inSala.filter(r => r.parent && r.reported);
        for (const r of done) await removeRobot(r, 'equipo despedido');
        return send(res, 200, { ok: true, despedidos: done.map(r => r.name), quedan: inSala.length - done.length });
      }
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
        archiveSala(s, 'la cerraste');
        replaceList(salas, salas.filter(x => x !== s)); // los archivos quedan en runs/salas/<id>/
        saveSalas(); emitSalas();
        return send(res, 200, { ok: true });
      }
    }
}

export { archiveSala, checkTeamDone, closeEmptyTeamSalas, contextPath, createSala, emitSalas, ownerBackIfAlone, postThread, rosterOf, rosterPath, rosterState, salaPreamble, salas, SALAS_ARCH_FILE, SALAS_DIR, salasApi, salasArchive, salaView, saveSalas, searchClosedSalas, teamSala, threadPath, toTrash, writeRoster };
