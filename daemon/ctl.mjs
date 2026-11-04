#!/usr/bin/env node
// Control del daemon desde la terminal (alternativa a la oficina web).

const [cmd, arg, ...rest] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${process.env.OFFICE_PORT || 4777}`;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  console.log(text || `${res.status}`);
}

const USAGE = `Uso:
  node daemon/ctl.mjs skill <skill> "<argumentos>"     (ej. skill review-deep "BFF/bff-integrator origin/production origin/rama --dry-run")
  node daemon/ctl.mjs libre "<tarea>"
  node daemon/ctl.mjs say <robot> "<mensaje>"
  node daemon/ctl.mjs approve <robot> | reject <robot>  (permiso pedido en su consola)
  node daemon/ctl.mjs pane <robot>
  node daemon/ctl.mjs kill <robot>`;

switch (cmd) {
  case 'skill': await call('POST', '/api/robots', { kind: 'skill', skill: arg, args: rest.join(' '), origin: 'Lanzado desde la terminal (ctl.mjs)' }); break;
  case 'libre': await call('POST', '/api/robots', { kind: 'libre', text: [arg, ...rest].join(' '), origin: 'Lanzado desde la terminal (ctl.mjs)' }); break;
  case 'say': await call('POST', `/api/robots/${arg}/say`, { text: rest.join(' ') }); break;
  case 'approve': await call('POST', `/api/robots/${arg}/permission`, { decision: 'approve' }); break;
  case 'reject': await call('POST', `/api/robots/${arg}/permission`, { decision: 'reject' }); break;
  case 'pane': {
    const res = await fetch(`${BASE}/api/robots/${arg}/pane`);
    console.log((await res.json()).text ?? '');
    break;
  }
  case 'kill': await call('DELETE', `/api/robots/${arg}`); break;
  default: console.log(USAGE);
}
