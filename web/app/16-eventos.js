/* ---------- eventos ---------- */
// Baja rápida desde el mapa: primer clic arma la ✕ («¿Baja?»), el segundo dentro de 3s la confirma.
async function quickKill(btn, name) {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed'); btn.textContent = '¿Baja?';
    clearTimeout(btn._t); btn._t = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = '×'; }, 3000);
    return;
  }
  clearTimeout(btn._t); btn.disabled = true; btn.textContent = '…';
  try { await api('DELETE', `/api/robots/${name}`); } catch { btn.disabled = false; btn.classList.remove('armed'); btn.textContent = '×'; }
}

MAP.addEventListener('click', e => {
  if (e.target.closest('[data-sala-exit]')) return leaveSala();
  const sdm = e.target.closest('[data-sala-dismiss]');
  if (sdm) { // dos clics: el primero arma, el segundo (en 3 s) despide
    if (!sdm.classList.contains('armed')) { sdm.classList.add('armed'); const t = sdm.textContent; sdm.textContent = '¿Seguro? Clic otra vez'; setTimeout(() => { sdm.classList.remove('armed'); sdm.textContent = t; renderBoard(); }, 3000); return; }
    sdm.disabled = true;
    api('POST', `/api/salas/${sdm.dataset.salaDismiss}/despedir-equipo`).then(r => toast(r.despedidos.length ? `Despedí a ${r.despedidos.join(', ')}${r.quedan ? ` · quedan ${r.quedan} en la sala` : ''}` : 'No había nadie que ya entregara.')).catch(() => {}).finally(() => { sdm.disabled = false; sdm.classList.remove('armed'); });
    return;
  }
  if (e.target.closest('[data-sala-ctx]')) { const s = st.salas.find(x => x.id === st.view); if (s) showDoc(s.context); return; }
  const so = e.target.closest('[data-sala-open]'); if (so) return select('@sala:' + so.dataset.salaOpen);
  const kx = e.target.closest('.kill-x'); if (kx) { e.stopPropagation(); return quickKill(kx, kx.closest('.robot').dataset.name); }
  const bb = e.target.closest('.robot.on-break'); if (bb) return assignFromBreak(bb.dataset.name);
  const r = e.target.closest('.robot'); if (r) return select(r.dataset.name);
  const dk = e.target.closest('.desk');
  if (dk) { const a = [...st.robots.values()].find(x => x.data.place.idx == dk.dataset.desk); return select(a ? a.data.name : '@new'); }
  const sala = e.target.closest('[data-sala]'); if (sala) return enterSala(sala.dataset.sala);
  const room = e.target.closest('[data-room]'); if (room) select('@' + room.dataset.room);
});
MAP.addEventListener('keydown', e => {
  if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.classList.contains('robot')) return;
  e.preventDefault();
  if (e.target.classList.contains('on-break')) assignFromBreak(e.target.dataset.name); else select(e.target.dataset.name);
});

PANEL.addEventListener('change', e => { if (e.target.name === 'inboxf') { st.inboxFilter = e.target.value; return renderPanel(); } if (['kind', 'rtkind', 'rttype', 'skind', 'rtwhen'].includes(e.target.name) || ['rt-where', 'rt-hours', 'rt-c-kind', 'rt-c-to', 'rt-w-kind'].includes(e.target.id)) syncKind(); });
PANEL.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.rt-card[data-sala]')) { e.preventDefault(); return enterSala(e.target.dataset.sala); }
  if (e.key === 'Enter' && !e.shiftKey && (e.target.id === 'chat-in' || e.target.id === 'sala-in')) { e.preventDefault(); e.target.form.requestSubmit(); } });
// Nombre aleatorio pronunciable: 6 letras (consonante-vocal) y 2 números, p. ej. «bakuro17».
function randomName() {
  const C = 'bcdfghjklmnprstvz', V = 'aeiou', pick = s => s[Math.floor(Math.random() * s.length)];
  for (let i = 0; i < 20; i++) {
    const n = pick(C) + pick(V) + pick(C) + pick(V) + pick(C) + pick(V) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
    if (!st.robots.has(n)) return n;
  }
  return 'robot' + Date.now() % 1000;
}
PANEL.addEventListener('click', e => { if (e.target.id === 'job-name-rand') { const el = $('#job-name'); el.value = randomName(); el.focus(); } });
// El daemon solo acepta minúsculas, números y guiones: se corrige mientras escribes.
PANEL.addEventListener('input', e => {
  if (e.target.id !== 'job-name') return;
  const v = e.target.value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (v !== e.target.value) e.target.value = v;
});

let launchingJob = false;
PANEL.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'job-form') {
    const libre = $('#kind-libre').checked;
    const attachments = attList('job').map(f => f.path);
    const body = libre
      ? {kind: 'libre', text: $('#job-text').value, permissionMode: $('#job-mode').value, name: $('#job-name').value.trim() || undefined, title: $('#job-title').value.trim() || undefined, attachments}
      : {kind: 'skill', skill: $('#job-skill').value, args: $('#job-args').value, permissionMode: $('#job-mode').value, name: $('#job-name').value.trim() || undefined, title: $('#job-title').value.trim() || undefined, attachments};
    body.origin = 'Lanzado por ti desde «Nuevo encargo»';
    body.queue = true; // con la oficina llena, espera en la puerta en vez de dar error
    // Mientras se revisa la cuota y se abre la consola el formulario queda bloqueado: un segundo clic no lanza otro.
    if (launchingJob) return;
    launchingJob = true;
    const btns = [...e.target.querySelectorAll('button')]; btns.forEach(b => { b.disabled = true; });
    try {
      if (!await quotaOk('Vas a lanzar un robot nuevo.')) return;
      const r = await api('POST', '/api/robots', body);
      ['job-text', 'job-args', 'job-name'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      st.att.job = [];
      if (r.queued) { toast(`La oficina está llena: «${r.title}» espera en la puerta (${r.position}.º) y entra solo cuando se libere un escritorio.`); PANEL.dataset.view = ''; renderPanel(); }
      else select(r.name);
    } catch { /* toast ya mostrado */ } finally { launchingJob = false; btns.forEach(b => { b.disabled = false; }); }
  }
  if (e.target.id === 'rt-form') {
    const btn = e.target.querySelector('button.primary'); btn.disabled = true;
    try {
      if (rtUi.edit) { await api('PUT', `/api/routines/${rtUi.edit}`, routineBody()); toast('Rutina guardada.'); }
      else { await api('POST', '/api/routines', routineBody()); toast('Rutina creada.'); }
      e.target.reset();
      rtUi.edit = null; rtUi.preview = '';
      PANEL.dataset.view = ''; renderPanel();
    } catch { /* toast ya mostrado */ } finally { btn.disabled = false; }
  }
  if (e.target.id === 'sala-new') {
    try {
      const {id} = await api('POST', '/api/salas', {name: $('#sn-name').value.trim(), key: $('#sn-key').value.trim(), folder: $('#sn-folder').value.trim(), context: $('#sn-context').value});
      ['sn-name', 'sn-key', 'sn-folder', 'sn-context'].forEach(x => { document.getElementById(x).value = ''; });
      select('@sala:' + id);
    } catch { /* toast ya mostrado */ }
  }
  if (e.target.id === 'sala-form') {
    const id = st.selected.slice(6), t = $('#sala-in').value.trim();
    if (!t) return;
    $('#sala-in').value = ''; grow($('#sala-in'));
    try {
      const {notified} = await api('POST', `/api/salas/${id}/hilo`, {text: t, notify: $('#sala-notify').checked});
      if (notified) toast(`Enviado también a ${notified} robot${notified === 1 ? '' : 's'} de la sala.`);
    } catch { $('#sala-in').value = t; }
  }
  if (e.target.id === 'sala-job') {
    const id = st.selected.slice(6), s = st.salas.find(x => x.id === id);
    const skill = $('#sk-skill-r').checked;
    const body = skill ? {kind: 'skill', skill: $('#sk-skill').value, args: $('#sk-args').value} : {kind: 'libre', text: $('#sk-text').value};
    Object.assign(body, {sala: id, permissionMode: $('#sk-mode').value, origin: `Lanzado por ti en la sala «${s?.name || id}»`, queue: true});
    try {
      if (!await quotaOk('Vas a lanzar un robot en la sala.')) return;
      const r = await api('POST', '/api/robots', body);
      ['sk-text', 'sk-args'].forEach(x => { document.getElementById(x).value = ''; });
      if (r.queued) toast(`La oficina está llena: «${r.title}» espera en la puerta (${r.position}.º) y entra solo cuando se libere un escritorio.`);
      else select(r.name);
    } catch { /* toast ya mostrado */ }
  }
  if (e.target.id === 'chat-form') {
    const name = st.selected;
    const t = $('#chat-in').value.trim();
    const files = attList(name);
    if ((!t && !files.length) || !name) return;
    $('#chat-in').value = ''; grow($('#chat-in'));
    try {
      await api('POST', `/api/robots/${name}/say`, {text: t, attachments: files.map(f => f.path)});
      st.att[name] = [];
      refreshTray(name);
    } catch { $('#chat-in').value = t; }
  }
});
PANEL.addEventListener('click', async e => {
  const pick = e.target.closest('[data-pick]'); if (pick) return select(pick.dataset.pick);
  const sc = e.target.closest('.rt-card[data-sala]'); if (sc) return enterSala(sc.dataset.sala);
  const sa = e.target.closest('[data-sala-act]');
  if (sa) {
    const s = st.salas.find(x => x.id === st.selected?.slice(6)); if (!s) return;
    try {
      if (sa.dataset.salaAct === 'context') return showDoc(s.context);
      if (sa.dataset.salaAct === 'reveal') await api('POST', '/api/reveal', {path: s.context});
      if (sa.dataset.salaAct === 'close' && confirm(`¿Cerrar la sala «${s.name}»? Sus archivos quedan en el disco.`)) { await api('DELETE', `/api/salas/${s.id}`); select('@war'); }
    } catch { /* toast ya mostrado */ }
    return;
  }
  const ib = e.target.closest('[data-inbox]');
  if (ib?.dataset.inbox === 'temp') {
    st.inboxTemp = !st.inboxTemp; prefSet('inboxTemp', st.inboxTemp ? '1' : '0');
    renderInboxBadge(); renderMeta(); return renderPanel();
  }
  if (ib) {
    const id = ib.dataset.id, item = st.inbox.find(x => x.id === id);
    try {
      if (ib.dataset.inbox === 'open' && item) return showDoc(item.path, id);
      if (ib.dataset.inbox === 'seen') await api('POST', `/api/inbox/${id}`, {status: 'visto'});
      if (ib.dataset.inbox === 'unseen') await api('POST', `/api/inbox/${id}`, {status: 'nuevo'});
      if (ib.dataset.inbox === 'reveal' && item) await api('POST', '/api/reveal', {path: item.path});
      if (ib.dataset.inbox === 'archive') await api('DELETE', `/api/inbox/${id}`);
      if (ib.dataset.inbox === 'seen-all') await api('POST', '/api/inbox/seen-all');
    } catch { /* toast ya mostrado */ }
    return;
  }
  const doc = e.target.closest('[data-docpath]'); if (doc) return showDoc(doc.dataset.docpath, doc.dataset.docid);
  const preset = e.target.closest('[data-preset]'); if (preset) return applyPreset(preset.dataset.preset);
  const un = e.target.closest('[data-unatt]');
  if (un) { attList(un.dataset.unatt).splice(Number(un.dataset.i), 1); return refreshTray(un.dataset.unatt); }
  const rb = e.target.closest('[data-rt]');
  if (rb) {
    const id = rb.dataset.id;
    try {
      if (rb.dataset.rt === 'edit' || rb.dataset.rt === 'dup') {
        const rt = st.routines.find(x => x.id === id); if (!rt) return;
        rtUi.edit = rb.dataset.rt === 'edit' ? id : null; rtUi.preview = '';
        PANEL.dataset.view = ''; renderPanel(); fillRoutineForm(rt, rb.dataset.rt === 'dup');
        $('#rt-form', PANEL)?.scrollIntoView({block: 'start'});
        return;
      }
      if (rb.dataset.rt === 'run') await api('POST', `/api/routines/${id}/run`);
      if (rb.dataset.rt === 'pause') await api('POST', `/api/routines/${id}/pause`);
      if (rb.dataset.rt === 'delete' && confirm('¿Eliminar esta rutina? Los robots que ya lanzó siguen trabajando.')) await api('DELETE', `/api/routines/${id}`);
    } catch { /* toast ya mostrado */ }
    return;
  }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const name = st.selected, a = st.robots.get(name);
  try {
    if (b.dataset.act === 'follow' && a) { select(null); return follow(name); }
    if (b.dataset.act === 'qnext') return goNextWaiting();
    if (b.dataset.act === 'compact' && a) return compact(name);
    if (b.dataset.act === 'wake-me' && a) { st.rtDraft = wakeDraft({kind: 'say', robot: name}, a.data.note); rtUi.edit = null; return select('@cron'); }
    if (b.dataset.act === 'wake-arch' && st.archView) { st.rtDraft = wakeDraft({kind: 'retake', archId: st.archView.id}, st.archView.note); rtUi.edit = null; return select('@cron'); }
    if (b.dataset.act === 'revive' && a) return revive(name, b);
    if (b.dataset.act === 'sumkill' && a) return sumKill(name);
    if (b.dataset.act === 'export' && a) return exportConv(`/api/robots/${name}/exportar`, b);
    if (b.dataset.act === 'export-arch' && st.archView) return exportConv(`/api/despedidos/${st.archView.id}/exportar`, b);
    if (b.dataset.act === 'arch-back') { select(st.archFrom || '@archivo'); return; }
    if ((b.dataset.act === 'spawn-ok' || b.dataset.act === 'spawn-no') && a?.data.spawnReq) { b.disabled = true; await decideSpawn(a.data, b.dataset.act === 'spawn-ok'); return; }
    if (b.dataset.act === 'console') await api('POST', `/api/robots/${name}/console`);
    if (b.dataset.act === 'again' && a) return launchAgain(a.data);
    if (b.dataset.act === 'fav' && a) { await api('POST', '/api/favorites', {...a.data.request, title: a.data.title}); toast('Guardado en frecuentes: lo ves arriba de «Nuevo encargo»'); }
    if (b.dataset.act === 'kill') { b.disabled = true; await api('DELETE', `/api/robots/${name}`); }
    if (b.dataset.act === 'perm-approve') await api('POST', `/api/robots/${name}/permission`, {decision: 'approve'});
    if (b.dataset.act === 'perm-reject') await api('POST', `/api/robots/${name}/permission`, {decision: 'reject'});
    if (b.dataset.act === 'hold-allow' && a?.data.hold) await api('POST', `/api/decision/${a.data.hold.id}`, {decision: 'allow'});
    if (b.dataset.act === 'hold-deny' && a?.data.hold) await api('POST', `/api/decision/${a.data.hold.id}`, {decision: 'deny'});
  } catch { /* toast ya mostrado */ }
});
$('#btn-new').addEventListener('click', () => select('@new'));
$('#btn-routine').addEventListener('click', () => select('@cron'));
async function setCap(delta) {
  const next = (st.config.maxRobots || 3) + delta;
  try { await api('POST', '/api/config', {maxRobots: next}); } catch { /* toast ya mostrado */ }
}
$('#cap-down').addEventListener('click', () => setCap(-1));

// Nombre de la oficina (solo estético): va en el encabezado, la pestaña y el ícono, para no confundir oficinas.
const OFFICE_HUES = [174, 38, 352, 250, 98, 205, 300, 18];
function officeHue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return OFFICE_HUES[h % OFFICE_HUES.length];
}
function renderOfficeName() {
  const name = st.config.name || '';
  const btn = $('#office-name');
  if (btn.querySelector('input')) return; // editando: no pisar lo que se escribe
  btn.textContent = name || 'ponle nombre';
  btn.classList.toggle('empty', !name);
  const hue = name ? officeHue(name) : 174;
  btn.style.setProperty('--oh', hue);
  notif.base = name ? `${name} · Oficina de Agentes` : 'Oficina de Agentes';
  fav.hue = hue; fav.letter = esc((name || 'O').trim()[0].toUpperCase());
  updateTitle(notif.known?.size || 0);
}
$('#office-name').addEventListener('click', () => {
  const btn = $('#office-name');
  if (btn.querySelector('input')) return;
  const input = document.createElement('input');
  input.maxLength = 40; input.value = st.config.name || ''; input.placeholder = 'ej. Wallet, Reviews…';
  input.setAttribute('aria-label', 'Nombre de la oficina');
  btn.textContent = ''; btn.classList.remove('empty'); btn.appendChild(input); input.focus(); input.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const value = input.value.replace(/\s+/g, ' ').trim();
    input.remove();
    if (save && value !== (st.config.name || '')) {
      try { await api('POST', '/api/config', {name: value}); } catch { /* toast ya mostrado */ }
    }
    renderOfficeName();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); e.stopPropagation(); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
});
$('#cap-up').addEventListener('click', () => { if ((st.config.maxRobots || 3) >= 3) toast('Más robots a la vez gastan tu cuota más rápido.'); setCap(1); });
$('#btn-inbox').addEventListener('click', () => select('@inbox'));
$('#btn-pins').addEventListener('click', () => select('@pins'));
$('#btn-search').addEventListener('click', () => { select('@search'); $('#search-in')?.focus(); });
$('#btn-usage').addEventListener('click', () => { select('@usage'); loadWeeks(); if (!st.claude) loadClaudeStatus(false); });
$('#week-chip').addEventListener('click', () => $('#btn-usage').click());
// Despide a todos los que terminaron; como la ✕ de cada robot, pide un segundo clic para confirmar.
$('#btn-dismiss').addEventListener('click', async () => {
  const b = $('#btn-dismiss');
  const done = [...st.robots.values()].filter(a => a.data.state === 'done').map(a => a.data.name);
  if (!b.classList.contains('armed')) {
    b.classList.add('armed'); b.textContent = `¿Despedir ${done.join(', ')}?`;
    clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('armed'); renderMeta(); }, 4000);
    return;
  }
  clearTimeout(b._t); b.classList.remove('armed');
  await Promise.allSettled(done.map(n => api('DELETE', `/api/robots/${n}`)));
  renderMeta();
});
$('#dlg-close').addEventListener('click', () => select(null));
$('#dialog').addEventListener('mousedown', e => { if (e.target.id === 'dialog') select(null); });

let modalPath = null;
// Exportar conversación: el daemon escribe el .md en docs/conversaciones-robots/ y aquí se abre para verlo.
async function exportConv(url, btn) {
  btn.disabled = true;
  try {
    const r = await api('POST', url);
    toast(`Conversación exportada (${r.messages} mensaje${r.messages === 1 ? '' : 's'}${r.fromLog ? ', desde lo que guardó la oficina' : ''}): ${r.shown}`);
    showDoc(r.path);
  } catch { /* toast ya mostrado */ } finally { btn.disabled = false; }
}
async function showDoc(p, inboxId) {
  try {
    const doc = await api('GET', `/api/doc?path=${encodeURIComponent(p)}`);
    modalPath = p;
    $('#modal-title').textContent = doc.path;
    $('#modal-body').textContent = doc.binary ? 'Este tipo de archivo no se puede mostrar aquí. Usa «Mostrar en Finder» para abrirlo.' : doc.text;
    modalMd = !doc.binary && /\.(md|markdown)$/i.test(p) && window.marked && window.DOMPurify ? doc.text : null;
    renderDocBody();
    $('#modal').hidden = false; $('#modal-close').focus();
    // Abrir un documento de la bandeja lo marca como visto.
    const item = st.inbox.find(x => (inboxId ? x.id === inboxId : x.path === p) && x.status !== 'visto');
    if (item) await api('POST', `/api/inbox/${item.id}`, {status: 'visto'});
  } catch { /* toast ya mostrado */ }
}
// Los .md se muestran con formato (marked + DOMPurify, servidos localmente); el botón alterna a texto plano.
let modalMd = null;
const prefersPlain = () => { try { return localStorage.getItem('office.docPlain') === '1'; } catch { return false; } };
function renderDocBody() {
  const formatted = modalMd !== null && !prefersPlain();
  $('#modal-fmt').hidden = modalMd === null;
  $('#modal-fmt').textContent = formatted ? 'Texto plano' : 'Con formato';
  $('#modal-body').hidden = formatted;
  $('#modal-md').hidden = !formatted;
  if (formatted) {
    $('#modal-md').innerHTML = DOMPurify.sanitize(marked.parse(modalMd, {gfm: true}));
    $('#modal-md').querySelectorAll('a[href]').forEach(l => { l.target = '_blank'; l.rel = 'noopener'; });
  }
}
$('#modal-fmt').addEventListener('click', () => { try { localStorage.setItem('office.docPlain', prefersPlain() ? '0' : '1'); } catch {} renderDocBody(); });
$('#modal-reveal').addEventListener('click', () => { if (modalPath) api('POST', '/api/reveal', {path: modalPath}).catch(() => {}); });
$('#modal-close').addEventListener('click', () => $('#modal').hidden = true);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').hidden = true; });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#keys')?.hidden && $('#keys')) $('#keys').hidden = true;
  else if (!$('#modal').hidden) $('#modal').hidden = true; // primero el documento, luego la ventana
  else if (st.selected) select(null);
  else if (zoom.follow) stopFollow();
  else if (st.view) leaveSala();
});

