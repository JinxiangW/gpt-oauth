// The Desktop development install shares its declared peers with the packaged
// Electron runtime. Standalone login must use the same peer instances as Host.
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pluginRoot = new URL("./", import.meta.url).href.toLowerCase();
const peers = new Set(Object.keys(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).peerDependencies ?? {}));
const runtimeManifest = join(dirname(process.execPath), "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh", "package.json");
if (!existsSync(runtimeManifest)) {
  throw new Error("Desktop login requires the DeepSeek Harness Electron executable. Use dsh-openai-login from the linked desktop installation.");
}
const runtimeAnchor = pathToFileURL(runtimeManifest).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    const parts = specifier.split("/");
    const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (error.code !== "ERR_MODULE_NOT_FOUND" || !peers.has(packageName) || !context.parentURL?.toLowerCase().startsWith(pluginRoot)) throw error;
    return nextResolve(specifier, { ...context, parentURL: runtimeAnchor });
  }
} });

const entryPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) {
  try {
    // Preflight credential imports before opening the authorization page.
    await import("./auth.mjs");
    const { main } = await import("./login.mjs");
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
