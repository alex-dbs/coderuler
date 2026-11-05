import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createProject } from '../dist/adapter/filesystem/project.js';
import { createLspBackend } from '../dist/adapter/lsp/backend.js';
import { createRunLsp } from '../dist/app/lsp.js';
import type { DocumentSymbol, Location, SymbolInformation, WorkspaceSymbol } from '../dist/index.js';
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

    for (const target of [widgetTarget, { filepath: 'lib/usage.rb', line: 1 }]) {
      await assert.rejects(tools.callers(target, { depth: 1 }), {
        message: 'LSP server does not support textDocument/prepareCallHierarchy',
      });
      await assert.rejects(tools.callees(target, { depth: 1 }), {
        message: 'LSP server does not support textDocument/prepareCallHierarchy',
      });
    }

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
