// Oficina de Agentes · adjuntos.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import fs from 'node:fs';
import path from 'node:path';
import { ATTACH_DIR, ATTACH_TTL_MS, WORKSPACE } from './base.mjs';

/* ---------- adjuntos ---------- */
// Se guardan dentro del workspace para que el robot los abra con Read; se borran a los 7 dias.

function validAttachments(list) {
  return (Array.isArray(list) ? list : [])
    .map(p => path.resolve(WORKSPACE, String(p)))
    .filter(p => p.startsWith(ATTACH_DIR + path.sep) && fs.existsSync(p));
}

function attachmentNote(list) {
  const files = validAttachments(list);
  if (!files.length) return '';
  return ` [Adjuntos: ${files.map(f => path.relative(WORKSPACE, f)).join(', ')} — ábrelos con la herramienta Read]`;
}

function cleanAttachments() {
  const walk = dir => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        try {
          if (!fs.readdirSync(p).length) fs.rmdirSync(p);
        } catch {
          /* en uso */
        }
      } else if (Date.now() - fs.statSync(p).mtimeMs > ATTACH_TTL_MS) {
        fs.unlinkSync(p);
      }
    }
  };
  walk(ATTACH_DIR);
}
cleanAttachments();
setInterval(cleanAttachments, 6 * 60 * 60 * 1000);

export { attachmentNote, validAttachments };
