// Oficina de Agentes · exportar conversaciones y resúmenes de despedidos.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { console_, now, replaceList, robots, RUNS, saveJson, saveJsonAsync, trunc, WORKSPACE } from './base.mjs';
import { broadcast, emit } from './estado.mjs';
import { lookFromName } from './equipo.mjs';
import { ARCH_FILE, ARCH_MAX, archive, normText, sumDir } from './turno.mjs';
import { launch } from './tmux.mjs';
import { toTrash } from './salas.mjs';
import { readBody, send } from './http.mjs';

/* ---------- exportar una conversación ---------- */
// Copia limpia de la conversación de un robot (vivo o del archivo) en docs/conversaciones-robots/, por si un resumen
// falla o queda corto. Sale del transcript completo de Claude: la oficina solo guarda los últimos 400 eventos. Lleva tus
// mensajes y los suyos en orden, con hora; los avances («Ahora reviso…») se marcan aparte de sus respuestas y las
// herramientas quedan como una línea con cuántas usó. Si el transcript ya no está, usa lo que guardó la oficina.
const flat = t =>
  String(t ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const convDir = () => path.join(WORKSPACE || RUNS, 'docs', 'conversaciones-robots');
const NOISE_RE =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|task-notification)\b|^\s*\[Request interrupted/;
const cleanText = t =>
  String(t ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\\?\/?pasted_content(?:\s+id=["']?[\w-]*["']?)?\s*>/gi, '')
    .trim();
function transcriptTurns(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
  const items = [],
    seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isMeta || e.isCompactSummary || e.isSidechain) continue;
    const at = e.timestamp,
      c = e.message?.content;
    if (e.type === 'user') {
      const parts =
        typeof c === 'string'
          ? [c]
          : Array.isArray(c) && !c.some(b => b.type === 'tool_result')
            ? c.filter(b => b.type === 'text').map(b => b.text)
            : [];
      for (const raw of parts) {
        const bash = String(raw).match(/^\s*<bash-input>([\s\S]*?)<\/bash-input>/);
        if (bash) {
          items.push({ who: 'user', text: '`! ' + bash[1].trim() + '`', at });
          continue;
        }
        if (NOISE_RE.test(raw)) continue;
        const text = cleanText(raw);
        if (text) items.push({ who: /^\[Oficina\]/.test(text) ? 'office' : 'user', text, at });
      }
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        const key = `${e.message?.id}|${b.type}|${b.type === 'text' ? b.text : b.id}`;
        if (seen.has(key)) continue; // Claude repite el mismo mensaje en varias líneas mientras lo escribe
        seen.add(key);
        if (b.type === 'text' && cleanText(b.text)) items.push({ who: 'agent', text: cleanText(b.text), at });
        else if (b.type === 'tool_use') items.push({ who: 'tool', at });
      }
    }
  }
  return items;
}
function convMarkdown(src, items) {
  const when = t =>
    t ? new Date(t).toLocaleString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const hhmm = t => (t ? new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '');
  const out = [
    `# Conversación de ${src.name}${src.title ? ` · ${src.title}` : ''}`,
    '',
    `_Exportada por la Oficina de Agentes el ${when(Date.now())} · entró ${when(src.startedAt)}${src.leftAt ? ` · se fue ${when(src.leftAt)}` : ''}${src.fromLog ? ' · desde lo que guardó la oficina (el transcript ya no estaba)' : ''}_`,
    '',
    `- **Encargo:** ${flat(src.label)}`
  ];
  if (src.origin) out.push(`- **Origen:** ${flat(src.origin)}`);
  if (src.note) out.push(`- **Nota:** ${flat(src.note)}`);
  if (src.sessionId) out.push(`- **Sesión de Claude:** \`${src.sessionId}\` (para retomarla: \`claude --resume ${src.sessionId}\`)`);
  out.push('', '---', '');
  let tools = 0,
    msgs = 0;
  const flushTools = () => {
    if (tools) out.push(`_… usó ${tools} herramienta${tools === 1 ? '' : 's'} …_`, '');
    tools = 0;
  };
  items.forEach((it, i) => {
    if (it.who === 'tool') {
      tools++;
      return;
    }
    flushTools();
    msgs++;
    if (it.who === 'agent') {
      // Avance: después vienen más herramientas o mensajes suyos antes de que le vuelvas a escribir.
      let interim = false;
      for (let k = i + 1; k < items.length && items[k].who !== 'user'; k++)
        if (items[k].who === 'tool' || items[k].who === 'agent') {
          interim = true;
          break;
        }
      out.push(interim ? `#### 🤖 ${src.name} · avance · ${hhmm(it.at)}` : `### 🤖 ${src.name} · ${hhmm(it.at)}`, '', it.text, '');
    } else out.push(`### ${it.who === 'office' ? '🏢 Oficina' : '🧑 Tú'} · ${hhmm(it.at)}`, '', it.text, '');
  });
  flushTools();
  if (src.summary)
    out.push(
      '---',
      '',
      `## Su resumen al irse (${src.summaryBy === 'robot' ? 'lo escribió el robot' : 'lo armó la oficina'})`,
      '',
      String(src.summary).trim(),
      ''
    );
  return { md: out.join('\n'), msgs };
}
function exportConversation(src) {
  let items = src.transcript ? transcriptTurns(src.transcript) : null;
  const fromLog = !items || !items.some(x => x.who !== 'tool');
  if (fromLog)
    items = (src.log || [])
      .filter(l => ['user', 'agent', 'bg'].includes(l.kind))
      .map(l => ({
        who: l.kind === 'agent' ? 'agent' : /^\[Oficina\]/.test(l.text) ? 'office' : 'user',
        text: cleanText(l.text),
        at: l.at
      }))
      .filter(x => x.text);
  if (!items.length) throw new Error(`${src.name} todavía no tiene conversación para exportar.`);
  const { md, msgs } = convMarkdown({ ...src, fromLog }, items);
  const file = path.join(convDir(), `${now().slice(0, 10)}-${src.name}-${crypto.randomBytes(2).toString('hex')}.md`);
  fs.mkdirSync(convDir(), { recursive: true });
  fs.writeFileSync(file, md + '\n');
  console_(src.name, 'exportada', path.relative(WORKSPACE || RUNS, file));
  return { path: file, shown: path.relative(WORKSPACE || RUNS, file), messages: msgs, fromLog };
}
// Los resúmenes de antes vivían en la carpeta de datos de la oficina (runs/resumenes): se mudan a la nueva.
function migrateSummaries() {
  const old = path.join(RUNS, 'resumenes');
  if (!WORKSPACE || !fs.existsSync(old)) return;
  let moved = 0;
  try {
    fs.mkdirSync(sumDir(), { recursive: true });
    for (const f of fs.readdirSync(old)) {
      const from = path.join(old, f),
        to = path.join(sumDir(), f);
      if (!f.endsWith('.md') || fs.existsSync(to)) continue;
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      moved++;
      for (const a of archive) if (a.summaryPath === from) a.summaryPath = to;
    }
    if (!fs.readdirSync(old).length) fs.rmdirSync(old);
  } catch (e) {
    console.error(`No se pudieron mudar los resúmenes a ${sumDir()}: ${e.message}`);
  }
  if (moved) {
    saveJson(ARCH_FILE, archive);
    console.log(`Resúmenes mudados a ${sumDir()}: ${moved}`);
  }
}
function writeSummary(r, summary, by) {
  const day = now().slice(0, 10);
  const file = path.join(sumDir(), `${day}-${r.name}-${crypto.randomBytes(2).toString('hex')}.md`);
  const head = `# ${r.name}${r.title ? ` · ${r.title}` : ''}\n\n_${by === 'robot' ? 'Resumen escrito por el robot al despedirlo' : 'Resumen armado por la oficina al despedirlo'} · entró ${r.startedAt?.slice(0, 16).replace('T', ' ')} · se fue ${now().slice(0, 16).replace('T', ' ')}_\n\n`;
  try {
    fs.mkdirSync(sumDir(), { recursive: true });
    fs.writeFileSync(file, head + summary.trim() + '\n');
    return file;
  } catch {
    return null;
  }
}
// Resumen que arma la oficina sin despertar al robot (no gasta tokens): para uno «frío», cuya caché ya venció y al que
// pedirle el resumen le costaría reescribir todo su contexto. Sale de lo que la oficina ya tiene de él.
function officeSummary(r) {
  const rel = p => (WORKSPACE && p.startsWith(WORKSPACE + path.sep) ? path.relative(WORKSPACE, p) : p);
  const said = r.log
    .filter(l => l.kind === 'agent')
    .slice(-2)
    .map(l => String(l.text || '').trim())
    .filter(Boolean);
  const out = [
    `## Objetivo\n\n${r.title ? `**${r.title}** · ` : ''}${trunc(
      String(r.prompt || r.label || '')
        .replace(/\n--- Sala[\s\S]*$/, '')
        .trim(),
      1500
    )}`
  ];
  if (r.note) out.push(`## Nota tuya\n\n${r.note}`);
  if (said.length) out.push(`## Lo último que dijo\n\n${said.map(t => trunc(t, 3000)).join('\n\n---\n\n')}`);
  if (r.docs.length) out.push(`## Documentos\n\n${r.docs.map(d => `- ${rel(d.path)}`).join('\n')}`);
  if (r.files?.length)
    out.push(
      `## Archivos que tocó\n\n${r.files
        .slice(-30)
        .reverse()
        .map(f => `- ${rel(f)}`)
        .join('\n')}`
    );
  const bg = Object.values(r.bg || {});
  if (bg.length) out.push(`## Dejó corriendo de fondo\n\n${bg.map(e => `- ${e.kind}: ${e.what}`).join('\n')}`);
  out.push(`## Sesión\n\n\`claude --resume ${r.sessionId}\` recupera su conversación completa.`);
  return out.join('\n\n');
}
// Solo se archiva (con su documento en docs/resumenes-robots/) quien se fue con «📝 Despedir con su resumen».
// «Dar de baja» es solo eso: se va sin resumen ni archivo.
function archiveRobot(r, reason, robotSummary, by = 'robot') {
  const summary = String(robotSummary || '').trim();
  if (!summary) return;
  const summaryPath = writeSummary(r, summary, by);
  const log = r.log
    .filter(l => ['user', 'agent', 'bg', 'doc'].includes(l.kind))
    .slice(-80)
    .map(l => ({ kind: l.kind, at: l.at, text: String(l.text ?? '').slice(0, 6000), ...(l.who ? { who: l.who } : {}) }));
  archive.push({
    id: crypto.randomBytes(4).toString('hex'),
    name: r.name,
    title: r.title || '',
    label: r.label,
    kind: r.kind,
    skill: r.skill,
    origin: r.origin,
    color: r.color,
    look: { ...lookFromName(r.name), ...(r.look || {}) },
    parent: r.parent || null,
    note: r.note || '',
    summary,
    summaryBy: by,
    summaryPath,
    permissionMode: r.permissionMode || '',
    tools: r.tools || [],
    modelPick: r.modelPick || '',
    request: r.request || null,
    transcript: r.transcript || null,
    sessionId: r.sessionId || null,
    startedAt: r.startedAt,
    leftAt: now(),
    reason,
    docs: r.docs.map(d => d.path),
    log
  });
  if (archive.length > ARCH_MAX) replaceList(archive, archive.slice(-ARCH_MAX));
  saveJsonAsync(ARCH_FILE, archive).catch(() => {});
  emitArchive();
}
const RELEVO_REASON = 'relevado por contexto'; // el motivo con que relevo.mjs da de baja al robot relevado
const archMeta = a => ({
  id: a.id,
  name: a.name,
  title: a.title,
  relevo: a.reason === RELEVO_REASON,
  label: a.label,
  color: a.color,
  look: a.look,
  startedAt: a.startedAt,
  leftAt: a.leftAt,
  docs: a.docs.length,
  note: a.note || '',
  summaryBy: a.summaryBy || 'oficina',
  summaryPath: a.summaryPath || null,
  excerpt: trunc(String(a.summary || '').replace(/[#*_`>|-]+/g, ' '), 260)
});
const emitArchive = () => broadcast({ type: 'archive', count: archive.length });
// Busca en el archivo (sin tildes ni mayúsculas): devuelve por robot las posiciones de los mensajes que coinciden.
function searchArchive(q) {
  const qn = normText(q).trim();
  if (qn.length < 2) return [];
  const out = [];
  for (const a of archive.slice().reverse()) {
    const hits = [];
    a.log.forEach((l, i) => {
      if (hits.length < 25 && normText(l.text).includes(qn))
        hits.push({ i, at: l.at, kind: l.kind, who: l.who || null, text: l.text.slice(0, 1500) });
    });
    const inMeta = !hits.length && normText(`${a.name} ${a.title} ${a.label} ${a.note || ''} ${a.summary || ''}`).includes(qn);
    if (hits.length || inMeta) out.push({ ...archMeta(a), hits });
    if (out.length >= 40) break;
  }
  return out;
}

// Retomar: entra un robot nuevo (sesión nueva) con solo el super resumen del que se fue y tu instrucción. Si necesita
// más contexto, se lo das tú o lo busca en los documentos y la memoria del proyecto.
async function retake(id, text) {
  const a = archive.find(x => x.id === id);
  if (!a) throw new Error('Ese robot ya no está en el archivo.');
  const summary = a.summary || '(sin resumen)';
  const prompt =
    `Retomas una tarea que dejó el robot ${a.name}${a.title ? ` («${a.title}»)` : ''}, que se fue el ${new Date(a.leftAt).toLocaleString('es')}. ` +
    `No tienes su contexto: solo este resumen${a.summaryPath ? ` (también en ${a.summaryPath})` : ''}.\n\n---\n${summary}\n---\n\n` +
    `Si necesitas más contexto, pídemelo o búscalo en los documentos que menciona y en la memoria del proyecto.` +
    (String(text || '').trim() ? `\n\n${String(text).trim()}` : '');
  const r = await launch({
    kind: 'libre',
    text: prompt,
    name: robots.has(a.name) ? undefined : a.name,
    title: a.title,
    label: `Retoma: ${a.title || a.label}`,
    color: a.color,
    look: a.look,
    tools: a.tools,
    modelPick: a.modelPick,
    origin: `Retoma la tarea de ${a.name} con su resumen (se había ido el ${new Date(a.leftAt).toLocaleString('es')})`
  });
  r.note = a.note || '';
  emit(r);
  return r;
}

// Rutas de la API: archivo de despedidos: buscar, ver, retomar, exportar y quitar. Las llama http.mjs en orden; devuelven algo (true) si atendieron la petición.
async function despedidosApi(req, res, url, parts) {
  if (req.method === 'GET' && url.pathname === '/api/despedidos') {
    const q = url.searchParams.get('q');
    const all = url.searchParams.get('all') === '1';
    return send(
      res,
      200,
      q
        ? { results: searchArchive(q) }
        : { recent: (all ? archive : archive.slice(-30)).slice().reverse().map(archMeta), total: archive.length }
    );
  }
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2] && parts[3] === 'retomar') {
    try {
      const r = await retake(parts[2], (await readBody(req)).text);
      return send(res, 201, { ok: true, name: r.name });
    } catch (e) {
      return send(res, 409, { error: e.message });
    }
  }
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2] && parts[3] === 'exportar') {
    const a = archive.find(x => x.id === parts[2]);
    if (!a) return send(res, 404, { error: 'Ese robot ya no está en el archivo.' });
    try {
      return send(res, 200, { ok: true, ...exportConversation(a) });
    } catch (e) {
      return send(res, 409, { error: e.message });
    }
  }
  // Limpiar relevos: los relevos por contexto son automáticos y su robot sigue con el mismo nombre (y el resumen en su
  // primer mensaje), así que se pueden quitar todos juntos. Igual que «Quitar»: los resúmenes van a la Papelera.
  if (req.method === 'POST' && url.pathname === '/api/despedidos/limpiar-relevos') {
    const gone = archive.filter(x => x.reason === RELEVO_REASON);
    if (!gone.length) return send(res, 200, { ok: true, quitados: 0, papelera: 0 });
    replaceList(
      archive,
      archive.filter(x => x.reason !== RELEVO_REASON)
    );
    saveJsonAsync(ARCH_FILE, archive).catch(() => {});
    emitArchive();
    let papelera = 0;
    for (const a of gone)
      if (
        a.summaryPath &&
        !archive.some(x => x.summaryPath === a.summaryPath) &&
        toTrash(a.summaryPath, path.basename(a.summaryPath, '.md'))
      )
        papelera++;
    return send(res, 200, { ok: true, quitados: gone.length, papelera });
  }
  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2]) {
    // lo quita de la lista y su resumen va a la Papelera
    const a = archive.find(x => x.id === parts[2]);
    if (!a) return send(res, 404, { error: 'Ese robot ya no está en el archivo.' });
    replaceList(
      archive,
      archive.filter(x => x !== a)
    );
    saveJsonAsync(ARCH_FILE, archive).catch(() => {});
    emitArchive();
    // Solo si ningún otro despedido usa ese mismo .md (no debería, pero no se borra lo que otro necesita).
    const moved =
      a.summaryPath && !archive.some(x => x.summaryPath === a.summaryPath)
        ? toTrash(a.summaryPath, path.basename(a.summaryPath, '.md'))
        : null;
    return send(res, 200, { ok: true, papelera: moved });
  }
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2]) {
    const a = archive.find(x => x.id === parts[2]);
    return a ? send(res, 200, a) : send(res, 404, { error: 'Ese robot ya no está en el archivo.' });
  }
}

export {
  archiveRobot,
  archMeta,
  convDir,
  officeSummary,
  despedidosApi,
  emitArchive,
  exportConversation,
  migrateSummaries,
  retake,
  searchArchive
};
