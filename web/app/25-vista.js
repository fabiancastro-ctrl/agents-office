/* ---------- header menus: «☰ Más» and «⚙ Ajustes» ---------- */
// «☰ Más» holds what is used now and then (routines, end of day, pins, Claude usage, health); «⚙ Ajustes» is the
// settings panel (how the office looks, map options, alerts). Every button keeps its id and its logic; the V key opens
// Ajustes directly.
const moreBtn = $('#btn-more'),
  moreMenu = $('#more-menu'),
  vistaBtn = $('#btn-vista'),
  vistaMenu = $('#vista-menu');
function toggleMore(open = moreMenu.hidden) {
  if (open) toggleVista(false);
  moreMenu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
  moreBtn.classList.toggle('on', open);
  if (open) moreMenu.querySelector('button')?.focus();
}
function toggleVista(open = vistaMenu.hidden) {
  if (open && moreMenu && !moreMenu.hidden) toggleMore(false);
  vistaMenu.hidden = !open;
  vistaBtn.setAttribute('aria-expanded', String(open));
  moreBtn.classList.toggle('on', open || !moreMenu.hidden);
  if (open) (vistaMenu.querySelector('select, button') || moreBtn).focus();
}
moreBtn.addEventListener('click', e => {
  e.stopPropagation();
  toggleMore();
});
vistaBtn.addEventListener('click', e => {
  e.stopPropagation();
  toggleVista(true);
});
// Picking an item closes the menu (the item's own handler already ran).
moreMenu.addEventListener('click', e => {
  if (e.target.closest('button')) toggleMore(false);
});
document.addEventListener('click', e => {
  if (!e.target.closest('.more-wrap')) {
    if (!moreMenu.hidden) toggleMore(false);
    if (!vistaMenu.hidden) toggleVista(false);
  }
});
for (const menu of [moreMenu, vistaMenu])
  menu.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    toggleMore(false);
    toggleVista(false);
    moreBtn.focus();
  });
