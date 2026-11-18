/* ---------- rutinas ---------- */
const DAYN = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const daysTxt = ds => { const s = [...(ds || [])].sort().join(); return s === '0,1,2,3,4,5,6' ? 'todos los días' : s === '1,2,3,4,5' ? 'días hábiles' : (ds || []).map(d => DAYN[d]).join(', '); };
function schedTxt(sch, everyMin) {
  if (!sch) return `cada ${everyMin} min`;
  if (sch.mode === 'once') return `una sola vez, ${new Date(sch.at).toLocaleString('es', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'})}`;
  if (sch.mode === 'daily') return `${daysTxt(sch.days)} a las ${sch.time}`;
  return `cada ${sch.everyMin} min${sch.hours ? ` · ${daysTxt(sch.hours.days)} de ${sch.hours.from} a ${sch.hours.to}` : ''}`;
}
function routineProgress(rt) {
  if (!rt.nextAt) return {left: Infinity, p: 0};
  const left = Math.max(0, rt.nextAt - Date.now());
  const span = rt.schedule?.mode === 'every' ? rt.schedule.everyMin * 60000 : Math.max(60000, rt.nextAt - (Date.parse(rt.lastRun?.at || '') || rt.nextAt - 864e5));
  return {left, p: rt.paused ? 0 : Math.max(0, Math.min(1, 1 - left / span))};
}
const fmtLeft = ms => { const s = Math.ceil(ms / 1000); if (s >= 86400) return `${Math.floor(s / 86400)} d ${Math.floor(s % 86400 / 3600)} h`; if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`; };
function routineStatus(rt) {
  if (rt.running) return 'revisando ahora…';
  if (rt.type === 'wake' && rt.fired) return '✓ ya se cumplió';
  if (rt.doneOnce) return '✓ ya corrió';
  if (rt.paused || !rt.nextAt) return 'en pausa';
  return `${rt.type === 'agenda' ? 'próxima ejecución' : 'próxima revisión'} en ${fmtLeft(routineProgress(rt).left)}`;
}
function lastRunText(rt) {
  const l = rt.lastRun;
  if (!l) return 'Todavía no ha revisado.';
  const t = new Date(l.at).toTimeString().slice(0, 5);
  if (l.error) return `${t} · Error: ${l.error}`;
  if (rt.type === 'wake' && rt.fired) return `Última revisión: ${t}`;
  if (rt.type !== 'watch') return `${t} · ${l.note || 'sin novedades'}`;
  const base = `${t} · ${l.open} PRs abiertos · ${l.changed} con novedades · ${l.dispatched} robots lanzados`;
  return l.pending ? `${base} · ${l.pending} pendientes (${l.note})` : l.note ? `${t} · ${l.note}` : base;
}
function renderRoutineChips() {
  const active = st.routines.filter(r => !r.paused).length;
  $('#rt-count').textContent = `${active} activa${active === 1 ? '' : 's'}`;
  $('#rt-chips').innerHTML = st.routines.slice(0, 4).map(rt => `<div class="rchip"><div class="ring ${rt.paused ? 'paused' : ''} ${rt.running ? 'running' : ''}" data-ring="${rt.id}"></div><span>${esc(rt.name)}<br><small data-next="${rt.id}"></small></span></div>`).join('') || '<div class="room-b">Sin rutinas. Clic para crear una.</div>';
  tickRoutines();
}
function tickRoutines() {
  for (const rt of st.routines) {
    document.querySelectorAll(`[data-ring="${rt.id}"]`).forEach(el => el.style.setProperty('--p', routineProgress(rt).p));
    document.querySelectorAll(`[data-next="${rt.id}"]`).forEach(el => { el.textContent = routineStatus(rt); });
  }
}
setInterval(tickRoutines, 1000);

const EVN = {new: 'PR nuevo', commits: 'commits nuevos', approved: 'aprobado', changes: 'piden cambios', comment: 'comentario o review nuevo', checks_fail: 'falla un check'};
const WAKE_EV = {approved: 'se apruebe', merged: 'se mergee', changes: 'pidan cambios', comment: 'tenga un comentario o review nuevo', checks_ok: 'pasen sus checks', checks_fail: 'falle un check', closed: 'se cierre o mergee'};
function routineSummary(rt) {
  const when = schedTxt(rt.schedule, rt.everyMin);
  if (rt.type === 'agenda') return [`Tarea programada · ${when} · ${rt.runs} ejecuciones${rt.delegate ? ' · puede delegar en otros robots' : ''}`, `→ ${rt.text}`, `Memoria: ${rt.memory}`];
  if (rt.type === 'wake') {
    const c = rt.cond || {}, w = rt.wake || {};
    const cond = c.kind === 'pr' ? `cuando ${c.repo}#${c.number} ${WAKE_EV[c.event]}` : c.kind === 'nexus' ? `cuando ${c.key} ${c.to === 'any' ? 'cambie de estado' : c.to === 'completed' ? 'se complete' : `pase a «${c.to}»`}` : `a las ${new Date(c.at).toLocaleString('es')}`;
    const act = w.kind === 'say' ? `escribirle a ${w.robot}` : w.kind === 'retake' ? 'retomar un resumen del archivo' : w.kind === 'launch' ? 'lanzar un robot nuevo' : 'avisarte (sin gastar cuota)';
    return [`Despertador ${cond} · revisa cada ${rt.schedule?.everyMin || 5} min`, `→ ${act}${w.text ? `: ${w.text}` : ''}`, ...(rt.status ? [`Ahora: ${rt.status}`] : []), ...(rt.fired ? [`✓ ${new Date(rt.fired.at).toLocaleString('es', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'})}: ${rt.fired.what} · ${rt.fired.done}`] : [])];
  }
  const s = rt.source;
  const where = s.scope === 'org' ? `toda ${s.owner}` : s.repo;
  const action = rt.action.kind === 'skill' ? `/${rt.action.skill} ${rt.action.args}` : `Tarea libre: ${rt.action.text}`;
  return [`Vigila PRs en ${where}${s.query ? ` · filtro «${s.query}»` : ''} · ${when}${rt.includeDrafts ? ' · incluye drafts' : ''}`,
    `Reacciona a: ${(rt.events || ['new', 'commits']).map(e => EVN[e]).join(', ')}`, `→ ${action}`, ...(rt.extra ? [`Instrucciones: ${rt.extra}`] : [])];
}
function historyHtml(rt) {
  const h = rt.history || [];
  if (!h.length) return '';
  const tok = n => n == null ? '' : ` · ${fmtTok(n)} tokens`;
  return `<details class="rt-hist"><summary>Historial (${h.length})</summary>${h.map(x => `<div class="rh ${x.error ? 'err' : ''}"><time>${new Date(x.at).toLocaleString('es', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'})}</time><span>${esc(x.note || '')}</span>${x.robots.length ? `<span class="rh-r">${x.robots.map(r => `${st.robots.has(r.name) ? `<button type="button" class="kid inline" data-pick="${esc(r.name)}">${esc(r.name)}</button>` : esc(r.name)} <small>${esc(r.state ? STATE_LABEL[r.state] || r.state : '')}${tok(r.tokens)}</small>`).join(' · ')}</span>` : ''}</div>`).join('')}</details>`;
}

// Formulario: crear, editar o duplicar. rtUi.edit = id de la rutina que se edita.
const rtUi = {edit: null, preview: ''};
const dayChips = (pre, sel) => `<span class="daych">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" id="${pre}-${d}" ${sel.includes(d) ? 'checked' : ''}>${DAYN[d]}</label>`).join('')}</span>`;
function cronPanel() {
  const cards = st.routines.map(rt => `<div class="rt-card ${rt.type === 'wake' ? 'wake' : ''}${rtUi.edit === rt.id ? ' editing' : ''}">
      <div class="top-r"><div class="ring ${rt.paused ? 'paused' : ''} ${rt.running ? 'running' : ''}" data-ring="${rt.id}"></div><b>${esc(rt.name)}</b></div>
      ${routineSummary(rt).map(l => `<div class="sub-h">${esc(l)}</div>`).join('')}
      <div class="sub-h ${rt.lastRun?.error ? 'rt-err' : ''}">${esc(lastRunText(rt))}</div>
      <div class="sub-h" data-next="${rt.id}"></div>
      ${historyHtml(rt)}
      <div class="row"><button class="btn sm" data-rt="run" data-id="${rt.id}" ${rt.running ? 'disabled' : ''}>${rt.type === 'agenda' ? 'Correr ahora' : 'Revisar ahora'}</button><button class="btn sm" data-rt="pause" data-id="${rt.id}">${rt.paused ? (rt.fired || rt.doneOnce ? 'Volver a activar' : 'Reanudar') : 'Pausar'}</button><button class="btn sm" data-rt="edit" data-id="${rt.id}">Editar</button><button class="btn sm" data-rt="dup" data-id="${rt.id}">Duplicar</button><button class="btn sm danger" data-rt="delete" data-id="${rt.id}">Eliminar</button></div>
    </div>`).join('');
  const robotsOpt = [...st.robots.values()].map(a => `<option value="${esc(a.data.name)}">${esc(a.data.name)}${titleOf(a.data) ? ' · ' + esc(titleOf(a.data).slice(0, 40)) : ''}</option>`).join('');
  const archOpt = (st.archList || []).map(a => `<option value="${esc(a.id)}">${esc(a.name)}${a.title ? ' · ' + esc(a.title.slice(0, 40)) : ''} (se fue ${new Date(a.leftAt).toLocaleDateString('es')})</option>`).join('');
  return `<div class="dlg-head"><h3>Rutinas</h3><p><b>Vigilar PRs</b> y <b>Despertador</b> revisan con <code>gh</code> y Nexus sin gastar cuota: solo gastan cuando despiertan o lanzan a un robot. <b>Tarea programada</b> lanza un robot en cada ejecución (gasta siempre): úsala con horario.</p></div>
    ${cards ? `<section class="dlg-sec"><h4>Rutinas creadas</h4><div class="rt-grid">${cards}</div></section>` : ''}
    <form class="dlg-sec" id="rt-form">
      <h4>${rtUi.edit ? `Editando «${esc(st.routines.find(r => r.id === rtUi.edit)?.name || '')}»` : 'Nueva rutina'}</h4>
      ${rtUi.edit ? '' : `<div class="row tpl"><span class="flabel">Plantillas</span><button class="btn sm" type="button" data-preset="mios">Mis PRs cada mañana</button><button class="btn sm" type="button" data-preset="author">PRs de alguien → /review-deep</button><button class="btn sm" type="button" data-preset="merge">Avísame cuando se mergee un PR</button><button class="btn sm" type="button" data-preset="approve">Sigue con un robot cuando aprueben su PR</button><button class="btn sm" type="button" data-preset="agenda">Tarea programada que delega</button></div>`}
      <div class="fgrid">
        <div class="seg full" role="radiogroup" aria-label="Tipo de rutina">
          <label><input type="radio" name="rttype" id="rt-type-watch" value="watch" checked ${rtUi.edit ? 'disabled' : ''}>Vigilar PRs</label>
          <label><input type="radio" name="rttype" id="rt-type-agenda" value="agenda" ${rtUi.edit ? 'disabled' : ''}>Tarea programada</label>
          <label><input type="radio" name="rttype" id="rt-type-wake" value="wake" ${rtUi.edit ? 'disabled' : ''}>⏰ Despertador</label>
        </div>
        <div class="field"><label for="rt-name">Nombre</label><input id="rt-name" placeholder="se genera solo"></div>
        <div class="field"><label for="rt-mode">Permisos de los robots</label><select id="rt-mode"><option value="">Heredar tu modo</option><option value="default">Preguntar (default)</option><option value="acceptEdits">Aceptar ediciones</option><option value="plan">Solo planear</option></select></div>

        <div class="fgrid full" id="g-sched">
          <div class="seg full" role="radiogroup" aria-label="Cuándo corre">
            <label><input type="radio" name="rtwhen" id="rt-when-every" value="every" checked>Cada N minutos</label>
            <label><input type="radio" name="rtwhen" id="rt-when-daily" value="daily">A una hora</label>
            <label><input type="radio" name="rtwhen" id="rt-when-once" value="once">Una sola vez</label>
          </div>
          <div class="field" id="f-every"><label for="rt-every">Cada cuántos minutos</label><input id="rt-every" type="number" min="1" max="1440" value="30"></div>
          <div class="field span2" id="f-hours"><label class="hcheck"><input type="checkbox" id="rt-hours"> Solo en horario laboral <small class="muted">(no gasta de noche ni el fin de semana)</small></label>
            <div class="hours-row" id="f-hours-r"><input id="rt-h-from" type="time" value="08:00"> a <input id="rt-h-to" type="time" value="18:00"> ${dayChips('rt-hday', [1, 2, 3, 4, 5])}</div></div>
          <div class="field span2" id="f-daily" hidden><label for="rt-time">A las</label><div class="hours-row"><input id="rt-time" type="time" value="08:00"> ${dayChips('rt-day', [1, 2, 3, 4, 5])}</div></div>
          <div class="field" id="f-once" hidden><label for="rt-at">Fecha y hora</label><input id="rt-at" type="datetime-local"></div>
        </div>

        <div class="fgrid full" id="g-watch">
          <div class="field"><label for="rt-where">Dónde buscar</label><select id="rt-where"><option value="repo">En un repositorio</option><option value="org">En toda la organización</option></select></div>
          <div class="field" id="f-rt-repo"><label for="rt-repo">Repositorio (owner/nombre)</label><input id="rt-repo" placeholder="DROPI-SAS/dropi-specs" autocomplete="off"></div>
          <div class="field" id="f-rt-owner" hidden><label for="rt-owner">Organización</label><input id="rt-owner" value="DROPI-SAS" autocomplete="off"></div>
          <div class="field"><label for="rt-query">Filtro de GitHub (opcional)</label><input id="rt-query" placeholder="author:karol · label:hotfix" autocomplete="off"></div>
          <div class="field span2"><label for="rt-scope">Qué PRs</label><select id="rt-scope"><option value="new">Solo lo que pase desde ahora</option><option value="all">También los que ya están abiertos</option></select></div>
          <label class="check field-check"><input type="checkbox" id="rt-drafts"> Incluir PRs en draft</label>
          <div class="field full"><span class="flabel">Lanza un robot cuando un PR…</span><span class="evch">${Object.entries(EVN).map(([k, l]) => `<label><input type="checkbox" id="rt-ev-${k}" ${k === 'new' || k === 'commits' ? 'checked' : ''}>${l}</label>`).join('')}</span><small class="muted">Por comentarios nuevos lanza como mucho un robot por PR cada 30 min.</small></div>
          <div class="seg full" role="radiogroup" aria-label="Qué hace el robot con cada PR">
            <label><input type="radio" name="rtkind" id="rt-kind-skill" value="skill" checked>Skill por cada PR</label>
            <label><input type="radio" name="rtkind" id="rt-kind-libre" value="libre">Tarea libre por cada PR</label>
          </div>
          <div class="field" id="f-rt-skill"><label for="rt-skill">Skill</label><input id="rt-skill" list="skills-list" value="pr-review" autocomplete="off"></div>
          <div class="field span2" id="f-rt-args"><label for="rt-args">Argumentos</label><input id="rt-args" value="{url}"></div>
          <div class="field full" id="f-rt-text" hidden><label for="rt-text">Qué hacer con cada PR</label><textarea id="rt-text" rows="3" data-ac>Revisa el PR {url} ({title}) de {author} y dime en 5 líneas si está listo para aprobar. No publiques nada.</textarea></div>
          <div class="field full"><label for="rt-extra">Instrucciones adicionales (opcional)</label><textarea id="rt-extra" rows="2" data-ac placeholder="Ej.: no publiques en el PR; si hay críticos, deja el resumen en la bandeja"></textarea></div>
          <div class="note full">Variables: <code>{url}</code> <code>{number}</code> <code>{repo}</code> <code>{head}</code> <code>{base}</code> <code>{title}</code> <code>{author}</code> <code>{local}</code> (carpeta del repo en tu workspace) <code>{event}</code> (qué pasó). Para /review-deep: <code>{local} origin/{base} origin/{head}</code>.</div>
        </div>

        <div class="fgrid full" id="g-agenda" hidden>
          <div class="field full"><label for="rt-agenda">Instrucciones</label><textarea id="rt-agenda" rows="5" data-ac placeholder="Ej.: busca los PRs abiertos de karol en DROPI-SAS y pásale a otro robot un /review-deep por cada uno que no hayas procesado"></textarea></div>
          <label class="check full"><input type="checkbox" id="rt-delegate" checked> Puede pasarle trabajo a otros robots de la oficina</label>
          <div class="note full">Cada ejecución gasta cuota aunque no haya nada nuevo: dale un horario («A una hora» o horario laboral). El robot recibe un archivo de memoria para recordar lo que hizo antes. Si la ejecución anterior sigue en la oficina, se salta la siguiente.</div>
        </div>

        <div class="fgrid full" id="g-wake" hidden>
          <div class="field"><label for="rt-c-kind">Esperar a que…</label><select id="rt-c-kind"><option value="pr">un PR…</option><option value="nexus">un ticket de Nexus…</option><option value="time">llegue una hora</option></select></div>
          <div class="field" id="f-c-ref"><label for="rt-c-ref">PR</label><input id="rt-c-ref" data-ac placeholder="nr-frontend#472, owner/repo#12 o la URL" autocomplete="off"></div>
          <div class="field" id="f-c-event"><label for="rt-c-event">Cuando</label><select id="rt-c-event">${Object.entries(WAKE_EV).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
          <div class="field" id="f-c-key" hidden><label for="rt-c-key">Ticket</label><input id="rt-c-key" placeholder="INT-40" autocomplete="off"></div>
          <div class="field" id="f-c-to" hidden><label for="rt-c-to">Cuando</label><select id="rt-c-to"><option value="any">cambie de estado</option><option value="completed">se complete (Hecho)</option><option value="custom">pase a un estado…</option></select><input id="rt-c-tostate" placeholder="Ej.: En revisión" hidden></div>
          <div class="field" id="f-c-at" hidden><label for="rt-c-at">Fecha y hora</label><input id="rt-c-at" type="datetime-local"></div>
          <div class="field"><label for="rt-c-every">Revisar cada (min)</label><input id="rt-c-every" type="number" min="1" max="1440" value="5"></div>
          <div class="field"><label for="rt-w-kind">Entonces</label><select id="rt-w-kind"><option value="notify">Avisarme (no gasta cuota)</option><option value="say">Escribirle a un robot</option><option value="retake">Retomar un resumen del archivo</option><option value="launch">Lanzar un robot nuevo</option></select></div>
          <div class="field" id="f-w-robot" hidden><label for="rt-w-robot">Robot</label><select id="rt-w-robot">${robotsOpt || '<option value="">(no hay robots)</option>'}</select></div>
          <div class="field span2" id="f-w-arch" hidden><label for="rt-w-arch">Resumen</label><select id="rt-w-arch">${archOpt || '<option value="">(el archivo está vacío)</option>'}</select></div>
          <div class="field full" id="f-w-text" hidden><label for="rt-w-text">Qué decirle</label><textarea id="rt-w-text" rows="2" data-ac placeholder="Ej.: ya se aprobó, sigue con el merge y avísame"></textarea></div>
          <div class="note full">Se cumple una vez y queda pausado («Volver a activar» lo rearma). Si el robot al que le escribe se fue, entra uno nuevo con su resumen; si su consola se cayó, se revive.</div>
        </div>
      </div>
      <div class="rt-prev" id="rt-preview">${rtUi.preview}</div>
      <div class="dlg-foot"><div class="row"><button class="btn sm" type="button" data-rt-preview title="Consulta GitHub o Nexus y te dice qué haría ahora, sin lanzar robots ni gastar cuota">👁 Probar sin gastar</button>${rtUi.edit ? '<button class="btn sm" type="button" data-rt-cancel>Cancelar edición</button>' : ''}</div>
        <button class="btn primary">${rtUi.edit ? 'Guardar cambios' : 'Crear rutina'}</button></div>
    </form>`;
}
const chk = id => document.getElementById(id)?.checked;
const val = id => document.getElementById(id)?.value ?? '';
const daysOf = pre => [0, 1, 2, 3, 4, 5, 6].filter(d => chk(`${pre}-${d}`));
function routineBody() {
  const type = chk('rt-type-agenda') ? 'agenda' : chk('rt-type-wake') ? 'wake' : 'watch';
  const when = chk('rt-when-daily') ? 'daily' : chk('rt-when-once') ? 'once' : 'every';
  const schedule = type === 'wake' ? {mode: 'every', everyMin: Number(val('rt-c-every'))}
    : when === 'daily' ? {mode: 'daily', time: val('rt-time'), days: daysOf('rt-day')}
    : when === 'once' ? {mode: 'once', at: val('rt-at') ? new Date(val('rt-at')).toISOString() : ''}
    : {mode: 'every', everyMin: Number(val('rt-every')), ...(chk('rt-hours') ? {hours: {from: val('rt-h-from'), to: val('rt-h-to'), days: daysOf('rt-hday')}} : {})};
  const common = {type, name: val('rt-name').trim() || undefined, schedule, permissionMode: val('rt-mode')};
  if (type === 'agenda') return {...common, text: val('rt-agenda'), delegate: chk('rt-delegate')};
  if (type === 'wake') {
    const ck = val('rt-c-kind'), to = val('rt-c-to');
    return {...common, cond: ck === 'pr' ? {kind: 'pr', ref: val('rt-c-ref'), event: val('rt-c-event')} : ck === 'nexus' ? {kind: 'nexus', key: val('rt-c-key'), to: to === 'custom' ? val('rt-c-tostate') : to} : {kind: 'time', at: val('rt-c-at') ? new Date(val('rt-c-at')).toISOString() : ''},
      wake: {kind: val('rt-w-kind'), robot: val('rt-w-robot'), archId: val('rt-w-arch'), text: val('rt-w-text')}};
  }
  return {...common, source: val('rt-where') === 'org' ? {scope: 'org', owner: val('rt-owner').trim(), query: val('rt-query').trim()} : {scope: 'repo', repo: val('rt-repo').trim(), query: val('rt-query').trim()},
    onlyNew: val('rt-scope') === 'new', includeDrafts: chk('rt-drafts'), extra: val('rt-extra'),
    events: Object.keys(EVN).filter(k => chk(`rt-ev-${k}`)),
    action: chk('rt-kind-libre') ? {kind: 'libre', text: val('rt-text')} : {kind: 'skill', skill: val('rt-skill'), args: val('rt-args')}};
}
// Llena el formulario con una rutina (editar o duplicar) o con un borrador (plantilla, «despiértame cuando…»).
function setField(id, v) { const el = document.getElementById(id); if (!el) return; if (el.type === 'radio' || el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; }
const localDT = iso => { const d = new Date(iso); if (Number.isNaN(+d)) return ''; d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function fillRoutineForm(rt, dup) {
  setField(`rt-type-${rt.type}`, true);
  setField('rt-name', dup ? `${rt.name} (copia)` : rt.name); setField('rt-mode', rt.permissionMode || '');
  const sch = rt.schedule || {mode: 'every', everyMin: rt.everyMin || 30};
  setField(`rt-when-${sch.mode}`, true);
  if (sch.mode === 'every') { setField('rt-every', sch.everyMin); setField('rt-hours', !!sch.hours); if (sch.hours) { setField('rt-h-from', sch.hours.from); setField('rt-h-to', sch.hours.to); for (let d = 0; d < 7; d++) setField(`rt-hday-${d}`, sch.hours.days.includes(d)); } }
  if (sch.mode === 'daily') { setField('rt-time', sch.time); for (let d = 0; d < 7; d++) setField(`rt-day-${d}`, sch.days.includes(d)); }
  if (sch.mode === 'once') setField('rt-at', localDT(sch.at));
  if (rt.type === 'agenda') { setField('rt-agenda', rt.text); setField('rt-delegate', rt.delegate); }
  if (rt.type === 'watch' && rt.source) {
    setField('rt-where', rt.source.scope); setField('rt-repo', rt.source.repo || ''); setField('rt-owner', rt.source.owner || 'DROPI-SAS'); setField('rt-query', rt.source.query);
    setField('rt-scope', rt.onlyNew ? 'new' : 'all'); setField('rt-drafts', rt.includeDrafts); setField('rt-extra', rt.extra);
    for (const k of Object.keys(EVN)) setField(`rt-ev-${k}`, (rt.events || ['new', 'commits']).includes(k));
    setField(`rt-kind-${rt.action?.kind || 'skill'}`, true);
    if (rt.action?.kind === 'libre') setField('rt-text', rt.action.text); else { setField('rt-skill', rt.action?.skill); setField('rt-args', rt.action?.args); }
  }
  if (rt.type === 'wake') {
    const c = rt.cond || {}, w = rt.wake || {};
    setField('rt-c-kind', c.kind || 'pr'); setField('rt-c-every', sch.everyMin || 5);
    if (c.kind === 'pr') { setField('rt-c-ref', c.ref || (c.repo ? `${c.repo}#${c.number}` : '')); setField('rt-c-event', c.event || 'approved'); }
    if (c.kind === 'nexus') { setField('rt-c-key', c.key); const std = ['any', 'completed'].includes(c.to); setField('rt-c-to', std ? c.to : 'custom'); setField('rt-c-tostate', std ? '' : c.to); }
    if (c.kind === 'time') setField('rt-c-at', localDT(c.at));
    setField('rt-w-kind', w.kind || 'notify'); setField('rt-w-robot', w.robot || ''); setField('rt-w-arch', w.archId || ''); setField('rt-w-text', w.text || '');
  }
  syncKind();
}
PANEL.addEventListener('click', async e => {
  if (e.target.closest('[data-rt-cancel]')) { rtUi.edit = null; rtUi.preview = ''; PANEL.dataset.view = ''; return renderPanel(); }
  const pv = e.target.closest('[data-rt-preview]'); if (!pv) return;
  const box = $('#rt-preview', PANEL); pv.disabled = true; box.innerHTML = '<p class="muted">Consultando… (no gasta cuota)</p>';
  try {
    const r = await api('POST', '/api/routines/preview', routineBody());
    const when = t => new Date(t).toLocaleString('es', {weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
    box.innerHTML = r.kind === 'watch'
      ? `<b>Ahora coinciden ${r.open.length} PR${r.open.length === 1 ? '' : 's'} abiertos.</b> ${r.onlyNew ? 'Con «solo lo que pase desde ahora» hoy no lanzaría ninguno: los marca como vistos y espera novedades.' : r.fire.length ? `Al crearla lanzaría <b>${r.fire.length} robot${r.fire.length === 1 ? '' : 's'}</b> (uno por PR).` : 'No lanzaría ninguno.'}<ul>${r.open.slice(0, 15).map(p => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.key)}</a> · ${esc(p.title)} <small>${esc(p.author)}${p.draft ? ' · draft' : ''}</small></li>`).join('')}${r.open.length > 15 ? `<li class="muted">…y ${r.open.length - 15} más</li>` : ''}</ul>`
      : r.kind === 'wake' ? `<b>Ahora:</b> ${esc(r.status)}. ${r.hit ? `<b class="rt-err">Ya se cumple</b>: al crearlo actuaría enseguida (${esc(r.what)}).` : 'Todavía no se cumple: queda esperando.'}`
      : `<b>Próximas ejecuciones:</b> ${r.next.map(when).join(' · ') || 'ninguna'} <small class="muted">(cada una lanza un robot y gasta cuota)</small>`;
    rtUi.preview = box.innerHTML;
  } catch { box.innerHTML = ''; } finally { pv.disabled = false; }
});
// Al abrir rutinas se trae la lista del archivo (para «retomar un resumen») y, si hay un borrador pendiente, se aplica.
async function cronOpened() {
  try { st.archList = (await (await fetch('/api/despedidos?all=1')).json()).recent || []; } catch { st.archList = []; }
  if (st.selected !== '@cron') return;
  const prev = $('#rt-w-arch', PANEL)?.value;
  const sel = $('#rt-w-arch', PANEL);
  if (sel) { sel.innerHTML = st.archList.map(a => `<option value="${esc(a.id)}">${esc(a.name)}${a.title ? ' · ' + esc(a.title.slice(0, 40)) : ''} (se fue ${new Date(a.leftAt).toLocaleDateString('es')})</option>`).join('') || '<option value="">(el archivo está vacío)</option>'; if (prev) sel.value = prev; }
  if (st.rtDraft) { const d = st.rtDraft; st.rtDraft = null; fillRoutineForm(d, false); $('#rt-form', PANEL)?.scrollIntoView({block: 'start'}); toast('Revisa el despertador y créalo'); }
}

// Borrador de despertador: si la nota menciona un PR (frontend#472) o un ticket (INT-40), se usa de condición.
function wakeDraft(wake, note) {
  const pr = /\b[\w.-]+(?:\/[\w.-]+)?#\d+\b/.exec(note || '')?.[0], tk = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/.exec(note || '')?.[0];
  const cond = pr ? {kind: 'pr', ref: pr, event: 'approved'} : tk ? {kind: 'nexus', key: tk, to: 'completed'} : {kind: 'pr', ref: '', event: 'approved'};
  return {type: 'wake', cond, wake: {...wake, text: wake.kind === 'say' ? 'Ya pasó lo que esperabas: sigue y avísame.' : ''}, schedule: {mode: 'every', everyMin: 5}};
}
const PRESETS = {
  mios: {type: 'agenda', name: 'Mis PRs cada mañana', schedule: {mode: 'daily', time: '08:00', days: [1, 2, 3, 4, 5]}, delegate: false,
    text: 'Busca mis PRs abiertos (gh search prs --author @me --state open) y dime en pocas líneas, por PR: si tiene review pendiente, cambios pedidos, checks rojos o está listo para mergear. No publiques nada.'},
  author: {type: 'watch', source: {scope: 'org', owner: 'DROPI-SAS', query: 'author:karol'}, onlyNew: false, events: ['new', 'commits'], schedule: {mode: 'every', everyMin: 30, hours: {from: '08:00', to: '18:00', days: [1, 2, 3, 4, 5]}},
    action: {kind: 'skill', skill: 'review-deep', args: '{local} origin/{base} origin/{head}'}, extra: 'No publiques nada en el PR; deja el reporte en reviews/ como siempre.'},
  merge: {type: 'wake', cond: {kind: 'pr', ref: '', event: 'merged'}, wake: {kind: 'notify'}, schedule: {mode: 'every', everyMin: 5}},
  approve: {type: 'wake', cond: {kind: 'pr', ref: '', event: 'approved'}, wake: {kind: 'say', robot: '', text: 'Ya lo aprobaron: sigue con lo que faltaba y avísame.'}, schedule: {mode: 'every', everyMin: 5}},
  agenda: {type: 'agenda', name: 'Reviews de karol (delega)', schedule: {mode: 'every', everyMin: 60, hours: {from: '08:00', to: '18:00', days: [1, 2, 3, 4, 5]}}, delegate: true,
    text: 'Busca los PRs abiertos de karol en DROPI-SAS (gh search prs --owner DROPI-SAS --author karol --state open). Por cada uno que no esté en tu memoria con el mismo commit, pásale a otro robot un /review-deep con la ruta local del repo, origin/<base> y origin/<rama>. Anota en la memoria cada PR y commit que delegaste.'}
};
function applyPreset(name) {
  fillRoutineForm(PRESETS[name], false);
  toast(name === 'author' || name === 'agenda' ? 'Plantilla cargada: cambia el autor por el login de GitHub real antes de crearla.' : 'Plantilla cargada: completa lo que falta y créala.');
}

function renderMeta() {
  renderOfficeName();
  const n = st.robots.size, max = st.config.maxRobots || 3;
  $('#cap-n').textContent = max;
  $('#cap-down').disabled = max <= 1;
  $('#cap-up').disabled = max >= (st.config.maxRobotsLimit || 20);
  const active = [...st.robots.values()].filter(a => a.data.state !== 'done' || onHold(a.data)).length; // en espera no cuenta como listo
  $('#meta').textContent = '';
  const done = n - active;
  $('#btn-dismiss').hidden = !done;
  if (!$('#btn-dismiss').classList.contains('armed')) $('#btn-dismiss').textContent = `Despedir listos (${done})`;
  scheduleCards();
}

