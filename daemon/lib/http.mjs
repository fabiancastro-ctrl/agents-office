// Oficina de Agentes · servidor HTTP y rutas de la API.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  ATTACH_DIR,
  ATTACH_MAX_BYTES,
  clients,
  console_,
  inbox,
  MAX_ROBOTS_LIMIT,
  PORT,
  robots,
  run,
  setMaxRobots,
  setWorkspace,
  WEB,
  WORKSPACE
} from './base.mjs';
import { broadcast, configView, emit, isCold, knownDoc, MAP_THEMES, TEXT_DOC, view } from './estado.mjs';
import { claudeStatus, fame, fameWall, loadSessions, officeUsage } from './uso.mjs';
import { OFFICE_NAME_MAX, officeName, saveConfig, saveWorkspace, setOfficeName, setupView, workspaceInfo } from './carpeta.mjs';
import { log, restore, saveState } from './persistencia.mjs';
import { doorView, drainSpawnQueue, equipoRobotApi, launchOrQueue, puertaApi, resumeResults, spawnQueue } from './equipo.mjs';
import { archive, cleanTitle, emitInbox, favorites, fijadosApi, frecuentesApi, pins, SUMMARY_ASK } from './turno.mjs';
import { despedidosApi, exportConversation, officeSummary } from './exportar.mjs';
import { removeRobot, revive } from './consola.mjs';
import { blockedBy, snooze, startRelevo } from './relevo.mjs';
import { answerAsk, decide, onHook } from './hooks.mjs';
import { validAttachments } from './adjuntos.mjs';
import { listSkills, openConsole, pane, pressKey, say } from './tmux.mjs';
import { resetRepoIndex, routines, routineView, rutinasApi } from './rutinas.mjs';
import { moveToSala, salas, salasApi, salaView } from './salas.mjs';
import { mantenimientoApi } from './mantenimiento.mjs';
import { openChange, robotChanges } from './cambios.mjs';

/* ---------- http ---------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > max) {
        reject(new Error('El archivo supera 20 MB.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Devuelve true: así las rutas de cada módulo (return send(...)) le dicen a http.mjs que atendieron la petición.
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(obj == null ? '' : JSON.stringify(obj));
  return true;
}

// La página vive en web/app/*.js, un archivo por tema (mapa, robots, rutinas, panel…). Se sirven unidos en orden de
// nombre dentro de una sola función, como si fueran un archivo: comparten variables y funciones sin volverse globales
// del navegador. Se arma en cada pedido, así que un cambio solo necesita recargar la página.
const APP_DIR = path.join(WEB, 'app');
function appBundle() {
  const parts = fs
    .readdirSync(APP_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();
  return (
    '// Oficina de Agentes: dibuja el estado que empuja el daemon y manda tus acciones por la API.\n' +
    `// Armado por el daemon a partir de web/app/ (${parts.join(', ')}). No se edita aquí.\n(() => {\n` +
    parts.map(f => fs.readFileSync(path.join(APP_DIR, f), 'utf8')).join('') +
    '})();\n'
  );
}
const STATIC = {
  '/': 'index.html',
  '/robot-art.js': 'robot-art.js',
  '/style.css': 'style.css',
  '/vendor/marked.min.js': 'vendor/marked.min.js',
  '/vendor/purify.min.js': 'vendor/purify.min.js'
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function robotOr404(res, name) {
  const r = robots.get(name);
  if (!r) send(res, 404, { error: `No hay un robot llamado ${name}.` });
  return r;
}

// Rutas de /api/robots/:name/:action. El despachador (más abajo, en el servidor) busca el robot y responde el 404 una sola
// vez, y llama al manejador de «MÉTODO acción»: route('POST', 'say', async (r, req, res) => …). Sin acción es el robot mismo.
// El manejador responde con `return send(...)`. Las acciones de equipo (encargos, cola) están en equipoRobotApi.
const ROBOT_ROUTES = new Map();
const route = (method, action, handler) => {
  ROBOT_ROUTES.set(`${method} ${action || ''}`, handler);
};

route('POST', 'exportar', async (r, req, res) => {
  try {
    return send(res, 200, { ok: true, ...exportConversation(r) });
  } catch (e) {
    return send(res, 409, { error: e.message });
  }
});
route('POST', 'revivir', async (r, req, res) => {
  try {
    await revive(r);
    return send(res, 200, { ok: true });
  } catch (e) {
    return send(res, 409, { error: e.message });
  }
});
route('POST', 'say', async (r, req, res) => {
  if (r.consoleLost) return send(res, 409, { error: `La consola de ${r.name} está caída: revívelo primero.` });
  const { text, attachments } = await readBody(req);
  if (!String(text || '').trim() && !validAttachments(attachments).length) return send(res, 400, { error: 'Mensaje vacío.' });
  await say(r, text, attachments);
  return send(res, 200, { ok: true });
});
route('POST', 'permission', async (r, req, res) => {
  const { decision } = await readBody(req);
  await pressKey(r, decision === 'approve' ? 'approve' : 'reject');
  return send(res, 200, { ok: true });
});
route('POST', 'ask', async (r, req, res) => {
  const { id, answers, console: toConsole } = await readBody(req);
  return answerAsk(r, id, answers, !!toConsole)
    ? send(res, 200, { ok: true })
    : send(res, 404, { error: 'Esas preguntas ya no están pendientes.' });
});
// Aspecto que le eliges al robot: color, antena, visor y accesorio (los topes son los largos de ROBOT_COLORS,
// ANTENNAS, VISORS y HEAD_ACC en web/robot-art.js: si sumas opciones allá, súbelos aquí). reset vuelve al de su nombre.
route('POST', 'look', async (r, req, res) => {
  const b = await readBody(req);
  if (b.reset) {
    r.look = null;
    if (Number.isInteger(r.baseColor)) r.color = r.baseColor;
  } else {
    const lim = { ant: 4, visor: 6, acc: 10 },
      look = { ...(r.look || {}) };
    for (const [k, n] of Object.entries(lim))
      if (b[k] !== undefined) {
        const v = Number(b[k]);
        if (!Number.isInteger(v) || v < 0 || v >= n) return send(res, 400, { error: `Valor inválido para ${k}.` });
        look[k] = v;
      }
    if (b.color !== undefined) {
      const c = Number(b.color);
      if (!Number.isInteger(c) || c < 0 || c > 15) return send(res, 400, { error: 'Color inválido.' });
      if (!Number.isInteger(r.baseColor)) r.baseColor = r.color;
      r.color = c;
    }
    r.look = Object.keys(look).length ? look : null;
  }
  emit(r);
  return send(res, 200, { ok: true });
});
// Despedir con su resumen: le pide un super resumen (su próxima respuesta) y al recibirlo lo da de baja.
route('POST', 'despedir-con-resumen', async (r, req, res) => {
  if (r.state !== 'done' && !(r.state === 'input' && !r.needsPermission && !r.hold && !r.ask))
    return send(res, 409, { error: 'Está en medio de algo: espera a que termine su turno.' });
  if (isCold(r)) {
    // frío: despertarlo reescribiría toda su caché; el resumen lo arma la oficina, sin tokens
    await removeRobot(r, 'despedido con su resumen', officeSummary(r), 'oficina');
    return send(res, 200, { ok: true, by: 'oficina' });
  }
  r.summaryPending = true;
  log(r, 'sys', 'Le pediste su resumen para despedirlo');
  emit(r);
  await say(r, SUMMARY_ASK);
  return send(res, 200, { ok: true });
});
// Relevo por contexto: escribe su resumen, se da de baja y entra otro robot con su mismo nombre y solo ese resumen.
route('POST', 'relevar', async (r, req, res) => {
  if ((r.state !== 'done' && !(r.state === 'input' && !r.needsPermission && !r.hold && !r.ask)) || blockedBy(r))
    return send(res, 409, { error: 'Está en medio de algo: espera a que termine su turno.' });
  await startRelevo(r, 'manual');
  return send(res, 200, { ok: true });
});
route('POST', 'seguir-sin-relevo', async (r, req, res) => {
  snooze(r);
  return send(res, 200, { ok: true });
});
// Nota tuya pegada al robot («esperando respuesta de Ramiro»): se ve en la tarjeta, el mapa y el archivo.
route('POST', 'note', async (r, req, res) => {
  r.note = String((await readBody(req)).note ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  emit(r);
  return send(res, 200, { ok: true, note: r.note });
});
// Priority of the robot in the «waiting for you» queue: 'p0', 'p1' or '' (normal). Persisted with the robot state.
route('POST', 'priority', async (r, req, res) => {
  const p = String((await readBody(req)).priority ?? '').toLowerCase();
  if (!['', 'p0', 'p1', 'normal'].includes(p)) return send(res, 400, { error: 'La prioridad debe ser p0, p1 o normal.' });
  r.priority = p === 'p0' || p === 'p1' ? p : undefined;
  emit(r);
  return send(res, 200, { ok: true, priority: r.priority || null });
});
// Título que le pones tú al robot («Tareas de QA», «Revisando wallet#32 Ramiro»); vacío lo quita.
route('POST', 'title', async (r, req, res) => {
  r.title = cleanTitle((await readBody(req)).title);
  emit(r);
  return send(res, 200, { ok: true, title: r.title });
});
route('GET', 'pane', async (r, req, res) => send(res, 200, { text: await pane(r) }));
route('POST', 'sala', async (r, req, res) => {
  const out = moveToSala(r, (await readBody(req)).sala || null);
  return send(res, out.status, out.error ? { error: out.error } : { ok: true });
});
// Cambios: los archivos que tocó y cómo están en git; «abrir» lo muestra en el editor (diff contra HEAD si tiene cambios).
route('GET', 'cambios', async (r, req, res) => send(res, 200, await robotChanges(r)));
route('POST', 'cambios-abrir', async (r, req, res) => {
  const out = await openChange(r, (await readBody(req)).path);
  return send(res, out.status, out.error ? { error: out.error } : { ok: true, mode: out.mode });
});
route('POST', 'console', async (r, req, res) => {
  await openConsole(r);
  return send(res, 200, { ok: true });
});
route('DELETE', '', async (r, req, res) => {
  await removeRobot(r, 'dado de baja');
  return send(res, 200, { ok: true });
});

// Solo local: la oficina atiende únicamente peticiones a 127.0.0.1/localhost en su puerto (frena que un dominio
// externo se haga pasar por tu equipo) y que no vengan de otra página (un sitio abierto en tu navegador no puede
// lanzar robots, escribirles ni aprobarles permisos). La página de la oficina manda su propio Origin y los robots
// llaman con curl, sin Origin: los dos pasan.
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
function localOnly(req) {
  if (!LOCAL_HOSTS.has(String(req.headers.host || ''))) return 'Solo se atiende en 127.0.0.1 o localhost.';
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return 'Petición desde otra página: rechazada.';
  if (origin === 'null') return 'Petición desde otra página: rechazada.';
  return '';
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const denied = localOnly(req);
  if (denied) {
    console_(
      'oficina',
      'rechazada',
      `${req.method} ${url.pathname} · host ${req.headers.host || '-'} · origen ${req.headers.origin || '-'}`
    );
    return send(res, 403, { error: denied });
  }
  try {
    if (url.pathname === '/api/setup' && req.method === 'GET') return send(res, 200, setupView());
    if (url.pathname === '/api/setup/check' && req.method === 'POST') return send(res, 200, workspaceInfo((await readBody(req)).workspace));
    if (url.pathname === '/api/setup' && req.method === 'POST') {
      if (process.env.OFFICE_WORKSPACE)
        return send(res, 409, { error: 'La carpeta viene de OFFICE_WORKSPACE; cámbiala ahí y reinicia la oficina.' });
      if (robots.size) return send(res, 409, { error: 'Da de baja a los robots antes de cambiar la carpeta de trabajo.' });
      const { workspace, create } = await readBody(req);
      if (!String(workspace || '').trim()) return send(res, 400, { error: 'Escribe la ruta de la carpeta.' });
      let info = workspaceInfo(workspace);
      if (!info.exists && create) {
        fs.mkdirSync(info.path, { recursive: true });
        info = workspaceInfo(workspace);
      }
      if (!info.isDir)
        return send(res, 400, {
          error: info.exists ? 'Esa ruta es un archivo, no una carpeta.' : 'Esa carpeta no existe (marca «Crearla si no existe»).'
        });
      if (info.insideOffice) return send(res, 400, { error: 'Elige una carpeta fuera de la oficina.' });
      const first = !WORKSPACE;
      setWorkspace(saveWorkspace(info.path));
      resetRepoIndex();
      console.log(`Carpeta de trabajo: ${WORKSPACE}`);
      if (first) {
        loadSessions();
        await restore();
        resumeResults();
      }
      broadcast({ type: 'setup', setup: setupView(), skills: listSkills() });
      return send(res, 200, { ok: true, ...setupView(), info });
    }
    // Sin carpeta de trabajo solo funcionan la página y la configuración inicial.
    if (!WORKSPACE && parts[0] === 'api' && url.pathname !== '/api/events')
      return send(res, 409, { error: 'Elige primero la carpeta de trabajo.', setup: true });
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
      res.on('close', () => {
        if (!res.writableEnded)
          closers.splice(0).forEach(f => {
            try {
              f();
            } catch {
              /* ya resuelto */
            }
          });
      });
      return send(res, 200, await onHook(name, await readBody(req), url.searchParams.get('via') || '', closers));
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(
        `data: ${JSON.stringify({ type: 'snapshot', setup: setupView(), robots: [...robots.values()].map(r => view(r, true)), inbox, routines: routines.map(routineView), salas: salas.map(salaView), config: configView(), favorites, pins, archiveCount: archive.length, door: doorView(), fame })}\n\n`
      );
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/attachments') {
      if (Number(req.headers['content-length'] || 0) > ATTACH_MAX_BYTES) return send(res, 413, { error: 'El archivo supera 20 MB.' });
      const scope = (url.searchParams.get('scope') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'encargos';
      const safe =
        path
          .basename(url.searchParams.get('name') || 'adjunto')
          .replace(/[^\w.-]+/g, '_')
          .slice(-80) || 'adjunto';
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
        setOfficeName(
          String(body.name ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, OFFICE_NAME_MAX)
        );
        saveConfig({ name: officeName });
      }
      if (body.mapTheme !== undefined) {
        if (!MAP_THEMES.includes(body.mapTheme)) return send(res, 400, { error: 'Estilo de oficina desconocido.' });
        saveConfig({ mapTheme: body.mapTheme }); // estilo del mapa: es de la oficina, no del navegador
      }
      if (body.hoursOn !== undefined) saveConfig({ hoursOn: !!body.hoursOn }); // 6 · registrar las horas de trabajo
      if (body.maxRobots !== undefined) {
        const n = Number(body.maxRobots);
        if (!Number.isInteger(n) || n < 1 || n > MAX_ROBOTS_LIMIT)
          return send(res, 400, { error: `El tope debe estar entre 1 y ${MAX_ROBOTS_LIMIT}.` });
        setMaxRobots(n);
        saveState();
        if (spawnQueue.length) setTimeout(drainSpawnQueue, 0); // con más cupo, lo que espera en la puerta entra ya
      }
      broadcast({ type: 'config', config: configView() });
      return send(res, 200, configView());
    }
    if (req.method === 'GET' && url.pathname === '/api/usage') return send(res, 200, { weeks: officeUsage() });
    if (req.method === 'GET' && url.pathname === '/api/fama') return send(res, 200, { weeks: fameWall(4) });
    if (req.method === 'GET' && url.pathname === '/api/claude-status')
      return send(res, 200, await claudeStatus(url.searchParams.get('refresh') === '1'));
    if (req.method === 'GET' && url.pathname === '/api/skills') return send(res, 200, { skills: listSkills() });
    // Repos de la carpeta de trabajo (primer nivel con .git): el autocompletado del chat los sugiere.
    if (req.method === 'GET' && url.pathname === '/api/vocab') {
      let repos = [];
      try {
        repos = fs
          .readdirSync(WORKSPACE, { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(WORKSPACE, e.name, '.git')))
          .map(e => e.name)
          .sort();
      } catch {
        /* sin carpeta */
      }
      return send(res, 200, { repos });
    }
    if (await rutinasApi(req, res, url, parts)) return;
    if (await mantenimientoApi(req, res, url)) return;
    if (await salasApi(req, res, url, parts)) return;
    if (await frecuentesApi(req, res, url, parts)) return;
    if (await despedidosApi(req, res, url, parts)) return;
    if (await fijadosApi(req, res, url, parts)) return;
    if (req.method === 'POST' && url.pathname === '/api/robots') {
      const out = await launchOrQueue(await readBody(req));
      if (out.queued) return send(res, 202, { ok: true, queued: true, id: out.queued.id, title: out.queued.title, position: out.position });
      return send(res, 201, { ok: true, name: out.robot.name });
    }
    if (await puertaApi(req, res, url, parts)) return;
    if (parts[0] === 'api' && parts[1] === 'robots' && parts[2]) {
      const r = robotOr404(res, parts[2]);
      if (!r) return;
      const action = parts[3];
      if (await equipoRobotApi(req, res, url, parts, r, action)) return;
      const handler = ROBOT_ROUTES.get(`${req.method} ${action || ''}`);
      if (handler) return await handler(r, req, res); // con await: si falla, lo atrapa el catch de abajo (si no, el daemon se cae)
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
    if (req.method === 'POST' && url.pathname === '/api/inbox/seen-many') {
      // Marks several items at once (a group in the inbox panel); unknown ids are ignored.
      const { ids } = await readBody(req);
      if (!Array.isArray(ids)) return send(res, 400, { error: 'Faltan los documentos a marcar.' });
      const set = new Set(ids.map(String));
      let n = 0;
      for (const it of inbox) {
        if (set.has(it.id) && it.status !== 'visto') {
          it.status = 'visto';
          n++;
        }
      }
      emitInbox();
      return send(res, 200, { ok: true, marked: n });
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

export { readBody, readRaw, send, server };
