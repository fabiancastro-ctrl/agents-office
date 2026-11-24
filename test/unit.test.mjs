// Pruebas unitarias: importan los módulos de daemon/lib/ sueltos, sin levantar una oficina ni tmux (son rápidas).
// Funciona porque ningún módulo toma el candado ni sale del proceso al cargarse: eso lo hace boot(), que solo llama
// daemon/daemon.mjs. Correr: node --test --test-force-exit test/unit.test.mjs (los módulos dejan timers vivos).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-unit-'));
process.env.OFFICE_DATA = path.join(tmp, 'datos');
process.env.OFFICE_SESSION = `office-unit-${process.pid}`;
process.env.OFFICE_TRASH = path.join(tmp, 'papelera');
process.env.OFFICE_PORT = '1';
process.env.AGENT_OFFICE_HOME = path.join(tmp, 'home'); // accounts registry isolated from the real one
process.env.OFFICE_PRINCIPAL_DIR = path.join(tmp, 'principal');
let base, equipo, salas, uso;
before(async () => {
  base = await import('../daemon/lib/base.mjs');
  equipo = await import('../daemon/lib/equipo.mjs');
  salas = await import('../daemon/lib/salas.mjs');
  uso = await import('../daemon/lib/uso.mjs');
});

test('cargar los módulos no toma el candado ni crea la carpeta de datos (eso es de boot)', () => {
  assert.ok(!fs.existsSync(path.join(process.env.OFFICE_DATA, 'daemon.lock')));
  assert.equal(typeof base.boot, 'function');
});

test('nombres de los hijos: salen del título, sin tildes ni palabras vacías, y se validan', () => {
  assert.equal(equipo.kidName('Revisión de los puertos'), 'revision-puertos');
  assert.equal(equipo.kidName('Handlers'), 'handlers');
  assert.equal(equipo.kidName('', 'migrar el wallet a hexagonal'), 'migrar-wallet', 'sin título sale del encargo');
  assert.equal(equipo.kidName('Migrar el repositorio'), 'migrar', 'si dos palabras no caben en 17 letras, queda la primera');
  assert.equal(equipo.kidName('Un nombre larguísimo de verdad para cortar'), 'nombre-larguisimo');
  assert.equal(equipo.kidName('de la'), '', 'sin palabras útiles no hay nombre');
  assert.equal(equipo.validName(' Mi-Robot '), 'mi-robot');
  assert.equal(equipo.validName('con espacios'), '');
});

test('replaceList y trunc', () => {
  const l = [1, 2, 3];
  assert.equal(base.replaceList(l, [9]), l, 'misma lista (la tienen importada otros módulos)');
  assert.deepEqual(l, [9]);
  assert.equal(base.trunc('  a   b  c  '), 'a b c');
  assert.equal(base.trunc('abcdef', 4), 'abc…');
});

test('papelera: mueve archivos y carpetas a OFFICE_TRASH con su nombre y hora', () => {
  const f = path.join(tmp, 'resumen.md');
  fs.writeFileSync(f, 'hola');
  const d = path.join(tmp, 'sala');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'CONTEXT.md'), 'ctx');
  const a = salas.toTrash(f, 'resumen-x'),
    b = salas.toTrash(d, 'sala-x');
  assert.ok(!fs.existsSync(f) && !fs.existsSync(d));
  assert.match(path.basename(a), /^resumen-x-.*\.md$/);
  assert.equal(fs.readFileSync(a, 'utf8'), 'hola');
  assert.equal(fs.readFileSync(path.join(b, 'CONTEXT.md'), 'utf8'), 'ctx');
  assert.equal(salas.toTrash(path.join(tmp, 'no-existe'), 'x'), null);
});

test('reparto: el estado sale de si el robot está, entregó, espera cupo o se fue', () => {
  assert.equal(salas.rosterState({ name: 'nadie-aqui', qid: 'zz' }), 'se fue');
  assert.equal(salas.rosterState({ name: 'nadie-aqui', qid: 'zz', dropped: true }), 'no se lanzó');
  assert.equal(salas.rosterState({ name: 'jefe-ausente', owner: true }), 'se fue');
});

test('semana de la cuota: sin dato de /usage cuenta desde el lunes y dura 7 días', () => {
  const p = uso.quotaPeriods(Date.parse('2026-11-18T15:00:00'));
  assert.equal(p.weekKnown, false);
  assert.equal(new Date(p.weekFrom).getDay(), 1, 'lunes');
  assert.equal(p.weekTo - p.weekFrom, 7 * 86400e3);
});

test('relevo por contexto: la decisión (oferta a los 300 k, automático en espera, exclusiones)', async () => {
  const { decideRelevo, blockedBy, isWait } = await import('../daemon/lib/relevo.mjs');
  for (const cmd of [
    '~/nr-fabi/.claude/skills/nr-ci/nr-esperar-ci nr-qa#310',
    'gh pr checks 12 --watch',
    'gh run watch 123',
    'until gh pr view 3 | grep -q MERGED; do sleep 60; done',
    'sleep 600'
  ])
    assert.ok(isWait({ kind: 'shell', cmd }), cmd);
  for (const cmd of ['go test ./...', 'terraform apply -auto-approve', 'npm run build && sleep 5 && npm test', ''])
    assert.ok(!isWait({ kind: 'shell', cmd }), cmd);
  for (const kind of ['monitor', 'despertador', 'cron']) assert.ok(isWait({ kind }), kind);
  const base = { closedTurn: true, blocked: false, bg: 0, waitedMin: 0, nextAt: 0, offerK: 300, waitK: 150, waitMin: 45 };
  const d = o => decideRelevo({ ...base, ...o });
  assert.equal(d({ tokens: 299000 }), null, 'bajo el umbral');
  assert.equal(d({ tokens: 300000 }), 'oferta');
  assert.equal(d({ tokens: 400000, closedTurn: false }), null, 'en medio de un turno');
  assert.equal(d({ tokens: 400000, blocked: true }), null, 'con algo pendiente');
  assert.equal(d({ tokens: 200000, bg: 1, waitedMin: 44 }), null, 'espera corta');
  assert.equal(d({ tokens: 200000, bg: 1, waitedMin: 45 }), 'auto');
  assert.equal(d({ tokens: 149000, bg: 1, waitedMin: 90 }), null, 'poco contexto');
  assert.equal(d({ tokens: 200000, bg: 0, waitedMin: 90 }), null, 'sin nada en segundo plano no es espera');
  assert.equal(d({ tokens: 350000, bg: 1, waitedMin: 60 }), 'auto', 'el automático gana a la oferta');
  assert.equal(d({ tokens: 200000, bg: 1, bgWork: 1, waitedMin: 90 }), null, 'con trabajo de fondo vivo no se releva solo');
  assert.equal(d({ tokens: 350000, bg: 2, bgWork: 1, waitedMin: 90 }), 'oferta', 'con trabajo de fondo solo se ofrece');
  assert.equal(d({ tokens: 350000, nextAt: 400000 }), null, '«Seguir así» sube el umbral');
  assert.equal(d({ tokens: 400000, nextAt: 400000 }), 'oferta');
  assert.equal(d({ tokens: 80000, offerK: 50 }), 'oferta', 'umbral configurable');
  assert.equal(blockedBy({}), null);
  for (const k of ['hold', 'ask', 'needsPermission', 'spawnReq', 'summaryPending', 'relevoPending', 'routine', 'consoleLost'])
    assert.ok(blockedBy({ [k]: 'x' }), k);
  assert.ok(blockedBy({ pendingSubs: 1 }));
});

test('uniforme del robot según el encargo (web/robot-art.js)', async () => {
  const vm = await import('node:vm');
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../web/robot-art.js', import.meta.url), 'utf8') + '\nthis.outfitOf = outfitOf;', ctx);
  const o = ctx.outfitOf;
  assert.equal(o({ skill: 'review-deep' }, null), 'inspector');
  assert.equal(o({ title: 'Investiga el timeout del gateway' }, null), 'explorer');
  assert.equal(o({ request: { text: 'Implementa el handler de pagos' } }, null), 'apron');
  assert.equal(o({ title: 'Fix login' }, null), 'apron');
  assert.equal(o({ origin: 'Lanzado por la rutina «vigía» para x#1', skill: 'review-deep' }, null), 'overall');
  assert.equal(o({ origin: 'Lanzado por ti', title: 'Hola' }, null), '');
  assert.equal(o({ skill: 'x' }, { type: 'room', sala: false }), 'hardhat');
});

test('el robot de relevo se reconoce por su origen (web/robot-art.js)', async () => {
  const vm = await import('node:vm');
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../web/robot-art.js', import.meta.url), 'utf8') + '\nthis.isRelevo = isRelevo;', ctx);
  assert.equal(ctx.isRelevo({ origin: 'Relevo por contexto de api (320k): sigue con su resumen' }), true);
  assert.equal(ctx.isRelevo({ origin: 'Relevo por contexto de api (320k) · esperó cupo en la puerta' }), true);
  assert.equal(ctx.isRelevo({ origin: 'Lanzado por ti' }), false);
  assert.equal(ctx.isRelevo(null), false);
});

test('accounts: automatic choice picks the most free weekly quota from simulated readings', async () => {
  const cu = await import('../daemon/lib/cuentas.mjs');
  const t = Date.parse('2026-11-25T12:00:00Z'),
    end = Date.parse('2026-11-30T23:00:00Z');
  const read = (pct, at = t - 60e3) => ({ weekPct: pct, weekPctAt: at, weekEnd: end });
  // Only the principal exists: it is always the answer
  assert.equal(cu.autoAccount({ principal: read(95) }, t), '');
  fs.mkdirSync(process.env.AGENT_OFFICE_HOME, { recursive: true });
  cu.saveAccounts([
    { id: 'b', nombre: 'B', dir: path.join(tmp, 'cb') },
    { id: 'c', nombre: 'C', dir: path.join(tmp, 'cc') }
  ]);
  assert.equal(cu.autoAccount({}, t), '', 'no readings: the principal');
  assert.equal(cu.autoAccount({ principal: read(70), b: read(30), c: read(50) }, t), 'b');
  assert.equal(cu.autoAccount({ principal: read(20), b: read(30) }, t), '', 'the principal has more free quota');
  assert.equal(cu.autoAccount({ principal: read(40), b: read(40) }, t), '', 'a tie goes to the principal');
  assert.equal(cu.autoAccount({ principal: read(90), b: read(60) }, t), 'b', 'an account never read does not compete');
  // A reading from before the last renewal counts as 0: the week started over
  const old = { weekPct: 99, weekPctAt: end - 9 * 86400e3, weekEnd: end };
  assert.equal(cu.autoAccount({ principal: read(50), b: old }, t), 'b');
  assert.equal(cu.weekUsed(old, t), 0);
  // 95 % ceiling: an account above it only wins when nothing else is left
  assert.equal(cu.autoAccount({ principal: read(96), b: read(97) }, t), '', 'all above 95: the least used anyway');
  assert.equal(cu.autoAccount({ principal: read(96), b: read(80) }, t), 'b');
  assert.equal(cu.autoAccount({ principal: read(10), b: read(40) }, t, { skip: ['principal'] }), 'b', 'skips an exhausted account');
  // strict (moving a robot): nothing usable is null; an account never read counts as available
  assert.equal(cu.pickAccount({ principal: read(10), b: read(96), c: read(99) }, t, { skip: ['principal'], strict: true }), null);
  assert.equal(cu.pickAccount({ principal: read(10) }, t, { skip: ['principal'], strict: true })?.id, 'b');
  cu.saveAccounts([]);
});

test('limits: the «hit your limit» text gives its kind and reset instant (with its time zone)', async () => {
  const { parseLimit } = await import('../daemon/lib/limite-texto.mjs');
  const from = Date.parse('2026-11-24T15:00:00Z'); // 10:00 in Bogota (UTC-5)
  const five = parseLimit("You've hit your 5-hour limit · resets 6:20pm (America/Bogota)", from);
  assert.equal(five.kind, '5h');
  assert.equal(five.resetsText, '6:20pm (America/Bogota)');
  assert.equal(new Date(five.until).toISOString(), '2026-11-24T23:20:00.000Z');
  // The clock already passed today: tomorrow
  const next = parseLimit("You've hit your 5-hour limit · resets 9am (America/Bogota)", from);
  assert.equal(new Date(next.until).toISOString(), '2026-11-25T14:00:00.000Z');
  const week = parseLimit("You've hit your weekly limit · resets Nov 30 at 6pm (America/Bogota)", from);
  assert.equal(week.kind, 'week');
  assert.equal(new Date(week.until).toISOString(), '2026-11-30T23:00:00.000Z');
  const odd = parseLimit("You've hit your weekly limit · resets soon", from);
  assert.deepEqual([odd.kind, odd.until], ['week', null]);
});

// ---- Cuaderno (daemon/lib/memoria.mjs) ----
const memDir = () => fs.mkdtempSync(path.join(tmp, 'memoria-'));
const NOTE = `---
titulo: nr-infra se fusiona con --admin
tema: merge, nr-infra
alcance: oficina            # oficina | sala:<id> | repo:<nombre>
autor: Fabian
creada: 2026-11-23
revisar: 2027-02-23
---
En nr-infra los PR se fusionan con gh pr merge --admin.
**Por qué:** el ruleset exige un architect.
**Cuándo aplica:** solo nr-infra.
`;

test('notebook: a note parses (frontmatter, inline comments, body) and serializes back', async () => {
  const m = await import('../daemon/lib/memoria.mjs');
  const { meta, body } = m.parseNote(NOTE);
  assert.equal(meta.titulo, 'nr-infra se fusiona con --admin');
  assert.equal(meta.alcance, 'oficina', 'the trailing comment is dropped');
  assert.equal(meta.revisar, '2027-02-23');
  assert.match(body, /\*\*Por qué:\*\*/);
  assert.deepEqual(m.parseNote(m.serializeNote(meta, body)), { meta, body });
  assert.deepEqual(m.parseNote('sin encabezado').meta, {});
});

test('notebook: revisar defaults to creada + 3 months (day clamped) and the note is validated', async () => {
  const m = await import('../daemon/lib/memoria.mjs');
  assert.equal(m.addMonths('2026-11-23'), '2027-02-23');
  assert.equal(m.addMonths('2026-11-30'), '2027-02-28');
  assert.equal(m.addMonths('2026-10-31'), '2027-01-31');
  const n = m.normalizeNote('---\ntitulo: Algo\n---\nUn hecho.', { autor: 'robot x', today: '2026-11-24' });
  assert.deepEqual([n.meta.alcance, n.meta.autor, n.meta.creada, n.meta.revisar], ['oficina', 'robot x', '2026-11-24', '2027-02-24']);
  assert.throws(() => m.normalizeNote('---\ntema: x\n---\nhecho'), /titulo/);
  assert.throws(() => m.normalizeNote('---\ntitulo: a\n---\n'), /no tiene texto/);
  assert.throws(() => m.normalizeNote('---\ntitulo: a\nalcance: mundo\n---\nhecho'), /alcance/);
  assert.throws(() => m.normalizeNote(`---\ntitulo: a\n---\n${'x'.repeat(2001)}`), /muy larga/);
});

test('notebook: credentials, emails and private URLs are rejected; public ones pass', async () => {
  const { forbidden } = await import('../daemon/lib/memoria.mjs');
  const bad = [
    ['-----BEGIN RSA PRIVATE KEY-----', /llave privada/],
    ['usa sk-ant-api03-abcdefghijklmnop1234', /API key/],
    ['el token ghp_abcdefghijklmnopqrstuvwxyz0123456789', /GitHub/],
    ['AKIAABCDEFGHIJKLMNOP', /AWS/],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123', /Bearer/],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', /JWT/],
    ['password: hunter2hunter2', /contraseña/],
    ['contraseña = Abc12345', /contraseña/],
    ['escribe a juan.perez@cliente.com', /correo/],
    ['mira https://gitea.dex.moimolcp.com/Fabi/agent-office', /URL no pública/],
    ['abre http://localhost:4778/api', /URL no pública/],
    ['en nexus.dropi.co está la tarea', /dirección privada/]
  ];
  for (const [text, why] of bad) assert.match(forbidden(text).join(' | '), why, text);
  const ok = [
    'Ver https://github.com/NR-2-0/nr-kit/pull/12 y https://docs.github.com/es',
    'El token expira rápido y la clave de partición es order_id',
    'Se fusiona con @NR-2-0/frontend-maintainers',
    'commit 0123456789abcdef0123456789abcdef01234567'
  ];
  for (const text of ok) assert.deepEqual(forbidden(text), [], text);
});

test('notebook: word search ignores case and accents, weighs title/tema, needs half of the words', async () => {
  const m = await import('../daemon/lib/memoria.mjs');
  const notes = [
    { id: 'a', titulo: 'Fusión de nr-infra', tema: 'merge', cuerpo: 'Usar --admin porque Fabian es architect' },
    { id: 'b', titulo: 'Colima para pruebas', tema: 'docker', cuerpo: 'Sin DOCKER_HOST no corre nada' },
    { id: 'c', titulo: 'Otra', tema: 'otra', cuerpo: 'merge de ramas' }
  ];
  assert.deepEqual(
    m.search(notes, 'FUSION').map(n => n.id),
    ['a']
  );
  assert.deepEqual(
    m.search(notes, 'merge').map(n => n.id),
    ['a', 'c'],
    'tema outranks body'
  );
  assert.deepEqual(
    m.search(notes, 'docker host').map(n => n.id),
    ['b']
  );
  assert.deepEqual(
    m.search(notes, 'nr-infra zzzz qqqq xxxx').map(n => n.id),
    [],
    'fewer than half of the words'
  );
  assert.deepEqual(m.search(notes, 'de la'), [], 'only stop words');
  assert.deepEqual(m.search(notes, ''), []);
});

test('notebook: similar notes are found by title and tema word overlap', async () => {
  const m = await import('../daemon/lib/memoria.mjs');
  const notes = [
    { id: 'a', titulo: 'nr-infra se fusiona con --admin', tema: 'merge, nr-infra' },
    { id: 'b', titulo: 'Colima para pruebas de integración', tema: 'docker' }
  ];
  assert.deepEqual(m.similar(notes, { titulo: 'Fusionar nr-infra con admin', tema: 'merge' }), [{ id: 'a', titulo: notes[0].titulo }]);
  assert.deepEqual(m.similar(notes, { titulo: 'Algo distinto del todo', tema: 'otro' }), []);
});

test('notebook: propose, approve (INDICE.md), edit, renew and reads, all on files', async () => {
  const m = await import('../daemon/lib/memoria.mjs');
  const dir = memDir();
  const today = '2026-11-24';
  const p = m.propose(
    { titulo: 'Colima para pruebas', tema: 'docker, tests', hecho: 'Exporta DOCKER_HOST.', porque: 'sin él no corre', autor: 'robot uno' },
    { dir, today }
  );
  assert.equal(p.id, 'colima-para-pruebas');
  assert.equal(m.listProposals(dir, today).length, 1);
  assert.equal(m.listNotes(dir, today).length, 0);
  assert.throws(
    () => m.propose({ titulo: 'Clave', hecho: 'api_key=abcd1234efgh' }, { dir, today }),
    e => e.motivos?.length > 0
  );
  // a second one with the same title: unique id and «se parece a»
  const q = m.propose({ titulo: 'Colima para pruebas', tema: 'docker', hecho: 'Otra vez.' }, { dir, today });
  assert.equal(q.id, 'colima-para-pruebas-2');
  assert.equal(q.parecidas[0].id, 'colima-para-pruebas');
  const nid = m.approve(p.id, undefined, { dir, today });
  assert.equal(m.listNotes(dir, today)[0].revisar, '2027-02-24');
  assert.equal(m.listProposals(dir, today).length, 1);
  assert.match(
    fs.readFileSync(path.join(dir, 'INDICE.md'), 'utf8'),
    /- Colima para pruebas — docker, tests — notas\/colima-para-pruebas\.md/
  );
  // edit and renew
  m.editNote(nid, '---\ntitulo: Colima\ntema: docker\ncreada: 2026-01-01\nrevisar: 2026-04-01\n---\nTexto nuevo.', { dir, today });
  assert.equal(m.listNotes(dir, today)[0].vencida, true, 'past revisar = expired');
  m.renewNote(nid, { dir, today });
  assert.deepEqual([m.listNotes(dir, today)[0].vencida, m.listNotes(dir, today)[0].revisar], [false, '2027-02-24']);
  assert.throws(() => m.approve('no-existe', undefined, { dir }), /ya no está/);
  // reads: per note, and distinct notes per robot (a new robot with the same name starts over)
  assert.equal(m.recordReads([nid], 'rex', 't1', dir), 1);
  assert.equal(m.recordReads([nid], 'rex', 't1', dir), 1);
  assert.equal(m.readReads(dir).notas[nid], 2);
  assert.equal(m.robotReads('rex', 't1', dir), 1);
  assert.equal(m.robotReads('rex', 't2', dir), 0);
});

test('notebook: INDICE.md has one line per approved note', async () => {
  const m = await import('../daemon/lib/memoria.mjs');
  const txt = m.indexText([
    { id: 'a', titulo: 'Uno', tema: 'x' },
    { id: 'b', titulo: 'Dos', tema: '' }
  ]);
  assert.match(txt, /- Uno — x — notas\/a\.md\n- Dos — sin tema — notas\/b\.md\n$/);
});

test('shared quota: the newest reading wins, histories merge by max, a missing or corrupt file is empty', async () => {
  const cu = await import('../daemon/lib/cuentas.mjs');
  const file = path.join(process.env.AGENT_OFFICE_HOME, 'cuota.json');
  fs.mkdirSync(process.env.AGENT_OFFICE_HOME, { recursive: true });
  fs.rmSync(file, { force: true });
  assert.deepEqual(cu.quotaReadings(), {}, 'missing file');
  assert.deepEqual(cu.quotaReadings({ b: { weekPct: 3, weekPctAt: 1 } }), { b: { weekPct: 3, weekPctAt: 1 } }, 'local only');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(cu.quotaReadings(), {}, 'corrupt file');
  cu.saveQuotaReading('b', { weekPct: 10, weekPctAt: 100, weekEnd: 5, history: { '2026-11-23': 10, '2026-11-30': 5 } });
  assert.equal(cu.quotaReadings().b.weekPct, 10, 'a corrupt file is replaced by a clean one');
  // An older reading never overwrites a newer one, but its history still merges
  cu.saveQuotaReading('b', { weekPct: 99, weekPctAt: 50, weekEnd: 5, history: { '2026-11-23': 40 } });
  const b = JSON.parse(fs.readFileSync(file, 'utf8')).b;
  assert.equal(b.weekPct, 10);
  assert.deepEqual(b.history, { '2026-11-23': 40, '2026-11-30': 5 });
  // A newer local reading wins over the global one; a newer global wins over a stale local one
  assert.equal(cu.quotaReadings({ b: { weekPct: 20, weekPctAt: 200, history: { '2026-11-30': 8 } } }).b.weekPct, 20);
  assert.equal(cu.quotaReadings({ b: { weekPct: 20, weekPctAt: 200, history: { '2026-11-30': 8 } } }).b.history['2026-11-30'], 8);
  assert.equal(cu.quotaReadings({ b: { weekPct: 20, weekPctAt: 10 } }).b.weekPct, 10);
  // Without weekPctAt the newer sessionEnd decides
  cu.saveQuotaReading('c', { sessionEnd: 10, weekPct: 1 });
  cu.saveQuotaReading('c', { sessionEnd: 5, weekPct: 2 });
  assert.equal(cu.quotaReadings().c.weekPct, 1);
  // History keeps the last 16 weeks
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`2026-01-${String(i + 1).padStart(2, '0')}`, i]));
  cu.saveQuotaReading('d', { weekPct: 1, weekPctAt: 1, history: many });
  assert.equal(Object.keys(cu.quotaReadings().d.history).length, 16);
  assert.ok(cu.quotaFileStamp() > 0);
});
