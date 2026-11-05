import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { createProject } from '../dist/adapter/filesystem/project.js';
import { createLspBackend } from '../dist/adapter/lsp/backend.js';
import { createRunLsp } from '../dist/app/lsp.js';
import type { Hover, LspBackend, LspCall, Project } from '../dist/index.js';

const project = { root: '/repo' } as Project;
const target = { filepath: 'src/main.go', line: 1 };
const LSP_FIXTURE = fileURLToPath(new URL('./fixtures/lsp/', import.meta.url));
const protocolNodeModuleUrl = import.meta.resolve('vscode-languageserver-protocol/node');

function backend(overrides: Partial<LspBackend> = {}): LspBackend {
  return {
    definitions: async () => [],
    declarations: async () => [],
    typeDefinitions: async () => [],
    implementations: async () => [],
    references: async () => [],
    hover: async () => null,
    documentSymbols: async () => [],
    workspaceSymbols: async () => [],
    callers: async () => [],
    callees: async () => [],
    close: async () => undefined,
    ...overrides,
  };
}

test('unused and depth-zero LSP facades do not start a backend', async () => {
  let starts = 0;
  const facade = createRunLsp(project, async () => {
    starts += 1;
    return backend();
  });

  assert.deepEqual(await facade.tools.callers(target, { depth: 0 }), []);
  await assert.rejects(
    facade.tools.callers({ filepath: target.filepath, line: 0 }, { depth: 0 }),
    /positive safe integer/,
  );
  assert.deepEqual(await facade.tools.workspaceSymbols(''), []);
  for (const depth of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(facade.tools.callers(target, { depth }), /nonnegative safe integer/);
  }
  assert.equal(starts, 0);
  const pending = facade.tools.definitions(target);
  await facade.close();
  await assert.rejects(pending, /closed/i);
  assert.equal(starts, 0);
});

test('validation failures are observed when callers discard the returned promises', async () => {
  const facade = createRunLsp(project, async () => backend());
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    void facade.tools.definitions({ filepath: target.filepath, line: 0 });
    void facade.tools.callers(target, { depth: -1 });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await facade.close();
  }
});

test('concurrent helpers share one lazy backend', async () => {
  let starts = 0;
  const requests: string[] = [];
  const facade = createRunLsp(project, async () => {
    starts += 1;
    return backend({
      definitions: async () => {
        requests.push('definition');
        return [];
      },
      hover: async () => {
        requests.push('hover');
        return null;
      },
    });
  });

  const [definitions, hover] = await Promise.all([
    facade.tools.definitions(target),
    facade.tools.hover(target),
  ]);

  assert.deepEqual(definitions, []);
  assert.equal(hover, null);
  assert.equal(starts, 1);
  assert.deepEqual(requests.sort(), ['definition', 'hover']);
  await facade.close();
});

test('missing and failed factories retain their first startup failure', async () => {
  const unconfigured = createRunLsp(project);
  await assert.rejects(unconfigured.tools.definitions(target), /LSP is not configured for this run/);
  await assert.rejects(unconfigured.tools.definitions(target), /LSP is not configured for this run/);
  await unconfigured.close();

  let starts = 0;
  const failure = new Error('startup failed');
  const failed = createRunLsp(project, async () => {
    starts += 1;
    throw failure;
  });
  await assert.rejects(failed.tools.hover(target), error => error === failure);
  await assert.rejects(failed.tools.hover(target), error => error === failure);
  assert.equal(starts, 1);
  await failed.close();
});

test('closing an unused facade rejects later calls', async () => {
  const facade = createRunLsp(project, async () => backend());
  await facade.close();
  await assert.rejects(facade.tools.definitions(target), /closed/i);
  await assert.rejects(facade.tools.callers(target, { depth: 0 }), /closed/i);
  await assert.rejects(facade.tools.workspaceSymbols(''), /closed/i);
});

test('a backend that resolves after close is closed immediately', async () => {
  const factoryStarted = Promise.withResolvers<void>();
  const factoryResult = Promise.withResolvers<LspBackend>();
  let closeCalls = 0;
  const facade = createRunLsp(project, async () => {
    factoryStarted.resolve();
    return factoryResult.promise;
  });

  const pending = facade.tools.definitions(target);
  await factoryStarted.promise;
  const closing = facade.close();
  factoryResult.resolve(backend({ close: async () => { closeCalls += 1; } }));
  await assert.rejects(pending, /closed/i);
  await closing;
  assert.equal(closeCalls, 1);
});

test('close aborts active work, waits for it, and closes the backend once', async () => {
  let closeCalls = 0;
  let signal: AbortSignal | undefined;
  const requestStarted = Promise.withResolvers<void>();
  const facade = createRunLsp(project, async (_project, runSignal) => {
    signal = runSignal;
    return backend({
      hover: () => {
        const pending = Promise.withResolvers<null>();
        runSignal.addEventListener('abort', () => pending.reject(new Error('aborted')), { once: true });
        requestStarted.resolve();
        return pending.promise;
      },
      close: async () => {
        closeCalls += 1;
      },
    });
  });

  const pending = facade.tools.hover(target);
  await requestStarted.promise;
  const firstClose = facade.close();
  const secondClose = facade.close();
  await assert.rejects(pending, /abort/i);
  await Promise.all([firstClose, secondClose]);
  assert.equal(signal?.aborted, true);
  assert.equal(closeCalls, 1);
});
interface ExpectedCall {
  readonly filepath: string;
  readonly source: string;
  readonly lines: { readonly start: number; readonly end: number };
  readonly depth: number;
}

interface LspGoldens {
  readonly seedCalleesDepth2: readonly ExpectedCall[];
  readonly firstCallCalleesDepth1: readonly ExpectedCall[];
  readonly seedCalleesWithDependenciesDepth2: readonly ExpectedCall[];
  readonly seedCallersDepth2: readonly ExpectedCall[];
  readonly cycleACalleesDepth3: readonly ExpectedCall[];
  readonly workerRunCalleesDepth2: readonly ExpectedCall[];
  readonly initializerCallersDepth2: readonly ExpectedCall[];
  readonly unicodeFirstCalleesDepth1: readonly ExpectedCall[];
  readonly unicodeFirstCallCallerDepth1: readonly ExpectedCall[];
}

async function copyLspFixture(crlfUnicode = false): Promise<{
  readonly workspace: string;
  readonly projectRoot: string;
  readonly dependencyRoot: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), 'rulekeeper lsp-'));
  const projectRoot = join(workspace, 'project');
  const dependencyRoot = join(workspace, 'project-dependency');
  await cp(join(LSP_FIXTURE, 'project'), projectRoot, { recursive: true });
  await cp(join(LSP_FIXTURE, 'project-dependency'), dependencyRoot, { recursive: true });
  if (crlfUnicode) {
    const unicodeFile = join(projectRoot, 'unicode.go');
    const source = await readFile(unicodeFile, 'utf8');
    await writeFile(unicodeFile, source.replace(/\n/g, '\r\n'));
  }
  return { workspace, projectRoot, dependencyRoot };
}

async function snapshotFiles(root: string): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filepath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(filepath);
      else if (entry.isFile()) files.set(relative(root, filepath), (await readFile(filepath)).toString('base64'));
    }
  };
  await visit(root);
  return files;
}

function normalizeCallPath(filepath: string, dependencyRoot: string): string {
  if (!isAbsolute(filepath)) return filepath;
  const withinDependency = relative(dependencyRoot, filepath);
  if (
    withinDependency === '' ||
    (withinDependency !== '..' && !withinDependency.startsWith(`..${sep}`) && !isAbsolute(withinDependency))
  ) {
    return `<dependency>${withinDependency === '' ? '' : `/${withinDependency.split(sep).join('/')}`}`;
  }
  return filepath;
}

function graphView(calls: readonly LspCall[], dependencyRoot: string): readonly ExpectedCall[] {
  return calls.map(call => ({
    filepath: normalizeCallPath(call.filepath, dependencyRoot),
    source: call.source,
    lines: call.lines,
    depth: call.depth,
  }));
}

async function readLspGoldens(): Promise<LspGoldens> {
  return JSON.parse(await readFile(join(LSP_FIXTURE, 'expected.json'), 'utf8')) as LspGoldens;
}

function hoverText(hover: Hover | null): string {
  const flatten = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(flatten).join('\n');
    if (typeof value === 'object' && value !== null && 'value' in value) {
      return typeof value.value === 'string' ? value.value : '';
    }
    return '';
  };
  return hover === null ? '' : flatten(hover.contents);
}

interface CallHierarchyPeerOptions {
  readonly documentSymbols: boolean;
  readonly itemHasFullRange: boolean;
  readonly languageId: string;
}

async function withCallHierarchyPeer(
  options: CallHierarchyPeerOptions,
  action: (backend: LspBackend, documentSymbolMarker: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'rulekeeper lsp hierarchy-'));
  const sourcePath = join(root, 'main.go');
  const documentSymbolMarker = join(root, 'document-symbol.requested');
  const source = 'package fixture\n\nfunc Target() {\n    Caller()\n}\n\nfunc Caller() {}\n\nfunc Parent() {\n    Target()\n}\n';
  await writeFile(sourcePath, source);

  const uri = pathToFileURL(sourcePath).href;
  const callerSelectionRange = {
    start: { line: 6, character: 5 },
    end: { line: 6, character: 11 },
  };
  const callerFullRange = {
    start: { line: 6, character: 0 },
    end: { line: 6, character: 'func Caller() {}'.length },
  };
  const peer = {
    rootItem: {
      name: 'Target',
      kind: 12,
      uri,
      range: { start: { line: 2, character: 0 }, end: { line: 4, character: 1 } },
      selectionRange: { start: { line: 2, character: 5 }, end: { line: 2, character: 11 } },
    },
    callerItem: {
      name: 'Caller',
      kind: 12,
      uri,
      range: options.itemHasFullRange ? callerFullRange : callerSelectionRange,
      selectionRange: callerSelectionRange,
    },
    flatSymbol: {
      name: 'Caller',
      kind: 12,
      location: { uri, range: callerSelectionRange },
    },
    parentItem: {
      name: 'Parent',
      kind: 12,
      uri,
      range: { start: { line: 8, character: 5 }, end: { line: 8, character: 11 } },
      selectionRange: { start: { line: 8, character: 5 }, end: { line: 8, character: 11 } },
    },
    parentCallRange: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
    callRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 10 } },
  };
  const capabilities: Record<string, unknown> = { callHierarchyProvider: true };
  if (options.documentSymbols) capabilities.documentSymbolProvider = true;
  const serverScript = `
    import { writeFileSync } from 'node:fs';
    // This child process must load the protocol package independently of the test runner.
    const { createProtocolConnection } = await import(${JSON.stringify(protocolNodeModuleUrl)});
    const peer = ${JSON.stringify(peer)};
    const connection = createProtocolConnection(process.stdin, process.stdout);
    connection.onRequest('initialize', () => ({ capabilities: ${JSON.stringify(capabilities)} }));
    connection.onRequest('textDocument/prepareCallHierarchy', () => [peer.rootItem]);
    connection.onRequest('callHierarchy/outgoingCalls', ({ item }) =>
      item.name === 'Target' ? [{ to: peer.callerItem, fromRanges: [peer.callRange] }] : [],
    );
    connection.onRequest('callHierarchy/incomingCalls', ({ item }) =>
      item.name === 'Target' ? [{ from: peer.parentItem, fromRanges: [peer.parentCallRange] }] : [],
    );
    connection.onRequest('textDocument/documentSymbol', () => {
      writeFileSync(${JSON.stringify(documentSymbolMarker)}, 'requested');
      return [peer.flatSymbol];
    });
    connection.onRequest('shutdown', () => null);
    connection.onNotification('exit', () => process.exit(0));
    connection.listen();
  `;

  try {
    const lspBackend = await createLspBackend(
      createProject(root),
      new AbortController().signal,
      {
        command: process.execPath,
        args: ['--input-type=module', '-e', serverScript],
        languageId: options.languageId,
        requestTimeoutMs: 5_000,
      },
    );
    try {
      await action(lspBackend, documentSymbolMarker);
    } finally {
      await lspBackend.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('call hierarchy uses its full range when document symbols are unsupported', async () => {
  await withCallHierarchyPeer(
    { documentSymbols: false, itemHasFullRange: true, languageId: 'go' },
    async (lspBackend, documentSymbolMarker) => {
      const calls = await lspBackend.callees(
        { filepath: 'main.go', line: 3, column: 6 },
        { depth: 1 },
      );
      assert.deepEqual(calls.map(call => ({ name: call.name, source: call.source })), [
        { name: 'Caller', source: 'func Caller() {}' },
      ]);
      await assert.rejects(readFile(documentSymbolMarker, 'utf8'), { code: 'ENOENT' });
    },
  );
});

test('flat symbol locations never become declaration source', async () => {
  await withCallHierarchyPeer(
    { documentSymbols: true, itemHasFullRange: false, languageId: 'go' },
    async (lspBackend, documentSymbolMarker) => {
      const calls = await lspBackend.callees(
        { filepath: 'main.go', line: 3, column: 6 },
        { depth: 1 },
      );
      assert.deepEqual(calls.map(call => ({ name: call.name, source: call.source })), [
        { name: 'Caller', source: 'func Caller() {}' },
      ]);
      assert.equal(await readFile(documentSymbolMarker, 'utf8'), 'requested');
    },
  );

  await withCallHierarchyPeer(
    { documentSymbols: true, itemHasFullRange: false, languageId: 'typescript' },
    async lspBackend => {
      await assert.rejects(
        lspBackend.callees({ filepath: 'main.go', line: 3, column: 6 }, { depth: 1 }),
        /Could not find the full declaration/,
      );
    },
  );
});

test('line-only Go graph targets use AST extents with flat identifier-only symbols', async () => {
  await withCallHierarchyPeer(
    { documentSymbols: true, itemHasFullRange: false, languageId: 'go' },
    async (lspBackend, documentSymbolMarker) => {
      const target = { filepath: 'main.go', line: 4 };
      const [callers, callees] = await Promise.all([
        lspBackend.callers(target, { depth: 1 }),
        lspBackend.callees(target, { depth: 1 }),
      ]);
      assert.deepEqual(callers.map(({ name, source }) => ({ name, source })), [
        { name: 'Parent', source: 'func Parent() {\n    Target()\n}' },
      ]);
      assert.deepEqual(callees.map(({ name, source }) => ({ name, source })), [
        { name: 'Caller', source: 'func Caller() {}' },
      ]);
      assert.equal(await readFile(documentSymbolMarker, 'utf8'), 'requested');
    },
  );
});

test('line-only Go interface method graph targets the method name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rulekeeper lsp interface method-'));
  const sourcePath = join(root, 'main.go');
  const preparedMarker = join(root, 'prepared-position.json');
  const source = 'package fixture\n\ntype Runner interface {\n    Run()\n}\n\nfunc Caller() {}\n';
  await writeFile(sourcePath, source);

  const uri = pathToFileURL(sourcePath).href;
  const methodRange = {
    start: { line: 3, character: 4 },
    end: { line: 3, character: 7 },
  };
  const callerItem = {
    name: 'Caller',
    kind: 12,
    uri,
    range: {
      start: { line: 6, character: 0 },
      end: { line: 6, character: 'func Caller() {}'.length },
    },
    selectionRange: {
      start: { line: 6, character: 5 },
      end: { line: 6, character: 11 },
    },
  };
  const serverScript = `
    import { writeFileSync } from 'node:fs';
    import { createProtocolConnection } from ${JSON.stringify(protocolNodeModuleUrl)};
    const connection = createProtocolConnection(process.stdin, process.stdout);
    const uri = ${JSON.stringify(uri)};
    const rootItem = {
      name: 'Run',
      kind: 6,
      uri,
      range: ${JSON.stringify(methodRange)},
      selectionRange: ${JSON.stringify(methodRange)},
    };
    const callerItem = ${JSON.stringify(callerItem)};
    connection.onRequest('initialize', () => ({
      capabilities: { callHierarchyProvider: true, documentSymbolProvider: true },
    }));
    connection.onRequest('textDocument/prepareCallHierarchy', ({ position }) => {
      writeFileSync(
        ${JSON.stringify(preparedMarker)},
        JSON.stringify(position),
      );
      return position.line === 3 && position.character === 4 ? [rootItem] : [];
    });
    connection.onRequest('callHierarchy/outgoingCalls', ({ item }) =>
      item.name === 'Run' ? [{
        to: callerItem,
        fromRanges: [{ start: { line: 3, character: 4 }, end: { line: 3, character: 7 } }],
      }] : [],
    );
    connection.onRequest('callHierarchy/incomingCalls', () => []);
    connection.onRequest('textDocument/documentSymbol', () => [{
      name: 'Run',
      kind: 6,
      location: { uri, range: ${JSON.stringify(methodRange)} },
    }]);
    connection.onRequest('shutdown', () => null);
    connection.onNotification('exit', () => process.exit(0));
    connection.listen();
  `;

  try {
    const lspBackend = await createLspBackend(
      createProject(root),
      new AbortController().signal,
      {
        command: process.execPath,
        args: ['--input-type=module', '-e', serverScript],
        languageId: 'go',
        requestTimeoutMs: 5_000,
      },
    );
    try {
      const calls = await lspBackend.callees({ filepath: 'main.go', line: 4 }, { depth: 1 });
      assert.equal(await readFile(preparedMarker, 'utf8'), JSON.stringify({ line: 3, character: 4 }));
      assert.ok(calls.length > 0);
      assert.deepEqual(calls.map(({ name, source }) => ({ name, source })), [
        { name: 'Caller', source: 'func Caller() {}' },
      ]);
    } finally {
      await lspBackend.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real gopls navigation and call hierarchy match the Go fixture goldens', { timeout: 180_000 }, async () => {
  const fixture = await copyLspFixture(true);
  const projectFilesBefore = await snapshotFiles(fixture.projectRoot);
  const dependencyFilesBefore = await snapshotFiles(fixture.dependencyRoot);
  const lspProject = createProject(fixture.projectRoot);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GOPROXY: 'off',
    GOWORK: 'off',
    GOTOOLCHAIN: 'local',
    GOTELEMETRY: 'off',
    GOCACHE: join(fixture.workspace, 'go-build-cache'),
    GOMODCACHE: join(fixture.workspace, 'go-module-cache'),
  };
  let starts = 0;
  const facade = createRunLsp(lspProject, (_project, signal) => {
    starts += 1;
    return createLspBackend(lspProject, signal, {
      command: 'gopls',
      args: ['serve'],
      languageId: 'go',
      env,
    });
  });
  try {
    const golden = await readLspGoldens();
    const seedTarget = { filepath: 'seed.go', line: 9 };
    const [localCallees, dependencyCallees] = await Promise.all([
      facade.tools.callees(seedTarget, { depth: 2 }),
      facade.tools.callees(seedTarget, { depth: 2, includeDependencies: true }),
    ]);
    assert.deepEqual(graphView(localCallees, fixture.dependencyRoot), golden.seedCalleesDepth2);
    assert.deepEqual(
      graphView(dependencyCallees, fixture.dependencyRoot),
      golden.seedCalleesWithDependenciesDepth2,
    );
    assert.ok(!graphView(localCallees, fixture.dependencyRoot).some(call => call.filepath.startsWith('<dependency>')));
    assert.ok(!dependencyCallees.some(call => call.source === 'func Deep() {}'));

    assert.deepEqual(
      graphView(await facade.tools.callers({ filepath: 'seed.go', line: 8 }, { depth: 2 }), fixture.dependencyRoot),
      golden.seedCallersDepth2,
    );
    assert.deepEqual(
      graphView(
        await facade.tools.callees({ filepath: 'seed.go', line: 9, column: 2 }, { depth: 1 }),
        fixture.dependencyRoot,
      ),
      golden.firstCallCalleesDepth1,
    );
    assert.deepEqual(
      graphView(await facade.tools.callees({ filepath: 'seed.go', line: 44 }, { depth: 3 }), fixture.dependencyRoot),
      golden.cycleACalleesDepth3,
    );
    assert.deepEqual(
      graphView(await facade.tools.callees({ filepath: 'worker.go', line: 10 }, { depth: 2 }), fixture.dependencyRoot),
      golden.workerRunCalleesDepth2,
    );
    assert.deepEqual(
      graphView(await facade.tools.callers({ filepath: 'initializers.go', line: 7 }, { depth: 2 }), fixture.dependencyRoot),
      golden.initializerCallersDepth2,
    );

    const unicodeSource = await readFile(join(fixture.projectRoot, 'unicode.go'), 'utf8');
    const unicodeColumn = unicodeSource.split(/\r?\n/u)[2]!.indexOf('First') + 1;
    const unicodeDefinition = await facade.tools.definitions({
      filepath: 'unicode.go',
      line: 3,
      column: unicodeColumn,
    });
    assert.ok(unicodeDefinition.some(location =>
      fileURLToPath(location.uri) === join(fixture.projectRoot, 'seed.go'),
    ));
    assert.deepEqual(
      graphView(await facade.tools.callees({ filepath: 'unicode.go', line: 3 }, { depth: 1 }), fixture.dependencyRoot),
      golden.unicodeFirstCalleesDepth1,
    );
    assert.deepEqual(
      graphView(
        await facade.tools.callers({ filepath: 'unicode.go', line: 3, column: unicodeColumn }, { depth: 1 }),
        fixture.dependencyRoot,
      ),
      golden.unicodeFirstCallCallerDepth1,
    );
    assert.deepEqual(await facade.tools.callees({ filepath: 'seed.go', line: 1 }, { depth: 1 }), []);

    const firstDefinition = await facade.tools.definitions({ filepath: 'seed.go', line: 9, column: 2 });
    assert.ok(firstDefinition.some(location =>
      fileURLToPath(location.uri) === join(fixture.projectRoot, 'seed.go') &&
      location.range.start.line === 15,
    ));
    const absoluteDefinition = await facade.tools.definitions({
      filepath: join(fixture.projectRoot, 'seed.go'),
      line: 9,
      column: 2,
    });
    assert.ok(absoluteDefinition.some(location => fileURLToPath(location.uri) === join(fixture.projectRoot, 'seed.go')));
    await assert.rejects(
      facade.tools.definitions({ filepath: join(fixture.dependencyRoot, 'dep.go'), line: 4, column: 2 }),
      /outside|dependency/i,
    );
    const externalDefinition = await facade.tools.definitions(
      { filepath: join(fixture.dependencyRoot, 'dep.go'), line: 4, column: 2 },
      { includeDependencies: true },
    );
    assert.ok(externalDefinition.some(location => fileURLToPath(location.uri) === join(fixture.dependencyRoot, 'dep.go')));
    const defaultReferences = await facade.tools.references({ filepath: 'seed.go', line: 8, column: 6 });
    assert.ok(defaultReferences.some(location =>
      fileURLToPath(location.uri) === join(fixture.projectRoot, 'seed.go') &&
      location.range.start.line === 32,
    ));
    assert.ok(!defaultReferences.some(location => location.range.start.line === 7));
    const declarationReferences = await facade.tools.references(
      { filepath: 'seed.go', line: 8, column: 6 },
      { includeDeclaration: true },
    );
    assert.ok(declarationReferences.some(location =>
      fileURLToPath(location.uri) === join(fixture.projectRoot, 'seed.go') &&
      location.range.start.line === 7,
    ));
    const workerType = await facade.tools.typeDefinitions({ filepath: 'worker.go', line: 15, column: 2 });
    assert.ok(workerType.some(location =>
      fileURLToPath(location.uri) === join(fixture.projectRoot, 'worker.go') &&
      location.range.start.line === 6,
    ));
    const runnerImplementations = await facade.tools.implementations({ filepath: 'worker.go', line: 3, column: 6 });
    assert.ok(runnerImplementations.some(location =>
      fileURLToPath(location.uri) === join(fixture.projectRoot, 'worker.go') &&
      location.range.start.line === 6,
    ));
    assert.match(hoverText(await facade.tools.hover({ filepath: 'seed.go', line: 8, column: 6 })), /func Seed\(\)/);
    assert.equal(await facade.tools.hover({ filepath: 'seed.go', line: 2 }), null);

    const documentSymbols = await facade.tools.documentSymbols('seed.go');
    assert.ok(documentSymbols.some(symbol => symbol.name === 'Seed'));
    assert.ok(documentSymbols.some(symbol => symbol.name === 'CycleA'));
    const workspaceSymbols = await facade.tools.workspaceSymbols('Grandcaller');
    assert.ok(workspaceSymbols.some(symbol => symbol.name === 'Grandcaller'));
    assert.deepEqual(await facade.tools.workspaceSymbols('NoSuchLspFixtureSymbol'), []);

    await assert.rejects(
      facade.tools.declarations({ filepath: 'seed.go', line: 9, column: 2 }),
      /textDocument\/declaration/,
    );
    assert.ok((await facade.tools.definitions({ filepath: 'seed.go', line: 9, column: 2 })).length > 0);
    await assert.rejects(facade.tools.definitions({ filepath: 'missing.go', line: 1 }), /missing\.go|could not be read/i);
    await assert.rejects(facade.tools.definitions({ filepath: 'seed.go', line: 10_000 }), /position|coordinate|line/i);
    await assert.rejects(facade.tools.definitions({ filepath: 'seed.go', line: 9, column: 10_000 }), /position|coordinate|column/i);
    assert.equal(starts, 1);
  } finally {
    try {
      await facade.close();
    } finally {
      try {
        assert.deepEqual(await snapshotFiles(fixture.projectRoot), projectFilesBefore);
        assert.deepEqual(await snapshotFiles(fixture.dependencyRoot), dependencyFilesBefore);
      } finally {
        await rm(fixture.workspace, { recursive: true, force: true });
      }
    }
  }
});
