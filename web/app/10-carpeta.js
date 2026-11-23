/* ---------- carpeta de trabajo ---------- */
// En la primera ejecución la oficina no sabe dónde trabajarán los robots: se pide aquí y se guarda en runs/config.json.
const needsSetup = () => !!st.setup && !st.setup.workspace;
function setSetup(setup) {
  st.setup = setup || null;
  const ws = st.setup?.workspace;
  $('#ws-chip').textContent = ws ? `carpeta · ${ws.split('/').pop()}` : 'sin carpeta de trabajo';
  $('#ws-chip').title = ws ? `Carpeta de trabajo: ${ws}. Clic para verla o cambiarla.` : 'Elige la carpeta de trabajo';
  if (needsSetup()) { st.wsDraft ??= st.setup.suggestion; select('@setup'); checkWorkspace(st.wsDraft); }
}
function onSetupSaved(m) {
  const first = needsSetup();
  st.setup = m.setup; setSetup(m.setup); setSkills(m.skills);
  st.wsInfo = null;
  if (st.selected === '@setup') select(null);
  toast(first ? 'Listo: la oficina ya trabaja en ' + m.setup.workspace : 'Carpeta de trabajo cambiada a ' + m.setup.workspace);
  loadWeeks();
}
async function checkWorkspace(p) {
  st.wsDraft = p;
  try { st.wsInfo = await api('POST', '/api/setup/check', {workspace: p}); } catch { st.wsInfo = null; }
  if (st.selected === '@setup') renderPanel();
}

function setupPanel() {
  const s = st.setup || {}, i = st.wsInfo, first = needsSetup();
  const draft = st.wsDraft ?? s.workspace ?? s.suggestion ?? '';
  const ok = (good, text) => `<li class="${good ? 'ok' : 'bad'}">${good ? '✓' : '✗'} ${text}</li>`;
  const note = text => `<li class="note-i">· ${text}</li>`;
  let checks = '';
  if (i) {
    checks = !i.exists ? ok(false, 'La carpeta no existe' + (first ? ' (marca «Crearla si no existe»)' : ''))
      : !i.isDir ? ok(false, 'Esa ruta es un archivo, no una carpeta')
      : i.insideOffice ? ok(false, 'Está dentro de la oficina: elige otra')
      : [ok(true, 'Carpeta encontrada'),
         note(i.claudeMd ? 'Tiene CLAUDE.md: los robots lo leerán' : 'Sin CLAUDE.md (opcional)'),
         note(i.projectSkills > 0 ? `${i.projectSkills} skills del proyecto (.claude/commands y .claude/skills)` : 'Sin skills del proyecto: estarán solo las tuyas de ~/.claude'),
         i.trusted ? ok(true, 'Claude Code ya confía en esta carpeta')
           : `<li class="warn">! Claude Code todavía no confía en esta carpeta: los robots se quedarían en esa pregunta. Ábrela una vez en la terminal, acepta y sal con <code>/exit</code>:<pre class="term">cd "${esc(i.path)}" && claude</pre></li>`].join('');
  }
  const locked = s.fromEnv ? 'La carpeta viene de la variable OFFICE_WORKSPACE: para cambiarla, cámbiala ahí y reinicia la oficina.'
    : !first && st.robots.size ? 'Para cambiarla, da de baja primero a los robots de la oficina.' : '';
  return `<div class="dlg-head"><h3>${first ? 'Elige la carpeta de trabajo' : 'Carpeta de trabajo'}</h3>
      <p>Los robots se abren en esta carpeta: ahí leen y escriben, dejan sus documentos y temporales, y de ahí salen las skills del proyecto (<code>.claude/commands</code>, <code>.claude/skills</code>) y su <code>CLAUDE.md</code>. Tus skills personales de <code>~/.claude</code> también están disponibles.</p></div>
    <form class="dlg-sec" id="setup-form">
      <div class="field"><label for="ws-path">Ruta de la carpeta</label>
        <div class="name-row"><input id="ws-path" value="${esc(draft)}" placeholder="/Users/tu-usuario/dropicode-Diagrams" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''}><button type="button" class="btn sm" data-setup="check" ${locked ? 'disabled' : ''}>Verificar</button></div>
      </div>
      ${checks ? `<ul class="checks">${checks}</ul>` : ''}
      ${locked ? `<p class="note">${esc(locked)}</p>` : ''}
      <div class="dlg-foot">
        <label class="chk"><input type="checkbox" id="ws-create" ${locked ? 'disabled' : ''}> Crearla si no existe</label>
        <button class="btn primary" ${locked ? 'disabled' : ''}>${first ? 'Empezar con esta carpeta' : 'Usar esta carpeta'}</button>
      </div>
    </form>`;
}
onClick('[data-setup=check]', () => checkWorkspace($('#ws-path').value));
PANEL.addEventListener('submit', async e => {
  if (e.target.id !== 'setup-form') return;
  e.preventDefault();
  st.wsDraft = $('#ws-path').value;
  try {
    const res = await api('POST', '/api/setup', {workspace: st.wsDraft, create: $('#ws-create').checked});
    if (res.info && !res.info.trusted) toast('Recuerda abrir claude una vez en esa carpeta para aceptar la confianza.');
  } catch { checkWorkspace(st.wsDraft); }
});
$('#ws-chip').addEventListener('click', () => { st.wsDraft = null; st.wsInfo = null; select('@setup'); checkWorkspace(st.setup?.workspace || ''); });

