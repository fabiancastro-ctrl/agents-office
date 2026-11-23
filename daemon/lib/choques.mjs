import { robots } from './base.mjs';
import { real } from './cambios.mjs';

/* ---------- file clashes ----------
   Two live robots of this office that edited the same file. Computed from r.files (real paths, like «Cambios») and r.fileAt
   (when each file was last edited). Nothing is blocked: the page only warns. «Entendido» (r.clashAck) silences one
   robot + file until either robot edits that file again, because the signature includes every editor's last edit time. */

const realCache = new Map();
function realOf(p) {
  let v = realCache.get(p);
  if (v == null) {
    if (realCache.size > 5000) realCache.clear();
    v = real(p);
    realCache.set(p, v);
  }
  return v;
}

// real path → last edit time (ms) for one robot
function editMap(r) {
  const m = new Map();
  for (const f of r.files || []) m.set(realOf(f), r.fileAt?.[f] || 0);
  return m;
}

// Clashes of robot `r` that are not silenced: [{ file, with: [names] }]
function clashesOf(r) {
  if (robots.size < 2 || !r.files?.length) return [];
  const mine = editMap(r);
  const others = [...robots.values()].filter(o => o !== r && o.files?.length).map(o => [o, editMap(o)]);
  const out = [];
  for (const [file, at] of mine) {
    const peers = others.filter(([, m]) => m.has(file));
    if (!peers.length) continue;
    const sig = [`${r.name}:${at}`, ...peers.map(([o, m]) => `${o.name}:${m.get(file)}`)].sort().join('|');
    if (r.clashAck?.[file] === sig) continue;
    out.push({ file, with: peers.map(([o]) => o.name), sig });
  }
  return out;
}

// Silences the current clash of `r` on `file` (the real path sent by the page). Returns false when there is none.
function ackClash(r, file) {
  const sig = fullSig(r, file);
  if (!sig) return false;
  (r.clashAck ||= {})[file] = sig;
  return true;
}

// Signature of the clash on `file` ignoring any previous acknowledgement ('' when no other robot edited it).
function fullSig(r, file) {
  const mine = editMap(r);
  if (!mine.has(file)) return '';
  const peers = [...robots.values()].filter(o => o !== r && editMap(o).has(file));
  if (!peers.length) return '';
  return [`${r.name}:${mine.get(file)}`, ...peers.map(o => `${o.name}:${editMap(o).get(file)}`)].sort().join('|');
}

// Live robots that share a real path with `r` (to refresh their view when `r` edits a file).
function clashPeers(r) {
  const mine = new Set(editMap(r).keys());
  return [...robots.values()].filter(o => o !== r && [...editMap(o).keys()].some(f => mine.has(f)));
}

export { ackClash, clashesOf, clashPeers };
