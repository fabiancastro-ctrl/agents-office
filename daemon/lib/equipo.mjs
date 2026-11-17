// Oficina de Agentes · robots que lanza un robot: peticiones, cola, nombres y resultados.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import path from 'node:path';
import crypto from 'node:crypto';
import { console_, maxRobots, now, robots, trunc } from './base.mjs';
import { broadcast, emit } from './estado.mjs';
import { log, saveState } from './persistencia.mjs';
import { cleanTitle } from './turno.mjs';
import { launch, launching, say } from './tmux.mjs';
import { checkTeamDone, contextPath, rosterOf, salas, SALAS_DIR, saveSalas, teamSala, writeRoster } from './salas.mjs';
import { readBody, send } from './http.mjs';

/* ---------- robots que lanza un robot ---------- */
// Un robot puede pedirle a la oficina robots nuevos (cada uno con su consola y su contexto) en vez de subagentes.
// La petición queda en r.spawnReq hasta que la apruebas; los aprobados entran si hay cupo y si no esperan en
// spawnQueue. Cuando un hijo termina su primer encargo, su respuesta final se le escribe al padre en su consola.
const SPAWN_MAX = 6;
const spawnQueue = []; // [{ id, parent, title, text, at }] o, si es un encargo tuyo que esperó cupo, [{ id, job, title, name, at }]
// Encargos tuyos que esperan en la puerta (sin padre): se ven en la barra y en «Nuevo encargo».
const doorView = () => spawnQueue.filter(q => q.job).map(q => ({ id: q.id, title: q.title, name: q.name || null, at: q.at }));
const emitDoor = () => broadcast({ type: 'door', door: doorView() });
const FULL_RE = /escritorios libres|tope/i;
// «Nuevo encargo» con la oficina llena: en vez de error, el encargo espera en la puerta y entra solo al haber cupo.
// Solo si el pedido lo pide (queue: true) y no es de una rutina: las rutinas ya reintentan solas en su próxima revisión.
async function launchOrQueue(body) {
  try { return { robot: await launch(body) }; } catch (e) {
    if (!body?.queue || body.routine || !FULL_RE.test(e.message)) throw e;
    const name = body.name ? String(body.name).toLowerCase() : '';
    if (name && !/^[a-z0-9-]{1,20}$/.test(name)) throw new Error('Nombre inválido: usa minúsculas, números y guiones.');
    if (name && (robots.has(name) || spawnQueue.some(q => q.name === name))) throw new Error(`Ya existe un robot llamado ${name} (o espera en la puerta).`);
    if (body.kind === 'libre' ? !String(body.text || '').trim() : !String(body.skill || '').trim()) throw new Error(body.kind === 'libre' ? 'Escribe qué necesitas.' : 'Elige la skill.');
    const { queue, ...job } = body;
    const title = cleanTitle(body.title || '') || trunc(body.kind === 'libre' ? String(body.text).replace(/\s+/g, ' ') : `/${body.skill} ${body.args || ''}`.trim(), 60);
    const q = { id: crypto.randomBytes(3).toString('hex'), job, title, name: name || null, at: now() };
    spawnQueue.push(q);
    console_(name || 'puerta', 'espera cupo', title);
    saveState(); emitDoor();
    return { queued: q, position: spawnQueue.filter(x => x.job).length };
  }
}
const kidsOf = name => [
  ...[...robots.values()].filter(x => x.parent === name).map(x => ({ name: x.name, state: x.state, title: x.title || '' })),
  ...spawnQueue.filter(q => q.parent === name).map(q => ({ name: null, state: 'queued', title: q.title, qid: q.id }))
];
// Nombre de un hijo según lo que hace: «Puertos de wallet» → «puertos-wallet» (sin tildes ni palabras vacías, máx. 17
// letras para que quepa un «-2» si se repite). El robot puede proponer el suyo con "nombre" y tú lo corriges al aprobar.
const NAME_STOP = new Set('de del la el los las lo y e o u en para con por a al un una unos unas que se su sus es the of and to for in on with'.split(' '));
function kidName(title, text) {
  const words = String(title || text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(w => w && !NAME_STOP.has(w));
  const two = words.slice(0, 2).join('-');
  const base = (two.length <= 17 ? two : words[0] || '').slice(0, 17).replace(/-+$/, '');
  return base.length >= 3 ? base : '';
}
const validName = n => { const s = String(n ?? '').trim().toLowerCase(); return /^[a-z0-9-]{1,20}$/.test(s) ? s : ''; };
function uniqueName(base) {
  if (!base) return undefined;
  const taken = n => robots.has(n) || launching.has(n);
  if (!taken(base)) return base;
  for (let i = 2; ; i++) { const n = `${base.slice(0, 17).replace(/-+$/, '')}-${i}`; if (!taken(n)) return n; }
}
function requestSpawn(r, body) {
  const list = Array.isArray(body) ? body : body?.encargos || body?.robots || [];
  const items = list.map(x => { const title = cleanTitle(x.titulo ?? x.title ?? ''), text = String(x.encargo ?? x.text ?? x.tarea ?? '').trim().slice(0, 20000); return { title, text, name: validName(x.nombre ?? x.name) || kidName(title, text) }; }).filter(x => x.text);
  if (!items.length) throw new Error('Manda {"encargos":[{"titulo":"…","encargo":"…"}]} con al menos un encargo.');
  if (items.length > SPAWN_MAX) throw new Error(`Máximo ${SPAWN_MAX} robots por petición.`);
  // contexto: lo que todos los del equipo deben saber (lo que el padre ya averiguó). Va al CONTEXT.md de la sala del equipo.
  const context = Array.isArray(body) ? '' : String(body?.contexto ?? body?.context ?? '').trim().slice(0, 30000);
  // La sala se reserva desde ya: así la respuesta del curl le da al padre la ruta del CONTEXT.md sin abrirle un turno.
  const salaId = r.place.sala && salas.some(x => x.id === r.place.sala) ? r.place.sala : crypto.randomBytes(4).toString('hex');
  // Nombres fijados desde ya (sin repetir con robots, cola ni otras peticiones): la respuesta se los dice al padre.
  const used = new Set([...robots.keys(), ...launching, ...spawnQueue.map(q => q.name).filter(Boolean), ...[...robots.values()].flatMap(x => x.spawnReq?.items?.map(i => i.name) || [])]);
  for (const it of items) {
    const base = (it.name || 'robot').slice(0, 17).replace(/-+$/, '');
    let n = it.name || base;
    for (let i = 2; used.has(n); i++) n = `${base}-${i}`;
    it.name = n; used.add(n);
  }
  r.toldNames = items.map(i => i.name); // si al aprobar cambian, se le aclara con sus primeros resultados
  r.spawnReq = { id: crypto.randomBytes(3).toString('hex'), at: now(), items, salaId, ...(context ? { context } : {}) };
  log(r, 'sys', `Pidió ${items.length} robot${items.length === 1 ? '' : 's'} nuevo${items.length === 1 ? '' : 's'}: espera tu aprobación`);
  console_(r.name, 'pide robots', items.map(i => i.title || trunc(i.text, 40)).join(' · '));
  emit(r);
  return r.spawnReq;
}
// Aspecto que el robot muestra: el que le elegiste o el que sale de su nombre (misma cuenta que lookOf en web/robot-art.js).
function lookFromName(name) {
  let h = 7;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { ant: h % 4, visor: (h >>> 3) % 3, acc: (h >>> 6) % 4 };
}
const KID_PREAMBLE = parent => `\n\n(Te lanzó el robot ${parent} desde la Oficina de Agentes. Arrancas sin su conversación: lo que necesitas está en este encargo y en el contexto compartido de la sala de tu equipo (abajo). Cuando termines, tu respuesta final se le envía a ${parent}, así que hazla completa y autosuficiente: resultado, archivos que tocaste o creaste y pendientes.)`;
async function decideSpawn(r, id, approve, edited) {
  if (!r.spawnReq || r.spawnReq.id !== id) throw new Error('Esa petición ya no está pendiente.');
  const items = Array.isArray(edited) ? edited.map(x => ({ title: cleanTitle(x.title ?? ''), text: String(x.text ?? '').trim(), name: validName(x.name) || kidName(x.title, x.text) })).filter(x => x.text) : r.spawnReq.items;
  const context = r.spawnReq.context || '', salaId = r.spawnReq.salaId;
  r.spawnReq = null;
  if (!approve || !items.length) {
    log(r, 'sys', 'No aprobaste los robots que pidió');
    emit(r);
    await say(r, '[Oficina] El usuario no aprobó lanzar los robots que pediste. Sigue tú con el trabajo o pregúntale cómo prefiere hacerlo.').catch(() => {});
    return { launched: [], queued: 0 };
  }
  // El padre y sus hijos quedan juntos en una sala: se ve que trabajan en lo mismo y comparten CONTEXT.md y el hilo.
  const { sala, created } = teamSala(r, items, context, salaId);
  const qs = items.map(it => ({ id: crypto.randomBytes(3).toString('hex'), parent: r.name, title: it.title, text: it.text, name: it.name || '', sala: sala.id, at: now() }));
  spawnQueue.push(...qs);
  sala.roster = [...(sala.roster || []), ...qs.map(q => ({ qid: q.id, name: q.name, title: q.title, parent: r.name }))];
  saveSalas(); writeRoster(sala);
  log(r, 'sys', `Aprobaste ${items.length} robot${items.length === 1 ? '' : 's'} · ${created ? 'pasa a la sala' : 'entran a su sala'} «${sala.name}»`);
  const launched = await drainSpawnQueue();
  emit(r);
  // Sin mensaje aparte (abriría un turno completo del padre solo para avisar): la nota viaja con sus primeros resultados.
  if (created) { r.salaNote = `[Oficina] Aprobé tus robots: tú y ellos están en la sala «${sala.name}». Su contexto compartido es ${contextPath(sala)}; si sabes algo durable que ellos no, agrégalo ahí.`; saveState(); }
  return { launched, queued: spawnQueue.filter(q => q.parent === r.name).length, sala: sala.id };
}
// Lanza los que esperan mientras haya cupo; se llama al aprobar, cuando un robot termina o se va, y cada tanto.
let draining = false;
async function drainSpawnQueue() {
  if (draining) return [];
  draining = true;
  const launched = [];
  try {
    while (spawnQueue.length && [...robots.values()].filter(x => x.state !== 'done').length < maxRobots) {
      const q = spawnQueue.shift();
      if (q.job) { // encargo tuyo que esperaba en la puerta
        try {
          const r = await launch({ ...q.job, origin: `${q.job.origin || 'Lanzado por ti'} · esperó cupo en la puerta desde ${new Date(q.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}` });
          launched.push(r.name);
          broadcast({ type: 'notice', text: `Se liberó un escritorio: entró ${r.name}${q.title ? ` («${q.title}»)` : ''}, que esperaba en la puerta.` });
        } catch (e) {
          if (FULL_RE.test(e.message)) { spawnQueue.unshift(q); break; }
          broadcast({ type: 'notice', text: `No pude lanzar «${q.title || 'el encargo'}» que esperaba en la puerta: ${e.message}` });
        }
        emitDoor();
        continue;
      }
      try {
        const par = robots.get(q.parent); // los hijos salen con el mismo diseño que el padre: color, antena, visor y accesorio
        const sala = q.sala && salas.some(s => s.id === q.sala) ? q.sala : undefined; // si cerraron su sala mientras esperaba, entra a un escritorio
        const kid = await launch({ kind: 'libre', name: uniqueName(q.name || kidName(q.title, q.text)), text: q.text + KID_PREAMBLE(q.parent), label: q.title || trunc(q.text, 80), title: q.title, parent: q.parent, sala,
          color: par?.color, look: par ? { ...lookFromName(par.name), ...(par.look || {}) } : null,
          origin: `Lanzado por el robot ${q.parent} (lo aprobaste en la oficina)` });
        launched.push(kid.name);
        const rs = sala && salas.find(x => x.id === sala), e = rs?.roster?.find(x => x.qid === q.id);
        if (e) { e.name = kid.name; e.sessionId = kid.sessionId; saveSalas(); writeRoster(rs); }
        const p = robots.get(q.parent); if (p) emit(p);
      } catch (e) {
        if (FULL_RE.test(e.message)) { spawnQueue.unshift(q); break; }
        const p = robots.get(q.parent); if (p) log(p, 'sys', `No se pudo lanzar «${q.title || trunc(q.text, 40)}»: ${e.message}`);
      }
    }
  } finally { draining = false; saveState(); }
  return launched;
}
setInterval(() => { if (spawnQueue.length) drainSpawnQueue(); }, 5000);
// Resultados de los hijos. Si el padre está libre le llegan enseguida (así sigue avanzando: ese turno es trabajo útil).
// Si está ocupado, escribirle no sirve de nada hasta que termine: los que lleguen mientras tanto se guardan y le
// llegan JUNTOS en un solo mensaje al terminar su turno, en vez de uno por hijo. Nadie espera a sus hermanos.
// Una pausa corta (RESULT_DEBOUNCE_MS) junta los que terminan casi a la vez.
const RESULT_DEBOUNCE_MS = Number(process.env.OFFICE_RESULT_DEBOUNCE_MS) || 20e3;
const pendingResults = new Map(); // padre -> { items: [{ name, title, text }], first }
const resultTimers = new Map();
const kidsWorking = parent => [...robots.values()].filter(x => x.parent === parent && !x.reported).length + spawnQueue.filter(q => q.parent === parent).length;
// Ocupado: en pleno turno, esperando un permiso o una respuesta tuya a una pregunta, o escribiendo su resumen para irse.
const parentBusy = p => ['working', 'delegating', 'walking'].includes(p.state) || p.needsPermission || !!p.hold || !!p.ask || !!p.summaryPending || !!p.consoleLost;
function reportToParent(r, lastMessage) {
  const p = r.parent && robots.get(r.parent);
  if (r.reported || !p || !String(lastMessage ?? '').trim()) return;
  r.reported = true;
  const b = pendingResults.get(p.name) || { items: [], first: Date.now() };
  b.items.push({ name: r.name, title: r.title || '', text: String(lastMessage).slice(0, 20000) });
  pendingResults.set(p.name, b);
  saveState();
  checkTeamDone(r);
  for (const s of rosterOf(r.name)) writeRoster(s);
  if (parentBusy(p)) log(p, 'sys', `${r.name} terminó; su resultado te llega apenas termines lo que haces`);
  else scheduleFlush(p.name);
  emit(p);
  setTimeout(drainSpawnQueue, 500);
}
function scheduleFlush(parent, ms = RESULT_DEBOUNCE_MS) {
  if (!resultTimers.has(parent)) resultTimers.set(parent, setTimeout(() => { resultTimers.delete(parent); maybeFlush(parent); }, ms));
}
// Entrega lo guardado si el padre está libre; si sigue ocupado, se reintenta al cerrar su turno (o en la revisión periódica).
function maybeFlush(parent) {
  const p = robots.get(parent);
  if (!p) { pendingResults.delete(parent); return; }
  if (pendingResults.has(parent) && !parentBusy(p)) flushResults(parent);
}
function flushResults(parent) {
  clearTimeout(resultTimers.get(parent)); resultTimers.delete(parent);
  const b = pendingResults.get(parent), p = robots.get(parent);
  if (!b?.items.length || !p) return;
  pendingResults.delete(parent);
  const left = kidsWorking(parent), n = b.items.length;
  let note = p.salaNote ? `${p.salaNote}\n\n` : '';
  p.salaNote = '';
  if (p.toldNames) { // si al aprobar cambiaron los nombres que le dije, se lo aclaro aquí (no en un mensaje aparte)
    const team = [...robots.values()].filter(x => x.parent === p.name).map(x => x.name);
    const changed = p.toldNames.filter(n => !team.includes(n) && !b.items.some(i => i.name === n));
    if (changed.length) note += `[Oficina] Nombres finales de tu equipo: ${[...robots.values()].filter(x => x.parent === p.name).map(x => `${x.name} (${x.title || 'sin título'})`).join(', ')}.\n\n`;
    p.toldNames = null;
  }
  const head = n === 1 ? `[Oficina] Resultado de ${b.items[0].name}${b.items[0].title ? ` («${b.items[0].title}»)` : ''}` : `[Oficina] Resultados de ${n} robots (terminaron mientras trabajabas)`;
  const body = n === 1 ? b.items[0].text : b.items.map(i => `## ${i.name}${i.title ? ` («${i.title}»)` : ''}\n\n${i.text}`).join('\n\n');
  say(p, `${note}${head}${left ? ` · ${left} sigue${left === 1 ? '' : 'n'} trabajando` : ' · ya terminaron todos'}:\n\n${body}`).catch(() => {});
  log(p, 'sys', n === 1 ? `Te llegó el resultado de ${b.items[0].name}` : `Te llegaron juntos los resultados de ${b.items.map(i => i.name).join(', ')}`);
  emit(p);
  saveState();
}
const flushIfIdle = parent => { if (parent && pendingResults.has(parent)) maybeFlush(parent); };
// Red de seguridad: tras reiniciar la oficina o si un padre se desocupa sin cerrar turno (p. ej. respondiste su pregunta).
function resumeResults() { for (const parent of pendingResults.keys()) maybeFlush(parent); }
setInterval(resumeResults, 15e3);

// Rutas de la API: sacar un encargo tuyo de la puerta. Las llama http.mjs en orden; devuelven algo (true) si atendieron la petición.
async function puertaApi(req, res, url, parts) {
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'puerta' && parts[2]) { // sacar un encargo tuyo de la puerta
      const i = spawnQueue.findIndex(q => q.job && q.id === parts[2]);
      if (i < 0) return send(res, 404, { error: 'Ese encargo ya entró o no estaba en la puerta.' });
      const [q] = spawnQueue.splice(i, 1);
      console_(q.name || 'puerta', 'sale de la puerta', q.title);
      saveState(); emitDoor();
      return send(res, 200, { ok: true });
    }
}

// Rutas de la API: un robot pide robots y tú decides; quitar uno de la cola. Las llama http.mjs en orden; devuelven algo (true) si atendieron la petición.
async function equipoRobotApi(req, res, url, parts, r, action) {
      // Un robot pide robots nuevos (curl desde su consola) y tú decides desde la oficina.
      if (req.method === 'POST' && action === 'encargos' && !parts[4]) {
        try { const q = requestSpawn(r, await readBody(req)); const ctx = path.join(SALAS_DIR, q.salaId, 'CONTEXT.md'); const team = q.items.map(i => `${i.name} (${i.title || trunc(i.text.replace(/\s+/g, ' '), 40)})`).join(', '); return send(res, 202, { ok: true, id: q.id, contexto: ctx, equipo: q.items.map(i => ({ nombre: i.name, titulo: i.title })), mensaje: `Petición enviada. Si la aprueba, tus robots se llamarán: ${team}. El usuario la aprueba en la oficina; sigue con tu trabajo. Si la aprueba, tú y ellos quedan en una sala con el contexto compartido en ${ctx}: agrega ahí lo durable que averigües y ellos necesiten. Sus resultados te llegan como mensajes «[Oficina] Resultado…» (juntos los que terminen mientras trabajas).` }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && action === 'encargos' && parts[4]) {
        const b = await readBody(req);
        try { return send(res, 200, { ok: true, ...(await decideSpawn(r, parts[4], b.decision === 'approve', b.items)) }); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (req.method === 'POST' && action === 'cola' && parts[4]) { // quitar uno que espera cupo en la puerta
        const i = spawnQueue.findIndex(q => q.id === parts[4] && q.parent === r.name);
        if (i < 0) return send(res, 404, { error: 'Ese robot ya entró o no estaba en la cola.' });
        const [q] = spawnQueue.splice(i, 1);
        log(r, 'sys', `Quitaste de la cola «${q.title || trunc(q.text, 40)}»`);
        for (const s of salas) { const e = s.roster?.find(x => x.qid === q.id); if (e) { e.dropped = true; saveSalas(); writeRoster(s); } }
        flushIfIdle(r.name);
        emit(r);
        return send(res, 200, { ok: true });
      }
}

export { decideSpawn, doorView, drainSpawnQueue, emitDoor, equipoRobotApi, flushIfIdle, kidName, kidsOf, launchOrQueue, lookFromName, maybeFlush, pendingResults, puertaApi, reportToParent, requestSpawn, resultTimers, resumeResults, spawnQueue, validName };
