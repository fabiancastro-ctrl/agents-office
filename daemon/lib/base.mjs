// Oficina de Agentes · configuración, rutas, sesión de tmux y utilidades comunes.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..'); // este archivo vive en daemon/lib/
const WEB = path.join(ROOT, 'web');
// Carpeta donde trabajan los robots (y de donde salen las skills del proyecto). Se elige en la primera
// ejecución desde la página y se guarda en runs/config.json; OFFICE_WORKSPACE manda si está definida.
let WORKSPACE = null;
const setWorkspace = v => {
  WORKSPACE = v;
};
const PORT = Number(process.env.OFFICE_PORT || 4777);
// Sesión de tmux donde viven los robots. Cada oficina del mismo equipo necesita la suya (y su puerto),
// o se pisarían las ventanas de los robots y la consola de /usage.
const SESSION = process.env.OFFICE_SESSION || 'office';
// Carpeta de datos de ESTA oficina (estado, bandeja, rutinas, salas, eventos, adjuntos). El código es uno solo
// y cada oficina del edificio trae la suya: `office start <nombre>` la pasa en OFFICE_DATA. Sin ella, runs/ junto al código.
const RUNS = path.resolve(process.env.OFFICE_DATA || path.join(ROOT, 'runs'));
const LEGACY_RUNS = RUNS === path.join(ROOT, 'runs');
// Hooks de los robots: se generan en la carpeta de datos con la ruta real de hooks/office-hook.sh,
// así el código se puede mover o clonar sin editar rutas a mano.
const SETTINGS = path.join(RUNS, 'office-settings.json');
// Tope de robots trabajando a la vez: todos gastan de la misma cuota de la suscripcion.
// Se ajusta desde la oficina (− / +) y se guarda en office-state.json.
let maxRobots = Number(process.env.OFFICE_MAX_ROBOTS || 3);
const setMaxRobots = n => {
  maxRobots = n;
};
// Reemplaza el contenido de una lista compartida sin reasignarla (los demás módulos la tienen importada).
const replaceList = (list, items) => {
  list.splice(0, list.length, ...items);
  return list;
};
const MAX_ROBOTS_LIMIT = 20;
const APPROVAL = process.env.OFFICE_APPROVAL === '1';
const HOLD_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Nunca se responde "allow" a estos comandos aunque se aprueben. Los deny de settings
// igual ganan sobre el allow del hook (verificado en el paso 1); esta lista es una segunda barrera.
const NEVER_ALLOW = [/\brm\s+-[a-z]*r/i, /\bmv\s/, /\bgit\s+push\b/, /--force\b/, /--no-verify\b/, /\bgit\s+commit\b.*--amend\b/];
const APPROVAL_TIMEOUT_MS = 9 * 60 * 1000;
// Las preguntas (AskUserQuestion) tienen su propio hook de 8 h: puedes contestarlas cuando vuelvas, no en 9 minutos.
const ASK_HOOK_S = 8 * 60 * 60,
  ASK_TIMEOUT_MS = (ASK_HOOK_S - 120) * 1000;
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
const NAMES = ['rex', 'nova', 'bolt', 'atlas', 'pixel', 'kiro', 'lumo', 'zeta', 'orbi', 'juno', 'milo', 'vega', 'ciro', 'indi', 'brio'];
const ROUTINE_TICK_MS = Number(process.env.OFFICE_ROUTINE_TICK_MS) || 15000;
// El programa que abre cada robot. Las pruebas (test/) usan un Claude falso que no llama a nada ni gasta cuota.
const CLAUDE_BIN = process.env.OFFICE_CLAUDE_BIN || 'claude';
const TIMELINE_MAX = 600;
const ATTACH_DIR = path.join(RUNS, 'adjuntos');
const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
const ATTACH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const LOCK_FILE = path.join(RUNS, 'daemon.lock');
// Guarda JSON de forma atómica: escribe a `file.tmp` y lo renombra, así un corte a media escritura no deja el archivo cortado.
// { pretty } indenta con 2 espacios (como los archivos que se editan a mano); { eol } agrega el salto de línea final.
const toJson = (data, { pretty = false, eol = false } = {}) => JSON.stringify(data, null, pretty ? 2 : 0) + (eol ? '\n' : '');
function saveJson(file, data, opts) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, toJson(data, opts));
  fs.renameSync(tmp, file);
}
// Igual que saveJson pero sin bloquear el bucle de eventos: para archivos grandes (archivo de despedidos). El que llama decide si ignora el error.
// El temporal lleva un número propio: dos guardados seguidos del mismo archivo no deben escribir sobre el mismo temporal.
let tmpSeq = 0;
async function saveJsonAsync(file, data, opts) {
  const tmp = `${file}.${tmpSeq++}.tmp`;
  await fs.promises.writeFile(tmp, toJson(data, opts));
  await fs.promises.rename(tmp, file);
}

// Lo que el daemon hace al arrancar y que ningún otro módulo debe hacer al cargarse: revisar la sesión, preparar la
// carpeta de datos y los hooks de los robots, tomar el candado y escuchar señales. Lo llama daemon.mjs antes que nada;
// así los módulos se pueden importar sueltos (p. ej. en test/unit.test.mjs) sin tomar el candado ni salir del proceso.
function boot() {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(SESSION)) {
    console.error(`OFFICE_SESSION inválido: «${SESSION}». Usa solo letras, números, guion o guion bajo (sin puntos ni dos puntos).`);
    process.exit(1);
  }
  fs.mkdirSync(RUNS, { recursive: true });
  {
    const hook = { type: 'command', command: path.join(ROOT, 'hooks', 'office-hook.sh') };
    const ev = (timeout, matcher) => [{ ...(matcher ? { matcher } : {}), hooks: [{ ...hook, timeout }] }];
    // PreToolUse: el hook general (10 min, para los permisos retenidos) y uno solo para las preguntas, de 8 h.
    // Los dos le llegan al daemon con AskUserQuestion; el general se hace a un lado (ver onHook, via).
    const askHook = { type: 'command', command: `"${hook.command}" ask`, timeout: ASK_HOOK_S };
    const settings = {
      hooks: {
        SessionStart: ev(10),
        UserPromptSubmit: ev(10),
        PreToolUse: [...ev(600, '*'), { matcher: 'AskUserQuestion', hooks: [askHook] }],
        PostToolUse: ev(10, '*'),
        SubagentStop: ev(10),
        Notification: ev(10),
        Stop: ev(10)
      }
    };
    saveJson(SETTINGS, settings, { pretty: true, eol: true });
  }
  // Una copia de la carpeta = una oficina: dos daemons sobre el mismo runs/ se pisarían el estado y la bandeja.
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    let alive = false;
    try {
      process.kill(lock.pid, 0);
      alive = lock.pid !== process.pid;
    } catch {
      /* proceso muerto: candado viejo */
    }
    if (alive) {
      console.error(`Esta oficina ya está corriendo (pid ${lock.pid}, puerto ${lock.port}, datos en ${RUNS}).`);
      console.error('Para otra oficina usa el edificio: bin/office create <nombre> --workspace <carpeta> y bin/office start <nombre>.');
      process.exit(1);
    }
  } catch {
    /* sin candado */
  }
  saveJson(LOCK_FILE, { pid: process.pid, port: PORT, session: SESSION });
  // Al salir: suelta el candado y deja en el registro cómo terminó (señal, error o código). Si una oficina aparece
  // detenida y su registro no dice nada, la mataron sin aviso (kill -9, el sistema). Las conversaciones las guarda
  // persistencia.mjs con su propio aviso de salida.
  const hhmm = () => new Date().toTimeString().slice(0, 8);
  process.on('exit', code => {
    try {
      if (JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ya no está */
    }
    console.log(`${hhmm()} oficina detenida (código de salida ${code})`);
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(sig, () => {
      console.log(`${hhmm()} se detiene: recibió ${sig}`);
      process.exit(0);
    });
  // Un error que nadie atrapó la tumba igual que antes, pero con hora y detalle en el registro.
  process.on('uncaughtException', e => {
    console.error(`${hhmm()} se cayó por un error: ${e?.stack || e}`);
    process.exit(1);
  });
  process.on('unhandledRejection', e => {
    console.error(`${hhmm()} se cayó por un error (promesa): ${e?.stack || e}`);
    process.exit(1);
  });
}
const CONFIG_FILE = path.join(RUNS, 'config.json');
const EVENTS_FILE = path.join(RUNS, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);

const robots = new Map();
const pending = new Map();
const inbox = [];
const clients = new Set();
let colorSeq = 0;
const setColorSeq = n => {
  colorSeq = n;
};
const nextColor = () => colorSeq++;

const trunc = (s, n = 160) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const now = () => new Date().toISOString();

function console_(robot, kind, text = '') {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`${t} [${robot}] ${kind.padEnd(12)} ${text}`);
}

function describeTool(tool, input = {}) {
  if (tool === 'Bash') return `Bash: ${trunc(input.command, 140)}`;
  if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(tool)) return `${tool}: ${input.file_path ?? ''}`;
  if (tool === 'Grep' || tool === 'Glob') return `${tool}: ${trunc(input.pattern, 100)}`;
  if (tool === 'Agent' || tool === 'Task') return `${tool}: ${input.subagent_type ?? ''} ${trunc(input.description, 80)}`;
  if (tool === 'Skill') return `Skill: ${input.skill ?? ''} ${trunc(input.args, 80)}`;
  return tool;
}

export {
  APPROVAL,
  APPROVAL_TIMEOUT_MS,
  ASK_TIMEOUT_MS,
  ATTACH_DIR,
  ATTACH_MAX_BYTES,
  ATTACH_TTL_MS,
  boot,
  CLAUDE_BIN,
  clients,
  colorSeq,
  CONFIG_FILE,
  console_,
  describeTool,
  EVENTS_FILE,
  HOLD_TOOLS,
  inbox,
  LEGACY_RUNS,
  MAX_ROBOTS_LIMIT,
  maxRobots,
  NAMES,
  NEVER_ALLOW,
  nextColor,
  now,
  pending,
  PERMISSION_MODES,
  PORT,
  replaceList,
  robots,
  ROOT,
  ROUTINE_TICK_MS,
  run,
  RUNS,
  saveJson,
  saveJsonAsync,
  SESSION,
  setColorSeq,
  setMaxRobots,
  SETTINGS,
  setWorkspace,
  TIMELINE_MAX,
  trunc,
  WEB,
  WORKSPACE
};
