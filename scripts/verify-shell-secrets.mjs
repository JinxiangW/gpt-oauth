/**
 * Synthetic-only regression for the aggregate shell's secret metadata.
 * All modules are supplied by the caller's official host/package resolver.
 * No imports of host plugins, service constructors, apply calls, listeners,
 * network, filesystem, profile configuration, or credential content occur here.
 */
export async function verifyShellSecrets({ shell, remote, settings, bridge, Context }) {
  const checks = [];
  const check = (name, test) => {
    let passed = false;
    try { passed = Boolean(test()); } catch { /* Never serialize errors/configs. */ }
    checks.push({ name, passed });
    return passed;
  };
  const limits = [
    'Synthetic Config parsing and SettingsForms.describe only; no activation, mutation, listener, network, or real profile data.',
    'Only the audited top-level tunnelToken secret is covered; unknown secret names/nested keys need their own schema metadata.',
    'Root volatility still admits arbitrary field edits; nested family validation remains deferred until mounting.',
  ];
  const safety = {
    syntheticDataOnly: true, pluginApplyCalled: false, serviceConstructorsCalled: false,
    contextsConstructed: false, listenersRegistered: false, networkRequests: false,
    filesystemAccess: false, profileConfigurationRead: false, credentialsRead: false,
  };
  const edgeCases = [];
  let bridgeChecked = false;
  let formCount = 0;
  const finish = () => ({
    ok: checks.every(row => row.passed),
    checks, passed: checks.filter(row => row.passed).length,
    failed: checks.filter(row => !row.passed).length,
    formsChecked: formCount, bridgeChecked, edgeCases,
    arbitraryInputCompatibilityPreserved: edgeCases.every(row => row.accepted && row.rootReference && row.valuePreserved),
    safety, limits,
  });
  const schema = shell?.Config;
  const remoteSchema = remote?.Config;
  if (!check('supplied-module-contracts', () =>
    typeof schema === 'function' && typeof schema.toJSON === 'function' &&
    typeof remoteSchema === 'function' && typeof remoteSchema.toJSON === 'function' &&
    typeof settings?.SettingsForms?.prototype?.describe === 'function' &&
    typeof settings?.redactSecrets === 'function' && typeof Context === 'function')) return finish();

  // Schemastery serializes a uid/refs graph, not an expanded schema tree.
  // Resolve only declared schema edges, with path-local cycle protection.
  const schemaRoot = encoded => encoded?.refs && Object.hasOwn(encoded.refs, encoded.uid)
    ? encoded.refs[encoded.uid] : encoded;
  const secretNodes = encoded => {
    const refs = encoded?.refs;
    const found = [];
    const visit = (edge, path, ancestors) => {
      const node = (typeof edge === 'number' || typeof edge === 'string') && refs && Object.hasOwn(refs, edge)
        ? refs[edge] : edge;
      if (!node || (typeof node !== 'object' && typeof node !== 'function') || ancestors.has(node)) return;
      const next = new Set(ancestors).add(node);
      if (node.meta?.role === 'secret') found.push(path);
      for (const [key, child] of Object.entries(node.dict ?? {})) visit(child, [...path, key], next);
      for (const child of node.list ?? []) visit(child, path, next);
      if (node.inner !== undefined) visit(node.inner, path, next);
    };
    visit(schemaRoot(encoded), [], new Set());
    return found;
  };
  const hasTokenRole = node => secretNodes(node).some(path => path.length === 1 && path[0] === 'tunnelToken');
  check('shell-root-is-volatile', () => schema.meta?.volatile === true);
  check('shell-live-schema-declares-token-secret', () => hasTokenRole(schema));
  check('shell-serialized-schema-retains-token-secret', () => hasTokenRole(schema.toJSON()));
  check('family-live-schema-declares-token-secret', () => hasTokenRole(remoteSchema));

  const makeRow = source => ({
    plugin: '@linxin666/dsh-remote-web-ui',
    enabled: false, relay: false, autoTunnel: false,
    tunnelToken: `synthetic-shell-secret-${source}`,
    tokenTtlMs: 120000,
    unrelated: { text: 'synthetic-public-value', array: [1, null, { enabled: false }] },
    unknownScalar: 7,
  });
  const current = makeRow('current');
  const inherited = makeRow('inherited');
  const override = makeRow('override');
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const plainTree = (node, seen = new Set()) => {
    if (!node || typeof node !== 'object') return typeof node !== 'function';
    if (seen.has(node) || typeof node.get === 'function') return false;
    seen.add(node);
    return Object.values(node).every(child => plainTree(child, seen));
  };
  let parsed;
  if (!check('row-parse-produces-single-root-reference', () => {
    parsed = schema(current);
    return typeof parsed?.get === 'function' && plainTree(parsed.get());
  })) return finish();
  check('row-roundtrip-preserves-secret-and-unknown-fields', () => equal(parsed.get(), current));
  check('row-reference-is-detached-from-input', () => {
    const row = makeRow('detachment');
    const reference = schema(row);
    row.unrelated.array.push('synthetic-later-edit');
    return reference.get().unrelated.array.length === 3;
  });

  // Preserve root-any behavior even for malformed non-object rows, so schema
  // validation cannot turn one shell's degraded row into a profile boot failure.
  // An any-first union carries secret metadata without narrowing accepted data.
  for (const [name, value] of [
    ['undefined', undefined], ['null', null], ['string', 'synthetic-public-scalar'],
    ['number', 7], ['boolean', false], ['array', [1, null]], ['empty-object', {}],
  ]) {
    let accepted = false;
    let rootReference = false;
    let valuePreserved = false;
    try {
      const result = schema(value);
      accepted = true;
      rootReference = typeof result?.get === 'function';
      valuePreserved = rootReference && equal(result.get(), value);
    } catch { /* No error text, which could include input, crosses this seam. */ }
    edgeCases.push({ name, accepted, rootReference, valuePreserved });
  }
  check('all-root-any-edge-behavior-preserved', () => edgeCases
    .every(row => row.accepted && row.rootReference && row.valuePreserved));
  if (edgeCases.some(row => !row.accepted)) limits.push(
    'A schema branch narrowed root-any behavior; use an any-first union rather than an intersection to preserve shell fault isolation.',
  );

  check('nested-family-schema-receives-plain-token-and-fields', () => {
    const { plugin: ignored, ...family } = parsed.get();
    const nested = remoteSchema(family);
    const read = value => typeof value?.get === 'function' ? value.get() : value;
    return read(nested.tunnelToken) === current.tunnelToken &&
      read(nested.enabled) === false && read(nested.relay) === false &&
      read(nested.tokenTtlMs) === current.tokenTtlMs;
  });
  check('host-redactor-removes-token-and-retains-public-fields', () => {
    const redacted = settings.redactSecrets(schema, current);
    const { tunnelToken: ignored, ...publicRow } = current;
    return equal(redacted.value, publicRow) && redacted.secrets.some(slot =>
      equal(slot.path, ['tunnelToken']) && slot.set === true);
  });

  // Bypass the SettingsForms constructor (it registers listeners and imports
  // legacy settings). Call the real prototype on a lightweight synthetic owner.
  // interpolate receives ordinary data with no !!js expressions, so an empty
  // context suffices; no Cordis Context is constructed or activated.
  const id = 'synthetic-web-ui-remote-web-ui';
  const entry = {
    id,
    options: { id, name: '@linxin666/dsh-web-all/remote-web-ui', config: current },
    fiber: {
      uid: -1, state: 2, runtime: { Config: schema }, config: parsed, ctx: {},
    },
  };
  const forms = Object.create(settings.SettingsForms.prototype);
  forms.ownerContext = {
    configEditor: { configuration: () => [{ entry, inherited, override }] },
    emit: () => {},
  };
  forms.revisions = new Map();
  forms.presentations = new Map();
  const redactedView = (row, source) => {
    const { tunnelToken: ignored, ...publicRow } = source;
    return !Object.hasOwn(row ?? {}, 'tunnelToken') && equal(row, publicRow);
  };
  const sidecar = row => equal(row?.secrets, [{ path: ['tunnelToken'], set: true }]);
  let descriptor;
  if (!check('official-describe-returns-one-synthetic-form', () => {
    const rows = forms.describe({ redactSecrets: true });
    formCount = rows.length;
    descriptor = rows[0];
    return rows.length === 1 && descriptor.ns === id;
  })) return finish();
  check('official-describe-value-redacted', () => redactedView(descriptor.value, current));
  check('official-describe-base-redacted', () => redactedView(descriptor.base, inherited));
  check('official-describe-user-redacted', () => redactedView(descriptor.user, override));
  check('official-describe-sidecar-is-write-only', () => sidecar(descriptor));
  check('official-describe-retains-schema-secret-metadata', () => hasTokenRole(descriptor.schema));
  check('official-describe-keeps-root-form-live', () => descriptor.applies === 'live' && schemaRoot(descriptor.schema).meta?.volatile !== true);
  check('synthetic-inputs-remain-unchanged-after-redaction', () =>
    equal(current, makeRow('current')) && equal(inherited, makeRow('inherited')) && equal(override, makeRow('override')));
  check('redaction-does-not-alter-in-process-describe-default', () => {
    const row = forms.describe()[0];
    return equal(row.value, current) && equal(row.base, inherited) && equal(row.user, override);
  });

  if (typeof bridge?.makeBridgeHandlers === 'function') {
    bridgeChecked = true;
    try {
      const handlers = bridge.makeBridgeHandlers({
        settings: forms, entries: () => [entry], readSettingsYaml: () => undefined,
      });
      const result = await handlers.describe();
      const row = result?.value?.namespaces?.find(item => item.ns === 'remote-web-ui');
      check('bridge-describe-preserves-official-redaction', () => result.ok === true &&
        row?.entryId === id && redactedView(row.value, current) &&
        redactedView(row.base, inherited) && redactedView(row.user, override) && sidecar(row));
    } catch { check('bridge-describe-preserves-official-redaction', () => false); }
  } else {
    limits.push('Installed bridge does not export makeBridgeHandlers; bridge wire behavior was not invoked by this helper.');
  }
  return finish();
}
