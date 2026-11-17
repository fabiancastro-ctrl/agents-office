/* ---------- robots que pide un robot ---------- */
// Te muestra los encargos que escribió (puedes corregirlos o quitar alguno) y los lanza al aprobar.
function spawnBox(d) {
  const q = d.spawnReq, n = q.items.length;
  const max = st.config.maxRobots || 3, active = [...st.robots.values()].filter(a => a.data.state !== 'done').length, free = Math.max(0, max - active);
  return `<form class="alert spawn-box" id="rp-alert" data-spawn="${esc(q.id)}"><b>Quiere lanzar ${n} robot${n === 1 ? '' : 's'} nuevo${n === 1 ? '' : 's'}</b>
    <span class="note">Cada uno con su propia consola. ${d.place.sala ? `Entran a su sala «${esc(st.salas.find(s => s.id === d.place.sala)?.name || 'sala')}»` : `${esc(d.name)} y ellos pasan a una sala de equipo`}: se ven juntos y comparten CONTEXT.md${q.context ? ' (con el contexto que mandó)' : ''} y el hilo. Revisa o corrige los encargos. Cada resultado le llega a ${esc(d.name)} en cuanto el hijo termina si está libre; si está ocupado, los que terminen mientras tanto le llegan juntos al acabar su turno (un solo turno suyo). ${free >= n ? '' : `Hay ${free} cupo${free === 1 ? '' : 's'} libre${free === 1 ? '' : 's'}: los demás esperan en la puerta hasta que se libere uno.`}</span>
    ${q.context ? `<details class="sp-ctx"><summary>Contexto que comparte con ellos</summary><div class="md-chat">${mdHtml(q.context)}</div></details>` : ''}
    ${q.items.map((it, i) => `<fieldset class="sp-it"><label class="sp-on"><input type="checkbox" checked data-sp-on="${i}"> Lanzar</label><input class="sp-n" data-sp-n="${i}" maxlength="20" value="${esc(it.name || '')}" placeholder="nombre" title="Nombre del robot: minúsculas, números y guiones" pattern="[a-z0-9-]{1,20}"><input class="sp-t" data-sp-t="${i}" maxlength="60" value="${esc(it.title)}" placeholder="Título"><textarea class="sp-x" data-sp-x="${i}" rows="4">${esc(it.text)}</textarea></fieldset>`).join('')}
    <div class="row"><button class="btn primary sm" data-act="spawn-ok">Lanzar</button><button type="button" class="btn danger sm" data-act="spawn-no">No, gracias</button></div></form>`;
}
PANEL.addEventListener('click', e => { const b = e.target.closest('[data-unqueue]'); if (b && st.selected) api('POST', `/api/robots/${st.selected}/cola/${b.dataset.unqueue}`).catch(() => {}); });
async function decideSpawn(d, allow) {
  const f = PANEL.querySelector(`form[data-spawn="${CSS.escape(d.spawnReq.id)}"]`);
  const items = f ? d.spawnReq.items.map((it, i) => ({name: f.querySelector(`[data-sp-n="${i}"]`)?.value.trim().toLowerCase() || '', title: f.querySelector(`[data-sp-t="${i}"]`).value, text: f.querySelector(`[data-sp-x="${i}"]`).value, on: f.querySelector(`[data-sp-on="${i}"]`).checked})).filter(x => x.on && x.text.trim()) : d.spawnReq.items;
  if (allow && items.length && !await quotaOk(`${d.name} quiere lanzar ${items.length} robot${items.length === 1 ? '' : 's'}.`)) return;
  const r = await api('POST', `/api/robots/${d.name}/encargos/${d.spawnReq.id}`, {decision: allow && items.length ? 'approve' : 'reject', items});
  if (allow) toast(r.launched?.length ? `Entraron ${r.launched.join(', ')}${r.queued ? ` · ${r.queued} esperan cupo` : ''}` : r.queued ? `${r.queued} esperan cupo en la puerta` : 'No lanzaste ninguno');
}
PANEL.addEventListener('submit', e => { if (e.target.matches('form[data-spawn]')) e.preventDefault(); });
function kidsBlock(d) {
  if (!d.kids?.length && !d.parent) return '';
  const KS = {queued: 'en la puerta, esperando cupo'};
  const kid = k => k.name ? `<button type="button" class="kid" data-pick="${esc(k.name)}"><b>${esc(k.name)}</b>${k.title ? ` · ${esc(k.title)}` : ''}<span class="pill p-${esc(k.state)}">${esc(STATE_LABEL[k.state] || k.state)}</span></button>` : `<span class="kid q">${esc(k.title || 'robot')}<span class="pill">${KS.queued}</span><button type="button" class="btn sm ghost" data-unqueue="${esc(k.qid)}" title="No lanzarlo">✕</button></span>`;
  return `<div class="rp-block kids" id="kids"><h4>${d.parent ? `Lo lanzó <button type="button" class="kid inline" data-pick="${esc(d.parent)}">${esc(d.parent)}</button>` : 'Robots que lanzó'}</h4>${d.kids?.length ? `<div class="kid-l">${d.kids.map(kid).join('')}</div>` : ''}</div>`;
}

function robotPanel(a) {
  const d = a.data;
  const u = d.usage || {};
  // Subagentes: una fila por cada uno (los que trabajan primero) en una lista con scroll, para que no empuje la consola ni los botones.
  const running = d.subs.filter(s => s.status !== 'done'), finished = d.subs.filter(s => s.status === 'done');
  const subRow = s => `<div class="sub-row${s.status === 'done' ? ' ok' : ''}" title="${esc(s.desc || s.activity || '')}"><i></i><b>${esc(shortType(s.type))}</b><span>${s.status === 'done' ? 'listo' : esc(s.activity || 'trabajando')}</span></div>`;
  const subs = d.subs.length ? `<div class="rp-block"><h4>Subagentes <small>${running.length ? `${running.length} trabajando` : ''}${running.length && finished.length ? ' · ' : ''}${finished.length ? `${finished.length} listo${finished.length === 1 ? '' : 's'}` : ''}</small></h4><div class="subs-list" id="subs-list">${[...running, ...finished].map(subRow).join('')}</div></div>` : '';
  let alert = '';
  if (d.consoleLost) alert = `<div class="alert" id="rp-alert"><b>⚠ Se cerró su consola</b><span class="note">Su ventana de tmux desapareció (se cerró tmux o la cerraron). Su sesión de Claude sigue en disco: «Revivir» le abre otra consola con esa misma sesión y recuerda todo. Si tenía agentes o tareas en segundo plano, esos sí se cortaron: pídele que los relance.</span><div class="row"><button class="btn primary sm" data-act="revive">↻ Revivir</button><button class="btn sm danger" data-act="kill">Despedir</button></div></div>`;
  else if (d.spawnReq) alert = spawnBox(d);
  else if (d.ask) alert = `<div class="alert ask-box" id="rp-alert"><b>Te pregunta</b>${askForm(d, 'p')}</div>`;
  else if (d.hold) alert = `<div class="alert" id="rp-alert"><b>Pide permiso (retenido por la oficina)</b><span class="sub-h">${esc(d.hold.tool)}</span><div class="row"><button class="btn primary sm" data-act="hold-allow">Aprobar</button><button class="btn danger sm" data-act="hold-deny">Denegar</button></div></div>`;
  else if (d.needsPermission) alert = `<div class="alert" id="rp-alert"><b>Pide permiso en su consola</b><span class="note">Aprobar elige la opción resaltada («Yes»). Rechazar cancela con Esc e interrumpe el turno. Mira la consola abajo antes de decidir.</span><div class="row"><button class="btn primary sm" data-act="perm-approve">Aprobar</button><button class="btn danger sm" data-act="perm-reject">Rechazar</button></div></div>`;
  return `
    <div class="ph"><div class="ph-av">${robotHead(COLORS[d.color % 8], lookOf(d.name, d.place, d))}</div><div class="ph-main"><h3>${esc(d.name)}</h3>${titleEditor(d)}<div class="ph-row" id="ph-row">${noteEditor(d)}${lookEditor(d)}${canCompact(d) ? `<button type="button" class="btn sm" data-act="compact" title="Contexto al ${d.ctx.pct} %: le manda /compact para resumir su conversación y liberar espacio">🧹 Compactar (${d.ctx.pct} %)</button>` : ''}${isSleepy(d) ? `<span class="rc-sleep">💤 ${fmtDur(sleepMs(d))} sin actividad</span>` : ''}<button type="button" class="btn sm ghost" data-act="wake-me" title="Crea un despertador: cuando pase algo (un PR aprobado, un ticket que cambia, una hora), la oficina le escribe a este robot">⏰ Despiértame cuando…</button><button type="button" class="btn sm ghost" data-act="follow" title="Cierra esta ventana y la cámara del mapa sigue a este robot (tecla F, o Mayús + clic en el robot)">📍 Seguir en el mapa</button>${sidePicker(d)}</div><div class="sub-h ph-what" title="${esc(d.label)}">${esc(d.kind === 'skill' ? d.label : 'Tarea libre · ' + d.label)} <span class="origin">· ${esc(d.origin || 'Origen desconocido')}</span></div></div><span class="pill p-${d.state}">${esc(stateLabel(d))}${d.state === 'input' && d.inputAt ? ` · <b data-since="${esc(d.inputAt)}">${fmtWait(Date.now() - Date.parse(d.inputAt))}</b>` : ''}</span></div>
    ${queueBar(d)}${alert}
    <div class="rp-grid" id="rp-grid">
      <div class="rp-col">
        <div class="log-h"><h4>Conversación</h4><span class="tmode" role="group" aria-label="Herramientas en la conversación"><small>Herramientas</small>${TOOL_MODES.map(([k, l]) => `<button type="button" class="${st.toolMode === k ? 'on' : ''}" data-toolmode="${k}" aria-pressed="${st.toolMode === k}">${l}</button>`).join('')}</span></div>
        <div class="log" id="log" data-src="${esc(d.name)}" style="--c:${COLORS[d.color % 8]}">${renderLog(a.log, d.name)}</div>
        <form class="chat" id="chat-form">
          <textarea id="chat-in" rows="2" data-ac data-big="chat-form" placeholder="Escríbele a ${esc(d.name)}… Enter envía, Shift+Enter salto de línea. Pega (Ctrl+V) o arrastra archivos."></textarea><button class="btn primary">Enviar</button>
          <div class="tray" data-tray="${esc(d.name)}">${trayHtml(d.name)}</div>
          <div class="chat-tools"><label class="btn sm attach">Adjuntar<input type="file" multiple hidden data-attfor="chat"></label><button type="button" class="btn sm" data-bigedit="chat-in" title="Abre un editor grande para respuestas o contextos largos (Enter envía, Shift+Enter salto de línea)">⤢ Expandir</button><small class="muted">/ comandos y skills · códigos y repos se sugieren solos · Tab elige</small></div>
        </form>
      </div>
      <div class="rp-col" style="--extra:${(d.subs.length ? 150 : 0) + (d.docs.length ? 205 : 0)}px">
        ${kidsBlock(d)}
        ${subs}
        ${docsBlock(d)}
        <h4>Consola en vivo</h4>
        <pre class="term" id="pane">${esc(paneCache.get(d.name) ?? 'cargando…')}</pre>
        <div class="row">
          <button class="btn sm" data-act="console">Abrir consola en Terminal</button>
          <button class="btn sm" data-act="again" title="Abre «Nuevo encargo» con lo mismo que le pediste a este robot">↻ Lanzar otro igual</button>
          <button class="btn sm" data-act="fav" title="Guarda este encargo como acceso rápido en «Nuevo encargo»">★ Frecuente</button>
          <button class="btn sm" data-act="export" title="Guarda toda su conversación (tus mensajes y los suyos, sin herramientas) en docs/conversaciones-robots/ de tu carpeta de trabajo. Por si un resumen falla o queda corto.">⬇ Exportar conversación</button>
          ${canSummary(d) ? `<button class="btn sm" data-act="sumkill" title="Le pide un super resumen de lo que hacía, lo guarda como documento en la oficina y lo despide. Con ese resumen otro robot puede retomar la tarea.">📝 Despedir con su resumen</button>` : d.summaryPending ? '<span class="note">📝 Escribiendo su resumen para irse…</span>' : ''}
          <button class="btn sm danger" data-act="kill" title="Lo despide ya, sin resumen. Si quieres que deje uno para retomar después, usa «📝 Despedir con su resumen».">Dar de baja</button>
        </div>
        <div class="stats">tokens · salida ${u.out ?? 0} · entrada ${u.in ?? 0} · caché leída ${u.cacheRead ?? 0} · caché escrita ${u.cacheWrite ?? 0}${spendText(d) ? ` · gasto: ${esc(spendText(d))}` : ''}${d.permissionMode ? ' · permisos: ' + esc(d.permissionMode) : ''}</div>
        <div class="note">tmux attach -t ${esc(st.config.session || 'office')}:${esc(d.name)} · sesión ${esc(d.sessionId)}</div>
      </div>
    </div>`;
}

// Aviso de cuota: antes de lanzar o retomar, si algún límite de tu suscripción va en 80 % o más, te pregunta.
// Usa lo último leído de /usage (hasta 10 min); si no hay, lo pide con un tope de 4 s y, si no llega, no frena.
async function quotaOk(what) {
  let c = st.claude;
  if (!(c && Date.now() - Date.parse(c.at) < 10 * 60e3)) {
    try { c = await Promise.race([fetch('/api/claude-status').then(r => r.ok ? r.json() : null), new Promise(r => setTimeout(() => r(null), 4000))]); if (c) st.claude = c; } catch { c = null; }
  }
  const hot = (c?.limits || []).filter(l => l.pct >= 80);
  if (!hot.length) return true;
  return confirm(`${what}\n\nVas en ${hot.map(l => `${l.pct} % de «${l.title}»${l.resets ? ` (${l.resets})` : ''}`).join(' y ')}. Cada robot gasta de la misma cuota.\n\n¿Seguir igual?`);
}

/* ---------- encargos que esperan en la puerta ---------- */
// Con la oficina llena, «Invocar robot» deja el encargo en la puerta (lo guarda el daemon) y entra solo, en orden,
// cuando se libera un escritorio. El tope cuenta como el daemon: solo los que trabajan (no los que terminaron).
const busyCount = () => [...st.robots.values()].filter(a => a.data.state !== 'done' && !a.data.consoleLost).length;
function renderDoor() {
  const b = $('#btn-door'); if (!b) return;
  b.hidden = !st.door.length;
  $('#door-n').textContent = st.door.length;
  if (st.selected === '@new') schedulePanel();
}
function doorSection() {
  if (!st.door.length) return '';
  return `<section class="dlg-sec"><h4>🚪 En la puerta (${st.door.length})</h4><p class="note">Entran solos, en este orden, cuando se libera un escritorio. Lo que hayas subido con + entra de inmediato.</p>
    <div class="kid-l">${st.door.map((q, i) => `<span class="kid q"><b>${i + 1}.</b> ${q.name ? `<b>${esc(q.name)}</b> · ` : ''}${esc(q.title || 'encargo')}<span class="pill">desde ${esc(new Date(q.at).toLocaleTimeString('es', {hour: '2-digit', minute: '2-digit'}))}</span><button type="button" class="btn sm ghost" data-door-del="${esc(q.id)}" title="Sacarlo de la puerta: no se lanza">✕</button></span>`).join('')}</div></section>`;
}
$('#btn-door').addEventListener('click', () => select('@new'));
PANEL.addEventListener('click', e => { const b = e.target.closest('[data-door-del]'); if (b) api('DELETE', `/api/puerta/${b.dataset.doorDel}`).catch(() => {}); });

function newPanel() {
  const max = st.config.maxRobots || 3;
  const full = busyCount() >= max;
  const present = [...st.robots.values()];
  return `<div class="dlg-head"><h3>Nuevo encargo</h3><p>Entra un robot por la puerta y abre su consola tmux con <code>claude</code> usando tu suscripción. Al terminar se queda en su escritorio con el cartel LISTO hasta que lo des de baja (✕ sobre el robot o «Despedir terminados»).</p></div>
    <form class="dlg-sec" id="job-form">
      ${st.favorites.length ? `<div class="favs" id="job-favs"><span class="flabel">Frecuentes</span>${st.favorites.map(f => `<span class="fav"><button type="button" data-fav="${esc(f.id)}" title="${esc(f.kind === 'skill' ? `/${f.skill} ${f.args}` : f.text)}">★ ${esc(f.name)}</button><button type="button" class="fav-x" data-fav-del="${esc(f.id)}" aria-label="Quitar ${esc(f.name)} de frecuentes">×</button></span>`).join('')}</div>` : ''}
      <div class="fgrid" id="job-grid">
        <div class="seg span2" role="radiogroup" aria-label="Tipo de encargo">
          <label><input type="radio" name="kind" id="kind-skill" value="skill" checked>Skill</label>
          <label><input type="radio" name="kind" id="kind-libre" value="libre">Tarea libre</label>
        </div>
        <div class="field"><label for="job-name">Nombre del robot (opcional)</label>
          <div class="name-row"><input id="job-name" placeholder="se asigna solo" maxlength="20" autocomplete="off" spellcheck="false"><button type="button" class="btn sm" id="job-name-rand" title="Nombre aleatorio: 6 letras y 2 números">Aleatorio</button></div>
        </div>
        <div class="field full"><label for="job-title">Título (opcional, para saber qué hace)</label><input id="job-title" maxlength="60" placeholder="Ej.: Tareas de QA · Revisando wallet#32 Ramiro" autocomplete="off"></div>
        <div class="field" id="f-skill"><label for="job-skill">Skill</label><input id="job-skill" list="skills-list" placeholder="review-deep" autocomplete="off"></div>
        <div class="field span2" id="f-args"><label for="job-args">Argumentos</label><input id="job-args" placeholder="BFF/bff-integrator origin/production origin/mi-rama --dry-run"></div>
        <div class="field full" id="f-text" hidden><label for="job-text">Qué necesitas</label><textarea id="job-text" rows="5" data-ac placeholder="Ej.: revisa por qué falla el pipeline de dropi-atom y explícame la causa sin tocar código"></textarea></div>
        <div class="field full"><span class="flabel">Adjuntos: pega con Ctrl+V o arrastra aquí</span><div class="tray" data-tray="job">${trayHtml('job')}</div></div>
        <div class="field"><label for="job-mode">Permisos</label><select id="job-mode"><option value="">Heredar tu modo</option><option value="default">Preguntar (default)</option><option value="acceptEdits">Aceptar ediciones</option><option value="plan">Solo planear</option></select></div>
      </div>
      <div class="dlg-foot">
        <div class="row"><label class="btn sm attach">Adjuntar archivos<input type="file" multiple hidden data-attfor="job"></label><button type="button" class="btn sm" data-fav-save title="Guarda lo que llenaste como acceso rápido">★ Guardar como frecuente</button></div>
        <div class="row"><span class="stats">${busyCount()}/${max} trabajando${full ? ' · oficina llena' : ''}</span><button class="btn primary" title="${full ? 'La oficina está llena: el encargo espera en la puerta y entra solo cuando se libere un escritorio' : ''}">${full ? '🚪 Dejar en la puerta' : 'Invocar robot'}</button></div>
      </div>
    </form>
    ${doorSection()}
    ${present.length ? `<section class="dlg-sec"><h4>En la oficina</h4><div class="rt-grid">${present.map(a => `<div class="item" data-pick="${esc(a.data.name)}"><div class="meta-i"><b>${esc(a.data.name)}</b><div>${esc(a.data.label)}</div></div><span class="pill p-${a.data.state}">${STATE_LABEL[a.data.state] || a.data.state}</span></div>`).join('')}</div></section>` : ''}`;
}

const fileName = p => String(p).split('/').pop();
// Ruta relativa a la carpeta de trabajo de esta oficina; fuera de ella, con ~ en vez de /Users/<tú>.
const shortPath = p => {
  const s = String(p), ws = st.setup?.workspace;
  if (ws && s.startsWith(ws.replace(/\/$/, '') + '/')) return s.slice(ws.replace(/\/$/, '').length + 1);
  return s.replace(/^.*\/scratchpad\//, '…/scratchpad/').replace(/^\/Users\/[^/]+(?=\/)/, '~');
};
// Archivos de carpetas temporales (borradores, láminas de un deck, scratchpads): ruido en la bandeja salvo que los pidas.
const isTempDoc = p => /^(\/private)?\/(tmp|var\/folders)\//.test(String(p)) || /\/scratchpad\//.test(String(p));

// Documentos de un robot: en su escritorio (sin entregar) o ya en tu bandeja.
function docsBlock(d) {
  if (!d.docs.length) return '';
  const rows = d.docs.slice().reverse().map(x => {
    const status = !x.delivered ? (x.updated ? ['p-input', 'actualizado, en el escritorio'] : ['p-working', 'en el escritorio']) : ['p-done', 'en tu bandeja'];
    return `<div class="item" data-docpath="${esc(x.path)}" title="${esc(x.path)}"><div class="meta-i"><b>${esc(fileName(x.path))}</b><div>${esc(shortPath(x.path))}</div></div><span class="pill ${status[0]}">${status[1]}</span></div>`;
  }).join('');
  return `<div class="rp-block"><h4>Documentos (${d.docs.length})</h4><div class="list doclist" id="doc-list">${rows}</div></div>`;
}

function inboxPanel() {
  const filter = st.inboxFilter || 'nuevos';
  const shown = inboxShown(), temps = st.inbox.length - shown.length;
  const items = filter === 'nuevos' ? shown.filter(i => i.status !== 'visto') : shown;
  const n = unseen();
  const row = i => {
    const isNew = i.status !== 'visto';
    return `<div class="inbox-item ${isNew ? 'new' : ''}">
      <div class="meta-i" data-docpath="${esc(i.path)}" data-docid="${esc(i.id)}" role="button" tabindex="0">
        <b>${esc(fileName(i.path))}</b>${i.critical > 0 ? ` <span class="tagx crit">⚠ ${i.critical} crítico${i.critical === 1 ? '' : 's'}</span>` : ''}${i.updated ? ' <span class="tagx">actualizado</span>' : ''}${isTempDoc(i.path) ? ' <span class="tagx tmp">temporal</span>' : ''}
        <div class="pathx" title="${esc(i.path)}">${esc(shortPath(i.path))} · ${new Date(i.at).toLocaleString('es', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'})}</div>
      </div>
      <div class="row">
        <button class="btn sm" data-inbox="open" data-id="${esc(i.id)}">Ver</button>
        <button class="btn sm" data-inbox="${isNew ? 'seen' : 'unseen'}" data-id="${esc(i.id)}">${isNew ? 'Marcar visto' : 'Marcar nuevo'}</button>
        <button class="btn sm" data-inbox="reveal" data-id="${esc(i.id)}">Finder</button>
        <button class="btn sm danger" data-inbox="archive" data-id="${esc(i.id)}">Archivar</button>
      </div>
    </div>`;
  };
  // Agrupado por robot (el que entregó más reciente primero): cada robot es una tarea distinta.
  const groups = new Map();
  for (const i of items) { if (!groups.has(i.robot)) groups.set(i.robot, []); groups.get(i.robot).push(i); }
  const rows = [...groups].map(([robot, list]) => {
    const live = st.robots.get(robot);
    const nNew = list.filter(i => i.status !== 'visto').length;
    return `<section class="ib-g">
      <div class="ib-gh">${live ? `<span class="ib-av">${robotSVG(COLORS[live.data.color % 8], lookOf(robot, live.data.place, live.data))}</span>` : ''}<b>${esc(robot)}</b><span class="ib-lbl" title="${esc(list[0].label)}">${esc(list[0].label)}</span><small>${list.length} doc${list.length === 1 ? '' : 's'}${nNew && filter !== 'nuevos' ? ` · ${nNew} nuevo${nNew === 1 ? '' : 's'}` : ''}${live ? '' : ' · ya se fue'}</small></div>
      ${list.map(row).join('')}
    </section>`;
  }).join('');
  return `<div class="dlg-head"><h3>Tu bandeja</h3><p>Documentos que te entregaron los robots, agrupados por robot. Abrir uno lo marca como visto; archivar lo saca de la lista sin borrar el archivo.</p></div>
    <div class="dlg-sec">
      <div class="row between">
        <div class="seg small" role="radiogroup" aria-label="Filtro">
          <label><input type="radio" name="inboxf" value="nuevos" ${filter === 'nuevos' ? 'checked' : ''}>Nuevos (${n})</label>
          <label><input type="radio" name="inboxf" value="todos" ${filter === 'todos' ? 'checked' : ''}>Todos (${shown.length})</label>
        </div>
        <div class="row">
          ${temps || st.inboxTemp ? `<button class="btn sm" data-inbox="temp" title="Archivos en carpetas temporales (/tmp, scratchpads): borradores, láminas de un deck…">${st.inboxTemp ? 'Ocultar temporales' : `Mostrar temporales (${temps})`}</button>` : ''}
          <button class="btn sm" data-inbox="seen-all" ${n ? '' : 'disabled'}>Marcar todos como vistos</button>
        </div>
      </div>
      <div class="list">${rows || `<p>${filter === 'nuevos' ? 'No tienes documentos nuevos.' : 'La bandeja está vacía.'}${temps && !st.inboxTemp ? ` Hay ${temps} archivo${temps === 1 ? '' : 's'} temporal${temps === 1 ? '' : 'es'} oculto${temps === 1 ? '' : 's'}.` : ''}</p>`}</div>
    </div>`;
}

