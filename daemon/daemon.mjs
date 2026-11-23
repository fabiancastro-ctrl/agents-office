#!/usr/bin/env node
// Daemon de la Oficina de Agentes (MVP local).
// - Lanza robots como ventanas tmux corriendo `claude` con la suscripcion del usuario.
// - Recibe los hooks de Claude Code y mantiene el estado de cada robot.
// - Sigue el transcript JSONL de cada robot (texto que dice, tokens, interrupciones).
// - Sirve la oficina (web/) y le empuja los cambios por Server-Sent Events.
// Sin dependencias: solo modulos de Node. El código vive en daemon/lib/, un módulo por tema; este archivo
// los carga en orden (el mismo de antes, así lo que corre al cargar ve lo que necesita) y arranca la oficina.

import { APPROVAL, boot, EVENTS_FILE, maxRobots, PORT, RUNS, SESSION, setWorkspace, WORKSPACE } from './lib/base.mjs';
import './lib/estado.mjs';
import { loadSessions } from './lib/uso.mjs';
import { initialWorkspace } from './lib/carpeta.mjs';
import { restore } from './lib/persistencia.mjs';
import { resumeResults } from './lib/equipo.mjs';
import './lib/turno.mjs';
import { migrateSummaries } from './lib/exportar.mjs';
import './lib/consola.mjs';
import './lib/transcript.mjs';
import './lib/hooks.mjs';
import './lib/relevo.mjs';
import './lib/adjuntos.mjs';
import { guardSession } from './lib/tmux.mjs';
import './lib/rutinas.mjs';
import './lib/salas.mjs';
import { server } from './lib/http.mjs';

boot();
await guardSession();
setWorkspace(initialWorkspace());
if (WORKSPACE) {
  loadSessions();
  await restore();
  resumeResults();
  migrateSummaries();
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Oficina de Agentes · http://127.0.0.1:${PORT}`);
  console.log(
    WORKSPACE ? `Carpeta de trabajo: ${WORKSPACE}` : `Primera ejecución: abre http://127.0.0.1:${PORT} para elegir la carpeta de trabajo`
  );
  console.log(`Sesión de tmux de los robots: ${SESSION} (tmux attach -t ${SESSION})`);
  console.log(`Tope de robots simultáneos: ${maxRobots}`);
  console.log(`Aprobaciones retenidas por el daemon: ${APPROVAL ? 'activas' : 'apagadas (OFFICE_APPROVAL=1)'}`);
  console.log(`Datos de la oficina: ${RUNS}`);
  console.log(`Eventos crudos: ${EVENTS_FILE}\n`);
});
