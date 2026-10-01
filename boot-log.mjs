import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Startup self-diagnosis for the two ChatGPT/Codex plugins.
//
// Why a file: this plugin runs inside the Electron host, whose stderr is captured
// into a bounded in-memory buffer nobody reads. A registration failure therefore
// looks identical to "the models never appeared", which makes an external
// observer (or the user) unable to tell the two apart. Writing a plain append-only
// log next to the Harness home makes every step observable.
//
// Logging is strictly best-effort: a failure to write must never affect the
// plugin, so every call is guarded.

const LOG_PATH = join(
  process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh"),
  "llm-openai-boot.log",
);

let enabled = true;

function stamp() {
  return new Date().toISOString();
}

export function bootLogPath() {
  return LOG_PATH;
}

export function bootLog(section, message) {
  if (!enabled) return;
  try {
    appendFileSync(LOG_PATH, `${stamp()} [${section}] ${message}\n`, "utf8");
  } catch {
    try {
      mkdirSync(join(LOG_PATH, ".."), { recursive: true });
      appendFileSync(LOG_PATH, `${stamp()} [${section}] ${message}\n`, "utf8");
    } catch {
      enabled = false;
    }
  }
}

export function bootLogError(section, error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && typeof error.stack === "string"
    ? error.stack.split("\n").slice(1, 4).map((line) => line.trim()).join(" <- ")
    : "";
  bootLog(section, `THREW ${detail}${stack.length > 0 ? ` | ${stack}` : ""}`);
}

/** Mark the beginning of one plugin activation. */
export function bootLogStart(section) {
  bootLog(section, "================ activation ================");
  bootLog(section, `pid=${String(process.pid)} node=${process.version}`);
}

/** Run one activation step, recording its outcome and rethrowing failures. */
export function traced(section, label, step) {
  try {
    const value = step();
    bootLog(section, `ok   ${label}`);
    return value;
  } catch (error) {
    bootLogError(section, error);
    bootLog(section, `FAIL ${label}`);
    throw error;
  }
}
