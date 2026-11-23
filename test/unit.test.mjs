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
