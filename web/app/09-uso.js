/* ---------- uso y estado de Claude ---------- */
const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
const weekLabel = w => new Date(w + 'T00:00:00').toLocaleDateString('es', {day: 'numeric', month: 'short'});
const tokLine = w => `salida ${fmtTok(w.out)} · entrada ${fmtTok(w.in)} · caché leída ${fmtTok(w.cacheRead)} · caché escrita ${fmtTok(w.cacheWrite)}`;

async function loadWeeks() {
  try { st.weeks = (await (await fetch('/api/usage')).json()).weeks || []; } catch { return; }
  const cur = st.weeks[0];
  $('#week-chip').textContent = cur ? `semana · ${tokLine(cur)}` : 'semana · sin uso';
  scheduleCards();
  if (st.selected === '@usage') schedulePanel();
}
async function loadClaudeStatus(refresh) {
  st.claudeLoading = true; st.claudeError = '';
  if (st.selected === '@usage') renderPanel();
  try {
    const res = await fetch('/api/claude-status' + (refresh ? '?refresh=1' : ''));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    st.claude = data;
  } catch (e) { st.claudeError = e.message || 'No se pudo leer /usage.'; }
  st.claudeLoading = false;
  scheduleCards();
  if (st.selected === '@usage') renderPanel();
}

function usagePanel() {
  const c = st.claude;
  const bars = c ? c.limits.map(l => `<div class="lim"><div class="lim-h"><b>${esc(l.title)}</b><span>${l.pct}% usado</span></div>
      <div class="bar"><i style="width:${Math.min(100, l.pct)}%" class="${l.pct >= 90 ? 'hot' : l.pct >= 70 ? 'warm' : ''}"></i></div>
      <div class="note">${esc(l.resets)}</div></div>`).join('') : '';
  const status = st.claudeError ? `<p class="err">${esc(st.claudeError)}</p>`
    : !c ? `<p>${st.claudeLoading ? 'Abriendo /usage en una consola aparte… (la primera vez tarda unos segundos)' : 'Sin datos todavía.'}</p>`
    : `${bars}${c.detail ? `<details><summary>Qué está consumiendo (según Claude)</summary><pre class="term">${esc(c.detail)}</pre></details>` : ''}
       <div class="note">Leído ${new Date(c.at).toLocaleTimeString('es', {hour: '2-digit', minute: '2-digit'})} · consola: tmux attach -t ${esc(st.config.session || 'office')}:_status</div>`;
  const rows = st.weeks.map((w, i) => `<tr${i === 0 ? ' class="cur"' : ''}><td>${i === 0 ? 'Esta semana' : 'Semana del ' + weekLabel(w.week)}</td><td>${w.sessions}</td>
      <td>${w.out.toLocaleString('es')}</td><td>${w.in.toLocaleString('es')}</td><td>${w.cacheRead.toLocaleString('es')}</td><td>${w.cacheWrite.toLocaleString('es')}</td></tr>`).join('');
  return `<div class="dlg-head"><h3>Uso y estado de Claude</h3><p>Los límites de tu suscripción salen de <code>/usage</code>; los tokens, de las sesiones que lanzó la oficina (incluidos sus subagentes).</p></div>
    <div class="dlg-sec">
      <div class="row between"><h4>Límites de tu suscripción</h4><button class="btn sm" data-usage="refresh" ${st.claudeLoading ? 'disabled' : ''}>${st.claudeLoading ? 'Leyendo…' : 'Actualizar'}</button></div>
      ${status}
    </div>
    <div class="dlg-sec">
      <h4>Tokens de la oficina por semana</h4>
      ${rows ? `<div class="tablewrap"><table class="usage"><thead><tr><th>Semana (lun–dom)</th><th>Robots</th><th>Salida</th><th>Entrada</th><th>Caché leída</th><th>Caché escrita</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Todavía no hay sesiones registradas.</p>'}
    </div>`;
}
PANEL.addEventListener('click', e => { if (e.target.closest('[data-usage=refresh]')) loadClaudeStatus(true); });
loadWeeks();
setInterval(loadWeeks, 60000);

