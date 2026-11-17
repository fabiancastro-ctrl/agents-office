// Dibujo de los robots, compartido por la oficina (web/app.js) y el edificio (edificio/index.html).
// Script clásico: estas constantes quedan en el ámbito global y app.js las usa desde su IIFE.
// Los 8 primeros son los de siempre (la oficina reparte esos a los robots nuevos); los demás se eligen en «🎨 Apariencia».
const ROBOT_COLORS = ['#5fcbb9','#f3b74f','#ef8f7a','#7cb6f0','#b9d06a','#d99ad6','#9fd3f0','#f0c38f',
  '#a99cf2','#ef7f8a','#6fd08c','#5b8def','#e0b43c','#e9e4d8','#8a96aa','#ff9f4a'];
const COLOR_NAMES = ['Menta', 'Ámbar', 'Coral', 'Celeste', 'Lima', 'Orquídea', 'Cielo', 'Durazno', 'Lavanda', 'Rubí', 'Hoja', 'Cobalto', 'Oro', 'Perla', 'Acero', 'Naranja'];
// Aspecto por nombre: antena, visor y accesorio salen de un hash del nombre (cada robot siempre se ve igual),
// salvo que le elijas otro (d.look). Los de una rutina o sala llevan pañoleta del color de su sala; el uniforme
// depende de su trabajo (outfitOf) y el gorro de la temporada sale solo según la fecha (seasonNow).
function lookOf(name, place, d) {
  let h = 7;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const o = d?.look || {}, pick = (v, n, def) => Number.isInteger(v) ? ((v % n) + n) % n : def;
  // Por nombre salen de las opciones originales (4 antenas, 3 visores, 4 accesorios): así nadie cambia de cara al
  // sumar opciones. Las nuevas solo aparecen si se las eliges.
  return {ant: pick(o.ant, ANTENNAS.length, h % 4), visor: pick(o.visor, VISORS.length, (h >>> 3) % 3), acc: pick(o.acc, HEAD_ACC.length, (h >>> 6) % 4),
    uniform: place?.type === 'room' ? (place.sala ? '#ef8f7a' : '#a99cf2') : '', outfit: outfitOf(d, place), season: seasonNow(), crown: Number(d?.crown) || 0};
}
// Uniforme según el trabajo: inspector (reviews y auditorías), escritor (documentación) o casco (rutinas).
function outfitOf(d, place) {
  if (place?.type === 'room' && !place.sala) return 'hardhat';
  const sk = String(d?.skill || d?.request?.skill || '');
  if (/review|audit|security|inspect|scan|validat/i.test(sk)) return 'inspector';
  if (/doc|create-hu|overview|adr|spec|readme|write|redact/i.test(sk)) return 'writer';
  return '';
}
// Gorro de temporada: Navidad en diciembre, bruja la última semana de octubre y cono de fiesta en Año Nuevo.
function seasonNow(t = new Date()) {
  const q = typeof location !== 'undefined' && new URLSearchParams(location.search).get('temporada'); // ?temporada=santa para verlo antes
  if (q) return q;
  const m = t.getMonth(), day = t.getDate();
  if ((m === 11 && day === 31) || (m === 0 && day === 1)) return 'party';
  if (m === 11) return 'santa';
  if (m === 9 && day >= 24) return 'witch';
  return '';
}
const ANTENNAS = [
  `<line x1="20" y1="2" x2="20" y2="9" stroke="#8b98ad" stroke-width="2"/><circle class="ant" cx="20" cy="3" r="3" fill="#97a5ba"/>`,
  `<line x1="15" y1="3" x2="16" y2="9" stroke="#8b98ad" stroke-width="1.6"/><line x1="25" y1="3" x2="24" y2="9" stroke="#8b98ad" stroke-width="1.6"/><circle class="ant" cx="15" cy="3" r="2.2" fill="#97a5ba"/><circle class="ant" cx="25" cy="3" r="2.2" fill="#97a5ba"/>`,
  `<path d="M20 9q-3-1.5 0-3t0-3" stroke="#8b98ad" stroke-width="1.6" fill="none"/><circle class="ant" cx="20" cy="1.8" r="2.4" fill="#97a5ba"/>`,
  `<rect x="17" y="5" width="6" height="4" rx="1" fill="#8b98ad"/><rect class="ant" x="18.3" y="2.6" width="3.4" height="2.6" rx="1" fill="#97a5ba"/>`
];
const VISORS = [
  `<rect x="11" y="12" width="18" height="8" rx="3" fill="#0f141c"/><circle class="eye" cx="16" cy="16" r="1.9" fill="#bdf7ee"/><circle class="eye" cx="24" cy="16" r="1.9" fill="#bdf7ee"/>`,
  `<rect x="9.5" y="13" width="21" height="6" rx="3" fill="#0f141c"/><rect class="eye" x="13" y="15" width="5" height="2" rx="1" fill="#bdf7ee"/><rect class="eye" x="22" y="15" width="5" height="2" rx="1" fill="#bdf7ee"/>`,
  `<circle cx="15.5" cy="16" r="3.6" fill="#0f141c"/><circle cx="24.5" cy="16" r="3.6" fill="#0f141c"/><circle class="eye" cx="15.5" cy="16" r="1.8" fill="#bdf7ee"/><circle class="eye" cx="24.5" cy="16" r="1.8" fill="#bdf7ee"/>`,
  // Cíclope: una banda con un solo ojo grande
  `<rect x="10" y="12.5" width="20" height="7" rx="3.5" fill="#0f141c"/><circle class="eye" cx="20" cy="16" r="2.6" fill="#bdf7ee"/><circle cx="20" cy="16" r="1" fill="#0f141c" opacity=".55"/>`,
  // Gafas: dos cristales cuadrados con marco y puente
  `<rect x="10" y="12" width="8.5" height="8" rx="2.4" fill="#0f141c" stroke="#3a4558" stroke-width="1"/><rect x="21.5" y="12" width="8.5" height="8" rx="2.4" fill="#0f141c" stroke="#3a4558" stroke-width="1"/><rect x="18.5" y="15" width="3" height="1.4" fill="#3a4558"/><circle class="eye" cx="14.25" cy="16" r="1.7" fill="#bdf7ee"/><circle class="eye" cx="25.75" cy="16" r="1.7" fill="#bdf7ee"/>`,
  // Pantalla LED: los ojos son dos «^» encendidos
  `<rect x="9.5" y="11.5" width="21" height="9" rx="2" fill="#0f141c"/><path d="M11 13h18M11 19h18" stroke="#bdf7ee" stroke-opacity=".08" stroke-width=".6"/><path class="eye" d="M13.5 17.6l2.5-2.6 2.5 2.6M21.5 17.6l2.5-2.6 2.5 2.6" stroke="#bdf7ee" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
];
const VISOR_NAMES = ['Clásico', 'Banda', 'Ojos redondos', 'Cíclope', 'Gafas', 'Pantalla LED'];
// Accesorios: los de cabeza van aquí; los del cuerpo (corbatín, bufanda, corbata, insignia) en BODY_ACC.
const HEAD_ACC = [
  '',
  `<path d="M8.5 15q0-11 11.5-11t11.5 11" stroke="#2a3342" stroke-width="2" fill="none"/><rect x="5.6" y="12.5" width="4" height="7.5" rx="2" fill="#2a3342"/><rect x="30.4" y="12.5" width="4" height="7.5" rx="2" fill="#2a3342"/>`,
  `<path d="M8 10.5q0-6 12-6t12 6z" fill="#2a3342"/><rect x="19" y="8.6" width="16" height="2.4" rx="1.2" fill="#2a3342"/>`,
  '',
  // Flor en la cabeza
  `<g transform="translate(29.5 8.2)"><circle cx="0" cy="-2.1" r="1.7" fill="#ef8fb0"/><circle cx="2" cy="-.6" r="1.7" fill="#ef8fb0"/><circle cx="1.2" cy="1.7" r="1.7" fill="#ef8fb0"/><circle cx="-1.2" cy="1.7" r="1.7" fill="#ef8fb0"/><circle cx="-2" cy="-.6" r="1.7" fill="#ef8fb0"/><circle r="1.3" fill="#ffd36b"/></g>`,
  // Lazo
  `<g transform="translate(11 8.4)"><path d="M0 0l-4-2.6v5.2zM0 0l4-2.6v5.2z" fill="#ef7f8a" stroke="#c24b58" stroke-width=".5"/><circle r="1.2" fill="#c24b58"/></g>`,
  '',
  // Gorro de lana con pompón
  `<path d="M8 12.5q0-8.5 12-8.5t12 8.5z" fill="#5b8def"/><rect x="7.6" y="10.6" width="24.8" height="3" rx="1.4" fill="#3f6fc9"/><path d="M11 11.4v1.4M14 11.4v1.4M17 11.4v1.4M20 11.4v1.4M23 11.4v1.4M26 11.4v1.4M29 11.4v1.4" stroke="#2c56a8" stroke-width=".7"/><circle cx="20" cy="3.6" r="2.3" fill="#e9e4d8"/>`,
  '',
  ''
];
const ACC_NAMES = ['Nada', 'Audífonos', 'Gorra', 'Corbatín', 'Flor', 'Lazo', 'Bufanda', 'Gorro de lana', 'Corbata', 'Insignia'];
const BOWTIE = `<path d="M15 24.6l5 2-5 2zM25 24.6l-5 2 5 2z" fill="#ef7f8a"/><circle cx="20" cy="26.6" r="1.1" fill="#c24b58"/>`;
const BODY_ACC = {
  3: BOWTIE,
  // Bufanda con una punta colgando
  6: `<path d="M13 24.4h14a2 2 0 0 1 0 3.4H13a2 2 0 0 1 0-3.4z" fill="#ef7f8a"/><path d="M23.5 27.4h3.4l-.6 7h-2.6z" fill="#ef7f8a"/><path d="M23.6 33.2h2.6M23.8 31.4h2.4" stroke="#c24b58" stroke-width=".6"/><path d="M14 26.1h12" stroke="#c24b58" stroke-width=".5" opacity=".6"/>`,
  // Corbata
  8: `<path d="M18.6 25.6h2.8l-.5 1.8h-1.8z" fill="#2c56a8"/><path d="M19.1 27.4h1.8l1.3 7.4-2.2 2-2.2-2z" fill="#3f6fc9"/><path d="M19.5 29.6l1.4 1.4M19.3 32l1.6 1.6" stroke="#2c56a8" stroke-width=".55"/>`,
  // Insignia (estrella dorada en el pecho)
  9: `<path d="M26 28.2l.75 1.55 1.7.25-1.23 1.2.29 1.7-1.51-.8-1.51.8.29-1.7-1.23-1.2 1.7-.25z" fill="#e0b43c" stroke="#9a7a1f" stroke-width=".45"/>`
};
// Utilería que la hoja de estilos muestra según lo que hace el robot (clases t-* y st-* del robot).
const PROPS_BODY = `<g class="p p-paper"><rect x="12" y="29" width="16" height="11" rx="1" fill="#f4efe2"/><path d="M14.5 32h11M14.5 34.5h11M14.5 37h7" stroke="#9aa3b0" stroke-width=".8"/></g>
  <g class="p p-chars" font-family="monospace" font-size="5" fill="#5fcbb9"><text x="11" y="31">1</text><text x="19" y="29">0</text><text x="26" y="31">{</text></g>
  <g class="p p-waves" stroke="#5fcbb9" stroke-width="1.2" fill="none" stroke-linecap="round"><path d="M11 0q-3 3 0 6"/><path d="M29 0q3 3 0 6"/><path d="M7.5-2q-4.5 5 0 10"/><path d="M32.5-2q4.5 5 0 10"/></g>
  <g class="p p-think" fill="#e8edf4"><circle cx="31" cy="5" r="1.2"/><circle cx="34.5" cy="1.5" r="1.6"/><circle cx="38.5" cy="-2.5" r="2.1"/></g>`;
const PROPS_HAND = `<g class="p p-glass"><line x1="33.5" y1="38" x2="34.5" y2="40" stroke="#6b5340" stroke-width="1.8" stroke-linecap="round"/><circle cx="35.6" cy="42.6" r="3.1" fill="rgba(189,247,238,.25)" stroke="#cfe3f7" stroke-width="1.2"/></g>
    <g class="p p-pencil"><path d="M33.5 37.5l-3.5 6" stroke="#f3b74f" stroke-width="2" stroke-linecap="round"/><path d="M30 43.5l-.7 1.4" stroke="#2a2418" stroke-width="1.3"/></g>
    <g class="p p-baton"><line x1="33.5" y1="38" x2="33.5" y2="46" stroke="#e8edf4" stroke-width="1.2" stroke-linecap="round"/><circle cx="33.5" cy="46" r="1" fill="#f3b74f"/></g>
    <g class="p p-mug"><rect x="31" y="37" width="5" height="5" rx="1" fill="#e8edf4"/><path d="M36 38.2h1.1a1.4 1.4 0 010 2.8H36" stroke="#e8edf4" stroke-width=".9" fill="none"/><path d="M32.2 35.5q.6-1 0-2M34.4 35.5q.6-1 0-2" stroke="#97a5ba" stroke-width=".6" fill="none"/></g>`;
// Volumen: brillo arriba-izquierda, sombra abajo y contorno suave sobre cabeza, cuerpo, brazos y piernas.
const OUT = 'stroke="rgba(8,12,20,.45)" stroke-width=".9"';
const SHADE_HEAD = `<path d="M8 17.5h24V19a5 5 0 0 1-5 5H13a5 5 0 0 1-5-5z" fill="#0b1018" opacity=".22"/><rect x="10.5" y="9.4" width="11" height="2.1" rx="1.05" fill="#fff" opacity=".38"/><circle cx="28.6" cy="10.6" r=".9" fill="#fff" opacity=".35"/>`;
const SHADE_BODY = `<path d="M10 34h20v2a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4z" fill="#0b1018" opacity=".22"/><rect x="12" y="27.3" width="9" height="1.6" rx=".8" fill="#fff" opacity=".32"/>`;
const VISOR_GLARE = `<path d="M12.4 13.4h4.2" stroke="#fff" stroke-width=".9" stroke-linecap="round" opacity=".28"/>`;
// Expresiones (las muestra la hoja de estilos según el estado): feliz, pregunta y sudor.
const FACES = `<g class="f f-happy" stroke="#bdf7ee" stroke-width="1.5" fill="none" stroke-linecap="round"><path d="M13.6 17q1.9-2.6 3.8 0M22.6 17q1.9-2.6 3.8 0"/></g>
  <g class="f f-ask" font-family="Arial,sans-serif" font-weight="700" font-size="6.2" fill="#ffd27a" text-anchor="middle"><text x="15.5" y="18.3">?</text><text x="24.5" y="18.3">?</text></g>
  <g class="f f-sweat"><path d="M32.6 9.5q2.2 3.3 0 4.6q-2.2-1.3 0-4.6z" fill="#9fd3f0" stroke="#5c8fb3" stroke-width=".5"/></g>`;
const HATS = {
  santa: `<path d="M8.6 10.6Q11 2 22 1.6q9 .3 12.6 6.8L31.4 10.6z" fill="#d23b45" stroke="rgba(8,12,20,.45)" stroke-width=".8"/><rect x="7.6" y="8.8" width="25" height="3.4" rx="1.7" fill="#f4efe2"/><circle cx="35" cy="8.4" r="2.3" fill="#f4efe2"/>`,
  witch: `<ellipse cx="20" cy="9.6" rx="15" ry="2.4" fill="#3b2a55"/><path d="M12.6 9.4L19 -4.4l7.6 13.8z" fill="#4a3570" stroke="rgba(8,12,20,.45)" stroke-width=".8"/><rect x="13.4" y="6.6" width="13" height="2.2" fill="#f3b74f"/>`,
  party: `<path d="M14 10.2L20 -3l6 13.2z" fill="#a99cf2" stroke="rgba(8,12,20,.45)" stroke-width=".8"/><path d="M16.4 5l7.2 0M15 8l10 0" stroke="#ffd36b" stroke-width="1.2"/><circle cx="20" cy="-3.4" r="1.8" fill="#ef7f8a"/>`,
  hardhat: `<path d="M8.6 11.6q0-8.4 11.4-8.4t11.4 8.4z" fill="#f3c33b" stroke="rgba(8,12,20,.45)" stroke-width=".8"/><rect x="6.6" y="10.4" width="26.8" height="2.4" rx="1.2" fill="#e0ab21"/><rect x="18.8" y="3.6" width="2.4" height="7" rx="1" fill="#ffd96b"/>`,
  inspector: `<path d="M8.4 11.4q0-8.2 11.6-8.2t11.6 8.2z" fill="#8a6447" stroke="rgba(8,12,20,.45)" stroke-width=".8"/><path d="M10 7q10-5 20 0" stroke="#6b4b33" stroke-width=".9" fill="none"/><rect x="18" y="10.2" width="17" height="2.2" rx="1.1" fill="#6b4b33"/><circle cx="20" cy="3.6" r="1.2" fill="#6b4b33"/>`
};
// Lo que el uniforme lleva en la mano izquierda (siempre visible).
const OUTFIT_HAND = {
  inspector: `<g class="o-hand"><line x1="5.6" y1="38.5" x2="4.4" y2="41.4" stroke="#6b5340" stroke-width="1.6" stroke-linecap="round"/><circle cx="3.6" cy="43.6" r="2.7" fill="rgba(189,247,238,.3)" stroke="#cfe3f7" stroke-width="1.1"/></g>`,
  writer: `<g class="o-hand"><rect x="1.6" y="35.6" width="6.4" height="8.4" rx=".8" fill="#8a6447"/><rect x="2.4" y="37" width="4.8" height="6.4" fill="#f4efe2"/><rect x="3.4" y="35" width="2.8" height="1.4" rx=".4" fill="#97a5ba"/><path d="M3.2 39h3.2M3.2 40.6h3.2M3.2 42.2h2" stroke="#9aa3b0" stroke-width=".5"/></g>`,
  hardhat: `<g class="o-hand"><path d="M5.4 38.6l-2 5.4" stroke="#97a5ba" stroke-width="1.8" stroke-linecap="round"/><path d="M2.2 43.2a2 2 0 1 0 2.6 1.4" stroke="#97a5ba" stroke-width="1.4" fill="none"/></g>`
};
const BOLTS = `<circle cx="7.4" cy="16" r="2" fill="#8b98ad" ${OUT}/><circle cx="32.6" cy="16" r="2" fill="#8b98ad" ${OUT}/><circle cx="7" cy="15.5" r=".6" fill="#fff" opacity=".5"/><circle cx="32.2" cy="15.5" r=".6" fill="#fff" opacity=".5"/>`;
const VENTS = `<path d="M24.6 10.6h4M25.4 12h3.2" stroke="#0b1018" stroke-width=".7" stroke-linecap="round" opacity=".25"/>`;
const CHEST = `<rect x="14.4" y="29.4" width="11.2" height="6.2" rx="1.6" fill="#0f141c" opacity=".55"/><circle class="led l1" cx="17" cy="32.5" r=".95" fill="#5fcbb9"/><circle class="led l2" cx="20" cy="32.5" r=".95" fill="#f3b74f"/><circle class="led l3" cx="23" cy="32.5" r=".95" fill="#ef7f8a"/><rect x="10.4" y="36.6" width="19.2" height="1.3" fill="#0b1018" opacity=".22"/>`;
const leg = (cls, x) => `<g class="${cls}"><rect x="${x}" y="40" width="5" height="6" rx="2" fill="#56627a" ${OUT}/><rect class="hd" x="${x}" y="40" width="5" height="6" rx="2" fill="url(#hd-cyl)"/><rect x="${x + .6}" y="43.6" width="3.8" height="1.6" rx=".8" fill="#0b1018" opacity=".25"/><rect x="${x - 1}" y="45" width="7" height="3" rx="1.3" fill="#3b4252" ${OUT}/><rect class="hd" x="${x - .4}" y="45.4" width="5.4" height=".9" rx=".45" fill="#fff" opacity=".22"/></g>`;
const arm = (cls, x, color, extra = '') => `<g class="${cls}"><rect x="${x}" y="27" width="5" height="11" rx="2.5" fill="${color}" ${OUT}/><rect class="hd" x="${x}" y="27" width="5" height="11" rx="2.5" fill="url(#hd-cyl)"/><rect x="${x + .4}" y="33" width="4.2" height="4.6" rx="2" fill="#0b1018" opacity=".2"/><circle cx="${x + 2.5}" cy="28.4" r="2.1" fill="#8b98ad" ${OUT}/><circle cx="${x + 2.5}" cy="38.6" r="1.9" fill="#56627a" ${OUT}/>${cls === 'arm-l' ? `<rect x="${x + 1}" y="29.4" width="1.4" height="3.4" rx=".7" fill="#fff" opacity=".35"/>` : ''}${extra}</g>`;
// Modo HD (botón «HD» de la oficina): capas de volumen, cristal del visor, brillo de los ojos, reflejo del monitor
// y juntas. Siempre se dibujan pero la hoja de estilos solo las muestra con html.hd-on, así cambiar de modo no
// redibuja nada. Los degradados son grises sobre el color del robot: sirven para cualquier color y viven una sola vez
// en el documento (HD_DEFS).
// Forma del cristal de cada visor (para el modo HD: brillo y reflejo recortados a esa forma).
const VISOR_SHAPES = [
  '<rect x="11" y="12" width="18" height="8" rx="3"/>',
  '<rect x="9.5" y="13" width="21" height="6" rx="3"/>',
  '<circle cx="15.5" cy="16" r="3.6"/><circle cx="24.5" cy="16" r="3.6"/>',
  '<rect x="10" y="12.5" width="20" height="7" rx="3.5"/>',
  '<rect x="10" y="12" width="8.5" height="8" rx="2.4"/><rect x="21.5" y="12" width="8.5" height="8" rx="2.4"/>',
  '<rect x="9.5" y="11.5" width="21" height="9" rx="2"/>'
];
const HD_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="hd-vol" x1="0" y1="0" x2=".25" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".38" stop-color="#fff" stop-opacity="0"/><stop offset=".62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".42"/></linearGradient>
  <linearGradient id="hd-cyl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".3"/><stop offset=".32" stop-color="#fff" stop-opacity=".3"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></linearGradient>
  <linearGradient id="hd-glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".26"/><stop offset=".42" stop-color="#fff" stop-opacity=".04"/><stop offset=".43" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#5fcbb9" stop-opacity=".12"/></linearGradient>
  <radialGradient id="hd-glow"><stop offset="0" stop-color="#bdf7ee" stop-opacity=".75"/><stop offset="1" stop-color="#bdf7ee" stop-opacity="0"/></radialGradient>
  ${VISOR_SHAPES.map((sh, i) => `<clipPath id="hd-v${i}">${sh}</clipPath>`).join('\n  ')}
</defs></svg>`;
if (typeof document !== 'undefined') {
  const addDefs = () => { if (!document.getElementById('hd-vol')) document.body.insertAdjacentHTML('afterbegin', HD_DEFS); };
  if (document.body) addDefs(); else document.addEventListener('DOMContentLoaded', addDefs);
}
const EYES = [[16, 16, 24, 16], [15.5, 16, 24.5, 16], [15.5, 16, 24.5, 16], [20, 16, 20, 16], [14.25, 16, 25.75, 16], [16, 16, 24, 16]];
function hdHead(v) {
  const e = EYES[v] || EYES[0];
  const glass = (VISOR_SHAPES[v] || VISOR_SHAPES[0]).replace(/\/>/g, ' fill="url(#hd-glass)"/>');
  return `<g class="hd"><rect x="8" y="8" width="24" height="16" rx="5" fill="url(#hd-vol)"/>
    <path d="M31.2 11.4v8.6" stroke="#fff" stroke-opacity=".38" stroke-width=".7" stroke-linecap="round"/><path d="M8.8 21.4h22.4" stroke="#0b1018" stroke-opacity=".22" stroke-width=".45"/>
    <circle cx="10.3" cy="10.1" r=".5" fill="#0b1018" opacity=".4"/><circle cx="29.7" cy="22.1" r=".5" fill="#0b1018" opacity=".4"/>
    <circle cx="${e[0]}" cy="${e[1]}" r="3.4" fill="url(#hd-glow)"/><circle cx="${e[2]}" cy="${e[3]}" r="3.4" fill="url(#hd-glow)"/>
    ${glass}<g clip-path="url(#hd-v${v})"><rect class="hd-refl" x="6" y="11" width="3.2" height="10" fill="#9ff0e4" transform="skewX(-18)"/></g>
    <circle class="eye" cx="${e[0] - .7}" cy="${e[1] - .8}" r=".5" fill="#fff" opacity=".85"/><circle class="eye" cx="${e[2] - .7}" cy="${e[3] - .8}" r=".5" fill="#fff" opacity=".85"/></g>`;
}
const HD_BODY = `<g class="hd"><rect x="10" y="26" width="20" height="14" rx="4" fill="url(#hd-vol)"/><path d="M29.1 28.4v8.4" stroke="#fff" stroke-opacity=".32" stroke-width=".6" stroke-linecap="round"/>
  <path d="M10.6 31h3.4M26 31h3.4" stroke="#0b1018" stroke-opacity=".22" stroke-width=".45"/><circle cx="11.9" cy="38.3" r=".45" fill="#0b1018" opacity=".4"/><circle cx="28.1" cy="38.3" r=".45" fill="#0b1018" opacity=".4"/></g>`;
const HD_NECK = `<path class="hd" d="M17 24.1h6M17 25.5h6" stroke="#0b1018" stroke-opacity=".35" stroke-width=".5"/>`;
// Accesorio secreto del robot del mes (lo decide el daemon: d.crown). Corona dorada con un fuego en la punta del
// centro o, si además es el que más gastó esta semana, dos fuegos en las puntas de los lados. Le gana a cualquier gorro.
const flame = (x, y) => `<g class="flame" style="transform-origin:${x}px ${y}px"><path d="M${x} ${y - 7.5}q3.6 3.8 2.6 6q-.8 1.6-2.6 1.6t-2.6-1.6q-1-2.2 2.6-6z" fill="#ff7a2f" stroke="rgba(120,30,0,.35)" stroke-width=".4"/><path d="M${x} ${y - 4.6}q1.9 2.2 1.3 3.4q-.5.9-1.3.9t-1.3-.9q-.6-1.2 1.3-3.4z" fill="#ffd36b"/></g>`;
function crownSVG(n) {
  return `<g class="crown"><path d="M10 9.6V2.6l5 3.2 5-6.2 5 6.2 5-3.2v7z" fill="#f2c230" stroke="#9a6d10" stroke-width=".8" stroke-linejoin="round"/>
    <path d="M10.6 8.2h18.8" stroke="#ffe48a" stroke-width=".9" opacity=".8"/><circle cx="20" cy="6.6" r="1.4" fill="#ef4f5c"/><circle cx="14.6" cy="7.2" r="1" fill="#5fcbb9"/><circle cx="25.4" cy="7.2" r="1" fill="#5fcbb9"/>
    ${n >= 2 ? flame(10, 2.6) + flame(30, 2.6) : flame(20, -.4)}</g>`;
}
function hatOf(look) { return look.crown ? crownSVG(look.crown) : HATS[look.season] || HATS[look.outfit] || ''; }
function robotSVG(color, look = {ant: 0, visor: 0, acc: 0, uniform: ''}) {
  const u = look.uniform, hat = hatOf(look);
  return `<svg viewBox="0 0 40 48" aria-hidden="true">
    <g class="legs">${leg('leg-l', 13)}${leg('leg-r', 22)}</g>
    ${arm('arm-l', 4, color, OUTFIT_HAND[look.outfit] || '')}
    <rect x="16.5" y="22.6" width="7" height="4.4" rx="1.2" fill="#3a4558"/>${HD_NECK}
    <rect x="10" y="26" width="20" height="14" rx="4" fill="${color}" ${OUT}/>${SHADE_BODY}${HD_BODY}${CHEST}
    ${u ? `<path d="M10.5 26.4h19v3h-19z" fill="${u}"/><path d="M23.5 29l3.4 6-4.4-1.2z" fill="${u}"/>` : ''}
    ${BODY_ACC[look.acc] || ''}
    ${PROPS_BODY}
    ${arm('arm-r', 31, color, PROPS_HAND)}
    <g class="head">${hat ? '' : `<g class="antg">${ANTENNAS[look.ant]}</g>`}${BOLTS}<rect x="8" y="8" width="24" height="16" rx="5" fill="${color}" ${OUT}/>${SHADE_HEAD}${VENTS}${VISORS[look.visor]}${VISOR_GLARE}${hdHead(look.visor)}${FACES}${hat || HEAD_ACC[look.acc]}</g>
  </svg>`;
}

// Solo la cabeza (antena, visor y accesorio o gorro): avatar pequeño para el chat.
function robotHead(color, look = {ant: 0, visor: 0, acc: 0}) {
  const hat = hatOf(look);
  return `<svg class="rhead" viewBox="${look.crown ? '4 -9 32 35' : '4 -5 32 31'}" aria-hidden="true">${hat ? '' : ANTENNAS[look.ant]}${BOLTS}<rect x="8" y="8" width="24" height="16" rx="5" fill="${color}" ${OUT}/>${SHADE_HEAD}${VENTS}${VISORS[look.visor]}${VISOR_GLARE}${hdHead(look.visor)}${hat || HEAD_ACC[look.acc]}</svg>`;
}

// Título sugerido para un robot sin título: sale del encargo con reglas simples (sin preguntarle a Claude).
// «/review-deep https://github.com/DROPI-SAS/dropi-tools/pull/52» → «review-deep · dropi-tools#52»
// «revisa por qué falla el pipeline de dropi-atom» → «Revisa por qué falla el pipeline de dropi-atom»
function suggestTitle(req) {
  if (!req) return '';
  const src = req.kind === 'skill' ? String(req.args || '') : String(req.text || '');
  const refs = [];
  const add = x => { if (x && !refs.includes(x)) refs.push(x); };
  for (const m of src.matchAll(/(?:github\.com|bitbucket\.org)\/[\w.-]+\/([\w.-]+)\/(?:pull|pull-requests)\/(\d+)/gi)) add(`${m[1]}#${m[2]}`);
  for (const m of src.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g)) add(m[1]);
  if (!refs.length) for (const m of src.matchAll(/\bPR\s*#?\s*(\d{1,6})\b/gi)) add(`PR #${m[1]}`);
  const cut = (t, n) => t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…';
  if (req.kind === 'skill') {
    const target = refs[0] || (src.split(/\s+/).find(w => w && !w.startsWith('-') && !/^origin\//.test(w)) || '').replace(/\/$/, '').split('/').pop();
    return cut([req.skill, target].filter(Boolean).join(' · '), 60);
  }
  const lines = src.replace(/<[^>]+>/g, '\n').replace(/https?:\/\/\S+/g, ' ').split('\n').map(l => l.replace(/^\s*(#+|>|[-*+]|\d+\.)\s+/, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim());
  let t = lines.find(l => l.length > 2) || '';
  t = t.split(/(?<=[.!?])\s/)[0];
  t = t.replace(/^(hola|buenas|buenos días|oye|bueno|ok|dale|por favor|porfa)[,!.]?\s+/i, '')
       .replace(/^(me (puedes|podrías) ayudar (a|con) |ay[uú]dame (a|con) )/i, '').trim();
  if (!t) return refs.join(' · ');
  t = t[0].toUpperCase() + t.slice(1);
  const extra = refs.filter(r => !t.includes(r.replace(/^PR #/, ''))).join(' ');
  return cut(t, extra ? 58 - extra.length : 60) + (extra ? ` · ${extra}` : '');
}
