/* ---------- salas de épica ---------- */
const salaRobots = id => [...st.robots.values()].filter(a => a.data.place.sala === id);
function renderSalaChips() {
  $('#sala-count').textContent = `${st.salas.length} sala${st.salas.length === 1 ? '' : 's'}`;
  $('#sala-chips').innerHTML = st.salas.slice(0, 6).map(s => {
    const n = salaRobots(s.id).length;
    return `<div class="rchip" data-sala="${esc(s.id)}"><i class="dot" style="background:${n ? 'var(--teal)' : 'var(--wall)'}"></i><span>${esc(s.name)}<br><small>${esc(s.key || 'sin clave')} · ${n} robot${n === 1 ? '' : 's'} · ${s.thread.length} msj</small></span></div>`;
  }).join('') || '<div class="room-b">Sin salas. Clic para crear una por épica de Jira.</div>';
}

function salasPanel() {
  const cards = st.salas.map(s => {
    const last = s.thread[s.thread.length - 1];
    return `<div class="rt-card" data-sala="${esc(s.id)}" role="button" tabindex="0" style="cursor:pointer">
      <div class="top-r"><b>${esc(s.name)}</b>${s.key ? `<span class="pill p-idle">${esc(s.key)}</span>` : ''}</div>
      <div class="sub-h">${salaRobots(s.id).length} robots · ${s.thread.length} mensajes · ${s.docs.length} documentos${s.folder ? ' · ' + esc(s.folder) : ''}</div>
      ${last ? `<div class="sub-h">Último: ${esc(last.from)} · ${esc(last.text.slice(0, 120))}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="dlg-head"><h3>Salas de épica</h3><p>Cada sala agrupa a los robots que trabajan sobre una épica de Jira. Comparten un <code>CONTEXT.md</code> (alcance, decisiones, estado verificado) que leen al entrar y corrigen al aprender algo, y un hilo donde queda lo que cada uno dice al cerrar su turno.</p></div>
    ${cards ? `<section class="dlg-sec"><h4>Salas</h4><div class="rt-grid">${cards}</div></section>` : ''}
    <form class="dlg-sec" id="sala-new">
      <h4>Nueva sala</h4>
      <div class="fgrid">
        <div class="field"><label for="sn-name">Nombre</label><input id="sn-name" placeholder="Wallet hexagonal" maxlength="60"></div>
        <div class="field"><label for="sn-key">Épica o tarea de Jira</label><input id="sn-key" placeholder="TECH-2783" autocomplete="off"></div>
        <div class="field"><label for="sn-folder">Carpeta de documentos (opcional)</label><input id="sn-folder" placeholder="TASK/WALLET" autocomplete="off"></div>
        <div class="field full"><label for="sn-context">Contexto inicial (Markdown, opcional)</label><textarea id="sn-context" rows="6" placeholder="Alcance, decisiones ya tomadas, qué no re-litigar, dónde está el estado. Si lo dejas vacío se crea una plantilla."></textarea></div>
      </div>
      <div class="dlg-foot"><span class="note">Los archivos quedan en <code>agent-office/runs/salas/&lt;id&gt;/</code>.</span><button class="btn primary">Crear sala</button></div>
    </form>`;
}

function salaPanel(s) {
  const present = salaRobots(s.id);
  const thread = s.thread.map((m, i) => logRow({kind: m.from === 'Coordinador' ? 'user' : 'agent', text: m.text, at: m.at, who: m.from}, undefined, i)).join('');
  const docs = s.docs.length ? `<h4>Documentos (${s.docs.length})</h4><div class="list doclist">${s.docs.slice().reverse().map(x => `<div class="item" data-docpath="${esc(x.path)}" title="${esc(x.path)}"><div class="meta-i"><b>${esc(fileName(x.path))}</b><div>${esc(x.robot)} · ${esc(shortPath(x.path))}</div></div></div>`).join('')}</div>` : '';
  const max = st.config.maxRobots || 3;
  const active = [...st.robots.values()].filter(a => a.data.state !== 'done').length;
  return `<div class="ph"><div style="min-width:0"><h3>Sala «${esc(s.name)}»</h3><div class="sub-h">${esc(s.key || 'sin clave de Jira')}${s.folder ? ' · documentos en ' + esc(s.folder) : ''}</div></div>
      <div class="row" style="margin-left:auto"><button class="btn sm" data-sala-act="context">Ver CONTEXT.md</button><button class="btn sm" data-sala-act="reveal">Finder</button><button class="btn sm danger" data-sala-act="close" ${present.length ? 'disabled title="Da de baja a sus robots primero"' : ''}>Cerrar sala</button></div></div>
    <div class="rp-grid">
      <div class="rp-col">
        <h4>Hilo de la sala</h4>
        <div class="log" id="sala-log" data-src="@sala:${esc(s.id)}">${thread || '<div class="lg sys"><span class="x">Todavía no hay mensajes. Lo que digan los robots al cerrar cada turno aparece aquí.</span></div>'}</div>
        <form class="chat" id="sala-form">
          <textarea id="sala-in" rows="2" data-ac data-big="sala-form" placeholder="Escribe en el hilo… Enter publica, Shift+Enter salto de línea."></textarea><button class="btn primary">Publicar</button>
          <label class="check" style="grid-column:1/-1"><input type="checkbox" id="sala-notify"> Enviárselo también a los ${present.length} robots de la sala (gasta cuota)</label>
        </form>
      </div>
      <div class="rp-col">
        <h4>Robots en la sala</h4>
        ${present.length ? `<div class="list">${present.map(a => `<div class="item" data-pick="${esc(a.data.name)}"><div class="meta-i"><b>${esc(a.data.name)}</b><div>${esc(a.data.label)}</div></div><span class="pill p-${a.data.state}">${STATE_LABEL[a.data.state] || a.data.state}</span></div>`).join('')}</div>` : '<p>Nadie trabajando aquí ahora.</p>'}
        <form class="dlg-sec" id="sala-job">
          <h4>Mandar un robot a la sala</h4>
          <div class="seg" role="radiogroup" aria-label="Tipo de encargo">
            <label><input type="radio" name="skind" id="sk-libre" value="libre" checked>Tarea libre</label>
            <label><input type="radio" name="skind" id="sk-skill-r" value="skill">Skill</label>
          </div>
          <div class="field" id="f-sk-text"><label for="sk-text">Qué necesitas</label><textarea id="sk-text" rows="4" placeholder="Ej.: valida el estado real de la migración contra el contexto y deja el resultado corregido en CONTEXT.md"></textarea></div>
          <div class="field" id="f-sk-skill" hidden><label for="sk-skill">Skill</label><input id="sk-skill" list="skills-list" autocomplete="off"></div>
          <div class="field" id="f-sk-args" hidden><label for="sk-args">Argumentos</label><input id="sk-args"></div>
          <div class="field"><label for="sk-mode">Permisos</label><select id="sk-mode"><option value="">Heredar tu modo</option><option value="default">Preguntar (default)</option><option value="acceptEdits">Aceptar ediciones</option><option value="plan">Solo planear</option></select></div>
          <div class="note">El robot recibe, además del encargo, las rutas de CONTEXT.md, del hilo${s.folder ? ' y de la carpeta de la épica' : ''} con instrucciones de leerlas primero.</div>
          <div class="row between"><span class="stats">${active}/${max} trabajando</span><button class="btn primary" title="${active >= max ? 'La oficina está llena: el robot espera en la puerta y entra solo cuando se libere un escritorio' : ''}">${active >= max ? '🚪 Dejar en la puerta' : 'Mandar robot'}</button></div>
        </form>
        ${docs}
      </div>
    </div>`;
}


function renderPanel() {
  const keep = {}; const focusId = PANEL.contains(document.activeElement) ? document.activeElement.id : null;
  PANEL.querySelectorAll('input,select,textarea').forEach(el => { if (el.id) keep[el.id] = el.type === 'radio' ? el.checked : el.value; });
  const logEl = $('#log', PANEL); const logScroll = logEl ? logEl.scrollTop : null; const atBottom = logEl ? logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30 : true;
  const sel = st.selected;
  const a = sel && st.robots.get(sel);
  const sala = sel?.startsWith('@sala:') ? st.salas.find(s => s.id === sel.slice(6)) : null;
  if (sel?.startsWith('@sala:') && !sala) { st.selected = '@war'; return renderPanel(); } // la sala se cerró
  if (!sel || (!a && !sel.startsWith('@'))) {
    st.selected = null; st.side = null; renderSide();
    clearInterval(paneTimer);
    $('#dialog').hidden = true;
    PANEL.innerHTML = ''; PANEL.dataset.view = '';
    return;
  }
  const wasHidden = $('#dialog').hidden;
  const sameView = !wasHidden && PANEL.dataset.view === sel;
  $('#dialog').hidden = false;
  $('#dlg-card').classList.toggle('wide', sel === '@cron' || sel === '@usage' || sel === '@war');
  $('#dlg-card').classList.toggle('tall', !!a || !!sala || sel === '@arch');
  const html = a ? robotPanel(a) : sala ? salaPanel(sala) : sel === '@inbox' ? inboxPanel() : sel === '@usage' ? usagePanel() : sel === '@setup' ? setupPanel() : sel === '@cron' ? cronPanel() : sel === '@war' ? salasPanel() : sel === '@search' ? searchPanel() : sel === '@arch' ? archPanel(st.archView) : sel === '@archivo' ? archivoPanel() : sel === '@pins' ? pinsPanel() : newPanel();
  if (sameView) {
    if (html === PANEL._html) { tickRoutines(); return; }
    const tpl = document.createElement('template'); tpl.innerHTML = html;
    PANEL._html = html;
    const sl = $('#sala-log', PANEL), slBottom = sl && sl.scrollTop + sl.clientHeight >= sl.scrollHeight - 30;
    // La conversación se queda abajo aunque aparezca o se vaya el aviso de permiso (si estabas leyendo arriba, no se mueve).
    const lg0 = $('#log', PANEL), lgTop = lg0?.scrollTop, lgBottom = lg0 && lg0.scrollTop + lg0.clientHeight >= lg0.scrollHeight - 30;
    morph(PANEL, tpl.content);
    if (sl && slBottom) sl.scrollTop = sl.scrollHeight;
    const lg1 = $('#log', PANEL);
    if (lg1 && (lgBottom || lg1 !== lg0)) lg1.scrollTop = lgBottom || lg0 == null ? lg1.scrollHeight : lgTop;
    tickRoutines(); syncKind(); renderSide(); markPins(PANEL); doJump();
    return;
  }
  clearInterval(paneTimer);
  PANEL.dataset.view = sel; PANEL._html = html;
  PANEL.innerHTML = html;
  if (wasHidden) PANEL.scrollTop = 0;
  tickRoutines();
  Object.entries(keep).forEach(([id, v]) => { const el = document.getElementById(id); if (el && PANEL.contains(el)) { if (el.type === 'radio') el.checked = v; else el.value = v; } });
  if (focusId) document.getElementById(focusId)?.focus();
  const lg = $('#log', PANEL) || $('#sala-log', PANEL); if (lg) lg.scrollTop = atBottom || logScroll == null ? lg.scrollHeight : logScroll;
  syncKind();
  if (a) { refreshPane(a.data.name); paneTimer = setInterval(() => refreshPane(a.data.name), 2000); }
  renderSide(); markPins(PANEL); doJump();
  if (sel === '@search') searchArchive();
  if (sel === '@archivo') loadArchivo();
  if (sel === '@cron') cronOpened();
  if (sel === '@arch' && st.focusRetake) { st.focusRetake = false; const t = $('#retake-in'); t?.scrollIntoView({block: 'center'}); t?.focus(); }
  if (wasHidden) (PANEL.querySelector('#search-in, #rp-alert input, #chat-in, #job-skill, #job-text, #sala-in, #sn-name') || $('#dlg-close')).focus();
}

async function refreshPane(name) {
  try {
    const res = await fetch(`/api/robots/${name}/pane`);
    if (!res.ok) return;
    const {text} = await res.json();
    const last = text.split('\n').slice(-60).join('\n');
    paneCache.set(name, last);
    const pre = $('#pane', PANEL);
    if (pre && st.selected === name && pre.textContent !== last) { pre.textContent = last; pre.scrollTop = pre.scrollHeight; }
  } catch { /* el robot pudo haberse ido */ }
}

