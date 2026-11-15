// Pruebas de la oficina contra un daemon real aislado y un Claude falso (no gastan cuota).
// Correr: node --test test/      (necesita tmux; cada prueba usa su propia sesión y carpeta temporal)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  } finally { await o.stop(); }
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
  } finally { await o.stop(); }
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
  } finally { await o.stop(); }
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
  } finally { await o.stop(); }
});

test('si la consola cancela la pregunta, la oficina la quita sola', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', libre('uno'));
    const ac = new AbortController();
    const q = { question: '¿Sí?', options: [{ label: 'Sí' }, { label: 'No' }] };
    fetch(`${o.url}/hook?robot=uno&via=ask`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [q] } }) }).catch(() => {});
    await waitFor(async () => (await o.robot('uno'))?.ask, { what: 'la pregunta' });
    ac.abort();
    await waitFor(async () => !(await o.robot('uno')).ask, { what: 'que se quite la pregunta' });
  } finally { await o.stop(); }
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
    await waitFor(() => o.claudeCalls().some(c => c.includes('--resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')), { what: 'que se retome la misma sesión' });
    assert.equal((await o.robot('vivo')).consoleLost, false);
  } finally { await o.stop(); }
});

test('un robot pide robots: apruebas con cambios, entran según el cupo y los demás esperan', async () => {
  const o = await startOffice({ maxRobots: 2 });
  try {
    await o.api('POST', '/api/robots', libre('padre'));
    const req = await o.api('POST', '/api/robots/padre/encargos', { encargos: [{ titulo: 'Uno', encargo: 'haz uno' }, { titulo: 'Dos', encargo: 'haz dos' }, { titulo: 'Tres', encargo: 'haz tres' }] });
    assert.equal(req.status, 202);
    assert.equal((await o.robot('padre')).spawnReq.items.length, 3);
    const items = [{ title: 'Uno editado', text: 'haz uno' }, { title: 'Dos', text: 'haz dos' }]; // el tercero lo desmarcaste
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
  } finally { await o.stop(); }
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
    assert.deepEqual(door.map(d => d.name), ['dos', null]);
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
  } finally { await o.stop(); }
});

test('oficina llena: subir el tope con + deja entrar de inmediato lo que espera en la puerta', async () => {
  const o = await startOffice({ maxRobots: 1 });
  try {
    await o.api('POST', '/api/robots', libre('uno'));
    assert.equal((await o.api('POST', '/api/robots', { ...libre('dos'), queue: true })).status, 202);
    await o.api('POST', '/api/config', { maxRobots: 2 });
    await waitFor(() => o.windows().includes('dos'), { timeout: 3000, what: 'que entre sin esperar la revisión de 5 s' });
  } finally { await o.stop(); }
});

test('despedir deja un resumen en docs/resumenes-robots y con él se retoma la tarea', async () => {
  const o = await startOffice();
  try {
    await o.api('POST', '/api/robots', { ...libre('memo', 'Revisa el PR 42'), title: 'PR 42' });
    await turn(o, 'memo', 'sigue', 'Falta el service; esperamos a Ramiro.');
    await o.api('POST', '/api/robots/memo/note', { note: 'esperando a Ramiro' });
    // «Despedir con su resumen»: le pide el resumen y se va al recibirlo.
    assert.equal((await o.api('POST', '/api/robots/memo/despedir-con-resumen')).status, 200);
    await o.hook('memo', { hook_event_name: 'Stop', last_assistant_message: '## Traspaso\n- Falta revisar el service del PR 42.\n- Esperamos a Ramiro.' });
    await waitFor(async () => !(await o.robot('memo')), { what: 'que se vaya' });
    const list = (await o.api('GET', '/api/despedidos?all=1')).body.recent;
    assert.equal(list[0].name, 'memo');
    assert.equal(list[0].summaryBy, 'robot');
    assert.ok(list[0].summaryPath.startsWith(path.join(o.ws, 'docs', 'resumenes-robots')));
    assert.match(fs.readFileSync(list[0].summaryPath, 'utf8'), /Falta revisar el service/);
    // Retomar: entra un robot nuevo solo con el resumen.
    const rt = await o.api('POST', `/api/despedidos/${list[0].id}/retomar`, { text: '¿Qué esperábamos?' });
    assert.equal(rt.status, 201);
    // La ventana aparece antes de que el Claude falso anote su llamada: se espera la del robot que retoma.
    const call = await waitFor(() => o.claudeCalls().find(c => c.includes('Retomas una tarea')), { what: 'la llamada del robot que retoma' });
    assert.match(call, /Retomas una tarea que dejó el robot memo/);
    assert.match(call, /Falta revisar el service/);
    const r = await o.robot(rt.body.name);
    assert.equal(r.title, 'PR 42');
    assert.equal(r.note, 'esperando a Ramiro');
    // Despedir normal: la oficina arma el resumen (con un turno hecho; uno que no hizo nada no se archiva).
    await turn(o, rt.body.name, '¿Qué esperábamos?', 'Esperábamos a Ramiro para el service.');
    await o.api('DELETE', `/api/robots/${rt.body.name}`);
    const again = (await o.api('GET', '/api/despedidos?all=1')).body.recent[0];
    assert.equal(again.summaryBy, 'oficina');
  } finally { await o.stop(); }
});

test('rutinas: vista previa, horarios, edición y despertador que se cumple', async () => {
  const o = await startOffice();
  try {
    const pv = await o.api('POST', '/api/routines/preview', { type: 'agenda', text: 'x', schedule: { mode: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] } });
    assert.equal(pv.body.next.length, 4);
    assert.ok(pv.body.next.every(t => [1, 2, 3, 4, 5].includes(new Date(t).getDay()) && new Date(t).getHours() === 8));
    assert.equal((await o.api('POST', '/api/routines', { type: 'agenda', text: 'x', schedule: { mode: 'daily', time: '8', days: [1] } })).status, 400);
    // Despertador por hora (ya pasada): se cumple, avisa y queda pausado.
    const past = new Date(Date.now() - 60000).toISOString();
    const w = await o.api('POST', '/api/routines', { type: 'wake', name: 'Ya', cond: { kind: 'time', at: past }, wake: { kind: 'notify' } });
    assert.equal(w.status, 201);
    const rt = await waitFor(async () => (await o.snapshot()).routines.find(x => x.id === w.body.id && x.fired), { what: 'que se cumpla el despertador' });
    assert.equal(rt.paused, true);
    // Editar.
    assert.equal((await o.api('PUT', `/api/routines/${w.body.id}`, { type: 'wake', name: 'Renombrado', cond: { kind: 'time', at: new Date(Date.now() + 3600e3).toISOString() }, wake: { kind: 'notify' } })).status, 200);
    const ed = (await o.snapshot()).routines.find(x => x.id === w.body.id);
    assert.equal(ed.name, 'Renombrado');
    assert.equal(ed.fired, null, 'al cambiar la condición se rearma');
    // Una sola vez: lanza un robot (Claude falso) y queda como «ya corrió», con historial.
    const once = await o.api('POST', '/api/routines', { type: 'agenda', name: 'Una vez', text: 'ok', schedule: { mode: 'once', at: new Date(Date.now() + 500).toISOString() } });
    const done = await waitFor(async () => (await o.snapshot()).routines.find(x => x.id === once.body.id && x.doneOnce), { what: 'que corra la de una sola vez' });
    assert.equal(done.history[0].robots.length, 1);
  } finally { await o.stop(); }
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
  } finally { await o.stop(); }
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
    line({ type: 'assistant', timestamp: new Date(t0 - 2000).toISOString(), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Voy a contar' }], usage: { input_tokens: 10, cache_read_input_tokens: 99990 } } });
    line({ type: 'user', timestamp: new Date().toISOString(), message: { content: '<bash-input>echo hola</bash-input>' } });
    line({ type: 'user', timestamp: new Date().toISOString(), message: { content: '<bash-stdout>hola\nmundo</bash-stdout><bash-stderr></bash-stderr>' } });
    line({ type: 'system', subtype: 'local_command', timestamp: new Date().toISOString(), content: '<command-name>/context</command-name><command-args></command-args>' });
    await waitFor(async () => (await o.robot('uno')).log.some(l => l.kind === 'shell' && l.slash), { what: 'los comandos en la conversación' });
    const log = (await o.robot('uno')).log;
    const i = k => log.findIndex(k);
    assert.ok(i(l => l.text === 'Voy a contar') < i(l => l.kind === 'tool'), 'el avance queda antes de su herramienta');
    assert.ok(log.some(l => l.kind === 'shell' && l.cmd && l.text === 'echo hola'));
    assert.ok(log.some(l => l.kind === 'shell' && !l.cmd && l.text === 'hola\nmundo'), 'la salida conserva los saltos de línea');
    let r = await o.robot('uno');
    assert.equal(r.ctx.window, 1000000, 'Opus 5 trabaja con 1 M de contexto');
    assert.equal(r.ctx.pct, 10);
    line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 100000, postTokens: 12000 } });
    await waitFor(async () => (await o.robot('uno')).ctx.tokens === 12000, { what: 'el contexto tras compactar' });
  } finally { await o.stop(); }
});

// Dos robots con su transcript (uno con un subagente): cada mensaje con su usage, como lo guarda Claude.
async function spendOffice(env, perRobot) {
  const o = await startOffice({ maxRobots: 3, env: { OFFICE_SPEND_TICK_MS: '300', ...env } });
  for (const [name, msgs] of Object.entries(perRobot)) {
    await o.api('POST', '/api/robots', libre(name));
    const tr = path.join(o.base, `${name}.jsonl`);
    const at = new Date().toISOString();
    fs.writeFileSync(tr, msgs.main.map((t, i) => JSON.stringify({ type: 'assistant', timestamp: at, message: { id: `${name}-${i}`, usage: { input_tokens: t, output_tokens: 0 } } })).join('\n') + '\n');
    if (msgs.sub) {
      fs.mkdirSync(path.join(o.base, name, 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(o.base, name, 'subagents', 'a.jsonl'), JSON.stringify({ type: 'assistant', timestamp: at, message: { id: `${name}-s`, usage: { output_tokens: msgs.sub } } }) + '\n');
    }
    await o.hook(name, { hook_event_name: 'SessionStart', source: 'startup', session_id: `${name}-sesion`, transcript_path: tr });
  }
  return o;
}

test('gasto por robot: parte de la semana con subagentes y aviso único cuando se dispara en la última hora', async () => {
  const o = await spendOffice({}, { uno: { main: [1_000_000, 600_000], sub: 400_000 }, dos: { main: [500_000] } });
  try {
    await waitFor(async () => (await o.robot('uno')).spend?.week === 2_000_000, { what: 'el gasto de uno (con su subagente)' });
    const uno = await o.robot('uno'), dos = await o.robot('dos');
    assert.equal(uno.spend.officeWeek, 2_500_000);
    assert.equal(uno.spend.pct, 80);
    assert.equal(dos.spend.pct, 20);
    assert.equal(uno.spend.hot, 'hour', '2 M en la última hora es disparo');
    assert.equal(dos.spend.hot, null, 'la regla del 25 % espera a que la semana pase de 5 M');
    await sleep(900); // varias revisiones más: el aviso sale una sola vez
    const hits = (await o.robot('uno')).log.filter(l => /🔥 Se disparó: gastó 2,0 M tokens en la última hora/.test(l.text));
    assert.equal(hits.length, 1);
  } finally { await o.stop(); }
});

test('gasto por robot: más de la cuarta parte de la semana también es disparo', async () => {
  const o = await spendOffice({ OFFICE_SPEND_HOUR_HOT: '1e12', OFFICE_SPEND_MIN_WEEK: '1000' }, { uno: { main: [3000] }, dos: { main: [1000] }, tres: { main: [100] } });
  try {
    await waitFor(async () => (await o.robot('tres')).spend?.officeWeek === 4100, { what: 'el gasto de la semana' });
    assert.equal((await o.robot('uno')).spend.hot, 'share');
    assert.equal((await o.robot('dos')).spend.pct, 24);
    assert.equal((await o.robot('dos')).spend.hot, null);
    assert.equal((await o.robot('tres')).spend.hot, null);
  } finally { await o.stop(); }
});

test('empleado de la semana: cuenta desde que se renovó la cuota, corona con un fuego y con dos si también lidera la sesión de 5 h', async () => {
  const o = await startOffice({ maxRobots: 4, env: { OFFICE_SPEND_TICK_MS: '300' } });
  try {
    const H = 3600e3, t = Date.now();
    // La cuota semanal se renueva en 2 días (la semana empezó hace 5) y la sesión de 5 h termina en 1 h.
    fs.writeFileSync(path.join(o.data, 'config.json'), JSON.stringify({ quota: { weekEnd: t + 2 * 24 * H, sessionEnd: t + H } }));
    const write = (name, msgs) => {
      const tr = path.join(o.base, `${name}.jsonl`);
      fs.appendFileSync(tr, msgs.map(([tok, ago], i) => JSON.stringify({ type: 'assistant', timestamp: new Date(t - ago).toISOString(), message: { id: `${name}-${tok}-${ago}-${i}`, usage: { input_tokens: tok } } })).join('\n') + '\n');
      return tr;
    };
    const plan = { uno: [[2_000_000, 0]], dos: [[3_000_000, 6 * H]], tres: [[9_000_000, 6 * 24 * H]] }; // tres: antes de la renovación
    for (const [name, msgs] of Object.entries(plan)) {
      await o.api('POST', '/api/robots', libre(name));
      await o.hook(name, { hook_event_name: 'SessionStart', source: 'startup', session_id: `${name}-s`, transcript_path: write(name, msgs) });
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
  } finally { await o.stop(); }
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
    const parts = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
    assert.ok(parts.length > 1);
    const body = parts.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    assert.ok(js.includes(`(() => {\n${body}})();\n`), 'las partes van completas, en orden y envueltas');
    // Cada parte termina en salto de línea: si no, la última línea de una se pegaría a la primera de la siguiente.
    for (const f of parts) assert.ok(fs.readFileSync(path.join(dir, f), 'utf8').endsWith('\n'), `${f} termina en salto de línea`);
  } finally { await o.stop(); }
});
