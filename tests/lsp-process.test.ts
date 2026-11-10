import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { createProject } from '../dist/adapter/filesystem/project.js';
import { createLspBackend } from '../dist/adapter/lsp/backend.js';
import type { LspBackend, Project } from '../dist/index.js';

const protocolNodeModuleUrl = import.meta.resolve('vscode-languageserver-protocol/node');
const source = 'package processfixture\n\nfunc Target() {}\n';

interface TestProject {
  readonly root: string;
  readonly sourcePath: string;
  readonly pidPath: string;
  readonly project: Project;
}

async function makeProject(sourceText = source, filename = 'main.go'): Promise<TestProject> {
  const root = await mkdtemp(join(tmpdir(), 'rulekeeper lsp process-'));
  const sourcePath = join(root, filename);
  await writeFile(sourcePath, sourceText);
  return {
    root,
    sourcePath,
    pidPath: join(root, 'child.pid'),
    project: createProject(root),
  };
}

function rubyServerOptions(command: string, args: readonly string[], requestTimeoutMs: number) {
  return {
    command,
    args,
    languageId: 'ruby',
    initializationProgressToken: 'indexing-progress',
    requestTimeoutMs,
  } as const;
}

async function removeProject(project: TestProject): Promise<void> {
  await rm(project.root, { recursive: true, force: true });
}

function nodeArgs(script: string): string[] {
  return ['--input-type=module', '-e', script];
}

function serverOptions(command: string, args: readonly string[], requestTimeoutMs: number) {
  return { command, args, languageId: 'go', requestTimeoutMs } as const;
}

async function waitForMarker(filepath: string, isComplete: (value: string) => boolean): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let settled = false;
  const watcher = watch(dirname(filepath));
  // Use filesystem events for synchronization; this timer only bounds a missing marker.
  const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${basename(filepath)}`)), 5_000);

  const finish = (error?: Error, value?: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    watcher.close();
    if (error !== undefined) reject(error);
    else resolve(value!);
  };

  const check = (): void => {
    void readFile(filepath, 'utf8').then(
      value => {
        try {
          if (isComplete(value)) finish(undefined, value);
        } catch {
          // A marker can be visible while its writer is still publishing it.
        }
      },
      error => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
        finish(error instanceof Error ? error : new Error(String(error)));
      },
    );
  };

  watcher.on('change', check);
  watcher.on('rename', check);
  watcher.on('error', error => finish(error));
  check();
  return promise;
}

function validPidMarker(value: string): boolean {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0;
}

function validJsonMarker(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function pidFromMarker(marker: string): number {
  const pid = Number(marker);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid child PID marker: ${marker}`);
  return pid;
}

function assertProcessExited(pid: number): void {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

async function waitForProcessExit(pid: number): Promise<void> {
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return;
      throw error;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

async function terminateChild(pidPath: string): Promise<void> {
  let pid: number;
  try {
    pid = pidFromMarker(await readFile(pidPath, 'utf8'));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return;
    throw error;
  }
  await waitForProcessExit(pid);
}

async function cleanupProject(project: TestProject, backend?: LspBackend): Promise<void> {
  try {
    await backend?.close();
  } finally {
    try {
      await terminateChild(project.pidPath);
    } finally {
      await removeProject(project);
    }
  }
}

function nonresponsiveScript(pidPath: string, initializePath: string, exitPath: string): string {
  return `
    import { renameSync, writeFileSync } from 'node:fs';
    const writeMarker = (path, value) => {
      const temporary = path + '.' + process.pid + '.tmp';
      writeFileSync(temporary, value);
      renameSync(temporary, path);
    };
    writeMarker(${JSON.stringify(pidPath)}, String(process.pid));
    let initializeReceived = false;
    process.stdin.on('data', () => {
      if (!initializeReceived) {
        initializeReceived = true;
        writeMarker(${JSON.stringify(initializePath)}, 'received');
      }
    });
    process.on('exit', () => writeMarker(${JSON.stringify(exitPath)}, String(process.pid)));
    process.on('SIGTERM', () => process.exit(0));
  `;
}

function protocolPeerScript(
  pidPath: string,
  exitPath: string,
  mode: 'hang-definition' | 'apply-edit',
  markerPath: string,
  sourceUri: string,
  spawnCountPath?: string,
): string {
  const serverBehavior = mode === 'hang-definition'
    ? `
      connection.onRequest('textDocument/definition', () => {
        writeMarker(${JSON.stringify(markerPath)}, 'requested');
        return new Promise(() => {});
      });
    `
    : `
      connection.onNotification('initialized', () => {
        void connection.sendRequest('workspace/applyEdit', {
          label: 'attempt to modify the project source',
          edit: {
            changes: {
              [${JSON.stringify(sourceUri)}]: [
                {
                  range: {
                    start: { line: 2, character: 0 },
                    end: { line: 2, character: 0 },
                  },
                  newText: ${JSON.stringify('// unauthorized edit\n')},
                },
              ],
            },
          },
        }).then(
          result => writeMarker(${JSON.stringify(markerPath)}, JSON.stringify(result)),
          error => writeMarker(${JSON.stringify(markerPath)}, JSON.stringify({ error: String(error) })),
        );
      });
    `;

  return `
    import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
    const writeMarker = (path, value) => {
      const temporary = path + '.' + process.pid + '.tmp';
      writeFileSync(temporary, value);
      renameSync(temporary, path);
    };
    writeMarker(${JSON.stringify(pidPath)}, String(process.pid));
    ${spawnCountPath === undefined ? '' : `appendFileSync(${JSON.stringify(spawnCountPath)}, String(process.pid) + String.fromCharCode(10));`}
    process.on('exit', () => writeMarker(${JSON.stringify(exitPath)}, String(process.pid)));
    process.on('SIGTERM', () => process.exit(0));
    const { createProtocolConnection } = await import(${JSON.stringify(protocolNodeModuleUrl)});
    const connection = createProtocolConnection(process.stdin, process.stdout);
    connection.onRequest('initialize', () => ({
      capabilities: {
        textDocumentSync: 1,
        definitionProvider: true,
      },
      serverInfo: { name: 'LSP process test peer', version: '1' },
    }));
    connection.onRequest('shutdown', () => null);
    connection.onNotification('exit', () => process.exit(0));
    ${serverBehavior}
    connection.listen();
  `;
}
type RubyProgressPeerMode = 'gated' | 'early' | 'indexing-error';

function rubyProgressPeerScript(
  pidPath: string,
  exitPath: string,
  markerPath: string,
  releasePath: string,
  mode: RubyProgressPeerMode,
  descendantPidPath?: string,
): string {
  const initializeHandler = mode === 'early'
    ? `
      connection.onRequest('initialize', async () => {
        await connection.sendRequest('window/workDoneProgress/create', { token });
        await connection.sendNotification('$/progress', {
          token,
          value: { kind: 'end' },
        });
        writeMarker(${JSON.stringify(markerPath)}, 'early-end-sent');
        return { capabilities: { textDocumentSync: 1 } };
      });
    `
    : `
      connection.onRequest('initialize', () => ({
        capabilities: { textDocumentSync: 1 },
      }));
    `;
  const initializedHandler = mode === 'gated'
    ? `
      connection.onNotification('initialized', async () => {
        await connection.sendRequest('window/workDoneProgress/create', { token });
        await connection.sendNotification('$/progress', {
          token,
          value: { kind: 'begin', title: 'Indexing' },
        });
        await connection.sendNotification('$/progress', {
          token,
          value: { kind: 'report', message: 'Indexing files' },
        });
        await connection.sendNotification('$/progress', {
          token: 'unrelated-token',
          value: { kind: 'end' },
        });
        await connection.sendRequest('window/showMessageRequest', {
          type: 3,
          message: 'progress synchronization barrier',
        });

        const watcher = watch(${JSON.stringify(dirname(releasePath))}, () => {
          if (!existsSync(${JSON.stringify(releasePath)})) return;
          watcher.close();
          void connection.sendNotification('$/progress', {
            token,
            value: { kind: 'end' },
          }).then(() => writeMarker(${JSON.stringify(`${markerPath}.end-sent`)}, 'end-sent'));
        });
        writeMarker(${JSON.stringify(markerPath)}, 'indexing-in-progress');
      });
    `
    : mode === 'indexing-error'
      ? `
        connection.onNotification('initialized', async () => {
          await connection.sendRequest('window/workDoneProgress/create', { token });
          const indexingError = connection.sendNotification('window/showMessage', {
            type: 1,
            message: 'Error while indexing (Ruby parser error)',
          });
          const indexingEnd = connection.sendNotification('$/progress', {
            token,
            value: { kind: 'end' },
          });
          writeMarker(${JSON.stringify(markerPath)}, 'indexing-error-and-end-sent');
          await Promise.all([indexingError, indexingEnd]);
        });
      `
      : '';
  const descendantScript = descendantPidPath === undefined
    ? ''
    : `
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      // The referenced timer keeps the descendant alive until process-group shutdown.
      setInterval(() => {}, 1_000);
      writeFileSync(${JSON.stringify(`${descendantPidPath}.ready`)}, String(process.pid));
    `;
  const spawnDescendant = descendantPidPath === undefined
    ? ''
    : `
      const descendant = spawn(process.execPath, [
        '--input-type=module',
        '-e',
        ${JSON.stringify(descendantScript)},
      ], { stdio: ['ignore', 'ignore', 'inherit'] });
      writeMarker(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
    `;

  return `
    import { spawn } from 'node:child_process';
    import { existsSync, renameSync, watch, writeFileSync } from 'node:fs';
    const writeMarker = (path, value) => {
      const temporary = path + '.' + process.pid + '.tmp';
      writeFileSync(temporary, value);
      renameSync(temporary, path);
    };
    const token = 'indexing-progress';
    writeMarker(${JSON.stringify(pidPath)}, String(process.pid));
    ${spawnDescendant}
    process.on('exit', () => writeMarker(${JSON.stringify(exitPath)}, String(process.pid)));
    process.on('SIGTERM', () => process.exit(0));
    // The peer must load the protocol implementation in its own process.
    const { createProtocolConnection } = await import(${JSON.stringify(protocolNodeModuleUrl)});
    const connection = createProtocolConnection(process.stdin, process.stdout);
    ${initializeHandler}
    connection.onRequest('shutdown', () => null);
    connection.onNotification('exit', () => process.exit(0));
    ${initializedHandler}
    connection.listen();
  `;
}

async function nextEventLoopTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

test('a nonexistent executable rejects during startup', { timeout: 10_000 }, async () => {
  const fixture = await makeProject();
  try {
    const missingExecutable = join(fixture.root, 'does-not-exist');
    await assert.rejects(
      createLspBackend(
        fixture.project,
        new AbortController().signal,
        serverOptions(missingExecutable, [], 500),
      ),
    );
    await assert.rejects(readFile(fixture.pidPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await cleanupProject(fixture);
  }
});

test('a child that exits during startup is rejected and reaped', { timeout: 10_000 }, async () => {
  const fixture = await makeProject();
  try {
    const script = `
      import { renameSync, writeFileSync } from 'node:fs';
      const temporary = ${JSON.stringify(fixture.pidPath)} + '.' + process.pid + '.tmp';
      writeFileSync(temporary, String(process.pid));
      renameSync(temporary, ${JSON.stringify(fixture.pidPath)});
      process.exit(23);
    `;
    await assert.rejects(
      createLspBackend(
        fixture.project,
        new AbortController().signal,
        serverOptions(process.execPath, nodeArgs(script), 1_000),
      ),
    );
    assertProcessExited(pidFromMarker(await waitForMarker(fixture.pidPath, validPidMarker)));
  } finally {
    await cleanupProject(fixture);
  }
});

test('a nonresponsive initialize request times out and kills its child', { timeout: 10_000 }, async () => {
  const fixture = await makeProject();
  const initializePath = join(fixture.root, 'initialize.received');
  const exitPath = join(fixture.root, 'child.exited');
  try {
    const startup = createLspBackend(
      fixture.project,
      new AbortController().signal,
      serverOptions(process.execPath, nodeArgs(nonresponsiveScript(fixture.pidPath, initializePath, exitPath)), 300),
    );
    const rejectedStartup = assert.rejects(startup, /timeout|timed out|deadline/i);
    const pid = pidFromMarker(await waitForMarker(fixture.pidPath, validPidMarker));
    await waitForMarker(initializePath, value => value === 'received');
    await rejectedStartup;
    await waitForMarker(exitPath, validPidMarker);
    await waitForProcessExit(pid);
    assertProcessExited(pid);
  } finally {
    await cleanupProject(fixture);
  }
});

test('aborting initialization rejects before timeout and kills the child', { timeout: 10_000 }, async () => {
  const fixture = await makeProject();
  const controller = new AbortController();
  const initializePath = join(fixture.root, 'initialize.received');
  const exitPath = join(fixture.root, 'child.exited');
  try {
    const startup = createLspBackend(
      fixture.project,
      controller.signal,
      serverOptions(process.execPath, nodeArgs(nonresponsiveScript(fixture.pidPath, initializePath, exitPath)), 5_000),
    );
    const rejectedStartup = assert.rejects(startup, /abort/i);
    const pid = pidFromMarker(await waitForMarker(fixture.pidPath, validPidMarker));
    await waitForMarker(initializePath, value => value === 'received');
    controller.abort();
    await rejectedStartup;
    await waitForMarker(exitPath, validPidMarker);
    assertProcessExited(pid);
  } finally {
    await cleanupProject(fixture);
  }
});

test('Ruby startup waits for the matching indexing end event', { timeout: 15_000 }, async () => {
  const fixture = await makeProject();
  const progressPath = join(fixture.root, 'indexing.progress');
  const releasePath = join(fixture.root, 'release-indexing');
  const exitPath = join(fixture.root, 'child.exited');
  let backend: LspBackend | undefined;
  try {
    let startupResolved = false;
    const startup = createLspBackend(
      fixture.project,
      new AbortController().signal,
      rubyServerOptions(
        process.execPath,
        nodeArgs(rubyProgressPeerScript(
          fixture.pidPath,
          exitPath,
          progressPath,
          releasePath,
          'gated',
        )),
        5_000,
      ),
    );
    void startup.then(
      resolvedBackend => {
        startupResolved = true;
        backend = resolvedBackend;
      },
      () => { startupResolved = true; },
    );

    await waitForMarker(progressPath, value => value === 'indexing-in-progress');
    await nextEventLoopTurn();
    assert.equal(startupResolved, false);

    await writeFile(releasePath, 'release');
    await waitForMarker(`${progressPath}.end-sent`, value => value === 'end-sent');
    backend = await startup;
    await backend.close();
    backend = undefined;
    await waitForMarker(exitPath, validPidMarker);
  } finally {
    await cleanupProject(fixture, backend);
  }
});

test('Ruby startup retains a matching end received during initialize', { timeout: 10_000 }, async () => {
  const fixture = await makeProject();
  const progressPath = join(fixture.root, 'indexing.progress');
  const releasePath = join(fixture.root, 'unused-release');
  const exitPath = join(fixture.root, 'child.exited');
  let backend: LspBackend | undefined;
  try {
    backend = await createLspBackend(
      fixture.project,
      new AbortController().signal,
      rubyServerOptions(
        process.execPath,
        nodeArgs(rubyProgressPeerScript(
          fixture.pidPath,
          exitPath,
          progressPath,
          releasePath,
          'early',
        )),
        2_000,
      ),
    );
    assert.equal(await waitForMarker(progressPath, value => value === 'early-end-sent'), 'early-end-sent');
    const pid = pidFromMarker(await waitForMarker(fixture.pidPath, validPidMarker));
    await backend.close();
    backend = undefined;
    await waitForMarker(exitPath, validPidMarker);
    await waitForProcessExit(pid);
    assertProcessExited(pid);
  } finally {
    await cleanupProject(fixture, backend);
  }
});

test('a Ruby indexing error still rejects when progress ends', { timeout: 10_000 }, async () => {
  const fixture = await makeProject();
  const progressPath = join(fixture.root, 'indexing.progress');
  const releasePath = join(fixture.root, 'unused-release');
  const exitPath = join(fixture.root, 'child.exited');
  try {
    const startup = createLspBackend(
      fixture.project,
      new AbortController().signal,
      rubyServerOptions(
        process.execPath,
        nodeArgs(rubyProgressPeerScript(
          fixture.pidPath,
          exitPath,
          progressPath,
          releasePath,
          'indexing-error',
        )),
        2_000,
      ),
    );
    const rejectedStartup = assert.rejects(startup, /Error while indexing \(/);
    await waitForMarker(progressPath, value => value === 'indexing-error-and-end-sent');
    await rejectedStartup;
    const pid = pidFromMarker(await waitForMarker(fixture.pidPath, validPidMarker));
    await waitForMarker(exitPath, validPidMarker);
    await waitForProcessExit(pid);
    assertProcessExited(pid);
  } finally {
    await cleanupProject(fixture);
  }
});

test('a Ruby indexing readiness timeout reaps the child', { timeout: 15_000 }, async () => {
  const fixture = await makeProject();
  const progressPath = join(fixture.root, 'indexing.progress');
  const releasePath = join(fixture.root, 'unused-release');
  const exitPath = join(fixture.root, 'child.exited');
  try {
    const startup = createLspBackend(
      fixture.project,
      new AbortController().signal,
      rubyServerOptions(
        process.execPath,
        nodeArgs(rubyProgressPeerScript(
          fixture.pidPath,
          exitPath,
          progressPath,
          releasePath,
          'gated',
        )),
        2_000,
      ),
    );
    const rejectedStartup = assert.rejects(startup, /timeout|timed out/i);
    await waitForMarker(progressPath, value => value === 'indexing-in-progress');
    await rejectedStartup;
    const pid = pidFromMarker(await waitForMarker(fixture.pidPath, validPidMarker));
    await waitForMarker(exitPath, validPidMarker);
    await waitForProcessExit(pid);
    assertProcessExited(pid);
  } finally {
    await cleanupProject(fixture);
  }
});

test('aborting Ruby indexing readiness reaps the child', { timeout: 10_000 }, async () => {
  const fixture = await makeProject();
  const controller = new AbortController();
  const progressPath = join(fixture.root, 'indexing.progress');
  const releasePath = join(fixture.root, 'unused-release');
  const exitPath = join(fixture.root, 'child.exited');
  try {
    const startup = createLspBackend(
      fixture.project,
      controller.signal,
      rubyServerOptions(
        process.execPath,
        nodeArgs(rubyProgressPeerScript(
          fixture.pidPath,
          exitPath,
          progressPath,
          releasePath,
          'gated',
        )),
        5_000,
      ),
    );
    const rejectedStartup = assert.rejects(startup, /abort/i);
    await waitForMarker(progressPath, value => value === 'indexing-in-progress');
    controller.abort();
    await rejectedStartup;
    const pid = pidFromMarker(await waitForMarker(fixture.pidPath, validPidMarker));
    await waitForMarker(exitPath, validPidMarker);
    await waitForProcessExit(pid);
    assertProcessExited(pid);
  } finally {
    controller.abort();
    await cleanupProject(fixture);
  }
});

if (process.platform !== 'win32') {
  test('aborting Ruby startup terminates a descendant holding stderr', { timeout: 15_000 }, async () => {
    const fixture = await makeProject();
    const progressPath = join(fixture.root, 'indexing.progress');
    const releasePath = join(fixture.root, 'unused-release');
    const exitPath = join(fixture.root, 'child.exited');
    const descendantPidPath = join(fixture.root, 'descendant.pid');
    const controller = new AbortController();
    let startup: Promise<LspBackend> | undefined;
    let settledStartup: Promise<void> | undefined;
    try {
      startup = createLspBackend(
        fixture.project,
        controller.signal,
        rubyServerOptions(
          process.execPath,
          nodeArgs(rubyProgressPeerScript(
            fixture.pidPath,
            exitPath,
            progressPath,
            releasePath,
            'gated',
            descendantPidPath,
          )),
          10_000,
        ),
      );
      settledStartup = startup.then(() => undefined, () => undefined);
      const rejectedStartup = assert.rejects(startup, /abort/i);
      const pid = pidFromMarker(await waitForMarker(fixture.pidPath, validPidMarker));
      const descendantPid = pidFromMarker(await waitForMarker(descendantPidPath, validPidMarker));
      await waitForMarker(`${descendantPidPath}.ready`, value => value === String(descendantPid));
      await waitForMarker(progressPath, value => value === 'indexing-in-progress');
      assert.doesNotThrow(
        () => process.kill(descendantPid, 0),
        'descendant must still be alive before abort',
      );
      controller.abort();
      await rejectedStartup;
      await waitForMarker(exitPath, validPidMarker);
      await Promise.all([waitForProcessExit(pid), waitForProcessExit(descendantPid)]);
      assertProcessExited(pid);
      assertProcessExited(descendantPid);
      assert.equal(await readFile(fixture.sourcePath, 'utf8'), source);
    } finally {
      controller.abort();
      await settledStartup;
      await terminateChild(descendantPidPath);
      await cleanupProject(fixture);
    }
  });
}

test('non-Ruby positive-depth call hierarchy rejects when the provider is unavailable', { timeout: 10_000 }, async () => {
  const fixture = await makeProject();
  const requestMarker = join(fixture.root, 'definition.requested');
  const exitPath = join(fixture.root, 'child.exited');
  let backend: LspBackend | undefined;
  try {
    backend = await createLspBackend(
      fixture.project,
      new AbortController().signal,
      serverOptions(
        process.execPath,
        nodeArgs(protocolPeerScript(
          fixture.pidPath,
          exitPath,
          'hang-definition',
          requestMarker,
          pathToFileURL(fixture.sourcePath).href,
        )),
        2_000,
      ),
    );

    for (const method of ['callers', 'callees'] as const) {
      for (const target of [
        { filepath: 'main.go', line: 3, column: 6 },
        { filepath: 'main.go', line: 3 },
      ]) {
        await assert.rejects(
          backend[method](target, { depth: 1 }),
          { message: 'LSP server does not support textDocument/prepareCallHierarchy' },
        );
      }
    }
  } finally {
    await cleanupProject(fixture, backend);
  }
});

test('a definition timeout kills the peer and leaves the backend terminal', { timeout: 15_000 }, async () => {
  const fixture = await makeProject();
  const requestMarker = join(fixture.root, 'definition.requested');
  const exitPath = join(fixture.root, 'child.exited');
  const spawnCountPath = join(fixture.root, 'spawned.pids');
  let backend: LspBackend | undefined;
  try {
    const activeBackend = await createLspBackend(
      fixture.project,
      new AbortController().signal,
      serverOptions(
        process.execPath,
        nodeArgs(protocolPeerScript(
          fixture.pidPath,
          exitPath,
          'hang-definition',
          requestMarker,
          pathToFileURL(fixture.sourcePath).href,
          spawnCountPath,
        )),
        1_000,
      ),
    );
    backend = activeBackend;
    const query = activeBackend.definitions({ filepath: 'main.go', line: 3 });
    const rejectedQuery = assert.rejects(query, /timeout|timed out|closed|abort|failed/i);
    const pid = pidFromMarker(await waitForMarker(fixture.pidPath, validPidMarker));
    await waitForMarker(requestMarker, value => value.includes('requested'));
    await rejectedQuery;
    await waitForMarker(exitPath, validPidMarker);
    await waitForProcessExit(pid);
    assertProcessExited(pid);

    await assert.rejects(activeBackend.definitions({ filepath: 'main.go', line: 3 }));
    assert.deepEqual((await readFile(spawnCountPath, 'utf8')).trim().split('\n'), [String(pid)]);
  } finally {
    await cleanupProject(fixture, backend);
  }
});

test('workspace/applyEdit is rejected without changing source bytes', { timeout: 10_000 }, async () => {
  const fixture = await makeProject();
  const resultPath = join(fixture.root, 'apply-edit.result');
  const exitPath = join(fixture.root, 'child.exited');
  let backend: LspBackend | undefined;
  try {
    const before = await readFile(fixture.sourcePath);
    const activeBackend = await createLspBackend(
      fixture.project,
      new AbortController().signal,
      serverOptions(
        process.execPath,
        nodeArgs(protocolPeerScript(
          fixture.pidPath,
          exitPath,
          'apply-edit',
          resultPath,
          pathToFileURL(fixture.sourcePath).href,
        )),
        1_000,
      ),
    );
    backend = activeBackend;
    const pid = pidFromMarker(await waitForMarker(fixture.pidPath, validPidMarker));
    const response = JSON.parse(await waitForMarker(resultPath, validJsonMarker)) as {
      readonly applied: boolean;
      readonly failureReason?: string;
    };

    assert.deepEqual(response, { applied: false, failureReason: 'Read-only LSP session' });
    assert.deepEqual(await readFile(fixture.sourcePath), before);
    await activeBackend.close();
    backend = undefined;
    await waitForMarker(exitPath, validPidMarker);
    await waitForProcessExit(pid);
    assertProcessExited(pid);
  } finally {
    await cleanupProject(fixture, backend);
  }
});
