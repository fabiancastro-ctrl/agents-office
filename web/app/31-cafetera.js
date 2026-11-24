/* ---------- coffee pot: the active account ---------- */
// The account that launches with «Por defecto» use. Clicking the pot opens it; «Volver a la principal» is the last item.
const coffeeMenu = { el: null };
function renderCoffeeMenu() {
  const el = coffeeMenu.el;
  const act = st.config.activeAccount || 'principal';
  const item = a => {
    const used = a.weekPct == null ? 'sin lectura' : `${a.weekPct} % semanal`;
    return `<button type="button" class="cm-i${a.id === act ? ' on' : ''}" role="menuitemradio" aria-checked="${a.id === act}" data-cm="${esc(a.id)}"><b>${esc(a.nombre)}</b><small>${used}</small></button>`;
  };
  el.innerHTML = `<h5>Cuenta activa</h5>${st.config.accounts.map(item).join('')}${
    act !== 'principal' ? '<button type="button" class="cm-i back" role="menuitem" data-cm="principal">Volver a la principal</button>' : ''
  }<p>Los lanzamientos «Por defecto» usan la activa. Los robots que ya trabajan no cambian.</p>`;
}
function closeCoffeeMenu() {
  if (coffeeMenu.el) coffeeMenu.el.hidden = true;
}
function openCoffeeMenu() {
  if (!hasAccounts()) return toast('Con una sola cuenta no hay nada que elegir. Agrega otra en ⚙ Ajustes › Cuentas.');
  if (!coffeeMenu.el) {
    coffeeMenu.el = document.createElement('div');
    coffeeMenu.el.className = 'coffee-menu';
    coffeeMenu.el.setAttribute('role', 'menu');
    coffeeMenu.el.setAttribute('aria-label', 'Cuenta activa');
    document.body.appendChild(coffeeMenu.el);
    coffeeMenu.el.addEventListener('click', async e => {
      const b = e.target.closest('[data-cm]');
      if (!b) return;
      try {
        await api('POST', '/api/cuenta-activa', { id: b.dataset.cm });
        st.config.activeAccount = b.dataset.cm;
        renderCoffee();
        toast(`Cuenta activa: ${accountLabel(b.dataset.cm)}`);
        closeCoffeeMenu();
      } catch {
        /* toast already shown */
      }
    });
    coffeeMenu.el.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeCoffeeMenu();
        $('#bcoffee').focus();
      }
    });
  }
  renderCoffeeMenu();
  const r = $('#bcoffee').getBoundingClientRect();
  coffeeMenu.el.hidden = false;
  const w = coffeeMenu.el.offsetWidth;
  coffeeMenu.el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  coffeeMenu.el.style.top = `${Math.min(r.bottom + 6, innerHeight - coffeeMenu.el.offsetHeight - 8)}px`;
  coffeeMenu.el.querySelector('.on, button')?.focus();
}
// A click on the pot does nothing else on the map, so it is free for this (there was no handler on it before).
$('#bcoffee').addEventListener('click', e => {
  e.stopPropagation();
  if (coffeeMenu.el && !coffeeMenu.el.hidden) closeCoffeeMenu();
  else openCoffeeMenu();
});
$('#bcoffee').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.stopPropagation();
    openCoffeeMenu();
  }
});
document.addEventListener('click', e => {
  if (coffeeMenu.el && !coffeeMenu.el.hidden && !e.target.closest('.coffee-menu')) closeCoffeeMenu();
});

// The registry or the active account changed (any office, the API, an automatic move): the open menu follows.
function cafeteraConfigChanged() {
  if (coffeeMenu.el && !coffeeMenu.el.hidden) renderCoffeeMenu();
}
