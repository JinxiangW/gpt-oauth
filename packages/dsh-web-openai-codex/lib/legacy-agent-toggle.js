import { installAgentWebTools } from "./tool-registration.js";

const FAILED_DISPOSAL_FINGERPRINT = Symbol("failed Codex Web disposal");

function safeDispose(dispose, logger, label) {
  try {
    dispose?.();
    return true;
  } catch (error) {
    logger.warn?.(`web-openai-codex: failed to dispose ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Compatibility helper for callers of dsh-web-openai-codex <=0.1.x.
 * The current plugin no longer calls this: standard DSH web providers and
 * @deepseek-ai/dsh-tool-web own registration now.
 */
export function createAgentWebToggle({ agents, searchProvider, makeFetchProvider, options, logger = console }) {
  const installed = new Map();

  function install(agent, config, fingerprint) {
    const fetchProvider = makeFetchProvider(config);
    const dispose = installAgentWebTools(agent, searchProvider, fetchProvider, config);
    installed.set(agent, { dispose, fingerprint });
  }

  function reconcile(agent) {
    const config = options();
    const desiredFingerprint = config.enabled ? JSON.stringify(config) : undefined;
    const existing = installed.get(agent);
    if (existing?.fingerprint === desiredFingerprint) return;
    if (agent.status !== "idle") return;

    if (existing !== undefined) {
      if (!safeDispose(existing.dispose, logger, `Codex web tools for agent ${agent.id ?? "<unknown>"}`)) {
        existing.fingerprint = FAILED_DISPOSAL_FINGERPRINT;
        return;
      }
      installed.delete(agent);
    }
    if (desiredFingerprint !== undefined) install(agent, config, desiredFingerprint);
  }

  function reconcileAll() {
    for (const agent of agents.list()) {
      try {
        reconcile(agent);
      } catch (error) {
        logger.error?.(`web-openai-codex: failed to reconcile agent ${agent.id ?? "<unknown>"}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function forget(agent) {
    installed.delete(agent);
  }

  function disposeAll() {
    for (const [agent, entry] of [...installed]) {
      if (safeDispose(entry.dispose, logger, `Codex web tools for agent ${agent.id ?? "<unknown>"}`)) installed.delete(agent);
    }
  }

  return { installed, reconcile, reconcileAll, forget, disposeAll };
}
