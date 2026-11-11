// Dibujo de los robots, compartido por la oficina (web/app.js) y el edificio (edificio/index.html).
// Script clásico: estas constantes quedan en el ámbito global y app.js las usa desde su IIFE.
const ROBOT_COLORS = ['#5fcbb9','#f3b74f','#ef8f7a','#7cb6f0','#b9d06a','#d99ad6','#9fd3f0','#f0c38f'];
// Aspecto por nombre: antena, visor y accesorio salen de un hash del nombre (cada robot siempre se ve igual).
// Los de una rutina o sala llevan pañoleta del color de su sala.
function lookOf(name, place) {
  let h = 7;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return {ant: h % 4, visor: (h >>> 3) % 3, acc: (h >>> 6) % 4, uniform: place?.type === 'room' ? (place.sala ? '#ef8f7a' : '#a99cf2') : ''};
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
  `<circle cx="15.5" cy="16" r="3.6" fill="#0f141c"/><circle cx="24.5" cy="16" r="3.6" fill="#0f141c"/><circle class="eye" cx="15.5" cy="16" r="1.8" fill="#bdf7ee"/><circle class="eye" cx="24.5" cy="16" r="1.8" fill="#bdf7ee"/>`
];
const HEAD_ACC = [
  '',
  `<path d="M8.5 15q0-11 11.5-11t11.5 11" stroke="#2a3342" stroke-width="2" fill="none"/><rect x="5.6" y="12.5" width="4" height="7.5" rx="2" fill="#2a3342"/><rect x="30.4" y="12.5" width="4" height="7.5" rx="2" fill="#2a3342"/>`,
  `<path d="M8 10.5q0-6 12-6t12 6z" fill="#2a3342"/><rect x="19" y="8.6" width="16" height="2.4" rx="1.2" fill="#2a3342"/>`,
  ''
];
const BOWTIE = `<path d="M15 24.6l5 2-5 2zM25 24.6l-5 2 5 2z" fill="#ef7f8a"/><circle cx="20" cy="26.6" r="1.1" fill="#c24b58"/>`;
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
function robotSVG(color, look = {ant: 0, visor: 0, acc: 0, uniform: ''}) {
  const u = look.uniform;
  return `<svg viewBox="0 0 40 48" aria-hidden="true">
    <g class="legs"><g class="leg-l"><rect x="13" y="40" width="5" height="7" rx="2" fill="#56627a" ${OUT}/><rect x="13.6" y="44.6" width="3.8" height="2" rx="1" fill="#0b1018" opacity=".25"/></g><g class="leg-r"><rect x="22" y="40" width="5" height="7" rx="2" fill="#56627a" ${OUT}/><rect x="22.6" y="44.6" width="3.8" height="2" rx="1" fill="#0b1018" opacity=".25"/></g></g>
    <g class="arm-l"><rect x="4" y="27" width="5" height="11" rx="2.5" fill="${color}" ${OUT}/><rect x="4.4" y="33" width="4.2" height="4.6" rx="2" fill="#0b1018" opacity=".2"/><rect x="5" y="28" width="1.4" height="4" rx=".7" fill="#fff" opacity=".35"/></g>
    <rect x="10" y="26" width="20" height="14" rx="4" fill="${color}" ${OUT}/>${SHADE_BODY}
    <rect x="15" y="30" width="10" height="5" rx="1.5" fill="#0f141c" opacity=".45"/>
    ${u ? `<path d="M10.5 26.4h19v3h-19z" fill="${u}"/><path d="M23.5 29l3.4 6-4.4-1.2z" fill="${u}"/>` : ''}
    ${look.acc === 3 ? BOWTIE : ''}
    ${PROPS_BODY}
    <g class="arm-r"><rect x="31" y="27" width="5" height="11" rx="2.5" fill="${color}" ${OUT}/><rect x="31.4" y="33" width="4.2" height="4.6" rx="2" fill="#0b1018" opacity=".2"/>${PROPS_HAND}</g>
    <g class="head">${ANTENNAS[look.ant]}<rect x="8" y="8" width="24" height="16" rx="5" fill="${color}" ${OUT}/>${SHADE_HEAD}${VISORS[look.visor]}${VISOR_GLARE}${FACES}${HEAD_ACC[look.acc]}</g>
  </svg>`;
}

// Solo la cabeza (antena, visor y accesorio): avatar pequeño para el chat.
function robotHead(color, look = {ant: 0, visor: 0, acc: 0}) {
  return `<svg class="rhead" viewBox="5 -1 30 27" aria-hidden="true">${ANTENNAS[look.ant]}<rect x="8" y="8" width="24" height="16" rx="5" fill="${color}" ${OUT}/>${SHADE_HEAD}${VISORS[look.visor]}${VISOR_GLARE}${HEAD_ACC[look.acc]}</svg>`;
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
