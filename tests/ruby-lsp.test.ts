import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createProject } from '../dist/adapter/filesystem/project.js';
import { createLspBackend } from '../dist/adapter/lsp/backend.js';
import { createRunLsp } from '../dist/app/lsp.js';
import type {
  DocumentSymbol,
  Location,
  LspCall,
  LspTarget,
  SymbolInformation,
  WorkspaceSymbol,
} from '../dist/index.js';
import { createSandbox } from './support.ts';
import { createRubyLspFixture } from './ruby-lsp-support.ts';

interface RubyLspGoldens {
  readonly widgetDefinitions: readonly { readonly path: string; readonly line: number }[];
  readonly unicodeWidgetDefinitions: readonly { readonly path: string; readonly line: number }[];
  readonly widgetReferences: readonly { readonly path: string; readonly line: number }[];
  readonly widgetDocumentSymbols: readonly RubySymbolView[];
  readonly widgetWorkspaceSymbols: readonly RubySymbolView[];
  readonly supportWidgetDefinitions: readonly { readonly path: string; readonly line: number }[];
}

interface RubySymbolView {
  readonly name: string;
  readonly kind: number;
  readonly path: string;
  readonly line: number | null;
}

interface RubyCallView {
  readonly name: string;
  readonly path: string;
  readonly depth: number;
  readonly source: string;
  readonly lines: { readonly start: number; readonly end: number };
}

interface RubyCallGoldens {
  readonly originCalleesDepth2: readonly RubyCallView[];
  readonly leafCallersDepth2: readonly RubyCallView[];
  readonly cycleAlphaCalleesDepth4: readonly RubyCallView[];
  readonly redRunCallers: readonly RubyCallView[];
  readonly blueRunCallers: readonly RubyCallView[];
  readonly redEntryCalleesDepth2: readonly RubyCallView[];
  readonly bareTargetCallers: readonly RubyCallView[];
  readonly localTargetCallers: readonly RubyCallView[];
  readonly singletonEntryCallees: readonly RubyCallView[];
  readonly endlessTargetCallers: readonly RubyCallView[];
  readonly outerCallees: readonly RubyCallView[];
  readonly nestedBodyLineOnlyCallees: readonly RubyCallView[];
  readonly blockEntryCallees: readonly RubyCallView[];
  readonly blockEntryCalleesWithDependencies: readonly RubyCallView[];
  readonly baseSaveCallers: readonly RubyCallView[];
  readonly childSaveCallees: readonly RubyCallView[];
  readonly forwardingSaveCallees: readonly RubyCallView[];
  readonly ambiguousCallSiteCallees: readonly RubyCallView[];
  readonly unicodeCallSiteCallers: readonly RubyCallView[];
  readonly unicodeOffsetCallers: readonly RubyCallView[];
  readonly dependencyCalleesDefault: readonly RubyCallView[];
  readonly dependencyCalleesOptIn: readonly RubyCallView[];
  readonly dependencyCallersDefault: readonly RubyCallView[];
  readonly dependencyCallersOptIn: readonly RubyCallView[];
  readonly dependencySinkCallersDefault: readonly RubyCallView[];
  readonly dependencySinkCallersOptIn: readonly RubyCallView[];
  readonly emptyNonMethodCallees: readonly RubyCallView[];
  readonly propertyAssignmentCallees: readonly RubyCallView[];
  readonly propertyGetterCallers: readonly RubyCallView[];
  readonly propertyAssignmentSiteCallees: readonly RubyCallView[];
}

function relativePath(root: string, path: string): string | undefined {
  const candidate = relative(root, path);
  return candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)
    ? undefined
    : candidate.split(sep).join('/');
}

function normalizeUri(uri: string, projectRoot: string, dependencyRoot: string): string {
  const path = fileURLToPath(uri);
  const projectPath = relativePath(projectRoot, path);
  if (projectPath !== undefined) return projectPath;
  const dependencyPath = relativePath(dependencyRoot, path);
  if (dependencyPath !== undefined) return `<dependency>/${dependencyPath}`;
  throw new Error(`Ruby LSP returned a URI outside the fixture: ${uri}`);
}

function locationView(
  locations: readonly Location[],
  projectRoot: string,
  dependencyRoot: string,
): readonly { readonly path: string; readonly line: number }[] {
  return locations
    .map(location => ({
      path: normalizeUri(location.uri, projectRoot, dependencyRoot),
      line: location.range.start.line + 1,
    }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

function normalizeCallPath(filepath: string, projectRoot: string, dependencyRoot: string): string {
  if (!isAbsolute(filepath)) return filepath.split(sep).join('/');
  const projectPath = relativePath(projectRoot, filepath);
  if (projectPath !== undefined) return projectPath;
  const dependencyPath = relativePath(dependencyRoot, filepath);
  if (dependencyPath !== undefined) return `<dependency>/${dependencyPath}`;
  throw new Error(`Ruby LSP returned a call path outside the fixture: ${filepath}`);
}

function callView(
  calls: readonly LspCall[],
  projectRoot: string,
  dependencyRoot: string,
): readonly RubyCallView[] {
  return calls
    .map(call => ({
      name: call.name,
      path: normalizeCallPath(call.filepath, projectRoot, dependencyRoot),
      depth: call.depth,
      source: call.source,
      lines: call.lines,
    }))
    .sort((left, right) => left.depth - right.depth
      || left.path.localeCompare(right.path)
      || left.lines.start - right.lines.start
      || left.name.localeCompare(right.name));
}

function lineTarget(source: string, marker: string, occurrence = 0) {
  let matched = 0;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!line.includes(marker)) continue;
    if (matched === occurrence) return { filepath: 'lib/call_graph.rb', line: index + 1 };
    matched += 1;
  }
  throw new Error(`Could not find occurrence ${occurrence + 1} of '${marker}' in call_graph.rb`);
}

function callSiteTarget(source: string, token: string, lineMarker: string) {
  const target = lineTarget(source, lineMarker);
  const line = source.split(/\r?\n/u)[target.line - 1]!;
  const column = line.lastIndexOf(token);
  if (column < 0) throw new Error(`Could not find '${token}' on '${lineMarker}'`);
  return { ...target, column: column + 1 };
}

function documentSymbolView(
  symbols: readonly DocumentSymbol[] | readonly SymbolInformation[],
  filepath: string,
): readonly RubySymbolView[] {
  const result: RubySymbolView[] = [];
  const visit = (items: readonly (DocumentSymbol | SymbolInformation)[]): void => {
    for (const symbol of items) {
      if ('location' in symbol) {
        result.push({
          name: symbol.name,
          kind: symbol.kind,
          path: filepath,
          line: symbol.location.range.start.line + 1,
        });
      } else {
        result.push({
          name: symbol.name,
          kind: symbol.kind,
          path: filepath,
          line: symbol.selectionRange.start.line + 1,
        });
        if (symbol.children !== undefined) visit(symbol.children);
      }
    }
  };
  visit(symbols);
  return result;
}

function workspaceSymbolView(
  symbols: readonly (SymbolInformation | WorkspaceSymbol)[],
  projectRoot: string,
  dependencyRoot: string,
): readonly RubySymbolView[] {
  return symbols
    .map(symbol => ({
      name: symbol.name,
      kind: symbol.kind,
      path: normalizeUri(symbol.location.uri, projectRoot, dependencyRoot),
      line: 'range' in symbol.location ? symbol.location.range.start.line + 1 : null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path)
      || left.name.localeCompare(right.name)
      || (left.line ?? 0) - (right.line ?? 0));
}

test('real Ruby LSP navigation matches the fixture golden', { timeout: 180_000 }, async () => {
  const sandboxes = createSandbox('ruby-lsp-test-');
  const fixture = await createRubyLspFixture(sandboxes.isolated('ruby'));
  await writeFile(join(fixture.cwd, 'lib', 'eof.rb'), '"𝄞"');
  const project = createProject(fixture.cwd);
  const dependencyRoot = join(fixture.root, 'project-dependency');
  const session = createRunLsp(project, (activeProject, signal) => createLspBackend(activeProject, signal, {
    command: 'ruby-lsp',
    args: [],
    languageId: 'ruby',
    initializationProgressToken: 'indexing-progress',
    env: fixture.env,
  }));
  let depthZeroStarts = 0;
  const depthZeroSession = createRunLsp(project, async () => {
    depthZeroStarts += 1;
    throw new Error('depth-zero call unexpectedly started Ruby LSP');
  });

  try {
    const goldenPath = fileURLToPath(new URL('./fixtures/ruby-lsp/expected.json', import.meta.url));
    const golden = JSON.parse(await readFile(goldenPath, 'utf8')) as RubyLspGoldens;
    const { tools } = session;
    const widgetTarget = { filepath: 'lib/usage.rb', line: 4, column: 1 };
    const widgetDefinition = locationView(
      await tools.definitions(widgetTarget),
      fixture.cwd,
      dependencyRoot,
    );
    assert.deepEqual(widgetDefinition, golden.widgetDefinitions);
    assert.deepEqual(widgetDefinition, [{ path: 'lib/widget.rb', line: 2 }]);

    const unicodeDefinition = locationView(
      await tools.definitions({ filepath: 'lib/unicode.rb', line: 2, column: 7 }),
      fixture.cwd,
      dependencyRoot,
    );
    assert.deepEqual(unicodeDefinition, golden.unicodeWidgetDefinitions);
    assert.deepEqual(unicodeDefinition, [{ path: 'lib/widget.rb', line: 2 }]);
    assert.deepEqual(
      await tools.definitions({ filepath: 'lib/eof.rb', line: 1, column: 5 }),
      [],
      'EOF after a surrogate pair is a valid query position',
    );

    const references = locationView(
      await tools.references(
        { filepath: 'lib/widget.rb', line: 2, column: 7 },
        { includeDeclaration: true },
      ),
      fixture.cwd,
      dependencyRoot,
    );
    assert.deepEqual(references, golden.widgetReferences);
    assert.deepEqual(references.map(reference => reference.path).sort(), [
      'lib/unicode.rb',
      'lib/usage.rb',
      'lib/widget.rb',
    ]);

    const hover = await tools.hover(widgetTarget);
    assert.ok(hover !== null && JSON.stringify(hover).includes('Widget'));

    const documentSymbols = documentSymbolView(
      await tools.documentSymbols('lib/widget.rb'),
      'lib/widget.rb',
    );
    assert.deepEqual(documentSymbols, golden.widgetDocumentSymbols);
    assert.ok(documentSymbols.some(symbol => symbol.name === 'Widget' && symbol.kind === 5));

    const workspaceSymbols = workspaceSymbolView(
      await tools.workspaceSymbols('Widget'),
      fixture.cwd,
      dependencyRoot,
    );
    assert.deepEqual(workspaceSymbols, golden.widgetWorkspaceSymbols);
    assert.ok(workspaceSymbols.some(symbol =>
      symbol.name === 'Widget' && symbol.path === 'lib/widget.rb' && symbol.line === 2,
    ));

    const supportTarget = { filepath: 'lib/usage.rb', line: 5, column: 1 };
    assert.deepEqual(
      await tools.definitions(supportTarget),
      [],
    );
    const supportDefinition = locationView(
      await tools.definitions(supportTarget, { includeDependencies: true }),
      fixture.cwd,
      dependencyRoot,
    );
    assert.deepEqual(supportDefinition, golden.supportWidgetDefinitions);
    assert.deepEqual(supportDefinition, [{ path: '<dependency>/lib/support_widget.rb', line: 1 }]);

    await assert.rejects(tools.declarations(widgetTarget), {
      message: 'LSP server does not support textDocument/declaration',
    });
    await assert.rejects(tools.typeDefinitions(widgetTarget), {
      message: 'LSP server does not support textDocument/typeDefinition',
    });
    await assert.rejects(tools.implementations(widgetTarget), {
      message: 'LSP server does not support textDocument/implementation',
    });

    assert.deepEqual(await depthZeroSession.tools.callers(widgetTarget, { depth: 0 }), []);
    assert.deepEqual(await depthZeroSession.tools.callees(widgetTarget, { depth: 0 }), []);
    assert.equal(depthZeroStarts, 0);
  } finally {
    try {
      await session.close();
    } finally {
      try {
        await depthZeroSession.close();
      } finally {
        sandboxes.cleanup();
      }
    }
  }
});
test('real Ruby LSP callers and callees match the fixture golden', { timeout: 180_000 }, async () => {
  const sandboxes = createSandbox('ruby-lsp-calls-test-');
  const fixture = await createRubyLspFixture(sandboxes.isolated('ruby'));
  const callGraphFixture = fileURLToPath(new URL('./fixtures/ruby-lsp/call_graph.rb', import.meta.url));
  await writeFile(
    join(fixture.cwd, 'lib', 'call_graph.rb'),
    await readFile(callGraphFixture, 'utf8'),
  );
  const project = createProject(fixture.cwd);
  const dependencyRoot = join(fixture.root, 'project-dependency');
  const session = createRunLsp(project, (activeProject, signal) => createLspBackend(activeProject, signal, {
    command: 'ruby-lsp',
    args: [],
    languageId: 'ruby',
    initializationProgressToken: 'indexing-progress',
    env: fixture.env,
  }));

  try {
    const callGoldenPath = fileURLToPath(new URL('./fixtures/ruby-lsp/call-expected.json', import.meta.url));
    const callGolden = JSON.parse(await readFile(callGoldenPath, 'utf8')) as RubyCallGoldens;
    const { tools } = session;
    const graphSource = await readFile(join(fixture.cwd, 'lib', 'call_graph.rb'), 'utf8');
    const graphCalls = async (
      direction: 'callers' | 'callees',
      target: LspTarget,
      depth: number,
      includeDependencies = false,
    ) => callView(
      await tools[direction](target, { depth, includeDependencies }),
      fixture.cwd,
      dependencyRoot,
    );
    const actualCallGraph: RubyCallGoldens = {
      originCalleesDepth2: await graphCalls('callees', lineTarget(graphSource, 'def origin'), 2),
      leafCallersDepth2: await graphCalls('callers', lineTarget(graphSource, 'def leaf'), 2),
      cycleAlphaCalleesDepth4: await graphCalls('callees', lineTarget(graphSource, 'def alpha'), 4),
      redRunCallers: await graphCalls('callers', lineTarget(graphSource, '  def run', 0), 1),
      blueRunCallers: await graphCalls('callers', lineTarget(graphSource, '  def run', 1), 1),
      redEntryCalleesDepth2: await graphCalls('callees', lineTarget(graphSource, 'def red_entry'), 2),
      bareTargetCallers: await graphCalls('callers', lineTarget(graphSource, 'def bare_target'), 1),
      localTargetCallers: await graphCalls('callers', lineTarget(graphSource, 'def local_target'), 1),
      singletonEntryCallees: await graphCalls('callees', lineTarget(graphSource, 'def self.singleton_entry'), 1),
      endlessTargetCallers: await graphCalls('callers', lineTarget(graphSource, 'def self.endless_target'), 1),
      outerCallees: await graphCalls('callees', lineTarget(graphSource, 'def outer'), 1),
      nestedBodyLineOnlyCallees: await graphCalls('callees', lineTarget(graphSource, '      nested_leaf'), 1),
      blockEntryCallees: await graphCalls('callees', lineTarget(graphSource, 'def block_entry'), 1),
      blockEntryCalleesWithDependencies: await graphCalls(
        'callees',
        lineTarget(graphSource, 'def block_entry'),
        1,
        true,
      ),
      baseSaveCallers: await graphCalls('callers', lineTarget(graphSource, 'def save(value)', 0), 1),
      childSaveCallees: await graphCalls('callees', lineTarget(graphSource, 'def save(value)', 1), 1),
      forwardingSaveCallees: await graphCalls('callees', lineTarget(graphSource, 'def save(value)', 2), 1),
      ambiguousCallSiteCallees: await graphCalls(
        'callees',
        callSiteTarget(graphSource, 'shared', 'receiver.shared'),
        1,
      ),
      unicodeCallSiteCallers: await graphCalls(
        'callers',
        callSiteTarget(graphSource, 'unicode_leaf', '"😀"; unicode_leaf'),
        1,
      ),
      unicodeOffsetCallers: await graphCalls(
        'callers',
        callSiteTarget(graphSource, 'x', 'def c; x; end'),
        1,
      ),
      dependencyCalleesDefault: await graphCalls(
        'callees',
        lineTarget(graphSource, 'def dependency_entry'),
        2,
      ),
      dependencyCalleesOptIn: await graphCalls(
        'callees',
        lineTarget(graphSource, 'def dependency_entry'),
        2,
        true,
      ),
      dependencyCallersDefault: await graphCalls(
        'callers',
        callSiteTarget(graphSource, 'remote_execute', 'SupportWidget.new.remote_execute'),
        1,
      ),
      dependencyCallersOptIn: await graphCalls(
        'callers',
        callSiteTarget(graphSource, 'remote_execute', 'SupportWidget.new.remote_execute'),
        1,
        true,
      ),
      dependencySinkCallersDefault: await graphCalls(
        'callers',
        lineTarget(graphSource, 'def dependency_sink'),
        1,
      ),
      dependencySinkCallersOptIn: await graphCalls(
        'callers',
        lineTarget(graphSource, 'def dependency_sink'),
        1,
        true,
      ),
      emptyNonMethodCallees: await graphCalls('callees', lineTarget(graphSource, 'class GraphFlow'), 1),
      propertyAssignmentCallees: await graphCalls(
        'callees',
        lineTarget(graphSource, 'def assignment_entry'),
        1,
      ),
      propertyGetterCallers: await graphCalls('callers', lineTarget(graphSource, 'def value', 0), 1),
      propertyAssignmentSiteCallees: await graphCalls(
        'callees',
        callSiteTarget(graphSource, 'value', 'self.value = rhs_helper'),
        1,
      ),
    };
    assert.deepEqual(actualCallGraph, callGolden);
  } finally {
    try {
      await session.close();
    } finally {
      sandboxes.cleanup();
    }
  }
});
