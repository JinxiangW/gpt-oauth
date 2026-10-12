#!/usr/bin/env node
/**
 * Service-free, read-only verification of the migrated web profile.
 *
 * node scripts/verify-web-profile-ui.mjs [--home PATH] [--profile-dir PATH]
 *   [--install-anchor PATH] [--output ABSOLUTE_WORKSPACE_REPORT.json]
 *
 * No boot/apply, package installation, network request, service listener,
 * settings/credential service, browser DOM, or client factory is activated.
 * Bundle/profile/home patch YAML is composed in memory; configs are never
 * printed. Credential files and desktop profile files are never opened.
 * --output is optional, workspace-only, and refuses to overwrite a report.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { verifySkinRoutes } from './verify-skin-routes.mjs';
import { verifyShellSecrets } from './verify-shell-secrets.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const aggregateName = '@linxin666/dsh-web-all';
const skinName = '@linxin666/dsh-client-ui-skin-center';
const providers = ['dsh-llm-openai', 'dsh-web-openai-codex'];
const legacySkinIds = new Set([
  'ui-skin-blue-fantasy', 'ui-skin-dragon-heir', 'ui-skin-miku',
  'ui-skin-minecraft', 'ui-skin-qq98', 'ui-skin-ths', 'ui-skin-trading',
  'ui-skin-whale-song', 'ui-skin-xp',
]);
const summary = {
  schemaVersion: 1,
  ok: false,
  generatedAt: new Date().toISOString(),
  mode: 'service-free import, composition, and registration verification',
  safety: {
    hostPluginsActivated: false, clientFactoriesMaterialized: false,
    servicesStartedOrStopped: false, credentialsOpened: false,
    desktopProfileOpened: false, installationFilesWritten: false,
    patchConfigsPrinted: false,
  },
  limits: [
    'Imports and registrations do not prove host activation, service injection, routes, or browser UI behavior.',
    'Synthetic loader fibers represent admission, not successfully activated real host fibers.',
    'Static require coverage checks literal calls and the known store adapter, not arbitrary dynamic expressions, exports used by callers, or DOM behavior.',
    'Optional external wallpaper-engine integration has its own storage; skin-center selection/background/custom-theme state is checked via its profile-local active-state path.',
    'No pnpm peer check is required: installation-scope DSH peers and browser static singletons are supplied by the host.',
  ],
  checks: [],
};
let options;
let context;
let packages;

function inside(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function check(name, condition, details) {
  summary.checks.push({ name, passed: Boolean(condition), ...(details === undefined ? {} : { details }) });
  assert.ok(condition, name);
}
function parseOptions() {
  const result = {
    home: resolve(process.env.DSH_HOME || join(homedir(), '.dsh')),
    installAnchor: resolve(process.env.APPDATA
      ? join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      : join(homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
  };
  const keys = new Map([
    ['--home', 'home'], ['--profile-dir', 'profileDir'],
    ['--install-anchor', 'installAnchor'], ['--output', 'output'],
  ]);
  for (let i = 2; i < process.argv.length; i++) {
    const key = keys.get(process.argv[i]);
    assert.ok(key, `Unknown argument: ${process.argv[i]}`);
    const value = process.argv[++i];
    assert.ok(value && !value.startsWith('--'), `Missing value for ${key}`);
    if (key === 'output') assert.ok(isAbsolute(value), '--output must be absolute');
    result[key] = resolve(value);
  }
  result.profileDir ??= join(result.home, 'profiles', 'web');
  assert.equal(basename(result.profileDir), 'web', 'This validator must not inspect a desktop profile');
  if (result.output) {
    assert.ok(inside(result.output, workspace) && !inside(result.output, result.home), '--output must be in the workspace, outside DSH home');
    assert.ok(!result.output.split(/[\\/]/).includes('node_modules'), '--output must not target installed packages');
    assert.ok(result.output.endsWith('.json'), '--output must be a JSON report');
    assert.ok(existsSync(dirname(result.output)), '--output parent directory must already exist');
    assert.ok(!existsSync(result.output), '--output refuses to overwrite an existing report');
  }
  return result;
}
function flatten(rows) {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])]);
}
/** Evaluate only the explicitly known disabled predicates, never arbitrary YAML expressions. */
function disabledOf(value) {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  assert.ok(value && typeof value.__jsExpr === 'string', 'Unsupported disabled field');
  const expr = value.__jsExpr.replace(/\s+/g, '');
  switch (expr) {
    case "!ctx.get('profileContext')": return false;
    case "ctx.get('profileContext')?.name!=='desktop'": return true;
    case "process.platform==='win32'": return process.platform === 'win32';
    case "process.platform!=='win32'": return process.platform !== 'win32';
    default: throw new Error(`Unrecognized disabled expression (not executed): ${expr}`);
  }
}
function clientPath(pkg) {
  let value = pkg.manifest.exports?.['./client'];
  if (value && typeof value === 'object') value = value.default;
  assert.equal(typeof value, 'string', `${pkg.name} must export a client artifact`);
  assert.ok(value.startsWith('./'), `${pkg.name} client export must be package-local`);
  const path = resolve(pkg.dir, value);
  assert.ok(inside(path, pkg.dir), `${pkg.name} client artifact escapes its package`);
  assert.ok(statSync(path).isFile(), `${pkg.name} client artifact is missing`);
  return path;
}
function isPlugin(mod) {
  const plugin = mod.default ?? mod;
  return typeof plugin === 'function' || (plugin && typeof plugin.apply === 'function');
}
/** Never call the captured factories. No document or fake DOM is supplied. */
function capture(source, filename, expectedIds, expectedChunk) {
  const captured = [];
  const sandbox = {
    window: { __ModuleLoader__: { load(value) {
      assert.ok(value && typeof value.id === 'string' && typeof value.factory === 'function', `Invalid factory registration in ${filename}`);
      assert.ok(expectedIds.has(value.id), `Unexpected registration ${value.id} in ${filename}`);
      assert.equal(value.chunk, expectedChunk, `Unexpected chunk registration in ${filename}`);
      captured.push({ id: value.id, factory: value.factory.toString() });
    } } },
  };
  new vm.Script(source, { filename }).runInNewContext(sandbox, { timeout: 5000 });
  assert.equal(captured.length, expectedIds.size, `Registration count in ${filename}`);
  assert.equal(new Set(captured.map(row => row.id)).size, captured.length, `Duplicate registrations in ${filename}`);
  return captured;
}
/** Conservative lexical scan: skip strings/templates/comments outside require calls. */
function requireCalls(source) {
  const literals = new Set();
  const dynamic = new Set();
  function skipString(start) {
    const quote = source[start];
    let i = start + 1;
    for (; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue; }
      if (source[i] === quote) return i + 1;
    }
    return i;
  }
  for (let i = 0; i < source.length;) {
    if ('\'"`'.includes(source[i])) { i = skipString(i); continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (source.startsWith('require', i) && !/[\w$.]/.test(source[i - 1] || '') && !/[\w$]/.test(source[i + 7] || '')) {
      let j = i + 7;
      while (/\s/.test(source[j] || '') && j < source.length) j++;
      if (source[j] === '(') {
        j++;
        while (/\s/.test(source[j] || '') && j < source.length) j++;
        if (source[j] === '"' || source[j] === "'") {
          const end = skipString(j);
          let k = end;
          while (/\s/.test(source[k] || '') && k < source.length) k++;
          if (source[k] === ')' && !source.slice(j + 1, end - 1).includes('\\')) literals.add(source.slice(j + 1, end - 1));
          else dynamic.add('nontrivial-string-expression');
        } else dynamic.add(source.slice(j).match(/^[\w$]+/)?.[0] || 'expression');
      }
    }
    i++;
  }
  return { literals: [...literals].sort(), dynamic: [...dynamic].sort() };
}
function staticSeeds(frontend) {
  const assets = join(frontend.dir, 'dist', 'assets');
  const matches = [];
  for (const name of readdirSync(assets).filter(name => /^index-.*\.js$/.test(name))) {
    const path = join(assets, name);
    const source = readFileSync(path, 'utf8');
    const match = source.match(/function\s+[\w$]+\(\)\{return\{(react:[^{}]{1,2500})\}\}/);
    if (!match || !match[1].includes('"@deepseek-ai/cordis"')) continue;
    const ids = [...match[1].matchAll(/(?:^|,)\s*(?:"([^"]+)"|([\w$]+))\s*:/g)].map(item => item[1] || item[2]);
    matches.push({ source: path, ids });
  }
  assert.equal(matches.length, 1, 'Locate exactly one actual browser static-module table without executing the shell');
  return matches[0];
}

async function main() {
  options = parseOptions();
  summary.paths = { workspace, ...options };
  const installRequire = createRequire(options.installAnchor);
  const official = name => import(pathToFileURL(installRequire.resolve(name)).href);
  const boot = await official('@deepseek-ai/dsh-app-boot');
  const { Context } = await official('@deepseek-ai/cordis');
  const { ModuleLoader } = await official('@deepseek-ai/cordis-plugin-loader');
  const { ClientModuleRegistry } = await official('@deepseek-ai/dsh-client-modules');
  const runtime = boot.getDshRuntimeVersion();
  check('global CLI and official runtime agree', readJson(options.installAnchor).version === runtime, { runtime });
  const profile = boot.loadProfileDirectory('verify-web-profile-ui', options.profileDir, options.installAnchor, { userLayer: false });
  check('no bundle was skipped', profile.skippedBundles.length === 0, profile.skippedBundles);
  const resolution = await boot.createRuntimeResolution({ installAnchor: options.installAnchor, profile, home: options.home });
  context = new Context();
  packages = new boot.PluginPackages(context, { resolution });
  const parentURL = pathToFileURL(join(options.profileDir, 'package.json')).href;
  const internal = ModuleLoader.fromInternal();
  check('official Node module loader is available', Boolean(internal));
  const hostModules = new Map();
  const hostImports = [];
  const locate = name => {
    const pkg = packages.packageOf(name, parentURL);
    assert.ok(pkg, `Runtime resolution has no package ${name}`);
    return pkg;
  };
  async function importHost(name, role) {
    const pkg = locate(name);
    const issue = boot.evaluatePluginCompatibility(pkg.manifest, {}, runtime);
    const record = {
      name, role, version: pkg.version, manifestPath: pkg.manifestPath,
      compatibility: issue === undefined ? 'compatible-without-exemption' : 'incompatible',
      dshPeers: Object.fromEntries(Object.entries(pkg.manifest.peerDependencies || {}).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))),
      imported: false,
    };
    hostImports.push(record);
    assert.equal(issue, undefined, `Incompatible DSH peers: ${name}`);
    const mod = await internal.import(name, parentURL, {});
    assert.ok(isPlugin(mod), `${name} has no host plugin shape`);
    record.imported = true;
    hostModules.set(name, mod);
    return pkg;
  }
  summary.runtime = { version: runtime, node: process.versions.node, resolutionEntries: resolution.entries.length, bundleOrder: profile.layers.map(layer => layer.packageName) };
  summary.hostImports = hostImports;
  const aggregate = await importHost(aggregateName, 'aggregate');
  check('aggregate is 0.4.6', aggregate.version === '0.4.6');
  const familyNames = Object.keys(aggregate.manifest.dependencies || {}).filter(name => name.startsWith('@linxin666/'));
  check('aggregate declares exactly 19 family packages', familyNames.length === 19);
  for (const name of familyNames) {
    const pkg = await importHost(name, 'family');
    check(`${name} resolved at pinned 0.4.6`, pkg.version === '0.4.6');
  }
  for (const name of providers) await importHost(name, 'provider');

  const profilePatches = boot.loadOptionalPatches('verify-web-profile-ui', profile.patchPath) || [];
  const homePatchPath = join(options.home, 'cordis.patch.yml');
  const homePatches = boot.loadOptionalPatches('verify-web-profile-ui', homePatchPath) || [];
  const layers = [...profile.layers.map(layer => layer.patches), profilePatches];
  const earlyWarnings = [];
  boot.composeEntries(layers, message => earlyWarnings.push(message));
  check('bundle/profile layers have no unexpected warnings', earlyWarnings.length === 0, earlyWarnings);
  const warnings = [];
  const composed = boot.composeEntries([...layers, homePatches], message => warnings.push(message));
  const expectedWarnings = [];
  const unexpectedWarnings = [];
  for (const message of warnings) {
    const id = /^patch: entry "([^"\n]+)" not found$/.exec(message)?.[1];
    const expected = id && legacySkinIds.has(id) && homePatches.some(patch => patch.id === id && patch.disabled === true && !patch.insert);
    (expected ? expectedWarnings : unexpectedWarnings).push(message);
  }
  summary.composition = { rows: composed.length, expectedWarnings, unexpectedWarnings, expectedWarningPolicy: 'Only the nine retained, disabled home legacy-skin overrides may target missing rows.' };
  check('only exact retained legacy-skin warnings are allowed', unexpectedWarnings.length === 0, unexpectedWarnings);
  const allRows = flatten(composed);
  const ids = allRows.map(row => row.id);
  check('all composed row IDs are nonempty and unique', ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length);
  const enabledRows = allRows.filter(row => !row.group && typeof row.name === 'string' && !disabledOf(row.disabled));
  summary.composition.enabledRows = enabledRows.length;
  const ssh = allRows.find(row => row.id === 'web-ui-ssh');
  const skill = allRows.find(row => row.id === 'web-ui-skill-explorer');
  check('SSH is enabled and its shell plugin selector survives overrides', ssh?.disabled === false && ssh.config?.plugin === '@linxin666/dsh-ssh');
  check('skill explorer remains disabled', skill?.disabled === true && skill.config?.plugin === '@linxin666/dsh-client-ui-skill-explorer');
  const familyRows = familyNames.map(name => {
    const rows = allRows.filter(row => row.name === name || row.config?.plugin === name);
    assert.equal(rows.length, 1, `Exactly one family row must select ${name}`);
    const row = rows[0];
    return { id: row.id, name: row.name, plugin: name, disabled: disabledOf(row.disabled), transport: row.config?.plugin ? 'aggregate-folded-client' : 'standalone-client' };
  });
  summary.composition.familyRows = familyRows;
  const retainedIds = [
    'web-ui-task-board', 'web-ui-git-graph', 'web-ui-pet',
    'web-ui-remote-web-ui', 'web-ui-ssh', 'web-ui-settings', 'web-ui-skin-center',
  ];
  summary.composition.retainedFeatures = retainedIds.map(id => {
    const row = familyRows.find(row => row.id === id);
    check(`retained feature ${id} has one enabled family row`, Boolean(row) && row.disabled === false);
    return { id: row.id, plugin: row.plugin, enabled: true };
  });
  const retiredNames = ['@linxin666/dsh-client-ui-aionui-panel', '@linxin666/dsh-live-stats'];
  check('user-excluded AionUi and TPS have no active profile rows', !enabledRows.some(row => retiredNames.includes(row.name) || retiredNames.includes(row.config?.plugin)));
  summary.composition.intentionallyOmittedFeatures = ['AionUi', 'real-time TPS'];
  const wrapperRows = allRows.filter(row => typeof row.name === 'string' && row.name.startsWith(`${aggregateName}/`) && row.config?.plugin);
  summary.shellImports = [];
  const wrapperModules = new Map();
  for (const row of wrapperRows) {
    const mod = await internal.import(row.name, parentURL, {});
    check(`shell subpath imports for ${row.id}`, isPlugin(mod));
    wrapperModules.set(row.name, mod);
    summary.shellImports.push({ id: row.id, name: row.name, imported: true });
  }
  summary.shellSecretSmoke = await verifyShellSecrets({
    shell: wrapperModules.get(`${aggregateName}/remote-web-ui`),
    remote: hostModules.get('@linxin666/dsh-remote-web-ui'),
    settings: await official('@deepseek-ai/dsh-settings'),
    bridge: hostModules.get('@linxin666/dsh-client-ui-web-ui-settings'),
    Context,
  });
  check('shell settings redact synthetic secrets without changing lazy plain-config parsing', summary.shellSecretSmoke.ok === true);
  summary.composition.providers = providers.map((name, index) => {
    const expectedId = ['llm-openai', 'web-openai-codex'][index];
    const rows = allRows.filter(row => row.name === name);
    check(`${name} has exactly one enabled provider row`, rows.length === 1 && rows[0].id === expectedId && !disabledOf(rows[0].disabled));
    return { name, id: rows[0].id, enabled: true };
  });
  check('removed aggregate is not a bundle or row', !profile.layers.some(layer => layer.packageName === '@linxin666/dsh-web-ui-all') && !allRows.some(row => row.name?.startsWith('@linxin666/dsh-web-ui-all')));

  // The registry is the real official class, but only its in-memory assembly runs.
  // Subpath shells are left intact: the official registry intentionally ignores
  // them, and their clients are folded into the aggregate, not separate graph rows.
  const syntheticEntries = allRows.filter(row => !row.group && typeof row.name === 'string').map(row => ({
    options: { id: row.id, name: row.name },
    disabled: disabledOf(row.disabled), fiber: {},
    parent: { tree: { ctx: { baseUrl: parentURL } } },
  }));
  context.provide('loader', { entries: () => syntheticEntries.values(), internal });
  const registry = new ClientModuleRegistry(context);
  const graph = registry.graph();
  const indexInjections = [];
  context.emit('webserver/index-inject', indexInjections);
  check('real index-inject event captures the official graph global', indexInjections.filter(row => row.kind === 'global' && row.name === '__DSH_BOOT__' && row.value === graph).length === 1);
  check('real index-inject event captures a bootstrap queue facade', indexInjections.filter(row => row.kind === 'script' && row.placement === 'head' && row.text.includes('window.__ModuleLoader__=')).length === 1);
  check('real index-inject event references every composed batch', graph.batches.every(batch => indexInjections.some(row => row.src === batch.url && row.kind === (batch.phase === 'bootstrap' ? 'script-src' : 'script-preload'))));
  summary.indexInjection = {
    rowCount: indexInjections.length,
    rows: indexInjections.map(row => ({ kind: row.kind, ...(row.placement ? { placement: row.placement } : {}), ...(row.src ? { src: row.src } : {}), ...(row.name ? { name: row.name } : {}) })),
    queueCreateCalled: false,
  };
  const graphIds = new Set(graph.entries.map(row => row.id));
  check('official graph has unique IDs', graphIds.size === graph.entries.length);
  check('official graph contains the new aggregate', graphIds.has(aggregateName));
  const frontend = locate('@deepseek-ai/dsh-web-frontend');
  const seeds = staticSeeds(frontend);
  const seedIds = new Set(seeds.ids);
  summary.browserStaticTable = { ...seeds, version: frontend.version, inspectedWithoutExecution: true };
  check('actual browser static table supplies the store and React/DSH singletons', ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store'].every(id => seedIds.has(id)));
  const normalize = id => id.endsWith('/client') ? id.slice(0, -7) : id;
  const covered = id => seedIds.has(id) || graphIds.has(normalize(id));
  summary.clientGraph = { entryCount: graph.entries.length, batchCount: graph.batches.length, entries: graph.entries, syntheticEntryCount: syntheticEntries.length };
  summary.clientArtifacts = [];
  const artifactNames = [...new Set([...graphIds, ...familyNames])];
  let registrationCount = 0;
  let chunkRegistrationCount = 0;
  let injectCount = 0;
  const missingInject = [];
  const missingExternal = [];
  for (const name of artifactNames) {
    const pkg = locate(name);
    const decl = pkg.manifest.dsh?.client;
    if (!decl || decl.platform !== 'web') continue;
    const path = clientPath(pkg);
    const source = readFileSync(path, 'utf8');
    const registrations = capture(source, path, new Set([name]));
    registrationCount += registrations.length;
    const calls = requireCalls(registrations[0].factory);
    const inject = decl.inject || [];
    const external = decl.external || [];
    for (const id of inject) {
      injectCount++;
      if (!covered(id)) missingInject.push({ package: name, specifier: id });
    }
    for (const id of [...new Set([...external, ...calls.literals])]) {
      if (!covered(id)) missingExternal.push({ package: name, specifier: id });
    }
    const adapter = calls.dynamic.includes('platform') && source.includes('["@deepseek-ai/dsh-client", "-store"].join("")') && calls.dynamic.includes('legacy');
    if (adapter && !covered('@deepseek-ai/dsh-client-store')) missingExternal.push({ package: name, specifier: '@deepseek-ai/dsh-client-store', kind: 'known-dynamic-primary' });
    const chunkFiles = readdirSync(dirname(path)).filter(file => /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(file));
    const chunks = [];
    for (const chunk of chunkFiles) {
      const chunkPath = join(dirname(path), chunk);
      const chunkSource = readFileSync(chunkPath, 'utf8');
      const chunkRegistrations = capture(chunkSource, chunkPath, new Set([name]), chunk);
      chunkRegistrationCount += chunkRegistrations.length;
      const chunkCalls = requireCalls(chunkRegistrations[0].factory);
      const inactiveBrowserRequires = [];
      // PDF.js retains a NodeCanvasFactory branch in its browser artifact.
      // This is NOT a global allow-list for `url`: admit just this exact call
      // with its Node-only class and browser default selector both present.
      const nodeCanvasCall = 'return process.getBuiltinModule("module").createRequire(require("url").pathToFileURL(__filename).href)("@napi-rs/canvas").createCanvas(width, height);';
      const nodeCanvasOnly = name === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' && chunk === 'client.pdf.js'
        && chunkSource.includes('const isNodeJS = typeof process === "object"')
        && /var NodeCanvasFactory = class extends BaseCanvasFactory\s*\{\s*_createCanvas\(width, height\)\s*\{/.test(chunkSource)
        && chunkSource.includes(nodeCanvasCall)
        && chunkSource.includes('const CanvasFactory = src.CanvasFactory || (isNodeJS ? NodeCanvasFactory : DOMCanvasFactory);')
        && [...chunkSource.matchAll(/require\("url"\)/g)].length === 1;
      for (const id of chunkCalls.literals) {
        if (covered(id)) continue;
        if (id === 'url' && nodeCanvasOnly) inactiveBrowserRequires.push({ specifier: id, reason: 'Official PDF.js NodeCanvasFactory method; the browser default selects DOMCanvasFactory.', evidence: { nodeCanvasCall, browserDefaultSelector: 'isNodeJS ? NodeCanvasFactory : DOMCanvasFactory' } });
        else missingExternal.push({ package: name, chunk, specifier: id });
      }
      chunks.push({ filename: chunk, path: chunkPath, registeredFactoryCount: chunkRegistrations.length, literalRequires: chunkCalls.literals, dynamicRequires: chunkCalls.dynamic, inactiveBrowserRequires });
    }
    summary.clientArtifacts.push({
      name, version: pkg.version, path, inGraph: graphIds.has(name),
      registeredFactoryCount: registrations.length, inject,
      declaredExternal: external, literalRequires: calls.literals,
      dynamicRequires: calls.dynamic,
      ...(adapter ? { knownDynamicStoreAdapter: { primary: '@deepseek-ai/dsh-client-store', primaryCovered: covered('@deepseek-ai/dsh-client-store'), legacyFallback: '@deepseek-ai/dsh-client-runtime/client', fallbackRequired: false } } : {}),
      chunks,
    });
  }
  summary.clientRegistration = { artifactCount: summary.clientArtifacts.length, registrationCount, chunkRegistrationCount, injectCount, missingInject, missingExternal, factoriesMaterialized: 0 };
  check('every client inject resolves to a real graph entry or actual static-table seed', missingInject.length === 0, missingInject);
  check('browser-active literal and declared client externals are covered', missingExternal.length === 0, missingExternal);
  const batchRegistrations = [];
  for (const batch of graph.batches) {
    const response = await registry.fetchBundle(new Request(new URL(batch.url, 'http://verification.invalid/')));
    check(`registry serves composed ${batch.phase} batch without a listener`, response.status === 200);
    const members = new Set(batch.entries);
    batchRegistrations.push(...capture(await response.text(), batch.url, members).map(row => row.id));
  }
  check('composed batch registration covers each graph entry exactly once', batchRegistrations.length === graph.entries.length && new Set(batchRegistrations).size === graph.entries.length && batchRegistrations.every(id => graphIds.has(id)));
  summary.clientRegistration.batchRegistrationCount = batchRegistrations.length;

  const skin = hostModules.get(skinName);
  const skinPkg = locate(skinName);
  const skinSource = readFileSync(installRequire.resolve(join(skinPkg.dir, 'lib', 'index.js')), 'utf8');
  const previousEnv = Object.fromEntries(['DSH_HOME', 'DSH_PROFILE', 'DSH_SKIN_PROFILE', 'DSH_SKINS_HOME', 'DSH_SKINS_DIR'].map(key => [key, process.env[key]]));
  let skinDir;
  let activePath;
  try {
    process.env.DSH_HOME = options.home;
    // Deliberately conflicting env values, never created or opened: installed
    // package layout must still win over a desktop/shared-skin preference.
    process.env.DSH_PROFILE = 'desktop';
    process.env.DSH_SKIN_PROFILE = 'desktop';
    process.env.DSH_SKINS_HOME = join(options.home, '__verification_shared_skins_never_opened__');
    process.env.DSH_SKINS_DIR = join(options.home, '__verification_shared_skins_never_opened__');
    skinDir = skin.userSkinsDir();
    activePath = skin.defaultActiveStatePath();
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const legacyMentions = [...skinSource.matchAll(/\bmigrateLegacySelection\s*\(/g)];
  const legacyDefinitions = [...skinSource.matchAll(/\bfunction\s+migrateLegacySelection\s*\(/g)];
  summary.skinIsolation = {
    version: skinPkg.version, userSkinsDir: skinDir, activeStatePath: activePath,
    testedWithConflictingDesktopAndSharedSkinEnvironment: true,
    legacyMigrationCallCount: legacyMentions.length - legacyDefinitions.length,
    homeSettingsYamlExists: existsSync(join(options.home, 'settings.yaml')),
    stateContentsOpened: false,
  };
  check('skin assets and active state are profile-local', resolve(skinDir) === join(options.profileDir, 'skins') && resolve(activePath) === join(options.profileDir, 'skin-center-active.json'));
  check('skin host artifact has no legacy patch migration call', summary.skinIsolation.legacyMigrationCallCount === 0);
  check('shared home settings legacy migration has no source document', !summary.skinIsolation.homeSettingsYamlExists);
  summary.skinRouteSmoke = await verifySkinRoutes(skin, workspace);
  check('real skin catalog, CSS, hooks delivery, and read-only route guards pass', summary.skinRouteSmoke.requestCount === 10 && summary.skinRouteSmoke.stateWritten === false);
  summary.ok = true;
}

try {
  await main();
} catch (error) {
  // Do not dump parsed patch configs or YAML parser source snippets.
  summary.failure = { name: error?.name || 'Error', message: String(error?.message || error).split('\n')[0] };
  process.exitCode = 1;
} finally {
  if (packages) {
    packages.disposeWorkerResolution?.();
    packages.interception?.dispose();
  }
  const output = `${JSON.stringify(summary, null, 2)}\n`;
  if (options?.output) {
    try { writeFileSync(options.output, output, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) {
      summary.ok = false;
      summary.reportWriteFailure = { code: error.code, message: 'Could not create the requested workspace report.' };
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
