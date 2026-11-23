// Pruebas de la oficina contra un daemon real aislado y un Claude falso (no gastan cuota).
// Correr: node --test test/      (necesita tmux; cada prueba usa su propia sesión y carpeta temporal)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { startOffice, waitFor, sleep, turn } from './helpers.mjs';

const libre = (name, text = 'Responde solo: ok') => ({ kind: 'libre', name, text });

test('arranca y entrega el estado completo', async () => {
  const o = await startOffice();
  try {
    const s = await o.snapshot();
    assert.equal(s.type, 'snapshot');
    assert.deepEqual(s.robots, []);
    assert.ok(s.config && Array.isArray(s.routines) && Array.isArray(s.pins));
  } finally {
    await o.stop();
  }
});

test('lanza un robot con el Claude falso y no abre dos con el mismo nombre', async () => {
  const o = await startOffice();
  try {
    const r = await o.api('POST', '/api/robots', libre('uno'));
    assert.equal(r.status, 201);
    await waitFor(() => o.windows().includes('uno'), { what: 'la consola del robot' });
    await waitFor(() => o.claudeCalls().some(c => c.includes('--session-id')), { what: 'que se abra Claude con su sesión' });
    // Doble clic: dos pedidos iguales casi a la vez → entra uno solo.
    const [a, b] = await Promise.all([o.api('POST', '/api/robots', libre('dos')), o.api('POST', '/api/robots', libre('dos'))]);
    assert.deepEqual([a.status, b.status].sort(), [201, 400]);
    await sleep(300);
    assert.equal(o.windows().filter(w => w === 'dos').length, 1);
  } finally {
    await o.stop();
  }
});

test('un turno simulado deja al robot listo con su respuesta', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', libre('uno'));
    await turn(o, 'uno', 'hola', 'Hecho: revisé todo.');
    const r = await o.robot('uno');
    assert.equal(r.state, 'done');
    assert.match(r.bubble, /Hecho/);
    assert.ok(r.log.some(l => l.kind === 'user' && l.text === 'hola'));
  } finally {
    await o.stop();
  }
});

test('una pregunta con opciones se retiene y se responde desde la oficina', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', libre('uno'));
    const q = { question: '¿Rojo o azul?', header: 'Color', multiSelect: false, options: [{ label: 'Rojo' }, { label: 'Azul' }] };
    const pending = o.hook('uno', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [q] } }, 'ask');
    const r = await waitFor(async () => (await o.robot('uno'))?.ask && (await o.robot('uno')), { what: 'la pregunta en la oficina' });
    const ans = await o.api('POST', '/api/robots/uno/ask', { id: r.ask.id, answers: { '¿Rojo o azul?': 'Azul' } });
    assert.equal(ans.status, 200);
    const out = await pending;
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(out.hookSpecificOutput.updatedInput.answers['¿Rojo o azul?'], 'Azul');
  } finally {
    await o.stop();
  }
});

test('si la consola cancela la pregunta, la oficina la quita sola', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', libre('uno'));
    const ac = new AbortController();
    const q = { question: '¿Sí?', options: [{ label: 'Sí' }, { label: 'No' }] };
    fetch(`${o.url}/hook?robot=uno&via=ask`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [q] } })
    }).catch(() => {});
    await waitFor(async () => (await o.robot('uno'))?.ask, { what: 'la pregunta' });
    ac.abort();
    await waitFor(async () => !(await o.robot('uno')).ask, { what: 'que se quite la pregunta' });
  } finally {
    await o.stop();
  }
});

test('consola caída: se detecta sin borrar al robot y «Revivir» abre su misma sesión', async () => {
  const o = await startOffice({ robots: [{ name: 'vivo', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }] });
  try {
    fs.mkdirSync(path.dirname(o.data), { recursive: true });
    const { execFileSync } = await import('node:child_process');
    execFileSync('tmux', ['kill-window', '-t', `${o.session}:vivo`]);
    await waitFor(async () => (await o.robot('vivo'))?.consoleLost, { what: 'la consola caída' });
    const say = await o.api('POST', '/api/robots/vivo/say', { text: 'hola' });
    assert.equal(say.status, 409, 'no deja escribirle mientras está caído');
    const rv = await o.api('POST', '/api/robots/vivo/revivir');
    assert.equal(rv.status, 200);
    await waitFor(() => o.windows().includes('vivo'), { what: 'la consola nueva' });
    await waitFor(() => o.claudeCalls().some(c => c.includes('--resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')), {
      what: 'que se retome la misma sesión'
    });
    assert.equal((await o.robot('vivo')).consoleLost, false);
  } finally {
    await o.stop();
  }
});

test('un robot pide robots: apruebas con cambios, entran según el cupo y los demás esperan', async () => {
  const o = await startOffice({ maxRobots: 2 });
  try {
    await o.api('POST', '/api/robots', libre('padre'));
    const req = await o.api('POST', '/api/robots/padre/encargos', {
      encargos: [
        { titulo: 'Uno', encargo: 'haz uno' },
        { titulo: 'Dos', encargo: 'haz dos' },
        { titulo: 'Tres', encargo: 'haz tres' }
      ]
    });
    assert.equal(req.status, 202);
    assert.equal((await o.robot('padre')).spawnReq.items.length, 3);
    const items = [
      { title: 'Uno editado', text: 'haz uno' },
      { title: 'Dos', text: 'haz dos' }
    ]; // el tercero lo desmarcaste
    const ok = await o.api('POST', `/api/robots/padre/encargos/${req.body.id}`, { decision: 'approve', items });
    assert.equal(ok.body.launched.length, 1, 'con tope 2 entra uno (el padre ocupa el otro)');
    assert.equal(ok.body.queued, 1);
    const kids = (await o.robot('padre')).kids;
    assert.equal(kids.length, 2);
    const kid = await o.robot(ok.body.launched[0]);
    assert.equal(kid.parent, 'padre');
    assert.equal(kid.title, 'Uno editado');
    // Quitar el que espera en la puerta.
    const q = kids.find(k => k.state === 'queued');
    assert.equal((await o.api('POST', `/api/robots/padre/cola/${q.qid}`)).status, 200);
    assert.equal((await o.robot('padre')).kids.length, 1);
  } finally {
    await o.stop();
  }
});

test('un robot pide robots: él y sus hijos quedan en una sala de equipo con su contexto, y se cierra sola al irse todos', async () => {
  const o = await startOffice({ maxRobots: 4 });
  try {
    await o.api('POST', '/api/robots', { ...libre('jefe'), title: 'Migrar wallet' });
    assert.equal((await o.robot('jefe')).place.type, 'desk');
    const req = await o.api('POST', '/api/robots/jefe/encargos', {
      contexto: 'El saldo vive en wallet_balances; no tocar el legacy.',
      encargos: [
        { titulo: 'Uno', encargo: 'haz uno' },
        { titulo: 'Dos', encargo: 'haz dos' }
      ]
    });
    assert.equal((await o.robot('jefe')).spawnReq.context, 'El saldo vive en wallet_balances; no tocar el legacy.');
    const ok = await o.api('POST', `/api/robots/jefe/encargos/${req.body.id}`, { decision: 'approve' });
    assert.equal(ok.body.launched.length, 2);
    let snap = await o.snapshot();
    const sala = snap.salas.find(s => s.id === ok.body.sala);
    assert.ok(sala?.auto, 'se crea una sala de equipo');
    assert.equal(sala.owner, 'jefe');
    assert.match(sala.name, /jefe.*Migrar wallet/);
    // Los hijos se llaman por lo que hacen (sin tildes ni palabras vacías), no con nombres genéricos.
    assert.deepEqual(ok.body.launched.sort(), ['dos', 'uno']);
    const r3 = await o.api('POST', '/api/robots/jefe/encargos', {
      encargos: [
        { titulo: 'Revisión de los puertos', encargo: 'x' },
        { titulo: 'Uno', encargo: 'otra vez' },
        { nombre: 'mi-nombre', titulo: 'Cualquiera', encargo: 'y' }
      ]
    });
    // Los nombres quedan fijos desde la petición (sin chocar con los que ya están) y la respuesta se los dice al padre.
    assert.deepEqual(
      (await o.robot('jefe')).spawnReq.items.map(i => i.name),
      ['revision-puertos', 'uno-2', 'mi-nombre']
    );
    assert.deepEqual(
      r3.body.equipo.map(e => e.nombre),
      ['revision-puertos', 'uno-2', 'mi-nombre']
    );
    assert.match(r3.body.mensaje, /revision-puertos \(Revisión de los puertos\), uno-2 \(Uno\), mi-nombre \(Cualquiera\)/);
    await o.api('POST', `/api/robots/jefe/encargos/${r3.body.id}`, { decision: 'reject' });
    for (const n of ['jefe', ...ok.body.launched])
      assert.equal(snap.robots.find(r => r.name === n).place.sala, sala.id, `${n} está en la sala`);
    const ctx = fs.readFileSync(sala.context, 'utf8');
    assert.match(ctx, /wallet_balances/);
    // Reparto con nombre · tarea · estado: en REPARTO.md y en la sala (el tablero), NO en CONTEXT.md, que es de los robots.
    const reparto = () => fs.readFileSync(path.join(path.dirname(sala.context), 'REPARTO.md'), 'utf8');
    assert.match(reparto(), /- `jefe` · Migrar wallet · coordina\n- `uno` · Uno · trabajando\n- `dos` · Dos · trabajando/);
    assert.doesNotMatch(ctx, /## Reparto/, 'la oficina no reescribe el archivo que editan los robots');
    assert.deepEqual(
      snap.salas.find(x => x.id === sala.id).roster.map(e => `${e.name}:${e.state}`),
      ['jefe:coordina', 'uno:trabajando', 'dos:trabajando']
    );
    // Cada hijo sabe quién es quién y se ve a sí mismo como «tú».
    await waitFor(
      () => o.claudeCalls().join('\n').includes('- `dos` · Dos · tú') && o.claudeCalls().join('\n').includes('- `uno` · Uno · tú'),
      { what: 'que los hijos reciban quién es quién' }
    );
    // Los hijos arrancan sabiendo de la sala; al padre se le avisa por su consola.
    await waitFor(() => o.claudeCalls().filter(c => c.includes(sala.context)).length >= 2, {
      what: 'que los hijos reciban la ruta del CONTEXT.md'
    });
    // Un hijo que pide robots: los suyos entran a la misma sala, sin crear otra.
    const kid = ok.body.launched[0];
    const r2 = await o.api('POST', `/api/robots/${kid}/encargos`, { encargos: [{ titulo: 'Tres', encargo: 'haz tres' }] });
    const ok2 = await o.api('POST', `/api/robots/${kid}/encargos/${r2.body.id}`, { decision: 'approve' });
    assert.equal(ok2.body.sala, sala.id);
    snap = await o.snapshot();
    assert.equal(snap.salas.filter(s => s.auto).length, 1);
    assert.match(reparto(), /- `tres` · Tres · trabajando/);
    assert.doesNotMatch(fs.readFileSync(sala.context, 'utf8'), /## Reparto/);
    // Equipo terminado: cuando todos los hijos entregaron, la sala queda marcada (una sola vez).
    const kids = snap.robots.filter(r => r.place.sala === sala.id && r.parent).map(r => r.name);
    assert.equal(kids.length, 3);
    for (const k of kids.slice(0, -1)) await turn(o, k, 'encargo', `Hecho por ${k}`);
    assert.ok(!(await o.snapshot()).salas.find(s => s.id === sala.id).done, 'falta uno por entregar');
    await turn(o, kids.at(-1), 'encargo', 'Hecho');
    await waitFor(async () => (await o.snapshot()).salas.find(s => s.id === sala.id).done, { what: 'que el equipo quede terminado' });
    assert.match(reparto(), /- `uno` · Uno · entregó/);
    // Mientras quede algún hijo la sala sigue; si el padre queda solo, vuelve a un escritorio y la sala pasa al archivo.
    for (const n of kids.slice(0, -1)) await o.api('DELETE', `/api/robots/${n}`);
    assert.ok((await o.snapshot()).salas.some(s => s.id === sala.id));
    await o.api('DELETE', `/api/robots/${kids.at(-1)}`);
    snap = await o.snapshot();
    assert.ok(!snap.salas.some(s => s.id === sala.id), 'la sala de equipo se cierra sola');
    assert.equal(snap.robots.find(r => r.name === 'jefe').place.type, 'desk', 'el padre vuelve a su escritorio');
    const cerradas = (await o.api('GET', '/api/salas-cerradas')).body.salas;
    assert.equal(cerradas[0].id, sala.id);
    assert.match(cerradas[0].purpose, /jefe armó este equipo/);
    assert.equal(
      (await o.api('GET', `/api/doc?path=${encodeURIComponent(cerradas[0].context)}`)).status,
      200,
      'su contexto se puede abrir desde el archivo'
    );
    assert.ok(fs.existsSync(sala.context), 'sus archivos quedan');
    assert.match(reparto(), /- `uno` · Uno · se fue/);
    // El buscador encuentra la sala cerrada por su contexto (sin tildes ni mayúsculas) y por su hilo.
    const found = (await o.api('GET', `/api/salas-cerradas?q=${encodeURIComponent('WALLET_BALANCES')}`)).body.results;
    assert.equal(found[0].id, sala.id);
    assert.equal(found[0].hits[0].where, 'contexto');
    assert.deepEqual((await o.api('GET', '/api/salas-cerradas?q=zzzz-nada')).body.results, []);
    // Borrar la sala cerrada: sale del archivo y su carpeta va a la papelera (aquí una temporal de la prueba).
    const del = await o.api('DELETE', `/api/salas-cerradas/${sala.id}`);
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(sala.context), 'su contexto ya no está en la oficina');
    assert.ok(fs.existsSync(path.join(del.body.papelera, 'CONTEXT.md')), 'quedó en la papelera');
    assert.ok(!(await o.api('GET', '/api/salas-cerradas')).body.salas.some(x => x.id === sala.id));
    assert.equal((await o.api('DELETE', `/api/salas-cerradas/${sala.id}`)).status, 404);
  } finally {
    await o.stop();
  }
});

test('plantas: crecen con las tareas de la semana de la cuota y al renovarse se cambian las materas', async () => {
  // Una semana vieja con muchas tareas: al arrancar, la semana ya cambió.
  const o = await startOffice({
    files: {
      'estadisticas.json': JSON.stringify({ total: 334, reviews: 0, day: '2026-01-01', today: 0, week: { from: 1, count: 250, n: 2 } })
    }
  });
  try {
    let s = (await o.snapshot()).config.stats;
    assert.equal(s.total, 334, 'el total sigue (trofeos)');
    assert.equal(s.week, 0, 'la semana nueva arranca en 0');
    assert.equal(s.pot, 3, 'otra matera');
    assert.ok(s.repotAt, 'queda anotado el cambio de materas');
    const at = s.repotAt;
    await o.api('POST', '/api/robots', libre('uno'));
    await turn(o, 'uno', 'hola', 'listo');
    await waitFor(async () => (await o.snapshot()).config.stats.week === 1, { what: 'que la tarea cuente en la semana' });
    s = (await o.snapshot()).config.stats;
    assert.equal(s.total, 335);
    assert.equal(s.repotAt, at, 'no se repite el cambio en la misma semana');
  } finally {
    await o.stop();
  }
});

test('resultados de los hijos: sin esperar a los hermanos si el padre está libre, juntos si llegan mientras trabaja, y sin turno extra al aprobar', async () => {
  const o = await startOffice({ maxRobots: 5, env: { OFFICE_RESULT_DEBOUNCE_MS: '300' } });
  const sentLog = async () => (await o.robot('jefe')).log.filter(l => /^Te lleg/.test(l.text)).map(l => l.text);
  try {
    await o.api('POST', '/api/robots', libre('jefe'));
    await turn(o, 'jefe', 'arranca', 'Pido robots'); // el padre queda libre
    const req = await o.api('POST', '/api/robots/jefe/encargos', {
      contexto: 'Dato que todos deben saber',
      encargos: [
        { titulo: 'Uno', encargo: 'a' },
        { titulo: 'Dos', encargo: 'b' },
        { titulo: 'Tres', encargo: 'c' }
      ]
    });
    assert.match(req.body.mensaje, /CONTEXT\.md/, 'el padre sabe desde ya dónde estará el contexto compartido');
    const ok = await o.api('POST', `/api/robots/jefe/encargos/${req.body.id}`, { decision: 'approve' });
    assert.equal((await o.snapshot()).salas.find(x => x.id === ok.body.sala).context, req.body.contexto, 'es la misma ruta');
    await sleep(600);
    assert.deepEqual(await sentLog(), [], 'aprobar no le escribe al padre (no le abre un turno)');
    // Se cuentan apariciones, no líneas: los Claude falsos arrancan a la vez y sus líneas del registro pueden mezclarse.
    await waitFor(() => o.claudeCalls().join('\n').split('Dato que todos deben saber').length - 1 >= 3, {
      what: 'que los hijos arranquen con el contexto'
    });
    const [k1, k2, k3] = ok.body.launched;
    // Padre libre: el primero le llega sin esperar a sus hermanos.
    await turn(o, k1, 'encargo', 'Resultado UNO');
    await waitFor(async () => (await sentLog()).length === 1, { what: 'el primer resultado' });
    assert.match((await sentLog())[0], new RegExp(k1));
    // Padre ocupado: los que terminan mientras trabaja se guardan y le llegan juntos al cerrar su turno.
    await o.hook('jefe', { hook_event_name: 'UserPromptSubmit', prompt: 'integra' });
    await turn(o, k2, 'encargo', 'Resultado DOS');
    await turn(o, k3, 'encargo', 'Resultado TRES');
    await sleep(800);
    assert.equal((await sentLog()).length, 1, 'mientras trabaja no se le escribe');
    await o.hook('jefe', { hook_event_name: 'Stop', last_assistant_message: 'Integré UNO' });
    await waitFor(async () => (await sentLog()).length === 2, { what: 'los resultados guardados' });
    assert.match((await sentLog())[1], new RegExp(`juntos los resultados de ${k2}, ${k3}`));
  } finally {
    await o.stop();
  }
});

test('equipo: el gasto de la sala suma a todos (también a los que se fueron) y «Despedir equipo» saca solo a los que entregaron', async () => {
  const o = await startOffice({ maxRobots: 5, env: { OFFICE_SPEND_TICK_MS: '300', OFFICE_RESULT_DEBOUNCE_MS: '300' } });
  try {
    await o.api('POST', '/api/robots', libre('jefe'));
    await turn(o, 'jefe', 'arranca', 'Pido robots');
    const req = await o.api('POST', '/api/robots/jefe/encargos', {
      encargos: [
        { titulo: 'Uno', encargo: 'a' },
        { titulo: 'Dos', encargo: 'b' }
      ]
    });
    const ok = await o.api('POST', `/api/robots/jefe/encargos/${req.body.id}`, { decision: 'approve' });
    const [k1, k2] = ok.body.launched;
    // Transcript de uno de los hijos con un mensaje que gastó 100 + 50 + 10 (caché escrita).
    const tr = path.join(o.base, `${k1}.jsonl`);
    fs.writeFileSync(
      tr,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          id: 'm1',
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 9999 },
          content: []
        }
      }) + '\n'
    );
    await o.hook(k1, { hook_event_name: 'SessionStart', source: 'startup', session_id: 'sesion-k1', transcript_path: tr });
    await waitFor(async () => (await o.snapshot()).salas.find(x => x.id === ok.body.sala)?.spend === 160, { what: 'el gasto del equipo' });
    // Uno entrega, el otro sigue: «Despedir equipo» saca solo al que entregó.
    await turn(o, k1, 'encargo', 'Hecho UNO');
    await waitFor(async () => (await o.robot(k1)).reported, { what: 'que entregue' });
    const d = await o.api('POST', `/api/salas/${ok.body.sala}/despedir-equipo`);
    assert.deepEqual(d.body.despedidos, [k1]);
    assert.equal(d.body.quedan, 2, 'quedan el padre y el que sigue trabajando');
    assert.ok(!(await o.robot(k1)) && (await o.robot(k2)) && (await o.robot('jefe')));
    // Su gasto sigue contando aunque se haya ido.
    await sleep(900);
    assert.equal((await o.snapshot()).salas.find(x => x.id === ok.body.sala).spend, 160);
  } finally {
    await o.stop();
  }
});

test('solo local: rechaza peticiones desde otra página o a otro host, y deja pasar a la oficina y a los robots', async () => {
  const o = await startOffice();
  const url = `http://127.0.0.1:${o.port}/api/robots`;
  const body = JSON.stringify({ kind: 'libre', name: 'intruso', text: 'haz algo', permissionMode: 'auto' });
  try {
    // Una página cualquiera (petición «simple», sin pre-chequeo CORS): rechazada, y no entra ningún robot.
    const ajena = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://pagina-cualquiera.example' },
      body
    });
    assert.equal(ajena.status, 403);
    const nula = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: 'null' }, body });
    assert.equal(nula.status, 403, 'tampoco desde un iframe o archivo local (Origin: null)');
    assert.equal(await o.robot('intruso'), undefined);
    // Otro host (un dominio externo que apunta a tu equipo): rechazado, también para leer.
    const { request } = await import('node:http');
    const status = await new Promise((res, rej) =>
      request({ host: '127.0.0.1', port: o.port, path: '/api/setup', headers: { Host: `evil.example:${o.port}` } }, r => {
        r.resume();
        res(r.statusCode);
      })
        .on('error', rej)
        .end()
    );
    assert.equal(status, 403);
    // La página de la oficina (su propio Origin) y los robots (curl, sin Origin) siguen pasando.
    const propia = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${o.port}` },
      body: JSON.stringify({ kind: 'libre', name: 'propio', text: 'ok' })
    });
    assert.equal(propia.status, 201);
    const local = await fetch(url.replace('127.0.0.1', 'localhost'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${o.port}` },
      body: JSON.stringify({ kind: 'libre', name: 'porlocalhost', text: 'ok' })
    });
    assert.equal(local.status, 201, 'abrir la oficina como localhost también vale');
  } finally {
    await o.stop();
  }
});

test('gasto por robot: el «% sem.» usa la semana de la cuota, la misma del empleado de la semana (cuadran)', async () => {
  // La cuota se renovó hace 6 días: un gasto de hace 5 días cuenta aunque sea de la semana del calendario anterior.
  const weekEnd = Date.now() + 86400e3;
  const o = await startOffice({ env: { OFFICE_SPEND_TICK_MS: '300' }, files: { 'config.json': JSON.stringify({ quota: { weekEnd } }) } });
  try {
    const msg = (id, daysAgo, out) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(Date.now() - daysAgo * 86400e3).toISOString(),
        message: { id, usage: { input_tokens: 0, output_tokens: out }, content: [] }
      }) + '\n';
    for (const [n, lines] of [
      ['viejo', [msg('a1', 5, 600)]],
      ['nuevo', [msg('b1', 0.01, 400)]]
    ]) {
      await o.api('POST', '/api/robots', libre(n));
      const tr = path.join(o.base, `${n}.jsonl`);
      fs.writeFileSync(tr, lines.join(''));
      await o.hook(n, { hook_event_name: 'SessionStart', source: 'startup', session_id: `s-${n}`, transcript_path: tr });
    }
    const viejo = await waitFor(
      async () => {
        const r = await o.robot('viejo');
        return r?.spend?.officeWeek === 1000 && r;
      },
      { what: 'el gasto de la semana de la cuota' }
    );
    assert.equal(viejo.spend.week, 600, 'cuenta lo de hace 5 días (dentro de la semana de la cuota)');
    assert.equal(viejo.spend.pct, 60);
    assert.equal((await o.robot('nuevo')).spend.pct, 40);
    const fame = (await o.snapshot()).fame;
    assert.equal(fame.employee.name, 'viejo', 'el de mayor % es el empleado de la semana');
    assert.equal(fame.employee.tokens, viejo.spend.week);
  } finally {
    await o.stop();
  }
});

test('detector de bucles: marca ⟳ a la 4.ª repetición idéntica, se apaga al cambiar de acción y al cerrar el turno', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', libre('uno'));
    await o.hook('uno', { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    const bash = cmd =>
      o.hook('uno', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: Math.random().toString(36),
        tool_input: { command: cmd }
      });
    for (let k = 0; k < 3; k++) await bash('npm test');
    assert.equal((await o.robot('uno')).loop, null, 'tres veces todavía no');
    await bash('npm test');
    const r = await o.robot('uno');
    assert.equal(r.loop.n, 4);
    assert.match(r.loop.what, /npm test/);
    assert.ok(r.log.some(l => /Posible bucle/.test(l.text)));
    await bash('npm run lint');
    assert.equal((await o.robot('uno')).loop, null, 'cambió de acción: ya salió');
    for (let k = 0; k < 4; k++) await bash('ls');
    assert.ok((await o.robot('uno')).loop);
    await o.hook('uno', { hook_event_name: 'Stop', last_assistant_message: 'listo' });
    assert.equal((await o.robot('uno')).loop, null, 'al cerrar el turno se limpia');
  } finally {
    await o.stop();
  }
});

test('exportar sala, muro de la fama e historial de la cuota', async () => {
  const o = await startOffice({
    env: { OFFICE_SPEND_TICK_MS: '300' },
    files: {
      'config.json': JSON.stringify({
        quota: { weekEnd: Date.now() + 86400e3, history: { '2026-11-18': 60, '2026-11-04': 30, '2026-11-11': 75 } }
      })
    }
  });
  try {
    // Exportar una sala: .md en docs/salas con porqué, contexto e hilo, y se puede abrir.
    const s = await o.api('POST', '/api/salas', {
      name: 'Épica de pagos',
      key: 'TECH-9',
      context: '# Contexto\n\nEl saldo vive en wallet_balances.'
    });
    await o.api('POST', `/api/salas/${s.body.id}/hilo`, { text: 'Arranco por los puertos' });
    const ex = await o.api('POST', `/api/salas/${s.body.id}/exportar`);
    assert.equal(ex.status, 200);
    assert.ok(ex.body.path.startsWith(path.join(o.ws, 'docs', 'salas')));
    const md = fs.readFileSync(ex.body.path, 'utf8');
    assert.match(md, /# Sala «Épica de pagos» \(TECH-9\)/);
    assert.match(md, /wallet_balances/);
    assert.match(md, /## Hilo[\s\S]*Arranco por los puertos/);
    assert.equal((await o.api('GET', `/api/doc?path=${encodeURIComponent(ex.body.path)}`)).status, 200);
    // Muro de la fama: 4 semanas, con el que más gastó en la actual.
    await o.api('POST', '/api/robots', libre('gasta'));
    const tr = path.join(o.base, 'gasta.jsonl');
    fs.writeFileSync(
      tr,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { id: 'g1', usage: { input_tokens: 0, output_tokens: 777 }, content: [] }
      }) + '\n'
    );
    await o.hook('gasta', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's-gasta', transcript_path: tr });
    const wall = await waitFor(
      async () => {
        const w = (await o.api('GET', '/api/fama')).body.weeks;
        return w[0].name === 'gasta' && w;
      },
      { what: 'el muro de la fama' }
    );
    assert.equal(wall.length, 4);
    assert.equal(wall[0].current, true);
    assert.equal(wall[0].tokens, 777);
    assert.equal(wall[1].name, null, 'la semana anterior no gastó nadie');
    // Historial de la cuota: en orden por semana.
    assert.deepEqual(
      (await o.snapshot()).config.stats.quotaHistory.map(x => x.pct),
      [30, 75, 60]
    );
  } finally {
    await o.stop();
  }
});

test('oficina llena: tu encargo espera en la puerta, se puede sacar y entra solo al liberarse un escritorio', async () => {
  const o = await startOffice({ maxRobots: 1 });
  try {
    assert.equal((await o.api('POST', '/api/robots', libre('uno'))).status, 201);
    // Sin pedir cola (curl de robots y rutinas): sigue el error de siempre.
    const sin = await o.api('POST', '/api/robots', libre('dos'));
    assert.equal(sin.status, 400);
    assert.match(sin.body.error, /tope/);
    // Desde «Nuevo encargo» (queue: true): queda en la puerta.
    const q1 = await o.api('POST', '/api/robots', { ...libre('dos', 'Revisa el PR 7'), queue: true });
    assert.equal(q1.status, 202);
    assert.equal(q1.body.position, 1);
    const q2 = await o.api('POST', '/api/robots', { kind: 'libre', text: 'Otra cosa', title: 'Otra', queue: true });
    assert.equal(q2.body.position, 2);
    // El nombre no se repite ni con los que esperan, y una rutina nunca se encola (ella reintenta sola).
    assert.equal((await o.api('POST', '/api/robots', { ...libre('dos'), queue: true })).status, 400);
    assert.equal((await o.api('POST', '/api/robots', { ...libre('tres'), queue: true, routine: 'rt1' })).status, 400);
    let door = (await o.snapshot()).door;
    assert.deepEqual(
      door.map(d => d.name),
      ['dos', null]
    );
    assert.equal(door[1].title, 'Otra');
    // Sacar el segundo de la puerta.
    assert.equal((await o.api('DELETE', `/api/puerta/${q2.body.id}`)).status, 200);
    assert.equal((await o.api('DELETE', `/api/puerta/${q2.body.id}`)).status, 404);
    assert.equal((await o.snapshot()).door.length, 1);
    // «uno» termina su turno: queda un escritorio libre y «dos» entra solo.
    await turn(o, 'uno', 'hola', 'listo');
    await waitFor(() => o.windows().includes('dos'), { timeout: 12000, what: 'que entre el que esperaba en la puerta' });
    await waitFor(() => o.claudeCalls().some(c => c.includes('Revisa el PR 7')), { what: 'su encargo' });
    assert.match((await o.robot('dos')).origin, /esperó cupo en la puerta/);
    assert.equal((await o.snapshot()).door.length, 0);
  } finally {
    await o.stop();
  }
});

test('oficina llena: subir el tope con + deja entrar de inmediato lo que espera en la puerta', async () => {
  const o = await startOffice({ maxRobots: 1 });
  try {
    await o.api('POST', '/api/robots', libre('uno'));
    assert.equal((await o.api('POST', '/api/robots', { ...libre('dos'), queue: true })).status, 202);
    await o.api('POST', '/api/config', { maxRobots: 2 });
    await waitFor(() => o.windows().includes('dos'), { timeout: 3000, what: 'que entre sin esperar la revisión de 5 s' });
  } finally {
    await o.stop();
  }
});

test('despedir deja un resumen en docs/resumenes-robots y con él se retoma la tarea', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', { ...libre('memo', 'Revisa el PR 42'), title: 'PR 42' });
    await turn(o, 'memo', 'sigue', 'Falta el service; esperamos a Ramiro.');
    await o.api('POST', '/api/robots/memo/note', { note: 'esperando a Ramiro' });
    // «Dar de baja» es solo eso: sin resumen, sin documento y sin archivo.
    await o.api('POST', '/api/robots', libre('baja'));
    await turn(o, 'baja', 'hola', 'Hice algo');
    assert.equal((await o.api('DELETE', '/api/robots/baja')).status, 200);
    assert.equal((await o.api('GET', '/api/despedidos?all=1')).body.recent.length, 0);
    assert.ok(!fs.existsSync(path.join(o.ws, 'docs', 'resumenes-robots')), 'no escribe resumen');
    // «Despedir con su resumen»: le pide el resumen y se va al recibirlo.
    assert.equal((await o.api('POST', '/api/robots/memo/despedir-con-resumen')).status, 200);
    await o.hook('memo', {
      hook_event_name: 'Stop',
      last_assistant_message: '## Traspaso\n- Falta revisar el service del PR 42.\n- Esperamos a Ramiro.'
    });
    await waitFor(async () => !(await o.robot('memo')), { what: 'que se vaya' });
    const list = (await o.api('GET', '/api/despedidos?all=1')).body.recent;
    assert.equal(list[0].name, 'memo');
    assert.equal(list[0].summaryBy, 'robot');
    assert.ok(list[0].summaryPath.startsWith(path.join(o.ws, 'docs', 'resumenes-robots')));
    assert.match(fs.readFileSync(list[0].summaryPath, 'utf8'), /Falta revisar el service/);
    const summaryPath = list[0].summaryPath,
      memoId = list[0].id;
    // Retomar: entra un robot nuevo solo con el resumen.
    const rt = await o.api('POST', `/api/despedidos/${list[0].id}/retomar`, { text: '¿Qué esperábamos?' });
    assert.equal(rt.status, 201);
    // La ventana aparece antes de que el Claude falso anote su llamada: se espera la del robot que retoma.
    const call = await waitFor(() => o.claudeCalls().find(c => c.includes('Retomas una tarea')), {
      what: 'la llamada del robot que retoma'
    });
    assert.match(call, /Retomas una tarea que dejó el robot memo/);
    assert.match(call, /Falta revisar el service/);
    const r = await o.robot(rt.body.name);
    assert.equal(r.title, 'PR 42');
    assert.equal(r.note, 'esperando a Ramiro');
    // Dar de baja normal: se va sin resumen y no entra al archivo.
    await turn(o, rt.body.name, '¿Qué esperábamos?', 'Esperábamos a Ramiro para el service.');
    await o.api('DELETE', `/api/robots/${rt.body.name}`);
    const again = (await o.api('GET', '/api/despedidos?all=1')).body.recent;
    assert.deepEqual(
      again.map(a => a.name),
      ['memo']
    );
    // «Quitar»: sale de la lista y su resumen va a la papelera (aquí una temporal de la prueba).
    const q = await o.api('DELETE', `/api/despedidos/${memoId}`);
    assert.equal(q.status, 200);
    assert.ok(!fs.existsSync(summaryPath), 'el resumen ya no está en docs/resumenes-robots');
    assert.match(fs.readFileSync(q.body.papelera, 'utf8'), /Falta revisar el service/);
    assert.equal((await o.api('GET', '/api/despedidos?all=1')).body.recent.length, 0);
  } finally {
    await o.stop();
  }
});

test('rutinas: vista previa, horarios, edición y despertador que se cumple', async () => {
  const o = await startOffice();
  try {
    const pv = await o.api('POST', '/api/routines/preview', {
      type: 'agenda',
      text: 'x',
      schedule: { mode: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }
    });
    assert.equal(pv.body.next.length, 4);
    assert.ok(pv.body.next.every(t => [1, 2, 3, 4, 5].includes(new Date(t).getDay()) && new Date(t).getHours() === 8));
    assert.equal(
      (await o.api('POST', '/api/routines', { type: 'agenda', text: 'x', schedule: { mode: 'daily', time: '8', days: [1] } })).status,
      400
    );
    // Despertador por hora (ya pasada): se cumple, avisa y queda pausado.
    const past = new Date(Date.now() - 60000).toISOString();
    const w = await o.api('POST', '/api/routines', {
      type: 'wake',
      name: 'Ya',
      cond: { kind: 'time', at: past },
      wake: { kind: 'notify' }
    });
    assert.equal(w.status, 201);
    const rt = await waitFor(async () => (await o.snapshot()).routines.find(x => x.id === w.body.id && x.fired), {
      what: 'que se cumpla el despertador'
    });
    assert.equal(rt.paused, true);
    // Editar.
    assert.equal(
      (
        await o.api('PUT', `/api/routines/${w.body.id}`, {
          type: 'wake',
          name: 'Renombrado',
          cond: { kind: 'time', at: new Date(Date.now() + 3600e3).toISOString() },
          wake: { kind: 'notify' }
        })
      ).status,
      200
    );
    const ed = (await o.snapshot()).routines.find(x => x.id === w.body.id);
    assert.equal(ed.name, 'Renombrado');
    assert.equal(ed.fired, null, 'al cambiar la condición se rearma');
    // Una sola vez: lanza un robot (Claude falso) y queda como «ya corrió», con historial.
    const once = await o.api('POST', '/api/routines', {
      type: 'agenda',
      name: 'Una vez',
      text: 'ok',
      schedule: { mode: 'once', at: new Date(Date.now() + 500).toISOString() }
    });
    const done = await waitFor(async () => (await o.snapshot()).routines.find(x => x.id === once.body.id && x.doneOnce), {
      what: 'que corra la de una sola vez'
    });
    assert.equal(done.history[0].robots.length, 1);
  } finally {
    await o.stop();
  }
});

test('fijar mensajes y notas por robot', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', libre('uno'));
    const p = await o.api('POST', '/api/pins', { robot: 'uno', at: '2026-01-01T00:00:00.000Z', text: 'Hola equipo' });
    assert.equal(p.status, 201);
    assert.equal((await o.snapshot()).pins.length, 1);
    await o.api('DELETE', `/api/pins/${p.body.pin.id}`);
    assert.equal((await o.snapshot()).pins.length, 0);
    await o.api('POST', '/api/robots/uno/note', { note: '  esperando   a Ramiro ' });
    assert.equal((await o.robot('uno')).note, 'esperando a Ramiro');
  } finally {
    await o.stop();
  }
});

test('comandos de la consola, orden por hora real y contexto tras compactar', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', libre('uno'));
    const tr = path.join(o.base, 'sesion.jsonl');
    fs.writeFileSync(tr, '');
    await o.hook('uno', { hook_event_name: 'SessionStart', source: 'startup', transcript_path: tr });
    const t0 = Date.now();
    const line = e => fs.appendFileSync(tr, JSON.stringify(e) + '\n');
    // Un avance escrito ANTES de su herramienta, pero que llega al archivo DESPUÉS (Claude guarda en tandas).
    await o.hook('uno', { hook_event_name: 'UserPromptSubmit', prompt: 'cuenta' });
    await o.hook('uno', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    line({
      type: 'assistant',
      timestamp: new Date(t0 - 2000).toISOString(),
      message: {
        id: 'm1',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Voy a contar' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 99990 }
      }
    });
    line({ type: 'user', timestamp: new Date().toISOString(), message: { content: '<bash-input>echo hola</bash-input>' } });
    line({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { content: '<bash-stdout>hola\nmundo</bash-stdout><bash-stderr></bash-stderr>' }
    });
    line({
      type: 'system',
      subtype: 'local_command',
      timestamp: new Date().toISOString(),
      content: '<command-name>/context</command-name><command-args></command-args>'
    });
    await waitFor(async () => (await o.robot('uno')).log.some(l => l.kind === 'shell' && l.slash), {
      what: 'los comandos en la conversación'
    });
    const log = (await o.robot('uno')).log;
    const i = k => log.findIndex(k);
    assert.ok(i(l => l.text === 'Voy a contar') < i(l => l.kind === 'tool'), 'el avance queda antes de su herramienta');
    assert.ok(log.some(l => l.kind === 'shell' && l.cmd && l.text === 'echo hola'));
    assert.ok(
      log.some(l => l.kind === 'shell' && !l.cmd && l.text === 'hola\nmundo'),
      'la salida conserva los saltos de línea'
    );
    let r = await o.robot('uno');
    assert.equal(r.ctx.window, 1000000, 'Opus 5 trabaja con 1 M de contexto');
    assert.equal(r.ctx.pct, 10);
    line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 100000, postTokens: 12000 } });
    await waitFor(async () => (await o.robot('uno')).ctx.tokens === 12000, { what: 'el contexto tras compactar' });
  } finally {
    await o.stop();
  }
});

// Dos robots con su transcript (uno con un subagente): cada mensaje con su usage, como lo guarda Claude.
async function spendOffice(env, perRobot) {
  const o = await startOffice({ maxRobots: 3, env: { OFFICE_SPEND_TICK_MS: '300', ...env } });
  for (const [name, msgs] of Object.entries(perRobot)) {
    await o.api('POST', '/api/robots', libre(name));
    const tr = path.join(o.base, `${name}.jsonl`);
    const at = new Date().toISOString();
    fs.writeFileSync(
      tr,
      msgs.main
        .map((t, i) =>
          JSON.stringify({
            type: 'assistant',
            timestamp: at,
            message: { id: `${name}-${i}`, usage: { input_tokens: t, output_tokens: 0 } }
          })
        )
        .join('\n') + '\n'
    );
    if (msgs.sub) {
      fs.mkdirSync(path.join(o.base, name, 'subagents'), { recursive: true });
      fs.writeFileSync(
        path.join(o.base, name, 'subagents', 'a.jsonl'),
        JSON.stringify({ type: 'assistant', timestamp: at, message: { id: `${name}-s`, usage: { output_tokens: msgs.sub } } }) + '\n'
      );
    }
    await o.hook(name, { hook_event_name: 'SessionStart', source: 'startup', session_id: `${name}-sesion`, transcript_path: tr });
  }
  return o;
}

test('gasto por robot: parte de la semana con subagentes y aviso único cuando se dispara en la última hora', async () => {
  const o = await spendOffice({}, { uno: { main: [1_000_000, 600_000], sub: 400_000 }, dos: { main: [500_000] } });
  try {
    await waitFor(async () => (await o.robot('uno')).spend?.week === 2_000_000, { what: 'el gasto de uno (con su subagente)' });
    const uno = await o.robot('uno'),
      dos = await o.robot('dos');
    assert.equal(uno.spend.officeWeek, 2_500_000);
    assert.equal(uno.spend.pct, 80);
    assert.equal(dos.spend.pct, 20);
    assert.equal(uno.spend.hot, 'hour', '2 M en la última hora es disparo');
    assert.equal(dos.spend.hot, null, 'la regla del 25 % espera a que la semana pase de 5 M');
    await sleep(900); // varias revisiones más: el aviso sale una sola vez
    const hits = (await o.robot('uno')).log.filter(l => /🔥 Se disparó: gastó 2,0 M tokens en la última hora/.test(l.text));
    assert.equal(hits.length, 1);
  } finally {
    await o.stop();
  }
});

test('gasto por robot: más de la cuarta parte de la semana también es disparo', async () => {
  const o = await spendOffice(
    { OFFICE_SPEND_HOUR_HOT: '1e12', OFFICE_SPEND_MIN_WEEK: '1000' },
    { uno: { main: [3000] }, dos: { main: [1000] }, tres: { main: [100] } }
  );
  try {
    await waitFor(async () => (await o.robot('tres')).spend?.officeWeek === 4100, { what: 'el gasto de la semana' });
    assert.equal((await o.robot('uno')).spend.hot, 'share');
    assert.equal((await o.robot('dos')).spend.pct, 24);
    assert.equal((await o.robot('dos')).spend.hot, null);
    assert.equal((await o.robot('tres')).spend.hot, null);
  } finally {
    await o.stop();
  }
});

test('empleado de la semana: cuenta desde que se renovó la cuota, corona con un fuego y con dos si también lidera la sesión de 5 h', async () => {
  const o = await startOffice({ maxRobots: 4, env: { OFFICE_SPEND_TICK_MS: '300' } });
  try {
    const H = 3600e3,
      t = Date.now();
    // La cuota semanal se renueva en 2 días (la semana empezó hace 5) y la sesión de 5 h termina en 1 h.
    fs.writeFileSync(path.join(o.data, 'config.json'), JSON.stringify({ quota: { weekEnd: t + 2 * 24 * H, sessionEnd: t + H } }));
    const write = (name, msgs) => {
      const tr = path.join(o.base, `${name}.jsonl`);
      fs.appendFileSync(
        tr,
        msgs
          .map(([tok, ago], i) =>
            JSON.stringify({
              type: 'assistant',
              timestamp: new Date(t - ago).toISOString(),
              message: { id: `${name}-${tok}-${ago}-${i}`, usage: { input_tokens: tok } }
            })
          )
          .join('\n') + '\n'
      );
      return tr;
    };
    const plan = { uno: [[2_000_000, 0]], dos: [[3_000_000, 6 * H]], tres: [[9_000_000, 6 * 24 * H]] }; // tres: antes de la renovación
    for (const [name, msgs] of Object.entries(plan)) {
      await o.api('POST', '/api/robots', libre(name));
      await o.hook(name, {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: `${name}-s`,
        transcript_path: write(name, msgs)
      });
    }
    await waitFor(async () => (await o.snapshot()).fame?.employee?.name === 'dos', { what: 'que dos sea el empleado de la semana' });
    let s = await o.snapshot();
    assert.equal(s.fame.employee.tokens, 3_000_000, 'lo de tres es de antes de que se renovara la cuota');
    assert.equal(s.fame.sessionTop.name, 'uno', 'lo de dos fue hace 6 h: fuera de la sesión de 5 h');
    assert.equal(s.fame.period.known, true);
    assert.equal(Date.parse(s.fame.period.from), t - 5 * 24 * H);
    const crown = n => s.robots.find(r => r.name === n).crown;
    assert.deepEqual([crown('uno'), crown('dos'), crown('tres')], [0, 1, 0]);
    // uno gasta 2 M más ahora: pasa a liderar la semana y la sesión → corona de dos fuegos.
    write('uno', [[2_000_000, 1000]]);
    await waitFor(async () => (await o.robot('uno')).crown === 2, { what: 'la corona de dos fuegos' });
    s = await o.snapshot();
    assert.equal(s.fame.employee.name, 'uno');
    assert.equal(crown('dos'), 0, 'dos pierde la corona');
  } finally {
    await o.stop();
  }
});

test('exportar conversación: .md limpio desde el transcript (avances, herramientas contadas, sin ruido) y desde el archivo', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', { ...libre('memo', 'Revisa el PR 42'), title: 'PR 42' });
    const tr = path.join(o.base, 'memo.jsonl');
    const t = Date.now(),
      at = k => new Date(t + k * 1000).toISOString();
    const L = [
      { type: 'user', timestamp: at(0), message: { content: 'Revisa el PR 42<system-reminder>ruido interno</system-reminder>' } },
      { type: 'assistant', timestamp: at(1), message: { id: 'a1', content: [{ type: 'text', text: 'Ahora reviso el diff.' }] } },
      { type: 'assistant', timestamp: at(1), message: { id: 'a1', content: [{ type: 'text', text: 'Ahora reviso el diff.' }] } }, // repetida al escribirse
      {
        type: 'assistant',
        timestamp: at(2),
        message: { id: 'a2', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh pr diff 42' } }] }
      },
      { type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'diff secreto' }] } },
      { type: 'assistant', timestamp: at(4), message: { id: 'a3', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] } },
      { type: 'assistant', timestamp: at(5), message: { id: 'a4', content: [{ type: 'text', text: 'Falta el **service**.' }] } },
      { type: 'user', timestamp: at(6), message: { content: '<bash-input>ls</bash-input>' } },
      { type: 'user', timestamp: at(7), message: { content: '<local-command-stdout>salida</local-command-stdout>' } },
      { type: 'user', isMeta: true, timestamp: at(8), message: { content: 'meta' } },
      { type: 'user', timestamp: at(9), message: { content: '[Oficina] Resultado del robot hijo: listo' } },
      { type: 'assistant', timestamp: at(10), message: { id: 'a5', content: [{ type: 'text', text: 'Integrado.' }] } }
    ];
    fs.writeFileSync(tr, L.map(x => JSON.stringify(x)).join('\n') + '\n');
    await o.hook('memo', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'sesion-memo', transcript_path: tr });
    const ex = await o.api('POST', '/api/robots/memo/exportar');
    assert.equal(ex.status, 200);
    assert.equal(ex.body.fromLog, false);
    assert.ok(ex.body.path.startsWith(path.join(o.ws, 'docs', 'conversaciones-robots')));
    const md = fs.readFileSync(ex.body.path, 'utf8');
    assert.match(md, /^# Conversación de memo · PR 42/);
    assert.match(md, /claude --resume /);
    assert.match(md, /### 🧑 Tú · .*\n\nRevisa el PR 42\n/);
    assert.match(md, /#### 🤖 memo · avance · .*\n\nAhora reviso el diff\./, 'el texto antes de herramientas es avance');
    assert.match(md, /_… usó 2 herramientas …_/);
    assert.match(md, /### 🤖 memo · .*\n\nFalta el \*\*service\*\*\./, 'la respuesta antes de que le escribas es final');
    assert.match(md, /`! ls`/);
    assert.match(md, /### 🏢 Oficina/);
    assert.equal((md.match(/Ahora reviso el diff/g) || []).length, 1, 'sin duplicados');
    for (const ruido of ['ruido interno', 'diff secreto', 'salida', 'meta']) assert.ok(!md.includes(ruido), `sin «${ruido}»`);
    assert.equal(ex.body.messages, 6);
    // Se puede abrir como documento de la oficina.
    assert.equal((await o.api('GET', `/api/doc?path=${encodeURIComponent(ex.body.path)}`)).status, 200);
    // Del archivo: un robot sin transcript se exporta con lo que guardó la oficina y su resumen al final.
    await o.api('POST', '/api/robots', libre('viejo'));
    const trv = path.join(o.base, 'viejo.jsonl');
    fs.writeFileSync(
      trv,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { id: 'v1', content: [{ type: 'text', text: 'Hecho: revisé todo.' }] }
      }) + '\n'
    );
    await o.hook('viejo', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'sesion-viejo', transcript_path: trv });
    await turn(o, 'viejo', 'hola', 'Hecho: revisé todo.');
    await waitFor(async () => (await o.robot('viejo')).log.some(l => l.kind === 'agent'), { what: 'su mensaje en la conversación' });
    await o.api('POST', '/api/robots/viejo/despedir-con-resumen');
    await o.hook('viejo', { hook_event_name: 'Stop', last_assistant_message: 'Revisé todo; no queda nada.' });
    await waitFor(async () => !(await o.robot('viejo')), { what: 'que se vaya con su resumen' });
    fs.rmSync(trv); // el transcript ya no está: se usa lo que guardó la oficina
    const id = (await o.api('GET', '/api/despedidos?all=1')).body.recent.find(a => a.name === 'viejo').id;
    const ex2 = await o.api('POST', `/api/despedidos/${id}/exportar`);
    assert.equal(ex2.status, 200);
    assert.equal(ex2.body.fromLog, true);
    const md2 = fs.readFileSync(ex2.body.path, 'utf8');
    assert.match(md2, /Hecho: revisé todo\./);
    assert.match(md2, /## Su resumen al irse \(lo escribió el robot\)/);
    // Un robot sin conversación no deja un archivo vacío.
    await o.api('POST', '/api/robots', libre('mudo'));
    assert.equal((await o.api('POST', '/api/robots/mudo/exportar')).status, 409);
  } finally {
    await o.stop();
  }
});

test('la página: /app.js une web/app/*.js en orden, dentro de una sola función y con sintaxis válida', async () => {
  const o = await startOffice();
  try {
    const res = await fetch(`${o.url}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const js = await res.text();
    const vm = await import('node:vm');
    assert.doesNotThrow(() => new vm.Script(js, { filename: 'app.js' }), 'el armado tiene sintaxis válida');
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'web', 'app');
    const parts = fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.js'))
      .sort();
    assert.ok(parts.length > 1);
    const body = parts.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    assert.ok(js.includes(`(() => {\n${body}})();\n`), 'las partes van completas, en orden y envueltas');
    // Cada parte termina en salto de línea: si no, la última línea de una se pegaría a la primera de la siguiente.
    for (const f of parts) assert.ok(fs.readFileSync(path.join(dir, f), 'utf8').endsWith('\n'), `${f} termina en salto de línea`);
  } finally {
    await o.stop();
  }
});

test('tiempo esperándote: suma la espera al responder y al despedir, por robot, tipo y permiso', async () => {
  const hace = min => new Date(Date.now() - min * 60e3).toISOString();
  const o = await startOffice({
    robots: [
      { name: 'uno', state: 'input', inputAt: hace(10), inputKind: 'permiso', inputPerm: 'Bash: git push' },
      { name: 'dos', idx: 1, state: 'input', inputAt: hace(5), inputKind: 'respuesta' }
    ]
  });
  try {
    await o.hook('uno', { hook_event_name: 'UserPromptSubmit', prompt: 'dale' });
    await o.api('DELETE', '/api/robots/dos');
    const hoy = new Date().toLocaleDateString('sv');
    let w;
    await waitFor(
      async () => {
        w = (await o.snapshot()).config.stats.waits.find(x => x.day === hoy);
        return w.total >= 14 * 60e3;
      },
      { what: 'que se sumen las dos esperas' }
    );
    const s = (await o.snapshot()).config.stats.waits;
    assert.equal(s.length, 7, 'siete días');
    assert.ok(Math.abs(w.by.uno - 10 * 60e3) < 5000 && Math.abs(w.by.dos - 5 * 60e3) < 5000, JSON.stringify(w.by));
    assert.ok(w.kinds.permiso >= 10 * 60e3 - 5000 && w.kinds.respuesta >= 5 * 60e3 - 5000);
    assert.equal(w.perms['Bash: git push'].n, 1);
    // Un robot que vuelve a esperar y se le responde enseguida (menos de 3 s) no suma.
    await o.hook('uno', { hook_event_name: 'Stop', last_assistant_message: '¿Sigo?' });
    await o.hook('uno', { hook_event_name: 'UserPromptSubmit', prompt: 'sí' });
    await sleep(300);
    assert.equal((await o.snapshot()).config.stats.waits.find(x => x.day === hoy).total, w.total);
  } finally {
    await o.stop();
  }
});

test('salas: el avance cuenta a los que entregaron (también despedidos) y tus notas del tablero no llegan a los robots', async () => {
  const o = await startOffice({ maxRobots: 5, env: { OFFICE_RESULT_DEBOUNCE_MS: '300' } });
  try {
    await o.api('POST', '/api/robots', libre('jefe'));
    await turn(o, 'jefe', 'arranca', 'Pido robots');
    const req = await o.api('POST', '/api/robots/jefe/encargos', {
      encargos: [
        { titulo: 'Uno', encargo: 'a' },
        { titulo: 'Dos', encargo: 'b' }
      ]
    });
    const ok = await o.api('POST', `/api/robots/jefe/encargos/${req.body.id}`, { decision: 'approve' });
    const [k1] = ok.body.launched,
      id = ok.body.sala;
    const sala = async () => (await o.snapshot()).salas.find(x => x.id === id);
    const prog = async () => (await sala()).roster.filter(e => !e.owner && e.delivered).length;
    assert.equal(await prog(), 0);
    await turn(o, k1, 'encargo', 'Hecho UNO');
    await waitFor(async () => (await prog()) === 1, { what: 'que cuente al que entregó' });
    await o.api('POST', `/api/salas/${id}/despedir-equipo`);
    await waitFor(async () => !(await o.snapshot()).robots.some(r => r.name === k1), { what: 'que se vaya' });
    assert.equal(await prog(), 1, 'despedido, sigue contando como entregado');
    // Notas: se guardan, tope de 4, se quitan; no tocan el hilo ni le escriben a nadie.
    const calls = o.claudeCalls().length,
      hilo = (await sala()).thread.length;
    for (const t of ['revisar el PR', 'llamar a QA', 'tres', 'cuatro'])
      assert.equal((await o.api('POST', `/api/salas/${id}/notas`, { text: t })).status, 201);
    assert.equal((await o.api('POST', `/api/salas/${id}/notas`, { text: 'quinta' })).status, 409);
    assert.equal((await o.api('POST', `/api/salas/${id}/notas`, { text: '  ' })).status, 400);
    let s = await sala();
    assert.deepEqual(
      s.notes.map(n => n.text),
      ['revisar el PR', 'llamar a QA', 'tres', 'cuatro']
    );
    assert.equal((await o.api('DELETE', `/api/salas/${id}/notas/${s.notes[0].id}`)).status, 200);
    s = await sala();
    assert.deepEqual(
      s.notes.map(n => n.text),
      ['llamar a QA', 'tres', 'cuatro']
    );
    assert.equal(s.thread.length, hilo, 'las notas no van al hilo');
    assert.equal(o.claudeCalls().length, calls, 'ni se le escriben a los robots');
  } finally {
    await o.stop();
  }
});

test('mantenimiento: repo del robot, salud, limpieza a la Papelera (sin perder sesiones), respaldo y horas', async () => {
  const viejo = '2020-01-01',
    hoy = new Date().toISOString().slice(0, 10);
  const ses = JSON.stringify({
    at: `${viejo}T10:00:00Z`,
    robot: 'x',
    hook_event_name: 'SessionStart',
    session_id: 'ses-vieja',
    transcript_path: '/no/existe.jsonl'
  });
  const o = await startOffice({
    env: { OFFICE_HOURS_TICK_MS: '200' },
    files: { [`events-${viejo}.jsonl`]: ses + '\n{"hook_event_name":"Stop"}\n' }
  });
  try {
    fs.mkdirSync(path.join(o.ws, 'nr-orders', '.git'), { recursive: true });
    fs.mkdirSync(path.join(o.ws, 'worktrees', 'T-1', 'nr-kit'), { recursive: true });
    const viejoT = new Date('2020-01-02');
    fs.mkdirSync(path.join(o.data, 'conversaciones'), { recursive: true });
    fs.writeFileSync(path.join(o.data, 'conversaciones', 'fantasma.json'), '{}');
    fs.utimesSync(path.join(o.data, 'conversaciones', 'fantasma.json'), viejoT, viejoT);
    await o.api('POST', '/api/robots', libre('uno'));
    // 2 · repo: por la carpeta de su consola y, si edita, por el archivo (también en worktrees/<tarea>/<repo>).
    await o.hook('uno', { hook_event_name: 'UserPromptSubmit', prompt: 'x', cwd: path.join(o.ws, 'nr-orders', 'internal') });
    assert.equal((await o.robot('uno')).repo, 'nr-orders');
    await o.hook('uno', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_use_id: 'e1',
      tool_input: { file_path: path.join(o.ws, 'worktrees', 'T-1', 'nr-kit', 'a.go') },
      cwd: o.ws
    });
    assert.equal((await o.robot('uno')).repo, 'nr-kit');
    await o.hook('uno', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_use_id: 'r1',
      tool_input: { file_path: '/etc/hosts' },
      cwd: '/tmp'
    });
    assert.equal((await o.robot('uno')).repo, 'nr-kit', 'fuera del workspace no lo cambia');
    // 3 · salud
    const h = (await o.api('GET', '/api/salud')).body;
    assert.ok(
      h.checks.some(c => c.label === 'Sesión de tmux' && c.ok),
      JSON.stringify(h.checks)
    );
    assert.ok(h.robots.some(r => r.name === 'uno' && r.console));
    const kinds = h.candidates.map(c => c.kind).sort();
    assert.deepEqual(kinds, ['conversaciones', 'eventos'], 'solo lo viejo y suelto, nunca lo de hoy');
    // 4 · limpieza: va a la Papelera y el SessionStart queda en sesiones.jsonl
    const c = (await o.api('POST', '/api/limpieza', { run: true, days: 7 })).body;
    assert.equal(c.moved, 2, JSON.stringify(c));
    assert.ok(!fs.existsSync(path.join(o.data, `events-${viejo}.jsonl`)) && fs.existsSync(path.join(o.data, `events-${hoy}.jsonl`)));
    assert.match(fs.readFileSync(path.join(o.data, 'sesiones.jsonl'), 'utf8'), /ses-vieja/);
    assert.ok(fs.readdirSync(path.join(o.base, 'papelera')).some(f => f.startsWith(`oficina-events-${viejo}`)));
    assert.equal((await o.api('POST', '/api/limpieza', { days: 14, auto: true })).body.clean.auto, true);
    // 7 · respaldo: exporta y, al importar, suma sin duplicar; las rutinas llegan en pausa.
    await o.api('POST', '/api/config', { name: 'Mi oficina' });
    await o.api('POST', '/api/favorites', { name: 'Review', kind: 'libre', text: 'revisa' });
    const bk = await (await fetch(`${o.url}/api/respaldo`)).json();
    assert.equal(bk.app, 'agent-office');
    assert.equal(bk.office.name, 'Mi oficina');
    assert.equal(bk.favorites.length, 1);
    bk.routines = [
      {
        id: 'r-importada',
        type: 'watch',
        name: 'Vigilar',
        source: { scope: 'repo', repo: 'nr-orders', query: '' },
        schedule: { mode: 'every', everyMin: 30 }
      }
    ];
    bk.office.name = 'Otra';
    bk.looks = { uno: { look: { ant: 1, visor: 2, acc: 3 }, color: 5 } };
    const imp = (await o.api('POST', '/api/respaldo', { data: bk, parts: ['routines', 'favorites', 'looks'] })).body;
    assert.deepEqual([imp.routines, imp.favorites, imp.looks, imp.office], [1, 0, 1, false]);
    const snap = await o.snapshot();
    assert.equal(snap.routines.find(r => r.id === 'r-importada').paused, true);
    assert.equal(snap.config.name, 'Mi oficina', 'sin «office» no cambia el nombre');
    assert.deepEqual((await o.robot('uno')).look, { ant: 1, visor: 2, acc: 3 });
    assert.equal((await o.api('POST', '/api/respaldo', { data: { app: 'otra' } })).status, 400);
    // 6 · horas: anota mientras hay robots trabajando; apagado, deja de anotar.
    await waitFor(async () => (await o.snapshot()).config.stats.hours.w.some(n => n > 0) || (await sleep(300), false), {
      what: 'que anote horas'
    });
    await o.api('POST', '/api/config', { hoursOn: false });
    const off = (await o.snapshot()).config.stats.hours;
    assert.equal(off.on, false);
  } finally {
    await o.stop();
  }
});

test('en espera: una shell o un Monitor de fondo lo dejan en espera hasta que llega su aviso de fin', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', libre('uno'));
    await o.hook('uno', { hook_event_name: 'UserPromptSubmit', prompt: 'vigila el CI' });
    await o.hook('uno', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_shell',
      tool_input: { command: 'until gh run view 1; do sleep 30; done', description: 'Esperar el CI de nr-qa', run_in_background: true }
    });
    await o.hook('uno', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      tool_use_id: 'toolu_mon',
      tool_input: { description: 'Estado cada 10 min', command: 'x', timeout_ms: 1800000 }
    });
    await o.hook('uno', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_normal', tool_input: { command: 'ls' } });
    await o.hook('uno', { hook_event_name: 'Stop', last_assistant_message: 'Lo dejo vigilando.' });
    let r = await o.robot('uno');
    assert.equal(r.state, 'done');
    assert.deepEqual(
      r.bg.map(e => [e.kind, e.what]),
      [
        ['shell', 'Esperar el CI de nr-qa'],
        ['monitor', 'Estado cada 10 min']
      ]
    );
    const aviso = (id, status, extra = '') =>
      `<task-notification>\n<task-id>b1</task-id>\n${id ? `<tool-use-id>${id}</tool-use-id>\n` : ''}${status ? `<status>${status}</status>\n` : ''}<summary>x</summary>${extra}\n</task-notification>`;
    // Un evento intermedio del Monitor (sin tool-use-id) no lo saca de la espera.
    await o.hook('uno', { hook_event_name: 'UserPromptSubmit', prompt: aviso(null, null, '<event>11:13 pendiente</event>') });
    await o.hook('uno', { hook_event_name: 'Stop', last_assistant_message: 'Sigue pendiente.' });
    assert.equal((await o.robot('uno')).bg.length, 2);
    await o.hook('uno', { hook_event_name: 'UserPromptSubmit', prompt: aviso('toolu_shell', 'completed') });
    await o.hook('uno', { hook_event_name: 'Stop', last_assistant_message: 'El CI pasó.' });
    r = await o.robot('uno');
    assert.deepEqual(
      r.bg.map(e => e.kind),
      ['monitor']
    );
    await o.hook('uno', { hook_event_name: 'UserPromptSubmit', prompt: aviso('toolu_mon', 'killed') });
    assert.deepEqual((await o.robot('uno')).bg, [], 'con todo terminado vuelve a quedar LISTO al cerrar el turno');
    // Despertador de /loop: se va cuando suena (le llega su prompt); una sesión nueva limpia lo de antes.
    await o.hook('uno', {
      hook_event_name: 'PreToolUse',
      tool_name: 'ScheduleWakeup',
      tool_use_id: 'toolu_w',
      tool_input: { delaySeconds: 600, reason: 'revisar el deploy' }
    });
    assert.equal((await o.robot('uno')).bg[0].kind, 'despertador');
    await o.hook('uno', { hook_event_name: 'UserPromptSubmit', prompt: '/loop revisa el deploy' });
    assert.deepEqual((await o.robot('uno')).bg, []);
    await o.hook('uno', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_s2',
      tool_input: { command: 'sleep 999', run_in_background: true }
    });
    await o.hook('uno', { hook_event_name: 'SessionStart', source: 'clear', session_id: 'nueva' });
    assert.deepEqual((await o.robot('uno')).bg, []);
  } finally {
    await o.stop();
  }
});

test('en espera tras reiniciar: lo de fondo lanzado antes se reconstruye desde el transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')),
    tr = path.join(dir, 's.jsonl'),
    at = new Date().toISOString();
  const tu = (id, name, input) =>
    JSON.stringify({ type: 'assistant', timestamp: at, message: { id: 'm' + id, content: [{ type: 'tool_use', id, name, input }] } });
  const aviso = id =>
    JSON.stringify({
      type: 'user',
      timestamp: at,
      message: {
        role: 'user',
        content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`
      }
    });
  fs.writeFileSync(
    tr,
    [
      tu('t1', 'Bash', { command: 'gh pr checks 502 --watch', description: 'Wait for PR 502 CI', run_in_background: true }),
      tu('t2', 'Bash', { command: 'sleep 9', description: 'Ya terminó', run_in_background: true }),
      aviso('t2'),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2020-01-01T00:00:00Z',
        message: { id: 'viejo', content: [{ type: 'tool_use', id: 't0', name: 'Bash', input: { command: 'x', run_in_background: true } }] }
      })
    ].join('\n') + '\n'
  );
  const o = await startOffice({ robots: [{ name: 'vigia', state: 'done', transcript: tr }] });
  try {
    const r = await o.robot('vigia');
    assert.deepEqual(
      r.bg.map(e => e.what),
      ['Wait for PR 502 CI'],
      'la terminada y la vencida (de 2020) no cuentan'
    );
  } finally {
    await o.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('en espera: el aviso de fin que llega a mitad de turno (entrada interna del transcript) también cuenta', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')),
    tr = path.join(dir, 's.jsonl'),
    at = new Date().toISOString();
  fs.writeFileSync(
    tr,
    [
      JSON.stringify({
        type: 'assistant',
        timestamp: at,
        message: {
          id: 'm1',
          content: [
            { type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'x', description: 'Esperar CI', run_in_background: true } }
          ]
        }
      }),
      JSON.stringify({
        type: 'attachment',
        timestamp: at,
        attachment: {
          type: 'queued_command',
          prompt:
            '<task-notification>\n<task-id>b9</task-id>\n<tool-use-id>t9</tool-use-id>\n<status>completed</status>\n</task-notification>'
        }
      })
    ].join('\n') + '\n'
  );
  const o = await startOffice({ robots: [{ name: 'vigia', state: 'done', transcript: tr }] });
  try {
    assert.deepEqual((await o.robot('vigia')).bg, []);
  } finally {
    await o.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('en espera: una shell de fondo que murió sin aviso (nadie tiene abierta su salida) deja de contar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')),
    tr = path.join(dir, 's.jsonl'),
    at = new Date(Date.now() - 5 * 60e3).toISOString();
  const viva = path.join(dir, 'viva.output'),
    muerta = path.join(dir, 'muerta.output');
  fs.writeFileSync(muerta, '');
  const { spawn } = await import('node:child_process');
  const p = spawn('sh', ['-c', `exec sleep 60 > '${viva}'`], { stdio: 'ignore' });
  await sleep(300);
  const tu = (id, d) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: at,
      message: {
        id: 'm' + id,
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'x', description: d, run_in_background: true } }]
      }
    });
  const res = (id, f) =>
    JSON.stringify({
      type: 'user',
      timestamp: at,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: `Command running in background with ID: b${id}. Output is being written to: ${f}. You will be notified when it completes.`
          }
        ]
      }
    });
  fs.writeFileSync(tr, [tu('t1', 'Viva'), res('t1', viva), tu('t2', 'Muerta'), res('t2', muerta)].join('\n') + '\n');
  const o = await startOffice({ robots: [{ name: 'vigia', state: 'done', transcript: tr }], env: { OFFICE_BG_CHECK_MS: '500' } });
  try {
    await waitFor(async () => (await o.robot('vigia')).bg.length === 1, { what: 'que descarte la muerta' });
    assert.deepEqual(
      (await o.robot('vigia')).bg.map(e => e.what),
      ['Viva']
    );
  } finally {
    p.kill();
    await o.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Transcript con un mensaje de Claude que reporta mucho contexto (y, si se pide, un despertador en segundo plano).
function heavyTranscript(dir, name, tokens, wake) {
  const file = path.join(dir, `${name}.jsonl`),
    at = new Date().toISOString();
  const content = [
    { type: 'text', text: 'trabajando' },
    ...(wake ? [{ type: 'tool_use', id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 3000, reason: 'revisar el CI' } }] : [])
  ];
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: at,
      message: { id: `m-${name}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: tokens }, content }
    }) + '\n'
  );
  return file;
}

test('relevo por contexto: oferta, «seguir así» y relevo manual de punta a punta', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-relevo-'));
  const o = await startOffice({
    env: { OFFICE_RELEVO_TICK_MS: '300' },
    maxRobots: 4,
    robots: [
      { name: 'pesado', idx: 0, title: 'PR 7', note: 'espera a Ana', transcript: heavyTranscript(dir, 'pesado', 320000) },
      { name: 'terco', idx: 1, transcript: heavyTranscript(dir, 'terco', 320000) },
      { name: 'ligero', idx: 2, transcript: heavyTranscript(dir, 'ligero', 90000) }
    ]
  });
  try {
    const offer = await waitFor(async () => (await o.robot('pesado'))?.relevo, { what: 'la oferta de relevo' });
    assert.ok(offer.tokens >= 300000);
    assert.equal((await o.robot('ligero')).relevo, null, 'con poco contexto no se ofrece');
    // «Seguir así»: descarta la oferta y no vuelve a salir.
    assert.equal((await o.api('POST', '/api/robots/terco/seguir-sin-relevo')).status, 200);
    await sleep(900);
    assert.equal((await o.robot('terco')).relevo, null);
    // Relevo: pide su resumen y, al recibirlo, se va y entra otro con su mismo nombre, título y nota.
    const oldSession = (await o.robot('pesado')).sessionId;
    assert.equal((await o.api('POST', '/api/robots/pesado/relevar')).status, 200);
    assert.equal((await o.api('POST', '/api/robots/pesado/relevar')).status, 409, 'ya está escribiendo su relevo');
    assert.equal((await o.robot('pesado')).relevoPending, true);
    await o.hook('pesado', {
      hook_event_name: 'Stop',
      last_assistant_message: '## Relevo\n- Falta mergear el PR 7.\n- Esperaba el CI: relánzalo con gh run watch.'
    });
    const call = await waitFor(() => o.claudeCalls().find(c => c.includes('relevo por contexto')), {
      what: 'la llamada del robot de relevo'
    });
    assert.match(call, /Falta mergear el PR 7/);
    const nuevo = await waitFor(
      async () => {
        const r = await o.robot('pesado');
        return r && r.sessionId !== oldSession ? r : null;
      },
      { what: 'el robot nuevo con el mismo nombre' }
    );
    assert.equal(nuevo.title, 'PR 7');
    assert.equal(nuevo.note, 'espera a Ana');
    assert.equal(nuevo.relevoPending, false);
    const arch = (await o.api('GET', '/api/despedidos?all=1')).body.recent;
    assert.equal(arch[0].name, 'pesado');
    assert.equal(arch.length, 1);
  } finally {
    await o.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('relevo por contexto: en espera con más de 150 k se releva solo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-relevo-'));
  const o = await startOffice({
    env: { OFFICE_RELEVO_TICK_MS: '300', OFFICE_RELEVO_ESPERA_MIN: '0' },
    robots: [{ name: 'espera', idx: 0, transcript: heavyTranscript(dir, 'espera', 200000, true) }]
  });
  try {
    await waitFor(async () => (await o.robot('espera'))?.relevoPending, { what: 'que la oficina pida el relevo' });
    await o.hook('espera', { hook_event_name: 'Stop', last_assistant_message: 'Esperaba el CI del PR 9.' });
    await waitFor(() => o.claudeCalls().find(c => c.includes('Esperaba el CI del PR 9')), { what: 'el robot de relevo' });
  } finally {
    await o.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rutina sin cambios: el robot de rutina que no cambió nada se da de baja solo; con cambios o si le escribes, se queda', async () => {
  const o = await startOffice({ maxRobots: 4, env: { OFFICE_NO_CHANGE_GRACE_MS: '300' } });
  try {
    const stop = (n, m) => o.hook(n, { hook_event_name: 'Stop', last_assistant_message: m });
    for (const n of ['quieto', 'cambia', 'charla', 'libre'])
      await o.api('POST', '/api/robots', { ...libre(n), ...(n === 'libre' ? {} : { routine: 'rt-x', leaveWhenDone: true }) });
    for (const n of ['quieto', 'cambia', 'charla', 'libre'])
      await o.hook(n, { hook_event_name: 'UserPromptSubmit', prompt: 'revisa los PRs' });
    // Leer y escribir su memoria no es un cambio; comentar un PR sí.
    await o.hook('quieto', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr list -R a/b' } });
    await o.hook('quieto', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(o.data, 'routines/rt-x/memoria.md') }
    });
    await o.hook('cambia', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr comment 3 -R a/b -b "listo"' }
    });
    await o.hook('charla', { hook_event_name: 'UserPromptSubmit', prompt: 'y el otro PR?' });
    for (const n of ['quieto', 'cambia', 'charla', 'libre']) await stop(n, 'Nada nuevo que revisar.');
    await waitFor(async () => !(await o.snapshot()).robots.some(r => r.name === 'quieto'), { what: 'que se vaya el robot sin cambios' });
    await sleep(600);
    const names = (await o.snapshot()).robots.map(r => r.name).sort();
    assert.deepEqual(names, ['cambia', 'charla', 'libre']);
  } finally {
    await o.stop();
  }
});

test('cambios: archivos que tocó el robot con su estado en git, otros cambios del repo y archivos ajenos rechazados', async () => {
  const o = await startOffice({ env: { OFFICE_EDITOR: '/usr/bin/true' } });
  try {
    const repo = path.join(o.ws, 'svc');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'src/a.go'), 'uno\ndos\n');
    fs.writeFileSync(path.join(repo, 'listo.md'), 'x\n');
    g('add', '.');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    await o.api('POST', '/api/robots', libre('dev'));
    const edit = (tool, f) => o.hook('dev', { hook_event_name: 'PostToolUse', tool_name: tool, cwd: repo, tool_input: { file_path: f } });
    fs.writeFileSync(path.join(repo, 'src/a.go'), 'uno\ntres\ncuatro\n');
    await edit('Edit', path.join(repo, 'src/a.go'));
    fs.writeFileSync(path.join(repo, 'src/b.go'), 'nuevo\n');
    await edit('Write', path.join(repo, 'src/b.go'));
    await edit('Edit', path.join(repo, 'listo.md')); // tocado pero sin cambio pendiente
    fs.writeFileSync(path.join(repo, 'sed.txt'), 'por fuera\n'); // cambio que no pasó por Edit/Write
    await waitFor(async () => (await o.snapshot()).robots.find(r => r.name === 'dev')?.files === 3, { what: 'que cuente 3 archivos' });
    const c = (await o.api('GET', '/api/robots/dev/cambios')).body;
    assert.equal(c.repos.length, 1);
    const r = c.repos[0];
    assert.equal(r.branch, 'main');
    assert.deepEqual(
      r.files.map(f => [f.shown, f.status, f.add, f.del]),
      [
        ['listo.md', 'sin cambios pendientes', null, null],
        ['src/b.go', 'nuevo', 1, null],
        ['src/a.go', 'modificado', 2, 1]
      ]
    );
    assert.deepEqual(
      r.others.map(f => f.shown),
      ['sed.txt']
    );
    assert.equal(r.pending, 3);
    assert.equal((await o.api('POST', '/api/robots/dev/cambios-abrir', { path: path.join(repo, 'src/a.go') })).body.mode, 'diff');
    assert.equal((await o.api('POST', '/api/robots/dev/cambios-abrir', { path: path.join(repo, 'src/b.go') })).body.mode, 'archivo');
    assert.equal((await o.api('POST', '/api/robots/dev/cambios-abrir', { path: '/etc/hosts' })).status, 403);
  } finally {
    await o.stop();
  }
});

test('limpiar relevos: quita del archivo solo a los relevados por contexto y manda sus resúmenes a la Papelera', async () => {
  const trash = fs.mkdtempSync(path.join(os.tmpdir(), 'office-trash-'));
  const sum = path.join(os.tmpdir(), `relevo-${Date.now()}.md`);
  fs.writeFileSync(sum, '# resumen del relevo\n');
  const base = {
    title: '',
    label: 'x',
    kind: 'libre',
    color: 1,
    look: null,
    docs: [],
    log: [],
    startedAt: '2026-11-19T10:00:00Z',
    leftAt: '2026-11-19T11:00:00Z',
    summaryBy: 'robot'
  };
  const arch = [
    { ...base, id: 'aaaa1111', name: 'rex', reason: 'relevado por contexto', summary: 'relevo', summaryPath: sum },
    { ...base, id: 'bbbb2222', name: 'nova', reason: 'despedido con su resumen', summary: 'se fue', summaryPath: null }
  ];
  const o = await startOffice({ env: { OFFICE_TRASH: trash }, files: { 'despedidos.json': JSON.stringify(arch) } });
  try {
    const before = (await o.api('GET', '/api/despedidos?all=1')).body.recent;
    assert.deepEqual(before.map(a => [a.name, a.relevo]).sort(), [
      ['nova', false],
      ['rex', true]
    ]);
    const r = (await o.api('POST', '/api/despedidos/limpiar-relevos')).body;
    assert.deepEqual([r.quitados, r.papelera], [1, 1]);
    assert.deepEqual(
      (await o.api('GET', '/api/despedidos?all=1')).body.recent.map(a => a.name),
      ['nova']
    );
    assert.equal(fs.existsSync(sum), false);
    assert.equal(fs.readdirSync(trash).length, 1);
    assert.equal((await o.api('POST', '/api/despedidos/limpiar-relevos')).body.quitados, 0);
  } finally {
    await o.stop();
  }
});

test('salas: el relevo de un hijo no cierra la sala; mudar robots y reabrir una sala cerrada', async () => {
  const o = await startOffice({ maxRobots: 4 });
  try {
    await o.api('POST', '/api/robots', { ...libre('jefe'), title: 'Epica' });
    const req = await o.api('POST', '/api/robots/jefe/encargos', { encargos: [{ titulo: 'Hijo', encargo: 'haz algo' }] });
    const ok = await o.api('POST', `/api/robots/jefe/encargos/${req.body.id}`, { decision: 'approve' });
    const salaId = ok.body.sala,
      kid = ok.body.launched[0];
    await o.hook(kid, { hook_event_name: 'Stop', last_assistant_message: 'listo por ahora' });
    const oldSession = (await o.robot(kid)).sessionId;
    assert.equal((await o.api('POST', `/api/robots/${kid}/relevar`)).status, 200);
    await o.hook(kid, { hook_event_name: 'Stop', last_assistant_message: '## Relevo\n- sigue con algo' });
    await waitFor(
      async () => {
        const r = await o.robot(kid);
        return r && r.sessionId !== oldSession;
      },
      { what: 'el relevo del hijo' }
    );
    let snap = await o.snapshot();
    assert.ok(
      snap.salas.some(s => s.id === salaId),
      'la sala sigue abierta'
    );
    for (const n of ['jefe', kid]) assert.equal(snap.robots.find(r => r.name === n).place.sala, salaId, `${n} sigue en la sala`);
    // Mudar: el hijo a un escritorio; el padre queda solo, vuelve al suyo y la sala pasa al archivo.
    assert.equal((await o.api('POST', `/api/robots/${kid}/sala`, { sala: null })).status, 200);
    snap = await o.snapshot();
    assert.ok(!snap.salas.some(s => s.id === salaId));
    // Reabrir: vuelve con su hilo y ya no se cierra sola; mudar a los dos de nuevo.
    const cerrada = (await o.api('GET', '/api/salas-cerradas')).body.salas.find(s => s.id === salaId);
    assert.equal(cerrada.reopen, true);
    assert.equal(cerrada.saved, undefined);
    assert.equal((await o.api('POST', `/api/salas-cerradas/${salaId}/reabrir`)).status, 200);
    for (const n of ['jefe', kid]) assert.equal((await o.api('POST', `/api/robots/${n}/sala`, { sala: salaId })).status, 200);
    assert.equal((await o.api('POST', `/api/robots/jefe/sala`, { sala: salaId })).status, 409, 'ya está en esa sala');
    snap = await o.snapshot();
    assert.deepEqual(
      snap.robots
        .filter(r => r.place.sala === salaId)
        .map(r => r.name)
        .sort(),
      ['jefe', kid].sort()
    );
    // Lo de la sala le llega pegado a su próximo mensaje, sin turno aparte.
    await o.api('POST', `/api/robots/${kid}/say`, { text: 'sigue con lo tuyo' });
    const pane = await waitFor(
      async () => {
        const t = (await o.api('GET', `/api/robots/${kid}/pane`)).body.text;
        return t.includes('sigue con lo tuyo') ? t : null;
      },
      { what: 'el mensaje en su consola' }
    );
    assert.match(pane, /--- fin de la sala ---\n\n+sigue con lo tuyo/); // la consola solo muestra el final del aviso
  } finally {
    await o.stop();
  }
});

test('cuota: robots sin herramientas pesadas, resumen sin tokens para uno frío y hilo de sala con @nombre', async () => {
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  const o = await startOffice({
    maxRobots: 4,
    robots: [{ name: 'frio', idx: 0, title: 'PR 9', note: 'espera a Ana', startedAt: old, lastEventAt: old }]
  });
  try {
    // Lanzamiento: sin Artifact ni Workflow (pesan ~16 k en cada llamada).
    await o.api('POST', '/api/robots', libre('nuevo'));
    const call = await waitFor(() => o.claudeCalls().find(c => c.includes('--session-id')), { what: 'el lanzamiento' });
    assert.match(call, /--disallowedTools=Artifact,[^ ]*Workflow/);
    // Frío: «Despedir con su resumen» no lo despierta; la oficina arma el resumen y lo despide.
    const r = await o.api('POST', '/api/robots/frio/despedir-con-resumen');
    assert.equal(r.body.by, 'oficina');
    const arch = (await o.api('GET', '/api/despedidos?all=1')).body.recent.find(a => a.name === 'frio');
    assert.equal(arch.summaryBy, 'oficina');
    assert.match(fs.readFileSync(arch.summaryPath, 'utf8'), /## Objetivo[\s\S]*PR 9[\s\S]*espera a Ana[\s\S]*claude --resume/);
    // Hilo: @nombre despierta solo a ese; el resto lo recibe con su próximo mensaje.
    const req = await o.api('POST', '/api/robots/nuevo/encargos', { encargos: [{ titulo: 'Uno', encargo: 'x' }] });
    const ok = await o.api('POST', `/api/robots/nuevo/encargos/${req.body.id}`, { decision: 'approve' });
    const h = await o.api('POST', `/api/salas/${ok.body.sala}/hilo`, { text: '@uno revisa el contrato' });
    assert.deepEqual([h.body.notified, h.body.queued], [1, 1]);
    const h2 = await o.api('POST', `/api/salas/${ok.body.sala}/hilo`, { text: 'nota para todos' });
    assert.deepEqual([h2.body.notified, h2.body.queued], [0, 2]);
  } finally {
    await o.stop();
  }
});

test('rutas de un robot: un cuerpo JSON roto responde con error y la oficina sigue viva', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', libre('rex'));
    const res = await fetch(`${o.url}/api/robots/rex/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{roto'
    });
    assert.ok(res.status >= 400 && res.status < 500, `respondió ${res.status}`);
    assert.equal((await o.api('GET', '/api/setup')).status, 200, 'el daemon sigue arriba');
  } finally {
    await o.stop();
  }
});

test('salas: pedir robots y dar de baja al último hijo antes de aprobar no borra el CONTEXT.md ni el hilo', async () => {
  const o = await startOffice({ maxRobots: 4 });
  try {
    await o.api('POST', '/api/robots', { ...libre('jefe'), title: 'Puente' });
    const r1 = await o.api('POST', '/api/robots/jefe/encargos', { encargos: [{ titulo: 'Rutas', encargo: 'x' }] });
    const ok1 = await o.api('POST', `/api/robots/jefe/encargos/${r1.body.id}`, { decision: 'approve' });
    const salaId = ok1.body.sala,
      kid = ok1.body.launched[0];
    const sala = (await o.snapshot()).salas.find(s => s.id === salaId);
    fs.appendFileSync(sala.context, '\n## Decisiones tomadas\n\n- DECISION-CLAVE: el puente usa colas\n');
    for (const t of ['avance 1', 'avance 2'])
      await fetch(`${o.url}/api/salas/${salaId}/hilo?from=${kid}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: t });
    // El padre pide más robots; antes de aprobar, se da de baja al único hijo: la sala no se archiva.
    const r2 = await o.api('POST', '/api/robots/jefe/encargos', {
      contexto: 'CONTEXTO-NUEVO',
      encargos: [{ titulo: 'Tablero', encargo: 'y' }]
    });
    assert.equal((await o.api('DELETE', `/api/robots/${kid}`)).status, 200);
    let snap = await o.snapshot();
    assert.ok(
      snap.salas.some(s => s.id === salaId),
      'la sala sigue abierta mientras espera tu aprobación'
    );
    assert.equal(snap.robots.find(r => r.name === 'jefe').place.sala, salaId);
    const ok2 = await o.api('POST', `/api/robots/jefe/encargos/${r2.body.id}`, { decision: 'approve' });
    assert.equal(ok2.body.sala, salaId);
    const ctx = fs.readFileSync(sala.context, 'utf8');
    assert.match(ctx, /DECISION-CLAVE/);
    assert.match(ctx, /CONTEXTO-NUEVO/);
    snap = await o.snapshot();
    assert.ok(snap.salas.find(s => s.id === salaId).thread.length >= 2, 'el hilo conserva los mensajes');
    // Una sala archivada no presta su id: crear otra con ese id da uno nuevo y no toca sus archivos.
    const ep = await o.api('POST', '/api/salas', { name: 'Epica vieja' });
    const vieja = (await o.snapshot()).salas.find(s => s.id === ep.body.id);
    fs.writeFileSync(vieja.context, 'CONTENIDO-VIEJO\n');
    assert.equal((await o.api('DELETE', `/api/salas/${ep.body.id}`)).status, 200);
    const nueva = await o.api('POST', '/api/salas', { name: 'Otra', id: ep.body.id });
    assert.notEqual(nueva.body.id, ep.body.id);
    assert.equal(fs.readFileSync(vieja.context, 'utf8'), 'CONTENIDO-VIEJO\n');
  } finally {
    await o.stop();
  }
});

test('bandeja: marcar vistos varios documentos a la vez ignora ids desconocidos y no toca el resto', async () => {
  const item = (id, extra = {}) => ({ id, path: `/x/${id}.md`, robot: 'r', label: 'l', at: 1, status: 'nuevo', ...extra });
  const o = await startOffice({
    files: {
      'office-state.json': JSON.stringify({
        colorSeq: 0,
        maxRobots: 4,
        inbox: [item('a1', { sala: 's1', salaName: 'Puente', repo: 'nr-x' }), item('b2'), item('c3')],
        robots: []
      })
    }
  });
  try {
    const bad = await o.api('POST', '/api/inbox/seen-many', { ids: 'a1' });
    assert.equal(bad.status, 400);
    const ok = await o.api('POST', '/api/inbox/seen-many', { ids: ['a1', 'b2', 'zzz'] });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.marked, 2);
    const inbox = (await o.snapshot()).inbox;
    assert.deepEqual(
      inbox.map(i => [i.id, i.status]),
      [
        ['a1', 'visto'],
        ['b2', 'visto'],
        ['c3', 'nuevo']
      ]
    );
    assert.equal(inbox[0].salaName, 'Puente', 'los campos de sala y repo se conservan');
  } finally {
    await o.stop();
  }
});

test('prioridad: se fija por robot, se valida, se guarda en el estado y se quita con normal', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', libre('rex'));
    assert.equal((await o.api('POST', '/api/robots/rex/priority', { priority: 'urgente' })).status, 400);
    assert.equal((await o.api('POST', '/api/robots/rex/priority', { priority: 'p0' })).body.priority, 'p0');
    assert.equal((await o.robot('rex')).priority, 'p0');
    const saved = () =>
      JSON.parse(fs.readFileSync(path.join(o.data, 'office-state.json'), 'utf8')).robots.find(r => r.name === 'rex')?.priority;
    await waitFor(() => saved() === 'p0', { what: 'que la prioridad quede guardada' });
    await o.api('POST', '/api/robots/rex/priority', { priority: 'normal' });
    assert.equal((await o.robot('rex')).priority, null);
    await waitFor(() => !saved(), { what: 'que se guarde sin prioridad' });
  } finally {
    await o.stop();
  }
});
