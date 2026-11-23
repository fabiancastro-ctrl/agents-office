/* ---------- menú «🎛 Vista» ---------- */
// Los botones de cómo se ve la oficina (estilo, tema, tamaño del texto, contraste, HD, 2.5D, compacta, avisos y sonido)
// viven en un menú: la barra queda en una fila con lo que se usa a diario. Cada botón conserva su id y su lógica.
const vistaBtn = $('#btn-vista'),
  vistaMenu = $('#vista-menu');
function toggleVista(open = vistaMenu.hidden) {
  vistaMenu.hidden = !open;
  vistaBtn.setAttribute('aria-expanded', String(open));
  vistaBtn.classList.toggle('on', open);
  if (open) (vistaMenu.querySelector('select, button') || vistaBtn).focus();
}
vistaBtn.addEventListener('click', e => {
  e.stopPropagation();
  toggleVista();
});
document.addEventListener('click', e => {
  if (!vistaMenu.hidden && !e.target.closest('.vista-wrap')) toggleVista(false);
});
vistaMenu.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    toggleVista(false);
    vistaBtn.focus();
  }
});
