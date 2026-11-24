/* ---------- Claude accounts: «Cuentas» in ⚙ Ajustes, the coffee-pot menu and «Sin cuota» actions ---------- */
// The panel lists every account (session, weekly quota, links), adds one (the daemon opens `claude auth login` in a tmux
// window and this page polls until the session shows up), renames and unregisters. The policy select says what a robot
// does when its account runs out of quota. The coffee pot opens a small menu to pick the active account.
const CUENTAS = $('#vm-cuentas');
const cuentasUi = {
  rows: null,
  policy: 'wait',
  active: 'principal',
  adding: false,
  hint: {},
  loading: false,
  watch: new Map(),
  rename: null
};
const POLICY_LABEL = {
  switch: 'Pasar solo a otra cuenta',
  ask: 'Preguntarme',
  wait: 'Esperar la renovación'
};

async function loadCuentas(fresh = false) {
  if (cuentasUi.loading) return;
  cuentasUi.loading = true;
  try {
    const res = await fetch(`/api/cuentas${fresh ? '?fresh=1' : ''}`);
    const data = await res.json();
    if (res.ok) {
      cuentasUi.rows = data.cuentas;
      cuentasUi.policy = data.policy;
      cuentasUi.active = data.active;
    }
  } catch {
    /* the panel keeps what it had */
  }
  cuentasUi.loading = false;
  renderCuentas();
}
// What a session looks like: amber when nobody is logged in (never grey).
const sessionText = s =>
  s?.loggedIn
    ? `<span class="ac-ok">iniciada${s.orgName ? ` · ${esc(s.orgName)}` : ''}${s.subscriptionType ? ` · ${esc(s.subscriptionType)}` : ''}</span>`
    : `<span class="ac-warn">${s?.error ? esc(s.error) : 'sin iniciar'}</span>`;
function cuentaRow(a) {
  const pct = a.weekPct;
  const quota =
    pct == null
      ? '<span class="ac-dim">sin lectura</span>'
      : `<span class="ac-bar${pct >= 100 ? ' full' : pct >= 90 ? ' high' : ''}" title="Cuota semanal usada: ${pct} %"><i style="width:${Math.min(100, pct)}%"></i></span> ${pct} %`;
  const links = a.principal
    ? ''
    : ` · enlaces ${a.links.missing.length ? `<span class="ac-warn">faltan: ${esc(a.links.missing.join(', '))}</span>` : '<span class="ac-ok">OK</span>'}`;
  const isActive = cuentasUi.active === a.id;
  const renaming = cuentasUi.rename === a.id;
  return `<div class="ac-row${isActive ? ' active' : ''}" data-acc="${esc(a.id)}">
    <div class="ac-h">${
      renaming
        ? `<input class="ac-in" data-ac-name value="${esc(a.nombre)}" maxlength="40" aria-label="Nombre de la cuenta"><button type="button" class="btn sm primary" data-ac="rename-ok">Guardar</button><button type="button" class="btn sm" data-ac="rename-cancel">Cancelar</button>`
        : `<b>${esc(a.nombre)}</b>${isActive ? '<span class="ac-tag">activa</span>' : ''}${a.exhausted ? `<span class="ac-tag warn">${icon('hourglass')} sin cuota</span>` : ''}`
    }</div>
    <div class="ac-dir" title="Carpeta de configuración de esta cuenta (CLAUDE_CONFIG_DIR)">${esc(a.dir)}</div>
    <div class="ac-s">Sesión: ${sessionText(a.session)}${a.login ? ' · <span class="ac-warn">inicio en curso</span>' : ''}<br>Semana: ${quota}${links}</div>
    ${cuentasUi.hint[a.id] ? `<p class="ac-hint">${esc(cuentasUi.hint[a.id])}</p>` : ''}
    <div class="ac-acts">
      ${isActive ? '' : '<button type="button" class="btn sm" data-ac="active" title="Los lanzamientos «Por defecto» usan esta cuenta">Usar como activa</button>'}
      <button type="button" class="btn sm" data-ac="login">Volver a iniciar sesión</button>
      ${a.principal ? '' : '<button type="button" class="btn sm" data-ac="rename">Renombrar</button><button type="button" class="btn sm danger" data-ac="remove">Quitar del registro</button>'}
    </div>
  </div>`;
}
function renderCuentas() {
  if (!CUENTAS) return;
  // Do not redraw under the user's hands (typing a name, the open form): only when nothing is being edited.
  if (CUENTAS.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const rows = cuentasUi.rows;
  const policy = hasAccounts()
    ? `<div class="vm-row"><span>Si una cuenta se queda sin cuota</span><select id="limit-policy" aria-label="Si una cuenta se queda sin cuota" title="Qué hace un robot cuando su cuenta se agota. Pasar solo: reabre su misma sesión en la cuenta con más cuota libre.">${Object.entries(
        POLICY_LABEL
      )
        .map(([k, l]) => `<option value="${k}"${cuentasUi.policy === k ? ' selected' : ''}>${l}</option>`)
        .join('')}</select></div>`
    : '<p class="vm-note">Con una sola cuenta, un robot sin cuota espera a la renovación. Agrega otra para que pueda seguir allí.</p>';
  const form = cuentasUi.adding
    ? `<form class="ac-form" data-ac-form>
        <label>Id <input class="ac-in" name="id" required maxlength="20" placeholder="b" autocomplete="off" title="Minúsculas, números y guiones"></label>
        <label>Nombre <input class="ac-in" name="nombre" maxlength="40" placeholder="Dropi nueva" autocomplete="off"></label>
        <details><summary>Avanzado</summary><label>Carpeta <input class="ac-in" name="dir" placeholder="~/.claude-<id> (por defecto)" autocomplete="off"></label></details>
        <div class="row"><button class="btn primary sm">Agregar y abrir el inicio de sesión</button><button type="button" class="btn sm" data-ac="add-cancel">Cancelar</button></div>
      </form>`
    : '<button type="button" class="btn sm" data-ac="add">Agregar cuenta</button>';
  CUENTAS.innerHTML = `${rows ? rows.map(cuentaRow).join('') : skeleton(3)}${policy}${form}`;
}
function cuentasConfigChanged() {
  if (vistaMenu && !vistaMenu.hidden) loadCuentas();
}
// Open the panel with fresh data every time.
new MutationObserver(() => {
  if (!vistaMenu.hidden) loadCuentas();
}).observe(vistaMenu, { attributes: true, attributeFilter: ['hidden'] });

// Polls the session of an account whose login window is open until it shows up (or the window disappears).
function watchLogin(id) {
  if (cuentasUi.watch.has(id)) return;
  const started = Date.now();
  const t = setInterval(async () => {
    try {
      const { session, login } = await (await fetch(`/api/cuentas/${encodeURIComponent(id)}/sesion`)).json();
      if (session?.loggedIn) {
        stopWatch(id);
        delete cuentasUi.hint[id];
        toast(`Sesión iniciada en ${accountLabel(id)}`);
        loadCuentas(true);
      } else if (!login || Date.now() - started > 10 * 60e3) {
        stopWatch(id);
        cuentasUi.hint[id] = 'La ventana del inicio de sesión se cerró sin iniciar sesión. Usa «Volver a iniciar sesión».';
        loadCuentas(true);
      }
    } catch {
      /* the next poll tries again */
    }
  }, 4000);
  cuentasUi.watch.set(id, t);
}
function stopWatch(id) {
  clearInterval(cuentasUi.watch.get(id));
  cuentasUi.watch.delete(id);
}
const loginHint = id =>
  `Autoriza en el navegador que se abrió (si no se abrió, mira la consola _login-${id}: tmux attach -t ${st.config?.session || 'office'}:_login-${id}).`;

CUENTAS?.addEventListener('submit', async e => {
  const f = e.target.closest('[data-ac-form]');
  if (!f) return;
  e.preventDefault();
  const v = n => f.elements[n].value.trim();
  const id = v('id').toLowerCase();
  try {
    const out = await api('POST', '/api/cuentas', { id, nombre: v('nombre'), dir: v('dir') || undefined });
    cuentasUi.adding = false;
    cuentasUi.hint[id] = out.loginError ? `No se pudo abrir el inicio de sesión: ${out.loginError}` : loginHint(id);
    if (!out.loginError) watchLogin(id);
    await loadCuentas(true);
  } catch {
    /* toast already shown */
  }
});
CUENTAS?.addEventListener('change', async e => {
  if (e.target.id !== 'limit-policy') return;
  try {
    await api('POST', '/api/config', { limitPolicy: e.target.value });
    cuentasUi.policy = e.target.value;
    toast(`Si una cuenta se queda sin cuota: ${POLICY_LABEL[e.target.value].toLowerCase()}`);
  } catch {
    loadCuentas();
  }
});
CUENTAS?.addEventListener('click', async e => {
  const b = e.target.closest('[data-ac]');
  if (!b) return;
  const row = b.closest('[data-acc]');
  const id = row?.dataset.acc;
  const act = b.dataset.ac;
  try {
    if (act === 'add') {
      cuentasUi.adding = true;
      renderCuentas();
      CUENTAS.querySelector('[name=id]')?.focus();
    } else if (act === 'add-cancel') {
      cuentasUi.adding = false;
      renderCuentas();
    } else if (act === 'login') {
      await api('POST', `/api/cuentas/${encodeURIComponent(id)}/login`);
      cuentasUi.hint[id] = loginHint(id);
      watchLogin(id);
      await loadCuentas(true);
    } else if (act === 'active') {
      await api('POST', '/api/cuenta-activa', { id });
      cuentasUi.active = id;
      renderCuentas();
    } else if (act === 'rename') {
      cuentasUi.rename = id;
      renderCuentas();
      CUENTAS.querySelector('[data-ac-name]')?.select();
    } else if (act === 'rename-cancel') {
      cuentasUi.rename = null;
      renderCuentas();
    } else if (act === 'rename-ok') {
      const nombre = row.querySelector('[data-ac-name]').value;
      cuentasUi.rename = null;
      await api('POST', `/api/cuentas/${encodeURIComponent(id)}/renombrar`, { nombre });
      await loadCuentas();
    } else if (act === 'remove') {
      if (!armed(b, '¿Quitar? Clic otra vez', 3000, 'Quitar del registro')) return;
      stopWatch(id);
      await api('DELETE', `/api/cuentas/${encodeURIComponent(id)}`);
      toast('Cuenta quitada del registro (su carpeta no se tocó)');
      await loadCuentas();
    }
  } catch {
    /* toast already shown */
  }
});
CUENTAS?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('[data-ac-name]')) {
    e.preventDefault();
    e.target.closest('[data-acc]').querySelector('[data-ac=rename-ok]').click();
  } else if (e.key === 'Escape' && e.target.matches('[data-ac-name]')) {
    e.stopPropagation();
    cuentasUi.rename = null;
    renderCuentas();
  }
});

/* ---------- «Sin cuota»: Seguir en <cuenta> / Esperar (card and window) ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-limit]');
  if (!b) return;
  e.stopPropagation();
  b.disabled = true;
  try {
    await api('POST', `/api/robots/${b.dataset.limitRobot}/limite`, { action: b.dataset.limit, account: b.dataset.limitAccount });
  } catch {
    b.disabled = false;
  }
});
