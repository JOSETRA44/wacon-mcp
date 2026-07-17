import { spawnSync } from "node:child_process";
import { statfsSync, existsSync } from "node:fs";
import type { Store } from "./store.js";
import type { ConnectionState } from "./connection.js";
import { loadNotebooksConfig } from "./notebooks-config.js";
import { loadConfig } from "./config.js";
import { WACON_HOME } from "./paths.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  healthy: boolean;
}

/** Try `nlm notebook list --json` and report whether a given notebook exists. */
function checkNotebookLM(nlmPath: string): CheckResult {
  let res;
  try {
    res = spawnSync(nlmPath, ["notebook", "list", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      shell: process.platform === "win32",
    });
  } catch (err) {
    return {
      name: "NotebookLM (nlm)",
      status: "warn",
      detail: `no se pudo ejecutar nlm: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Instala el CLI de NotebookLM y asegúrate de que 'nlm' esté en el PATH. El playbook es opcional; Wacon funciona sin él.",
    };
  }
  if (res.error || res.status !== 0) {
    const msg = res.stderr?.trim() || res.error?.message || `código ${res.status}`;
    // Auth failures usually surface here.
    return {
      name: "NotebookLM (nlm)",
      status: "warn",
      detail: `nlm no respondió correctamente: ${msg.slice(0, 160)}`,
      fix: "Verifica que estés autenticado en NotebookLM (revisa `nlm --help` para el comando de login). El playbook es opcional.",
    };
  }
  const config = loadNotebooksConfig();
  const wanted = new Set(Object.values(config.tags).map((t) => t.notebook.toLowerCase()));
  let notebooks: { title?: string; id?: string }[] = [];
  try {
    const start = res.stdout.indexOf("[");
    notebooks = start >= 0 ? (JSON.parse(res.stdout.slice(start)) as { title?: string; id?: string }[]) : [];
  } catch {
    // couldn't parse; still counts as "nlm works"
  }
  const titles = new Set(notebooks.map((n) => (n.title ?? "").toLowerCase()));
  const ids = new Set(notebooks.map((n) => (n.id ?? "").toLowerCase()));
  const missing = [...wanted].filter((w) => !titles.has(w) && !ids.has(w));
  if (missing.length > 0) {
    return {
      name: "NotebookLM (nlm)",
      status: "warn",
      detail: `nlm autenticado (${notebooks.length} notebooks) pero faltan los mapeados: ${missing.join(", ")}`,
      fix: `Crea el cuaderno en NotebookLM y cárgale tus fuentes, o ajusta ~/.wacon/notebooks.json para apuntar a un notebook existente.`,
    };
  }
  return {
    name: "NotebookLM (nlm)",
    status: "ok",
    detail: `autenticado, ${notebooks.length} notebooks; los notebooks del playbook existen`,
  };
}

function checkDisk(): CheckResult {
  try {
    const s = statfsSync(WACON_HOME);
    const freeMb = (s.bavail * s.bsize) / (1024 * 1024);
    if (freeMb < 50) {
      return { name: "Espacio en disco", status: "fail", detail: `solo ${freeMb.toFixed(0)} MB libres en ${WACON_HOME}`, fix: "Libera espacio: SQLite y el caché del playbook necesitan escribir." };
    }
    if (freeMb < 500) {
      return { name: "Espacio en disco", status: "warn", detail: `${freeMb.toFixed(0)} MB libres en ${WACON_HOME}` };
    }
    return { name: "Espacio en disco", status: "ok", detail: `${(freeMb / 1024).toFixed(1)} GB libres` };
  } catch {
    return { name: "Espacio en disco", status: "warn", detail: "no se pudo medir el espacio libre" };
  }
}

export interface DoctorInputs {
  connectionState: ConnectionState;
  store: Store;
  daemon: { port: number; pid: number } | null;
}

export function runDoctor(inputs: DoctorInputs): DoctorReport {
  const checks: CheckResult[] = [];

  // WhatsApp
  const s = inputs.connectionState;
  checks.push({
    name: "Sesión WhatsApp",
    status: s === "connected" ? "ok" : s === "waiting_qr" ? "warn" : "fail",
    detail: s,
    fix: s === "connected" ? undefined : s === "waiting_qr" ? "Escanea el QR con `wacon login`." : "Ejecuta `wacon login` para vincular la sesión.",
  });

  // Local DB
  try {
    const stats = inputs.store.stats();
    checks.push({ name: "Base de datos local", status: "ok", detail: `${stats.messages} mensajes, ${stats.chats} chats` });
  } catch (err) {
    checks.push({ name: "Base de datos local", status: "fail", detail: err instanceof Error ? err.message : String(err), fix: "La DB SQLite puede estar corrupta; revisa ~/.wacon/wacon.db" });
  }

  // Daemon
  checks.push(
    inputs.daemon
      ? { name: "Daemon", status: "ok", detail: `vivo (pid ${inputs.daemon.pid}, puerto ${inputs.daemon.port})` }
      : { name: "Daemon", status: "warn", detail: "no reportado", fix: "El daemon arranca solo al usar cualquier comando." }
  );

  // NotebookLM + media backends + disk
  const config = loadNotebooksConfig();
  checks.push(checkNotebookLM(config.nlmPath));
  checks.push(checkMediaBackends());
  checks.push(checkDisk());

  return { checks, healthy: !checks.some((c) => c.status === "fail") };
}

/** Report the optional layer-2 media backends (transcription/vision). */
function checkMediaBackends(): CheckResult {
  const cfg = loadConfig();
  const parts: string[] = [];
  const t = cfg.transcription.backend;
  const v = cfg.vision.backend;

  if (t === "none") {
    parts.push("audio→bloque nativo MCP");
  } else if (t === "whispercpp") {
    const ok = cfg.transcription.binPath && existsSync(cfg.transcription.binPath) && cfg.transcription.modelPath && existsSync(cfg.transcription.modelPath);
    if (!ok) {
      return {
        name: "Multimedia (backends)",
        status: "warn",
        detail: "transcripción whispercpp configurada pero falta binPath/modelPath",
        fix: "Instala whisper.cpp y apunta transcription.binPath y modelPath en config.json, o pon backend 'none' para usar el bloque de audio nativo.",
      };
    }
    parts.push("audio→whisper.cpp");
  } else {
    if (!cfg.transcription.endpoint) {
      return {
        name: "Multimedia (backends)",
        status: "warn",
        detail: "transcripción openai-compatible sin endpoint",
        fix: "Define transcription.endpoint (URL /audio/transcriptions) en config.json, o usa backend 'none'.",
      };
    }
    parts.push("audio→API");
  }
  parts.push(v === "none" ? "imagen→bloque nativo MCP" : "imagen→API");
  return { name: "Multimedia (backends)", status: "ok", detail: parts.join(", ") };
}
