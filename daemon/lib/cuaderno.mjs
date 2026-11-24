// Oficina de Agentes · «Cuaderno»: rutas de la API y avisos a la página. La lógica de archivos vive en memoria.mjs.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import { console_, robots } from './base.mjs';
import { broadcast, emit } from './estado.mjs';
import { toTrash } from './salas.mjs';
import { readBody, send } from './http.mjs';
import {
  approve,
  daysUnread,
  editNote,
  isUnread,
  similar,
  listNotes,
  listProposals,
  notePath,
  propose,
  readReads,
  recordReads,
  renewNote,
  search,
  writeIndex
} from './memoria.mjs';

// Counters for the header badge and the panel tabs.
function summary() {
  const notes = listNotes();
  return { notas: notes.length, propuestas: listProposals().length, porRevisar: notes.filter(n => n.vencida).length };
}
const emitMemoria = () => broadcast({ type: 'memoria', memoria: summary() });

// Regenerates INDICE.md at start (notes may have been written by hand since the last run).
try {
  writeIndex();
} catch (e) {
  console_('cuaderno', 'índice', `no pude escribir INDICE.md: ${e.message}`);
}

const withReads = notes => {
  const { notas, ultima } = readReads();
  return notes.map(n => ({
    ...n,
    lecturas: notas[n.id] || 0,
    ultimaLectura: ultima[n.id] || '',
    diasSinLeer: daysUnread(n, ultima[n.id]),
    sinLeer: isUnread(n, ultima[n.id])
  }));
};
// Each proposal with the approved notes it resembles, so the panel can warn before approving.
const withSimilar = (props, notes = listNotes()) => props.map(p => ({ ...p, parecidas: similar(notes, p) }));

// The badge counts what needs Fabian: proposals waiting plus notes past their review day. A note becomes due with the
// calendar, not with an event, so a slow tick tells the page when the count changed.
let lastCount = '';
setInterval(() => {
  const s = summary(),
    key = `${s.propuestas}:${s.porRevisar}`;
  if (lastCount && key !== lastCount) emitMemoria();
  lastCount = key;
}, Number(process.env.OFFICE_MEMORIA_TICK_MS) || 3600e3).unref();
// Errors from memoria.mjs carry a status; anything else is a bad request from the caller.
const fail = (res, e) => send(res, e.status || (e.motivos ? 422 : 400), { error: e.message, motivos: e.motivos });

async function cuadernoApi(req, res, url, parts) {
  if (parts[0] !== 'api' || parts[1] !== 'memoria') return false;
  const sub = parts[2],
    id = parts[3],
    act = parts[4];
  try {
    // Search from a robot (counts the read) or from anyone with ?q=.
    if (req.method === 'GET' && !sub) {
      const q = url.searchParams.get('q') || '';
      const results = search(listNotes(), q);
      const name = url.searchParams.get('robot') || '';
      const r = robots.get(name);
      const n = recordReads(
        results.map(x => x.id),
        r ? name : '',
        r?.startedAt
      );
      if (r && n) emit(r);
      return send(res, 200, { q, results });
    }
    if (req.method === 'GET' && sub === 'resumen') return send(res, 200, summary());
    // The page lists and filters without counting reads.
    if (req.method === 'GET' && sub === 'notas') return send(res, 200, { notas: withReads(listNotes()) });
    if (req.method === 'GET' && sub === 'propuestas') return send(res, 200, { propuestas: withSimilar(listProposals()) });

    if (req.method === 'POST' && sub === 'propuestas' && !id) {
      const b = await readBody(req);
      const robot = String(b.robot || '').trim();
      try {
        const r = propose({
          titulo: b.titulo,
          tema: b.tema,
          alcance: b.alcance,
          autor: robot ? `robot ${robot}` : 'robot',
          hecho: b.hecho,
          porque: b.porque,
          cuando: b.cuando
        });
        console_('cuaderno', 'propuesta', `${robot || '?'}: ${r.id}`);
        emitMemoria();
        return send(res, 201, { ok: true, ...r });
      } catch (e) {
        if (e.motivos) console_('cuaderno', 'rechazada', `${robot || '?'}: ${e.message}`);
        return fail(res, e);
      }
    }
    if (req.method === 'POST' && sub === 'propuestas' && id && act === 'aprobar') {
      const b = await readBody(req);
      const nid = approve(id, typeof b.texto === 'string' ? b.texto : undefined);
      emitMemoria();
      return send(res, 200, { ok: true, id: nid });
    }
    if (req.method === 'POST' && sub === 'propuestas' && id && act === 'descartar') {
      const file = notePath('propuesta', id);
      if (!file) return send(res, 404, { error: 'Esa propuesta ya no está.' });
      toTrash(file, `cuaderno-propuesta-${id}`);
      emitMemoria();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && sub === 'notas' && id) {
      const b = await readBody(req);
      editNote(id, String(b.texto ?? ''));
      emitMemoria();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && sub === 'notas' && id && act === 'renovar') {
      renewNote(id);
      emitMemoria();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && sub === 'notas' && id) {
      const file = notePath('nota', id);
      if (!file) return send(res, 404, { error: 'Esa nota ya no está.' });
      toTrash(file, `cuaderno-nota-${id}`);
      writeIndex();
      emitMemoria();
      return send(res, 200, { ok: true });
    }
  } catch (e) {
    return fail(res, e);
  }
  return false;
}

export { cuadernoApi, summary };
