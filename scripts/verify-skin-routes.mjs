/**
 * Exercise exported skin-center route handlers in memory, without a listener,
 * plugin apply, persistent state, browser factories, or network requests.
 * Only the package's shipped built-in skin files are read. All other data
 * providers are explicitly injected; state/user paths must not exist.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function verifySkinRoutes(skin, workspace) {
  const userDir = join(workspace, '__verification_absent_skin_directory__');
  const activeStatePath = join(workspace, '__verification_absent_skin_state__.json');
  assert.ok(!existsSync(userDir), 'Reserved skin test directory must not exist');
  assert.ok(!existsSync(activeStatePath), 'Reserved skin test state must not exist');
  const catalog = skin.loadSkinCatalog({
    builtinDir: skin.builtinSkinsDir(), userDir, catalogCache: new Map(),
  });
  assert.ok(catalog.skins.length > 0, 'At least one shipped skin must load');
  const entry = skin.findSkin(catalog, 'blue-fantasy');
  assert.ok(entry && entry.origin === 'builtin', 'Shipped default skin must load');
  assert.equal(catalog.diagnostics.length, 0, 'Shipped skin catalog diagnostics');
  const prefix = skin.SKIN_CENTER_V2_PREFIX;
  const routes = skin.makeSkinCenterV2Routes({
    loadCatalog: () => catalog, activeStatePath, userDir,
    shippedSkinIds: () => new Set(catalog.skins.map(row => row.manifest.id)),
    listDelegatedSkins: () => [],
    detectExternalWallpaper: () => ({ installed: false }),
    fetchImpl: () => { throw new Error('Network is forbidden in route verification'); },
  });
  assert.equal(new Set(routes.map(row => row.path)).size, routes.length);
  const results = [];
  async function request(path, method = 'GET', headers = {}) {
    const route = routes.find(row => row.kind === 'exact' && row.path === path)
      ?? routes.find(row => row.kind === 'prefix' && path.startsWith(`${row.path}/`));
    assert.ok(route, `No route for ${path}`);
    let status;
    let responseHeaders;
    let body;
    let ended = false;
    const req = {
      url: path, method,
      headers: { host: 'verification.invalid', ...headers },
      [Symbol.asyncIterator]() { throw new Error('Request body must not be consumed'); },
    };
    const res = {
      writeHead(code, values) { status = code; responseHeaders = values; },
      end(value = '') { assert.equal(ended, false); ended = true; body = Buffer.from(value); },
    };
    await route.handler(req, res);
    assert.equal(ended, true, `${path} must terminate its response`);
    const result = { path, method, status, contentType: responseHeaders?.['content-type'], bytes: body.length };
    results.push(result);
    return { ...result, text: body.toString('utf8'), json: () => JSON.parse(body.toString('utf8')) };
  }
  let response = await request(`${prefix}/catalog`);
  assert.equal(response.status, 200);
  assert.ok(response.json().skins.some(row => row.manifest.id === 'blue-fantasy'));
  response = await request(`${prefix}/active`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { ok: true, active: null, background: null });
  for (const resource of ['stylesheet', 'patches']) {
    response = await request(`${prefix}/skins/blue-fantasy/${resource}`);
    assert.equal(response.status, 200, `Shipped ${resource} must pass its real CSS safety transform`);
    assert.ok(response.contentType.startsWith('text/css'));
    assert.ok(response.bytes > 0);
    assert.ok(response.text.includes('blue-fantasy'), 'CSS transform must retain its scoped skin ID');
  }
  response = await request(`${prefix}/skins/blue-fantasy/hooks.mjs`);
  assert.equal(response.status, 200, 'Shipped hook manifest/content must satisfy the reviewed allow-list');
  assert.ok(response.contentType.startsWith('text/javascript'));
  assert.ok(response.bytes > 0);
  response = await request(`${prefix}/skins/not-an-installed-skin/stylesheet`);
  assert.equal(response.status, 404);
  assert.equal(response.json().error, 'skin-not-found');
  response = await request(`${prefix}/skins/blue-fantasy/unknown-resource`);
  assert.equal(response.status, 404);
  assert.equal(response.json().error, 'unknown-skin-resource');
  response = await request(`${prefix}/active`, 'PUT');
  assert.equal(response.status, 405);
  response = await request(`${prefix}/active`, 'POST', { origin: 'https://foreign.invalid', 'sec-fetch-site': 'cross-site' });
  assert.equal(response.status, 403);
  response = await request(`${prefix}/skins/blue-fantasy/uninstall`, 'POST');
  assert.equal(response.status, 400);
  assert.equal(response.json().error, 'cannot-uninstall-builtin');
  assert.ok(!existsSync(activeStatePath) && !existsSync(userDir), 'Route smoke must not create persistent state');
  return {
    mode: 'in-memory exported route handlers; controlled catalog/state dependencies',
    builtinSkinIds: catalog.skins.map(row => row.manifest.id),
    catalogDiagnostics: catalog.diagnostics, registeredRouteCount: routes.length,
    requestCount: results.length, results, stateWritten: false, networkRequests: 0,
    hooksExecuted: false, cssRendered: false,
    limits: ['No listener, host apply, HTML integration, browser rendering, successful mutation, market repair, or external wallpaper detection was exercised.'],
  };
}
