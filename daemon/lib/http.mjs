// Oficina de Agentes · servidor HTTP y rutas de la API.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ATTACH_DIR, ATTACH_MAX_BYTES, clients, console_, inbox, MAX_ROBOTS_LIMIT, PORT, replaceList, robots, run, setMaxRobots, setWorkspace, trunc, WEB, WORKSPACE } from './base.mjs';
import { broadcast, configView, emit, knownDoc, MAP_THEMES, TEXT_DOC, view } from './estado.mjs';
import { claudeStatus, fame, loadSessions, officeUsage } from './uso.mjs';
import { OFFICE_NAME_MAX, officeName, saveConfig, saveWorkspace, setOfficeName, setupView, workspaceInfo } from './carpeta.mjs';
import { log, restore, saveState } from './persistencia.mjs';
import { decideSpawn, doorView, drainSpawnQueue, emitDoor, flushIfIdle, launchOrQueue, requestSpawn, resumeResults, spawnQueue } from './equipo.mjs';
import { ARCH_FILE, archive, cleanTitle, emitInbox, favorites, pins, saveFavorites, savePins, SUMMARY_ASK } from './turno.mjs';
import { archMeta, emitArchive, exportConversation, retake, searchArchive } from './exportar.mjs';
import { removeRobot, revive } from './consola.mjs';
import { answerAsk, decide, onHook } from './hooks.mjs';
import { validAttachments } from './adjuntos.mjs';
import { listSkills, openConsole, pane, pressKey, say } from './tmux.mjs';
import { checkRoutine, createRoutine, emitRoutines, firstRun, previewRoutine, resetRepoIndex, routines, routineView, saveRoutines, updateRoutine } from './rutinas.mjs';
import { archiveSala, createSala, emitSalas, postThread, salas, SALAS_ARCH_FILE, SALAS_DIR, salasArchive, salaView, saveSalas, threadPath, toTrash, writeRoster } from './salas.mjs';

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

// La página vive en web/app/*.js, un archivo por tema (mapa, robots, rutinas, panel…). Se sirven unidos en orden de
// nombre dentro de una sola función, como si fueran un archivo: comparten variables y funciones sin volverse globales
// del navegador. Se arma en cada pedido, así que un cambio solo necesita recargar la página.
const APP_DIR = path.join(WEB, 'app');
function appBundle() {
  const parts = fs.readdirSync(APP_DIR).filter(f => f.endsWith('.js')).sort();
  return '// Oficina de Agentes: dibuja el estado que empuja el daemon y manda tus acciones por la API.\n'
    + `// Armado por el daemon a partir de web/app/ (${parts.join(', ')}). No se edita aquí.\n(() => {\n`
    + parts.map(f => fs.readFileSync(path.join(APP_DIR, f), 'utf8')).join('') + '})();\n';
}
const STATIC = { '/': 'index.html', '/robot-art.js': 'robot-art.js', '/style.css': 'style.css', '/vendor/marked.min.js': 'vendor/marked.min.js', '/vendor/purify.min.js': 'vendor/purify.min.js' };
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
      setWorkspace(saveWorkspace(info.path));
      resetRepoIndex();
      console.log(`Carpeta de trabajo: ${WORKSPACE}`);
      if (first) { loadSessions(); await restore(); resumeResults(); }
      broadcast({ type: 'setup', setup: setupView(), skills: listSkills() });
      return send(res, 200, { ok: true, ...setupView(), info });
    }
    // Sin carpeta de trabajo solo funcionan la página y la configuración inicial.
    if (!WORKSPACE && parts[0] === 'api' && url.pathname !== '/api/events') return send(res, 409, { error: 'Elige primero la carpeta de trabajo.', setup: true });
    if (!WORKSPACE && url.pathname === '/hook') return send(res, 200, null);
    if (req.method === 'GET' && url.pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      return res.end(appBundle());
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = path.join(WEB, STATIC[url.pathname]);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'POST' && url.pathname === '/hook') {
      const name = url.searchParams.get('robot') || 'desconocido';
      // Si la consola corta el hook (la cerraron, cancelaron la pregunta o se reinició), lo retenido se suelta.
      const closers = [];
      res.on('close', () => { if (!res.writableEnded) closers.splice(0).forEach(f => { try { f(); } catch { /* ya resuelto */ } }); });
      return send(res, 200, await onHook(name, await readBody(req), url.searchParams.get('via') || '', closers));
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', setup: setupView(), robots: [...robots.values()].map(r => view(r, true)), inbox, routines: routines.map(routineView), salas: salas.map(salaView), config: configView(), favorites, pins, archiveCount: archive.length, door: doorView(), fame })}\n\n`);
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
        setOfficeName(String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, OFFICE_NAME_MAX));
        saveConfig({ name: officeName });
      }
      if (body.mapTheme !== undefined) {
        if (!MAP_THEMES.includes(body.mapTheme)) return send(res, 400, { error: 'Estilo de oficina desconocido.' });
        saveConfig({ mapTheme: body.mapTheme }); // estilo del mapa: es de la oficina, no del navegador
      }
      if (body.maxRobots !== undefined) {
        const n = Number(body.maxRobots);
        if (!Number.isInteger(n) || n < 1 || n > MAX_ROBOTS_LIMIT) return send(res, 400, { error: `El tope debe estar entre 1 y ${MAX_ROBOTS_LIMIT}.` });
        setMaxRobots(n);
        saveState();
        if (spawnQueue.length) setTimeout(drainSpawnQueue, 0); // con más cupo, lo que espera en la puerta entra ya
      }
      broadcast({ type: 'config', config: configView() });
      return send(res, 200, configView());
    }
    if (req.method === 'GET' && url.pathname === '/api/usage') return send(res, 200, { weeks: officeUsage() });
    if (req.method === 'GET' && url.pathname === '/api/claude-status') return send(res, 200, await claudeStatus(url.searchParams.get('refresh') === '1'));
    if (req.method === 'GET' && url.pathname === '/api/skills') return send(res, 200, { skills: listSkills() });
    // Repos de la carpeta de trabajo (primer nivel con .git): el autocompletado del chat los sugiere.
    if (req.method === 'GET' && url.pathname === '/api/vocab') {
      let repos = [];
      try { repos = fs.readdirSync(WORKSPACE, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(WORKSPACE, e.name, '.git'))).map(e => e.name).sort(); } catch { /* sin carpeta */ }
      return send(res, 200, { repos });
    }
    if (req.method === 'POST' && url.pathname === '/api/routines/preview') {
      try { return send(res, 200, await previewRoutine(await readBody(req))); } catch (e) { return send(res, 400, { error: trunc(e.stderr || e.message, 300) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/routines') {
      try { const rt = await createRoutine(await readBody(req)); emitRoutines(); return send(res, 201, { ok: true, id: rt.id }); }
      catch (e) { return send(res, 400, { error: trunc(e.stderr || e.message, 300) }); }
    }
    if (parts[0] === 'api' && parts[1] === 'routines' && parts[2]) {
      const rt = routines.find(x => x.id === parts[2]);
      if (!rt) return send(res, 404, { error: 'Esa rutina no existe.' });
      if (req.method === 'POST' && parts[3] === 'run') { checkRoutine(rt); return send(res, 200, { ok: true }); }
      if (req.method === 'PUT' && !parts[3]) {
        try { await updateRoutine(rt, await readBody(req)); emitRoutines(); return send(res, 200, { ok: true }); }
        catch (e) { return send(res, 400, { error: trunc(e.stderr || e.message, 300) }); }
      }
      if (req.method === 'POST' && parts[3] === 'pause') {
        rt.paused = !rt.paused;
        if (!rt.paused) { if (rt.type === 'wake') delete rt.fired; rt.doneOnce = false; rt.nextAt = firstRun(rt); } else rt.nextAt = Infinity;
        saveRoutines(); emitRoutines();
        return send(res, 200, { ok: true, paused: rt.paused });
      }
      if (req.method === 'DELETE' && !parts[3]) {
        replaceList(routines, routines.filter(x => x !== rt));
        saveRoutines(); emitRoutines();
        return send(res, 200, { ok: true });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/salas-cerradas') return send(res, 200, { salas: salasArchive });
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
      replaceList(favorites, favorites.filter(f => f.id !== parts[2]));
      saveFavorites();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/despedidos') {
      const q = url.searchParams.get('q');
      const all = url.searchParams.get('all') === '1';
      return send(res, 200, q ? { results: searchArchive(q) } : { recent: (all ? archive : archive.slice(-30)).slice().reverse().map(archMeta), total: archive.length });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2] && parts[3] === 'retomar') {
      try { const r = await retake(parts[2], (await readBody(req)).text); return send(res, 201, { ok: true, name: r.name }); }
      catch (e) { return send(res, 409, { error: e.message }); }
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2] && parts[3] === 'exportar') {
      const a = archive.find(x => x.id === parts[2]);
      if (!a) return send(res, 404, { error: 'Ese robot ya no está en el archivo.' });
      try { return send(res, 200, { ok: true, ...exportConversation(a) }); } catch (e) { return send(res, 409, { error: e.message }); }
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2]) { // lo quita de la lista y su resumen va a la Papelera
      const a = archive.find(x => x.id === parts[2]);
      if (!a) return send(res, 404, { error: 'Ese robot ya no está en el archivo.' });
      replaceList(archive, archive.filter(x => x !== a));
      fs.promises.writeFile(ARCH_FILE, JSON.stringify(archive)).catch(() => {});
      emitArchive();
      // Solo si ningún otro despedido usa ese mismo .md (no debería, pero no se borra lo que otro necesita).
      const moved = a.summaryPath && !archive.some(x => x.summaryPath === a.summaryPath) ? toTrash(a.summaryPath, path.basename(a.summaryPath, '.md')) : null;
      return send(res, 200, { ok: true, papelera: moved });
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2]) {
      const a = archive.find(x => x.id === parts[2]);
      return a ? send(res, 200, a) : send(res, 404, { error: 'Ese robot ya no está en el archivo.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/pins') {
      const b = await readBody(req);
      const text = String(b.text || '').slice(0, 60000), robot = trunc(String(b.robot || '').trim(), 40);
      if (!text.trim() || !robot) return send(res, 400, { error: 'Falta el mensaje.' });
      const at = String(b.at || new Date().toISOString());
      const dup = pins.find(p => p.robot === robot && p.at === at);
      if (dup) return send(res, 200, { ok: true, pin: dup });
      const p = { id: crypto.randomBytes(4).toString('hex'), robot, title: trunc(String(b.title || ''), 80), at, text, pinnedAt: new Date().toISOString() };
      pins.push(p); if (pins.length > 100) pins.shift();
      savePins();
      return send(res, 201, { ok: true, pin: p });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'pins' && parts[2]) {
      replaceList(pins, pins.filter(p => p.id !== parts[2]));
      savePins();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/robots') {
      const out = await launchOrQueue(await readBody(req));
      if (out.queued) return send(res, 202, { ok: true, queued: true, id: out.queued.id, title: out.queued.title, position: out.position });
      return send(res, 201, { ok: true, name: out.robot.name });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'puerta' && parts[2]) { // sacar un encargo tuyo de la puerta
      const i = spawnQueue.findIndex(q => q.job && q.id === parts[2]);
      if (i < 0) return send(res, 404, { error: 'Ese encargo ya entró o no estaba en la puerta.' });
      const [q] = spawnQueue.splice(i, 1);
      console_(q.name || 'puerta', 'sale de la puerta', q.title);
      saveState(); emitDoor();
      return send(res, 200, { ok: true });
    }
    if (parts[0] === 'api' && parts[1] === 'robots' && parts[2]) {
      const r = robotOr404(res, parts[2]);
      if (!r) return;
      const action = parts[3];
      if (req.method === 'POST' && action === 'exportar') {
        try { return send(res, 200, { ok: true, ...exportConversation(r) }); } catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (req.method === 'POST' && action === 'revivir') {
        try { await revive(r); return send(res, 200, { ok: true }); } catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (req.method === 'POST' && action === 'say') {
        if (r.consoleLost) return send(res, 409, { error: `La consola de ${r.name} está caída: revívelo primero.` });
        const { text, attachments } = await readBody(req);
        if (!String(text || '').trim() && !validAttachments(attachments).length) return send(res, 400, { error: 'Mensaje vacío.' });
        await say(r, text, attachments);
        return send(res, 200, { ok: true });
      }
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
      // Aspecto que le eliges al robot: color (0-7), antena (0-3), visor (0-2) y accesorio (0-3). reset vuelve al de su nombre.
      if (req.method === 'POST' && action === 'look') {
        const b = await readBody(req);
        if (b.reset) { r.look = null; if (Number.isInteger(r.baseColor)) r.color = r.baseColor; }
        else {
          const lim = { ant: 4, visor: 3, acc: 4 }, look = { ...(r.look || {}) };
          for (const [k, n] of Object.entries(lim)) if (b[k] !== undefined) { const v = Number(b[k]); if (!Number.isInteger(v) || v < 0 || v >= n) return send(res, 400, { error: `Valor inválido para ${k}.` }); look[k] = v; }
          if (b.color !== undefined) { const c = Number(b.color); if (!Number.isInteger(c) || c < 0 || c > 7) return send(res, 400, { error: 'Color inválido.' }); if (!Number.isInteger(r.baseColor)) r.baseColor = r.color; r.color = c; }
          r.look = Object.keys(look).length ? look : null;
        }
        emit(r);
        return send(res, 200, { ok: true });
      }
      // Despedir con su resumen: le pide un super resumen (su próxima respuesta) y al recibirlo lo da de baja.
      if (req.method === 'POST' && action === 'despedir-con-resumen') {
        if (r.state !== 'done' && !(r.state === 'input' && !r.needsPermission && !r.hold && !r.ask)) return send(res, 409, { error: 'Está en medio de algo: espera a que termine su turno.' });
        r.summaryPending = true;
        log(r, 'sys', 'Le pediste su resumen para despedirlo');
        emit(r);
        await say(r, SUMMARY_ASK);
        return send(res, 200, { ok: true });
      }
      // Nota tuya pegada al robot («esperando respuesta de Ramiro»): se ve en la tarjeta, el mapa y el archivo.
      if (req.method === 'POST' && action === 'note') {
        r.note = String((await readBody(req)).note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
        emit(r);
        return send(res, 200, { ok: true, note: r.note });
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

export { server };
