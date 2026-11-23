/* ---------- uso y estado de Claude ---------- */
const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const weekLabel = w => fmtDay(w + 'T00:00:00');
const tokLine = w =>
  `salida ${fmtTok(w.out)} · entrada ${fmtTok(w.in)} · caché leída ${fmtTok(w.cacheRead)} · caché escrita ${fmtTok(w.cacheWrite)}`;

async function loadWeeks() {
  try {
    st.weeks = (await (await fetch('/api/usage')).json()).weeks || [];
  } catch {
    return;
  }
  const cur = st.weeks[0];
  // Short line under «Uso Claude» in the More menu; the full breakdown goes in the tooltip.
  $('#week-chip').textContent = cur ? `semana · salida ${fmtTok(cur.out)}` : 'semana · sin uso';
  $('#week-chip').title = cur ? `Tokens de la oficina esta semana: ${tokLine(cur)}. Clic para el detalle.` : 'Todavía no hay uso esta semana.';
  scheduleCards();
  if (st.selected === '@usage') schedulePanel();
}
async function loadClaudeStatus(refresh) {
  st.claudeLoading = true;
  st.claudeError = '';
  if (st.selected === '@usage') renderPanel();
  try {
    const res = await fetch('/api/claude-status' + (refresh ? '?refresh=1' : ''));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    st.claude = data;
  } catch (e) {
    st.claudeError = e.message || 'No se pudo leer /usage.';
  }
  st.claudeLoading = false;
  scheduleCards();
  if (st.selected === '@usage') renderPanel();
}

function usagePanel() {
  const c = st.claude;
  const bars = c
    ? c.limits
        .map(
          l => `<div class="lim"><div class="lim-h"><b>${esc(l.title)}</b><span>${l.pct}% usado</span></div>
      <div class="bar"><i style="width:${Math.min(100, l.pct)}%" class="${l.pct >= 90 ? 'hot' : l.pct >= 70 ? 'warm' : ''}"></i></div>
      <div class="note">${esc(l.resets)}</div></div>`
        )
        .join('')
    : '';
  const status = st.claudeError
    ? `<p class="err">${esc(st.claudeError)}</p>`
    : !c
      ? `<p>${st.claudeLoading ? 'Abriendo /usage en una consola aparte… (la primera vez tarda unos segundos)' : 'Sin datos todavía.'}</p>`
      : `${bars}${c.detail ? `<details><summary>Qué está consumiendo (según Claude)</summary><pre class="term">${esc(c.detail)}</pre></details>` : ''}
       <div class="note">Leído ${fmtTime(c.at)} · consola: tmux attach -t ${esc(st.config.session || 'office')}:_status</div>`;
  // 3 · Tu cuota semana a semana (lo más alto leído de /usage en cada semana; se arma solo mientras usas la oficina).
  const qh = st.config?.stats?.quotaHistory || [];
  const hist = qh.length
    ? `<div class="dlg-sec"><h4>Tu cuota semana a semana</h4><div class="qh">${qh
        .map((w, i) => {
          const end = new Date(w.end + 'T12:00:00');
          const cur = i === qh.length - 1;
          return `<div class="qh-c${cur ? ' cur' : ''}" title="Semana que termina el ${end.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })}: ${w.pct} % usado${cur ? ' (en curso)' : ''}"><span class="qh-v">${w.pct}%</span><i class="${w.pct >= 90 ? 'hot' : w.pct >= 70 ? 'warm' : ''}" style="height:${Math.max(3, Math.min(100, w.pct))}%"></i><small>${fmtDay(end)}</small></div>`;
        })
        .join(
          ''
        )}</div><p class="note">Lo más alto que marcó <code>/usage</code> en cada semana de tu cuota. La oficina lo relee cada hora mientras está abierta; no gasta tokens.</p></div>`
    : '';
  // 3 · Tiempo esperándote: los últimos 7 días, quién esperó más hoy y qué permisos hicieron esperar más.
  const { days: wd, today: wt } = waitDays(),
    wtop = Math.max(10 * 60e3, ...wd.map(w => w.total)),
    todayKey = new Date().toLocaleDateString('sv');
  const perms = {};
  for (const w of wd)
    for (const [p, v] of Object.entries(w.perms || {})) {
      const x = (perms[p] ||= { n: 0, ms: 0 });
      x.n += v.n;
      x.ms += v.ms;
    }
  const permRows = Object.entries(perms)
    .sort((x, y) => y[1].ms - x[1].ms)
    .slice(0, 5);
  const whoRows = Object.entries(wt?.by || {})
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5);
  const waitSec = wd.length
    ? `<div class="dlg-sec"><h4>Tiempo esperándote</h4>
      <div class="qh wq">${wd
        .map(w => {
          const dt = new Date(w.day + 'T12:00:00'),
            cur = w.day === todayKey,
            top = topWaiter(w);
          return `<div class="qh-c${cur ? ' cur' : ''}" title="${esc(dt.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }))}: ${fmtDur(w.total)} esperándote${top ? ` · el que más: ${esc(top[0])} (${fmtDur(top[1])})` : ''}"><span class="qh-v">${w.total ? esc(fmtDur(w.total)) : '–'}</span><i class="${w.total >= 3600e3 ? 'hot' : w.total >= 1200e3 ? 'warm' : ''}" style="height:${w.total ? Math.max(3, Math.round((w.total * 100) / wtop)) : 0}%"></i><small>${esc(dt.toLocaleDateString('es', { weekday: 'short', day: 'numeric' }))}</small></div>`;
        })
        .join('')}</div>
      ${
        whoRows.length
          ? `<p class="note"><b>Hoy:</b> ${whoRows.map(([n, ms]) => `${esc(n)} ${esc(fmtDur(ms))}`).join(' · ')}${
              wt
                ? ` — ${WAIT_KINDS.filter(([k]) => wt.kinds[k])
                    .map(([k, l]) => `${l} ${esc(fmtDur(wt.kinds[k]))}`)
                    .join(', ')}`
                : ''
            }</p>`
          : '<p class="note">Hoy ningún robot ha tenido que esperarte.</p>'
      }
      ${permRows.length ? `<table class="usage wperm"><thead><tr><th>Permisos que más hicieron esperar (7 días)</th><th>Veces</th><th>Espera</th><th></th></tr></thead><tbody>${permRows.map(([p, v]) => `<tr><td><code>${esc(p)}</code></td><td>${v.n}</td><td>${esc(fmtDur(v.ms))}</td><td><button type="button" class="btn sm" data-allow-perm="${esc(p)}" title="Muestra la regla de permissions.allow y, con un segundo clic, la agrega a .claude/settings.local.json de la carpeta de trabajo">Permitir siempre</button></td></tr>`).join('')}</tbody></table><p class="note">Si un permiso se repite y es seguro, puedes darlo fijo con «Permitir siempre»: se agrega a <code>permissions.allow</code> de <code>.claude/settings.local.json</code> del workspace y los robots dejan de esperarte por él.</p>` : ''}
      <p class="note">Cuenta desde que un robot pide permiso, te pregunta o termina su turno con una pregunta, hasta que le respondes. Lo calcula la oficina; no gasta tokens.</p></div>`
    : '';
  // 6 · Horas de trabajo: a qué hora del día trabajan los robots y a qué hora te esperan (últimos 14 días). Se apaga aquí.
  const hr = st.config?.stats?.hours;
  const hoursSec = hr
    ? (() => {
        const tog = `<label class="check"><input type="checkbox" id="hours-on"${hr.on ? ' checked' : ''}> Registrar las horas de trabajo</label>`;
        if (!hr.on)
          return `<div class="dlg-sec"><div class="row between"><h4>Horas de trabajo</h4>${tog}</div><p class="note">Apagado: la oficina no anota a qué hora trabajan los robots. Actívalo para ver la gráfica.</p></div>`;
        const top = Math.max(1, ...hr.w.map((w, h) => w + hr.i[h])),
          sum = hr.w.reduce((a, b) => a + b, 0) + hr.i.reduce((a, b) => a + b, 0);
        const peak = arr => {
            const m = Math.max(...arr);
            return m ? arr.indexOf(m) : -1;
          },
          pw = peak(hr.w),
          pi = peak(hr.i);
        const hh = h => `${h}–${h + 1} h`;
        const cols = hr.w
          .map((w, h) => {
            const i = hr.i[h];
            return `<div class="hr-c${new Date().getHours() === h ? ' cur' : ''}" title="${hh(h)}: ${Math.round((w / 60) * 10) / 10} h-robot trabajando y ${Math.round((i / 60) * 10) / 10} h-robot esperándote (${hr.days} día${hr.days === 1 ? '' : 's'})"><i class="hw" style="height:${(w * 100) / top}%"></i><i class="hi" style="height:${(i * 100) / top}%"></i>${h % 3 === 0 ? `<small>${h}</small>` : ''}</div>`;
          })
          .join('');
        return `<div class="dlg-sec"><div class="row between"><h4>Horas de trabajo</h4>${tog}</div>
      ${sum ? `<div class="hr-chart">${cols}</div><p class="note"><span class="hr-k hw"></span> trabajando · <span class="hr-k hi"></span> esperándote · ${hr.days} día${hr.days === 1 ? '' : 's'}${pw >= 0 ? ` · más trabajo: <b>${hh(pw)}</b>` : ''}${pi >= 0 ? ` · más te esperan: <b>${hh(pi)}</b>` : ''}. Lo anota la oficina cada minuto; no gasta tokens.</p>` : '<p class="note">Todavía no hay datos: se anotan cada minuto mientras haya robots en la oficina.</p>'}</div>`;
      })()
    : '';
  const rows = st.weeks
    .map(
      (
        w,
        i
      ) => `<tr${i === 0 ? ' class="cur"' : ''}><td>${i === 0 ? 'Esta semana' : 'Semana del ' + weekLabel(w.week)}</td><td>${w.sessions}</td>
      <td>${w.out.toLocaleString('es')}</td><td>${w.in.toLocaleString('es')}</td><td>${w.cacheRead.toLocaleString('es')}</td><td>${w.cacheWrite.toLocaleString('es')}</td></tr>`
    )
    .join('');
  return `<div class="dlg-head"><h3>Uso y estado de Claude</h3><p>Los límites de tu suscripción salen de <code>/usage</code>; los tokens, de las sesiones que lanzó la oficina (incluidos sus subagentes).</p></div>
    <div class="dlg-sec">
      <div class="row between"><h4>Límites de tu suscripción</h4><button class="btn sm" data-usage="refresh" ${st.claudeLoading ? 'disabled' : ''}>${st.claudeLoading ? 'Leyendo…' : 'Actualizar'}</button></div>
      ${status}
    </div>
    ${waitSec}
    ${hoursSec}
    ${hist}
    <div class="dlg-sec">
      <h4>Tokens de la oficina por semana</h4>
      ${rows ? `<div class="tablewrap"><table class="usage"><thead><tr><th>Semana (lun–dom)</th><th>Robots</th><th>Salida</th><th>Entrada</th><th>Caché leída</th><th>Caché escrita</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Todavía no hay sesiones registradas.</p>'}
    </div>`;
}
onClick('[data-usage=refresh]', () => loadClaudeStatus(true));
// «Permitir siempre»: the first click asks the daemon for the rule and shows it on the button; the second one adds it.
onClick('[data-allow-perm]', async b => {
  const key = b.dataset.allowPerm;
  try {
    if (b.classList.contains('armed')) {
      clearTimeout(b._t);
      b.disabled = true;
      const r = await api('POST', '/api/permitir-siempre', { key, apply: true });
      b.textContent = r.added ? '✓ Agregada' : '✓ Ya estaba';
      b.classList.remove('armed');
      toast(r.added ? `Regla ${r.rule} agregada a ${r.file}` : `La regla ${r.rule} ya estaba en ${r.file}`);
      return;
    }
    const r = await api('POST', '/api/permitir-siempre', { key });
    b.title = `Se agregará a ${r.file}`;
    armed(b, `Agregar ${r.rule}`, 8000, 'Permitir siempre');
  } catch {
    b.disabled = false; // api() already showed the error
  }
});
PANEL.addEventListener('change', e => {
  if (e.target.id === 'hours-on')
    api('POST', '/api/config', { hoursOn: e.target.checked })
      .then(c => {
        st.config = c;
        renderPanel();
      })
      .catch(() => {});
});
loadWeeks();
setInterval(loadWeeks, 60000);
