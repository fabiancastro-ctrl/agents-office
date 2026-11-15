/* ---------- lanzar otro igual y encargos frecuentes ---------- */
st.favorites = [];
function fillJob(req) {
  select('@new');
  const set = (id, v) => { const el = $('#' + id, PANEL); if (el) el.value = v ?? ''; };
  ($(req.kind === 'libre' ? '#kind-libre' : '#kind-skill', PANEL) || {}).checked = true;
  set('job-skill', req.skill ? req.skill : ''); set('job-args', req.args); set('job-text', req.text);
  set('job-mode', req.permissionMode); set('job-title', req.title); set('job-name', '');
  syncKind();
  const focus = req.kind === 'libre' ? $('#job-text', PANEL) : $('#job-args', PANEL);
  focus?.focus(); focus?.setSelectionRange?.(focus.value.length, focus.value.length);
}
const launchAgain = d => fillJob({...d.request, title: d.title});
PANEL.addEventListener('click', async e => {
  const use = e.target.closest('[data-fav]'), del = e.target.closest('[data-fav-del]'), save = e.target.closest('[data-fav-save]');
  if (use) { const f = st.favorites.find(x => x.id === use.dataset.fav); if (f) fillJob(f); return; }
  if (del) { try { await api('DELETE', `/api/favorites/${del.dataset.favDel}`); } catch { /* toast ya mostrado */ } return; }
  if (!save) return;
  const libre = $('#kind-libre', PANEL)?.checked;
  try {
    await api('POST', '/api/favorites', {kind: libre ? 'libre' : 'skill', skill: $('#job-skill').value, args: $('#job-args').value, text: $('#job-text').value, permissionMode: $('#job-mode').value, title: $('#job-title').value});
    toast('Guardado en frecuentes');
  } catch { /* toast ya mostrado */ }
});

function syncKind() {
  const libre = $('#kind-libre', PANEL)?.checked;
  if ($('#f-text', PANEL)) {
    $('#f-text').hidden = !libre; $('#f-skill').hidden = !!libre; $('#f-args').hidden = !!libre;
  }
  if ($('#f-sk-text', PANEL)) {
    const skill = $('#sk-skill-r', PANEL).checked;
    $('#f-sk-text').hidden = skill; $('#f-sk-skill').hidden = !skill; $('#f-sk-args').hidden = !skill;
  }
  const rtLibre = $('#rt-kind-libre', PANEL)?.checked;
  if ($('#f-rt-text', PANEL)) {
    $('#f-rt-text').hidden = !rtLibre; $('#f-rt-skill').hidden = !!rtLibre; $('#f-rt-args').hidden = !!rtLibre;
    const agenda = $('#rt-type-agenda').checked, wake = $('#rt-type-wake').checked;
    $('#g-agenda').hidden = !agenda; $('#g-watch').hidden = agenda || wake; $('#g-wake').hidden = !wake; $('#g-sched').hidden = wake;
    const org = $('#rt-where').value === 'org';
    $('#f-rt-owner').hidden = !org; $('#f-rt-repo').hidden = org;
    const when = $('#rt-when-daily').checked ? 'daily' : $('#rt-when-once').checked ? 'once' : 'every';
    $('#f-every').hidden = when !== 'every'; $('#f-hours').hidden = when !== 'every'; $('#f-daily').hidden = when !== 'daily'; $('#f-once').hidden = when !== 'once';
    $('#f-hours-r').hidden = !$('#rt-hours').checked;
    const ck = $('#rt-c-kind').value;
    $('#f-c-ref').hidden = ck !== 'pr'; $('#f-c-event').hidden = ck !== 'pr'; $('#f-c-key').hidden = ck !== 'nexus'; $('#f-c-to').hidden = ck !== 'nexus'; $('#f-c-at').hidden = ck !== 'time';
    $('#rt-c-tostate').hidden = $('#rt-c-to').value !== 'custom';
    const wk = $('#rt-w-kind').value;
    $('#f-w-robot').hidden = wk !== 'say'; $('#f-w-arch').hidden = wk !== 'retake'; $('#f-w-text').hidden = wk === 'notify';
    $('#f-w-text label').textContent = wk === 'launch' ? 'Qué debe hacer el robot nuevo' : 'Qué decirle (opcional)';
  }
}

/* ---------- nube al pasar el mouse ---------- */
const hover = {el: document.createElement('div'), name: null, timer: null, line: ''};
hover.el.className = 'hovercard'; hover.el.hidden = true;
MAP.appendChild(hover.el);

// Ultima linea "util" de la consola: se saltan bordes, el prompt y la barra de modo de Claude Code.
const NOISE = /^[\s─━│┃╭╮╰╯┌┐└┘═╌╍┄┈\-_|]*$|^\s*❯|⏵⏵|⏸|\? for shortcuts|esc to interrupt|shift\+tab|mode on|^\s*>\s*$/;
function lastConsoleLine(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || NOISE.test(l)) continue;
    return l.replace(/^[⎿⏺✻✳✶✢·•*]+\s*/, '').slice(0, 110);
  }
  return '';
}

function hoverActivity(d) {
  if (d.ask) return `Te hizo ${d.ask.questions.length === 1 ? 'una pregunta' : `${d.ask.questions.length} preguntas`} con opciones`;
  if (d.needsPermission || d.hold) return 'Esperando tu permiso';
  if (d.state === 'delegating') {
    const running = d.subs.filter(s => s.status === 'running');
    return `Esperando ${running.length} subagente${running.length === 1 ? '' : 's'}${running[0]?.activity ? ' · ' + running[0].activity : ''}`;
  }
  if (d.activity) return d.activity;
  return plainMd(d.bubble) || STATE_LABEL[d.state] || '';
}

function renderHover() {
  const a = st.robots.get(hover.name);
  if (!a) return hideHover();
  const d = a.data;
  const label = stateLabel(d);
  hover.el.innerHTML = `<div class="hc-top"><b>${esc(d.name)}</b><span class="pill p-${d.state}">${esc(label)}</span></div>
    ${titleOf(d) ? `<div class="hc-title${d.title ? '' : ' auto'}">📌 ${esc(titleOf(d))}</div>` : ''}
    <div class="hc-act">${esc(hoverActivity(d).slice(0, 120))}</div>
    ${d.state === 'input' && d.inputAt ? `<div class="hc-wait">Esperando tu respuesta hace <b data-since="${esc(d.inputAt)}">${fmtWait(Date.now() - Date.parse(d.inputAt))}</b></div>` : ''}
    ${d.note ? `<div class="hc-note">🗒 ${esc(d.note)}</div>` : ''}${isSleepy(d) ? `<div class="hc-org">💤 Dormido: ${fmtDur(sleepMs(d))} sin actividad</div>` : ''}${d.ctx ? `<div class="hc-org">Contexto ${d.ctx.pct}% lleno (${fmtTok(d.ctx.tokens)} de ${fmtTok(d.ctx.window || 200000)})</div>` : ''}${d.crown ? `<div class="hc-org hc-crown">👑 Empleado de la semana${d.crown >= 2 ? ' · 🔥🔥 también el que más gastó en esta sesión de 5 h' : ' 🔥'}</div>` : ''}${spendText(d) ? `<div class="hc-org${d.spend.hot ? ' hc-hot' : ''}">Gasto: ${esc(spendText(d))}</div>` : ''}<div class="hc-org">${esc(d.origin || 'Origen desconocido')}</div>
    ${hover.line ? `<div class="hc-con">› ${esc(hover.line)}</div>` : ''}`;
  hover.el.style.left = a.pos.x + '%';
  hover.el.style.top = py(a.pos.y);
  hover.el.classList.toggle('flip', a.pos.y < 30);
  hover.el.hidden = false;
  clampHover();
}
// Robots del borde: la tarjeta se corre hacia adentro para no quedar cortada por el borde del mapa
// (la flecha sigue apuntando al robot). En la vista 2.5D no se toca: allí la rota la perspectiva.
function clampHover() {
  const el = hover.el;
  el.style.setProperty('--hx', '0px');
  if (MAP.closest('.map-wrap')?.classList.contains('iso')) return;
  const r = el.getBoundingClientRect(), m = MAP.getBoundingClientRect(), w = MAP.parentElement.getBoundingClientRect();
  const left = Math.max(m.left, w.left) + 6, right = Math.min(m.right, w.right) - 6;
  const dx = r.left < left ? left - r.left : r.right > right ? right - r.right : 0;
  if (dx) el.style.setProperty('--hx', Math.round(dx / zoom.z) + 'px');
}

async function refreshHoverLine() {
  const name = hover.name; if (!name) return;
  try {
    const res = await fetch(`/api/robots/${name}/pane`);
    if (!res.ok || hover.name !== name) return;
    hover.line = lastConsoleLine((await res.json()).text);
    renderHover();
  } catch { /* el robot pudo irse */ }
}

function showHover(name) {
  if (hover.name === name) return;
  hover.name = name; hover.line = '';
  renderHover();
  refreshHoverLine();
  clearInterval(hover.timer);
  hover.timer = setInterval(refreshHoverLine, 2000);
}
function hideHover() {
  hover.name = null;
  clearInterval(hover.timer);
  hover.el.hidden = true;
}

MAP.addEventListener('mouseover', e => {
  const r = e.target.closest('.robot:not(.on-break)');
  if (r) showHover(r.dataset.name);
});
MAP.addEventListener('mouseout', e => {
  const r = e.target.closest('.robot');
  if (r && !r.contains(e.relatedTarget)) hideHover();
});

