/* ---------- salas de épica ---------- */
const salaRobots = id => [...st.robots.values()].filter(a => a.data.place.sala === id);
// Cara de quien armó la sala (con su color y apariencia, aunque ya se haya ido); si la creaste tú (sala de épica), un libro.
function salaFace(s) {
  if (!s.owner) return `<b class="sala-book" aria-hidden="true">${icon('book')}</b>`;
  const live = st.robots.get(s.owner)?.data;
  return robotHead(COLORS[(live?.color ?? s.color ?? 0) % COLORS.length], lookOf(s.owner, null, { look: live?.look ?? s.ownerLook }));
}
// Dentro de una sala no se ven los demás robots: si alguno de afuera (en la oficina o en otra sala) te necesita, la sala
// brilla en rojo y la cabecera dice quién; clic abre al que más lleva esperando, sin salir de la sala.
function renderOutsideNeed() {
  const room = st.view && MAP.querySelector('.r-sala.in-sala'),
    btn = room?.querySelector('[data-out-need]');
  if (!room || !btn) return;
  const out = [...st.robots.values()]
    .map(a => a.data)
    .filter(d => d.place?.sala !== st.view && (d.state === 'input' || d.spawnReq || d.consoleLost))
    .sort((x, y) => (Date.parse(x.inputAt || '') || 0) - (Date.parse(y.inputAt || '') || 0));
  room.classList.toggle('outside-need', !!out.length);
  btn.hidden = !out.length;
  if (!out.length) return;
  btn.dataset.outNeed = out[0].name;
  btn.innerHTML = `${icon('dot')} ${esc(out.length === 1 ? `${out[0].name} te necesita afuera` : `${out.length} te necesitan afuera`)}`;
  btn.title = `Fuera de esta sala te esperan: ${out.map(d => d.name + (d.place?.sala ? ` (en la sala «${st.salas.find(s => s.id === d.place.sala)?.name || 'otra'}»)` : '')).join(', ')}. Clic: abrir a ${out[0].name} (el que más lleva esperando) sin salir de la sala.`;
}
// Por qué te necesita, en pocas palabras (para el aviso de la sala en la lista «Salas de épica»).
const needWhy = d =>
  d.consoleLost
    ? 'perdió su consola'
    : d.spawnReq
      ? 'pide robots'
      : d.ask
        ? 'te pregunta'
        : d.hold || d.needsPermission
          ? 'pide permiso'
          : 'espera tu respuesta';
// Everything the cork-board notes and the «Salas» tab need to draw one room: its robots, who needs you, whether it
// finished, the team progress and the note colour (never grey, grey means disconnected: amber needs you, green done,
// teal working, cream empty).
function salaInfo(s) {
  const bots = salaRobots(s.id),
    n = bots.length;
  // Their robots are not visible in the office: if one needs you, the room says so.
  const needers = bots
      .map(a => a.data)
      .filter(d => d.state === 'input' || d.spawnReq || d.consoleLost)
      .sort((x, y) => (Date.parse(x.inputAt || '') || 0) - (Date.parse(y.inputAt || '') || 0)),
    need = needers.length;
  const done = s.done && !need; // team finished: everyone delivered
  const prog = salaProgress(s); // team progress, visible without entering
  const tone = need ? 'need' : done ? 'done' : n ? 'work' : 'empty';
  return { bots, n, needers, need, done, prog, tone };
}
function renderSalaChips() {
  renderOutsideNeed();
  $('#sala-count').textContent = `${st.salas.length} sala${st.salas.length === 1 ? '' : 's'}`;
  $('#sala-chips').innerHTML =
    st.salas
      .map(s => {
        const { bots, n, needers, need, done, prog, tone } = salaInfo(s);
        // Stable small tilt per room: hash of the id with >>> (unsigned), mapped to -2.4..+2.4 degrees.
        let h = 0;
        for (const ch of s.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const rot = (((h >>> 3) % 7) - 3) * 0.8;
        const faces = bots
          .slice(0, 5)
          .map(a => {
            const d = a.data;
            return `<span class="sn-bot${d.state === 'done' ? ' ok' : ''}">${robotHead(COLORS[d.color % COLORS.length], lookOf(d.name, d.place, d))}${d.state === 'done' ? '<b aria-hidden="true">✓</b>' : ''}</span>`;
          })
          .join('');
        const more = n > 5 ? `<span class="sn-more">+${n - 5}</span>` : '';
        const alert = need
          ? `<button type="button" class="rchip-alert" data-need-robot="${esc(needers[0].name)}" title="Abrir a ${esc(needers[0].name)} sin entrar a la sala${
              need > 1
                ? ` (también: ${esc(
                    needers
                      .slice(1)
                      .map(d => d.name)
                      .join(', ')
                  )})`
                : ''
            }">${icon('warn')} ${need === 1 ? `${esc(needers[0].name)} ${needWhy(needers[0])}` : `${need} te necesitan`}</button>`
          : `<small class="sn-state">${done ? '✓ terminó' : prog ? `${prog.ok}/${prog.n} entregaron` : n ? `${s.thread.length} msj` : 'sin robots'}</small>`;
        return `<div class="rchip sala-note sn-${tone}${need ? ' need' : ''}${done ? ' done' : ''}${st.view === s.id ? ' cur' : ''}${prog ? ' prog' : ''}" data-sala="${esc(s.id)}" style="--rot:${rot.toFixed(1)}deg" title="Entrar a la sala${s.owner ? ` · la armó ${esc(s.owner)}` : ' · sala de épica creada por ti'} · ${esc(s.auto ? 'equipo' : s.key || 'sin clave')} · ${n} robot${n === 1 ? '' : 's'}${prog ? ` · ${prog.ok} de ${prog.n} hijos entregaron su resultado` : ''}"><i class="sn-pin" aria-hidden="true">📌</i><span class="sn-head"><span class="sala-face">${salaFace(s)}</span><b class="sn-name">${esc(s.name)}</b></span><span class="sn-bots">${faces}${more}</span>${alert}${prog ? `<i class="rchip-bar${prog.ok === prog.n ? ' full' : ''}" style="--p:${Math.round((prog.ok * 100) / prog.n)}%" aria-hidden="true"></i>` : ''}</div>`;
      })
      .join('') || '<div class="room-b">Sin salas. Clic para crear una por épica de Jira.</div>';
  // Si alguien dentro de una sala te necesita, todo el cuarto «Salas de épica» late en ámbar (sus robots no se ven afuera).
  $('#sala-chips')
    .closest('.room')
    ?.classList.toggle(
      'sala-need',
      st.salas.some(s => salaRobots(s.id).some(a => a.data.state === 'input' || a.data.spawnReq || a.data.consoleLost))
    );
  renderColumn();
}

function salasPanel() {
  const cards = st.salas
    .map(s => {
      const last = s.thread[s.thread.length - 1];
      return `<div class="rt-card" data-sala="${esc(s.id)}" role="button" tabindex="0" style="cursor:pointer">
      <div class="top-r"><span class="sala-face big">${salaFace(s)}</span><b>${esc(s.name)}</b>${s.key ? `<span class="pill p-idle">${esc(s.key)}</span>` : ''}</div>
      ${(p => (p ? `<div class="sub-h">${icon('box')} ${p.ok}/${p.n} entregaron<i class="rt-prog${p.ok === p.n ? ' full' : ''}" style="--p:${Math.round((p.ok * 100) / p.n)}%"></i></div>` : ''))(salaProgress(s))}
      <div class="sub-h">${salaRobots(s.id).length} robots · ${s.thread.length} mensajes · ${s.docs.length} documentos${s.folder ? ' · ' + esc(s.folder) : ''}</div>
      ${last ? `<div class="sub-h">Último: ${esc(last.from)} · ${esc(last.text.slice(0, 120))}</div>` : ''}
    </div>`;
    })
    .join('');
  return `<div class="dlg-head"><h3>Salas de épica</h3><p>Cada sala agrupa a los robots que trabajan sobre una épica de Jira. Comparten un <code>CONTEXT.md</code> (alcance, decisiones, estado verificado) que leen al entrar y corrigen al aprender algo, y un hilo donde queda lo que cada uno dice al cerrar su turno. Cuando un robot pide robots y los apruebas, él y los nuevos quedan en una sala de equipo que se cierra sola al irse todos.</p></div>
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
  const thread = s.thread
    .map((m, i) => logRow({ kind: m.from === 'Coordinador' ? 'user' : 'agent', text: m.text, at: m.at, who: m.from }, undefined, i))
    .join('');
  const docs = s.docs.length
    ? `<h4>Documentos (${s.docs.length})</h4><div class="list doclist">${s.docs
        .slice()
        .reverse()
        .map(
          x =>
            `<div class="item" data-docpath="${esc(x.path)}" title="${esc(x.path)}"><div class="meta-i"><b>${esc(fileName(x.path))}</b><div>${esc(x.robot)} · ${esc(shortPath(x.path))}</div></div></div>`
        )
        .join('')}</div>`
    : '';
  const max = st.config.maxRobots || 3;
  const active = [...st.robots.values()].filter(a => a.data.state !== 'done').length;
  return `<div class="ph"><div style="min-width:0"><h3>Sala «${esc(s.name)}»</h3><div class="sub-h">${esc(s.auto ? `Equipo que armó ${s.owner}: se cierra sola cuando se van todos` : s.key || 'sin clave de Jira')}${s.folder ? ' · documentos en ' + esc(s.folder) : ''}</div></div>
      <div class="row" style="margin-left:auto"><button class="btn sm" data-sala-act="context">Ver CONTEXT.md</button><button class="btn sm" data-sala-act="export" title="Guarda la sala completa (porqué, reparto, contexto e hilo) en docs/salas/ de tu carpeta de trabajo, para compartirla">${icon('down')} Exportar</button><button class="btn sm" data-copy-link="sala:${esc(s.id)}" title="Copia un enlace que abre la oficina directo en esta sala (solo funciona en este computador)">${icon('link')} Copiar enlace</button><button class="btn sm" data-sala-act="reveal">Finder</button><button class="btn sm danger" data-sala-act="close" ${present.length ? 'disabled title="Da de baja a sus robots primero"' : ''}>Cerrar sala</button></div></div>
    <div class="rp-grid">
      <div class="rp-col">
        <h4>Hilo de la sala</h4>
        <div class="log" id="sala-log" data-src="@sala:${esc(s.id)}">${thread || '<div class="lg sys"><span class="x">Todavía no hay mensajes. Lo que digan los robots al cerrar cada turno aparece aquí.</span></div>'}</div>
        <form class="chat" id="sala-form">
          <textarea id="sala-in" rows="2" data-ac data-big="sala-form" placeholder="Escribe en el hilo… Enter publica, Shift+Enter salto de línea."></textarea><button class="btn primary">Publicar</button>
          <label class="check" style="grid-column:1/-1"><input type="checkbox" id="sala-notify"> Despertar ya a los ${present.length} robots de la sala (gasta un turno cada uno). Sin marcar, les llega con su próximo mensaje; con <code>@nombre</code> despiertas solo a ese.</label>
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
          <div class="row between"><span class="stats">${active}/${max} trabajando</span><button class="btn primary" title="${active >= max ? 'La oficina está llena: el robot espera en la puerta y entra solo cuando se libere un escritorio' : ''}">${active >= max ? `${icon('door')} Dejar en la puerta` : 'Mandar robot'}</button></div>
        </form>
        ${docs}
      </div>
    </div>`;
}

function renderPanel() {
  const keep = {};
  const focusId = PANEL.contains(document.activeElement) ? document.activeElement.id : null;
  PANEL.querySelectorAll('input,select,textarea').forEach(el => {
    if (el.id) keep[el.id] = el.type === 'radio' ? el.checked : el.value;
  });
  const logEl = $('#log', PANEL);
  const logScroll = logEl ? logEl.scrollTop : null;
  const atBottom = logEl ? logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30 : true;
  const sel = st.selected;
  const a = sel && st.robots.get(sel);
  const sala = sel?.startsWith('@sala:') ? st.salas.find(s => s.id === sel.slice(6)) : null;
  if (sel?.startsWith('@sala:') && !sala) {
    st.selected = '@war';
    return renderPanel();
  } // la sala se cerró
  if (!sel || (!a && !sel.startsWith('@'))) {
    st.selected = null;
    st.side = null;
    renderSide();
    clearInterval(paneTimer);
    $('#dialog').hidden = true;
    PANEL.innerHTML = '';
    PANEL.dataset.view = '';
    return;
  }
  const wasHidden = $('#dialog').hidden;
  const sameView = !wasHidden && PANEL.dataset.view === sel;
  $('#dialog').hidden = false;
  $('#dlg-card').classList.toggle('wide', sel === '@cron' || sel === '@usage' || sel === '@war' || sel === '@oficina' || sel === '@cierre');
  $('#dlg-card').classList.toggle('tall', !!a || !!sala || sel === '@arch');
  const html = a
    ? robotPanel(a)
    : sala
      ? salaPanel(sala)
      : sel === '@inbox'
        ? inboxPanel()
        : sel === '@usage'
          ? usagePanel()
          : sel === '@setup'
            ? setupPanel()
            : sel === '@cron'
              ? cronPanel()
              : sel === '@war'
                ? salasPanel()
                : sel === '@search'
                  ? searchPanel()
                  : sel === '@arch'
                    ? archPanel(st.archView)
                    : sel === '@archivo'
                      ? archivoPanel()
                      : sel === '@fama'
                        ? famaPanel()
                        : sel === '@cierre'
                          ? cierrePanel()
                          : sel === '@oficina'
                            ? oficinaPanel()
                            : sel === '@pins'
                              ? pinsPanel()
                              : newPanel();
  if (sameView) {
    if (html === PANEL._html) {
      tickRoutines();
      return;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    PANEL._html = html;
    const sl = $('#sala-log', PANEL),
      slBottom = sl && sl.scrollTop + sl.clientHeight >= sl.scrollHeight - 30;
    // La conversación se queda abajo aunque aparezca o se vaya el aviso de permiso (si estabas leyendo arriba, no se mueve).
    const lg0 = $('#log', PANEL),
      lgTop = lg0?.scrollTop,
      lgBottom = lg0 && lg0.scrollTop + lg0.clientHeight >= lg0.scrollHeight - 30;
    morph(PANEL, tpl.content);
    if (sl && slBottom) sl.scrollTop = sl.scrollHeight;
    const lg1 = $('#log', PANEL);
    if (lg1 && (lgBottom || lg1 !== lg0)) lg1.scrollTop = lgBottom || lg0 == null ? lg1.scrollHeight : lgTop;
    tickRoutines();
    syncKind();
    renderSide();
    markPins(PANEL);
    doJump();
    return;
  }
  clearInterval(paneTimer);
  PANEL.dataset.view = sel;
  PANEL._html = html;
  PANEL.innerHTML = html;
  if (wasHidden) PANEL.scrollTop = 0;
  tickRoutines();
  Object.entries(keep).forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (el && PANEL.contains(el)) {
      if (el.type === 'radio') el.checked = v;
      else el.value = v;
    }
  });
  if (focusId) document.getElementById(focusId)?.focus();
  const lg = $('#log', PANEL) || $('#sala-log', PANEL);
  if (lg) lg.scrollTop = atBottom || logScroll == null ? lg.scrollHeight : logScroll;
  syncKind();
  if (a) {
    refreshPane(a.data.name);
    paneTimer = setInterval(() => refreshPane(a.data.name), 2000);
  }
  renderSide();
  markPins(PANEL);
  doJump();
  if (sel === '@search') searchArchive();
  if (sel === '@archivo') loadArchivo();
  if (sel === '@fama') {
    famaUi.weeks = null;
    loadFama();
  }
  if (sel === '@oficina') loadSalud();
  if (sel === '@cron') cronOpened();
  if (sel === '@arch' && st.focusRetake) {
    st.focusRetake = false;
    const t = $('#retake-in');
    t?.scrollIntoView({ block: 'center' });
    t?.focus();
  }
  if (wasHidden)
    (PANEL.querySelector('#search-in, #rp-alert input, #chat-in, #job-skill, #job-text, #sala-in, #sn-name') || $('#dlg-close')).focus();
}

async function refreshPane(name) {
  try {
    const res = await fetch(`/api/robots/${name}/pane`);
    if (!res.ok) return;
    const { text } = await res.json();
    const last = text.split('\n').slice(-60).join('\n');
    paneCache.set(name, last);
    const pre = $('#pane', PANEL);
    if (pre && st.selected === name && (pre.classList.contains('loading') || pre.textContent !== last)) {
      pre.classList.remove('loading');
      pre.removeAttribute('aria-busy');
      pre.removeAttribute('aria-label');
      pre.textContent = last;
      pre.scrollTop = pre.scrollHeight;
    }
  } catch {
    /* el robot pudo haberse ido */
  }
}
