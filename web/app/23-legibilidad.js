/* ---------- 6 · Legibilidad ---------- */
// Tamaño del texto (tarjetas, métricas, paneles y globos del mapa) y alto contraste. Son de este navegador: cada quien
// ve la oficina como le resulte cómoda, sin cambiarla para los demás. El mapa no se escala (sus medidas son el dibujo).
const FZ_STEPS = [1, 1.15, 1.3, 1.45];
const legib = {fz: 1, hc: false};
try { const f = Number(localStorage.getItem('office.fz')); if (FZ_STEPS.includes(f)) legib.fz = f; legib.hc = localStorage.getItem('office.hc') === '1'; } catch { /* sin almacenamiento: tamaño normal */ }
function applyLegib() {
  const root = document.documentElement;
  if (legib.fz === 1) { delete root.dataset.fz; root.style.removeProperty('--fz'); } else { root.dataset.fz = ''; root.style.setProperty('--fz', legib.fz); }
  root.classList.toggle('hc', legib.hc);
  $('#btn-fz').textContent = `Aa ${Math.round(legib.fz * 100)} %`;
  $('#btn-hc').textContent = legib.hc ? 'contraste alto' : 'contraste';
  $('#btn-hc').setAttribute('aria-pressed', String(legib.hc));
  $('#btn-hc').classList.toggle('on', legib.hc);
  if (typeof declutterBubbles === 'function') declutterBubbles(); // los globos cambian de tamaño: se reacomodan
}
$('#btn-fz').addEventListener('click', e => {
  const i = FZ_STEPS.indexOf(legib.fz), step = e.shiftKey ? -1 : 1; // Mayús + clic: más chico
  legib.fz = FZ_STEPS[(i + step + FZ_STEPS.length) % FZ_STEPS.length];
  try { localStorage.setItem('office.fz', String(legib.fz)); } catch { /* sin almacenamiento */ }
  applyLegib();
});
$('#btn-hc').addEventListener('click', () => {
  legib.hc = !legib.hc;
  try { localStorage.setItem('office.hc', legib.hc ? '1' : '0'); } catch { /* sin almacenamiento */ }
  applyLegib();
});
applyLegib();
