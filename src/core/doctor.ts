import { spawnSync } from "node:child_process";
import { statfsSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import type { ConnectionState } from "./connection.js";
import { loadNotebooksConfig } from "./notebooks-config.js";
import { loadConfig } from "./config.js";
import { readPersona, isTemplateBody } from "../memory/persona.js";
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
    // Thresholds raised after a REAL failure: with ~544 MB free the WhatsApp
    // session could not reconnect at all — Baileys writes its auth state on
    // every handshake and died with ENOSPC, leaving the daemon stuck in
    // waiting_qr as if the session had been unlinked. The old 50/500 MB
    // limits reported that state as a mere "warn", which buried the real
    // cause. WhatsApp history sync + SQLite WAL + the media cache need GBs.
    if (freeMb < 1024) {
      return {
        name: "Espacio en disco",
        status: "fail",
        detail: `solo ${freeMb.toFixed(0)} MB libres en ${WACON_HOME}`,
        fix: "Libera espacio YA: sin disco, WhatsApp no puede reconectar (falla al guardar la sesión y parece que te desvincularon).",
      };
    }
    if (freeMb < 3072) {
      return {
        name: "Espacio en disco",
        status: "warn",
        detail: `${(freeMb / 1024).toFixed(1)} GB libres en ${WACON_HOME}`,
        fix: "Vas justo. La sincronización de historial y el caché de medios pueden llenar lo que queda.",
      };
    }
    return { name: "Espacio en disco", status: "ok", detail: `${(freeMb / 1024).toFixed(1)} GB libres` };
  } catch {
    return { name: "Espacio en disco", status: "warn", detail: "no se pudo medir el espacio libre" };
  }
}

/**
 * Integrity of the stored WhatsApp credentials.
 *
 * Exists because of a real incident (2026-07-31): a full disk made Baileys
 * truncate `creds.json` to 0 bytes, yet the daemon kept working for a whole
 * day on its already-open socket. The loss only appeared on the next restart,
 * as a bare `waiting_qr` that looked like the user had been unlinked. A live
 * connection is NOT evidence that the session survives a restart — this is the
 * only check that looks at what is actually on disk.
 */
function checkSessionFiles(): CheckResult {
  const creds = join(WACON_HOME, "auth", "creds.json");
  const name = "Credenciales de sesión";
  if (!existsSync(creds)) {
    return { name, status: "warn", detail: "no hay sesión guardada", fix: "Vincula con `wacon login`." };
  }
  let raw: string;
  try {
    raw = readFileSync(creds, "utf8");
  } catch {
    return { name, status: "fail", detail: "no se pudo leer creds.json", fix: "Revisa permisos; si persiste, `wacon login`." };
  }
  if (raw.trim().length === 0) {
    return {
      name,
      status: "fail",
      detail: "creds.json está VACÍO — la sesión se perderá al reiniciar",
      fix: "Casi siempre es disco lleno: libera espacio y vuelve a vincular con `wacon login`.",
    };
  }
  try {
    JSON.parse(raw);
  } catch {
    return {
      name,
      status: "fail",
      detail: "creds.json está corrupto (JSON inválido)",
      fix: "Suele ser una escritura truncada por falta de disco: libera espacio y `wacon login`.",
    };
  }
  return { name, status: "ok", detail: "sesión guardada e íntegra" };
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

  // Knowledge layer: is the persona actually usable by agents?
  checks.push(checkPersona());

  // NotebookLM + media backends + disk
  const config = loadNotebooksConfig();
  checks.push(checkNotebookLM(config.nlmPath));
  checks.push(checkMediaBackends());
  checks.push(checkSessionFiles());
  checks.push(checkDisk());

  return { checks, healthy: !checks.some((c) => c.status === "fail") };
}

/**
 * The persona drives every message sent as the user, so an empty/boilerplate
 * one is a real problem — flag it instead of letting agents run on nothing.
 */
function checkPersona(): CheckResult {
  const persona = readPersona();
  if (!persona) {
    return { name: "Persona (tu voz)", status: "warn", detail: "no existe persona.md", fix: "Ejecuta `wacon init` para generarla desde tus mensajes." };
  }
  if (isTemplateBody(persona.body)) {
    return {
      name: "Persona (tu voz)",
      status: "warn",
      detail: "sigue con la plantilla vacía",
      fix: "Ejecuta `wacon init` para redactar un borrador con tus datos reales, y luego edítalo a mano.",
    };
  }
  const stats = persona.stats as { messageCount?: number } | null;
  return { name: "Persona (tu voz)", status: "ok", detail: `redactada${stats?.messageCount ? ` desde ${stats.messageCount} mensajes` : ""}` };
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
