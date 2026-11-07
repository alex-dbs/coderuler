import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createProject } from '../dist/adapter/filesystem/project.js';
import { createTypescriptLspBackend } from '../dist/adapter/lsp/backend.js';
import { createRunLsp } from '../dist/app/lsp.js';
import type {
  DocumentSymbol,
  Location,
  LspCall,
  SymbolInformation,
  WorkspaceSymbol,
} from '../dist/index.js';
import { createSandbox } from './support.ts';
import { createTypescriptLspFixture } from './typescript-lsp-support.ts';

interface LocationView {
  readonly path: string;
  readonly line: number;
}

interface SymbolView {
  readonly name: string;
  readonly kind: number;
  readonly path: string;
  readonly line: number | null;
}

interface CallView {
  readonly name: string;
  readonly path: string;
  readonly depth: number;
  readonly source: string;
  readonly lines: { readonly start: number; readonly end: number };
}

interface TypescriptLspGoldens {
  readonly widgetDefinitions: readonly LocationView[];
  readonly widgetTypeDefinitions: readonly LocationView[];
  readonly builderImplementations: readonly LocationView[];
  readonly widgetReferencesWithDeclaration: readonly LocationView[];
  readonly widgetReferencesWithoutDeclaration: readonly LocationView[];
  readonly widgetDocumentSymbols: readonly SymbolView[];
  readonly widgetWorkspaceSymbols: readonly SymbolView[];
  readonly tsxLabelDefinitions: readonly LocationView[];
  readonly unicodeWidgetDefinitions: readonly LocationView[];
  readonly moduleValueDefinitions: readonly LocationView[];
  readonly commonValueDefinitions: readonly LocationView[];
  readonly hoverIdentifiesWidget: boolean;
  readonly runCalleesDepth2: readonly CallView[];
  readonly leafCallersDepth2: readonly CallView[];
  readonly externalDefinitions: readonly LocationView[];
  readonly externalDependencyDefinitions: readonly LocationView[];
  readonly nonSymbolDefinitions: readonly LocationView[];
}

function normalizePath(path: string, projectRoot: string, dependencyRoot: string): string {
  if (!isAbsolute(path)) return path.split(sep).join('/');
  const projectPath = relative(projectRoot, path);
  if (projectPath !== '..' && !projectPath.startsWith(`..${sep}`) && !isAbsolute(projectPath)) {
    return projectPath.split(sep).join('/');
  }
  const dependencyPath = relative(dependencyRoot, path);
  if (dependencyPath !== '..' && !dependencyPath.startsWith(`..${sep}`) && !isAbsolute(dependencyPath)) {
    return `<dependency>/${dependencyPath.split(sep).join('/')}`;
  }
  throw new Error(`TypeScript LSP returned a path outside the fixture: ${path}`);
}

function locationView(
  locations: readonly Location[],
  projectRoot: string,
  dependencyRoot: string,
): readonly LocationView[] {
  return locations
    .map(location => ({
      path: normalizePath(fileURLToPath(location.uri), projectRoot, dependencyRoot),
      line: location.range.start.line + 1,
    }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

function documentSymbolView(
  symbols: readonly DocumentSymbol[] | readonly SymbolInformation[],
  filepath: string,
): readonly SymbolView[] {
  const result: SymbolView[] = [];
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
  return result.sort((left, right) => left.path.localeCompare(right.path)
    || (left.line ?? 0) - (right.line ?? 0)
    || left.name.localeCompare(right.name));
}

function workspaceSymbolView(
  symbols: readonly (SymbolInformation | WorkspaceSymbol)[],
  projectRoot: string,
  dependencyRoot: string,
): readonly SymbolView[] {
  return symbols
    .map(symbol => ({
      name: symbol.name,
      kind: symbol.kind,
      path: normalizePath(fileURLToPath(symbol.location.uri), projectRoot, dependencyRoot),
      line: 'range' in symbol.location ? symbol.location.range.start.line + 1 : null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path)
      || left.name.localeCompare(right.name)
      || (left.line ?? 0) - (right.line ?? 0));
}

function callView(
  calls: readonly LspCall[],
  projectRoot: string,
  dependencyRoot: string,
): readonly CallView[] {
  return calls
    .map(call => ({
      name: call.name,
      path: normalizePath(call.filepath, projectRoot, dependencyRoot),
      depth: call.depth,
      source: call.source,
      lines: call.lines,
    }))
    .sort((left, right) => left.depth - right.depth
      || left.path.localeCompare(right.path)
      || left.lines.start - right.lines.start
      || left.name.localeCompare(right.name));
}

function targetAtToken(filepath: string, source: string, token: string, lineMarker = token) {
  const lines = source.split(/\r?\n/u);
  const lineIndex = lines.findIndex(line => line.includes(lineMarker));
  const line = lines[lineIndex];
  if (lineIndex < 0 || line === undefined) throw new Error(`Could not find '${lineMarker}' in ${filepath}`);
  const columnIndex = line.lastIndexOf(token);
  if (columnIndex < 0) throw new Error(`Could not find token '${token}' in ${filepath}:${lineIndex + 1}`);
  return { filepath, line: lineIndex + 1, column: columnIndex + 1 };
}

function lineNumber(filepath: string, source: string, lineMarker: string): number {
  const line = source.split(/\r?\n/u).findIndex(candidate => candidate.includes(lineMarker));
  if (line < 0) throw new Error(`Could not find '${lineMarker}' in ${filepath}`);
  return line + 1;
}

test('real TypeScript LSP navigation matches the fixture golden', { timeout: 180_000 }, async () => {
  const sandboxes = createSandbox('typescript-lsp-test-');
  const fixture = await createTypescriptLspFixture(sandboxes.isolated('typescript'));
  const project = createProject(fixture.cwd);
  const dependencyRoot = join(fixture.root, 'project-dependency');
  const session = createRunLsp(project, createTypescriptLspBackend);

  try {
    const goldenPath = fileURLToPath(new URL('./fixtures/typescript-lsp/expected.json', import.meta.url));
    const golden = JSON.parse(await readFile(goldenPath, 'utf8')) as TypescriptLspGoldens;
    const { tools } = session;
    const widgetSource = await readFile(join(fixture.cwd, 'src', 'widget.ts'), 'utf8');
    const usageSource = await readFile(join(fixture.cwd, 'src', 'usage.ts'), 'utf8');
    const viewSource = await readFile(join(fixture.cwd, 'src', 'view.tsx'), 'utf8');
    const unicodeSource = await readFile(join(fixture.cwd, 'src', 'unicode.ts'), 'utf8');
    const moduleSource = await readFile(join(fixture.cwd, 'src', 'module.mts'), 'utf8');
    const commonSource = await readFile(join(fixture.cwd, 'src', 'common.cts'), 'utf8');

    const widgetTarget = targetAtToken('src/usage.ts', usageSource, 'Widget', 'new Widget()');
    const widgetInstanceTarget = targetAtToken('src/usage.ts', usageSource, 'widget', 'widget.build()');
    const builderTarget = targetAtToken('src/usage.ts', usageSource, 'Builder', 'builder: Builder');
    const tsxLabelTarget = targetAtToken('src/view.tsx', viewSource, 'label', '{label()}');
    const unicodeWidgetTarget = targetAtToken('src/unicode.ts', unicodeSource, 'Widget', 'new Widget()');
    const moduleReferenceTarget = targetAtToken(
      'src/module.mts', moduleSource, 'moduleValue', 'moduleReference = moduleValue',
    );
    const commonReferenceTarget = targetAtToken(
      'src/common.cts', commonSource, 'commonValue', 'commonReference = commonValue',
    );
    const externalTarget = targetAtToken('src/usage.ts', usageSource, 'external', 'externalValue = external()');
    const runLineTarget = {
      filepath: 'src/usage.ts',
      line: lineNumber('src/usage.ts', usageSource, 'return widget.build();'),
    };
    const leafTarget = targetAtToken('src/widget.ts', widgetSource, 'leaf', 'export function leaf');
    const blankLine = usageSource.split(/\r?\n/u).findIndex(line => line.length === 0);
    if (blankLine < 0) throw new Error('Could not find a non-symbol line in src/usage.ts');
    const nonSymbolTarget = { filepath: 'src/usage.ts', line: blankLine + 1, column: 1 };

    const widgetHover = await tools.hover(widgetTarget);
    const actual: TypescriptLspGoldens = {
      widgetDefinitions: locationView(
        await tools.definitions(widgetTarget), fixture.cwd, dependencyRoot,
      ),
      widgetTypeDefinitions: locationView(
        await tools.typeDefinitions(widgetInstanceTarget), fixture.cwd, dependencyRoot,
      ),
      builderImplementations: locationView(
        await tools.implementations(builderTarget), fixture.cwd, dependencyRoot,
      ),
      widgetReferencesWithDeclaration: locationView(
        await tools.references(widgetTarget, { includeDeclaration: true }), fixture.cwd, dependencyRoot,
      ),
      widgetReferencesWithoutDeclaration: locationView(
        await tools.references(widgetTarget, { includeDeclaration: false }), fixture.cwd, dependencyRoot,
      ),
      widgetDocumentSymbols: documentSymbolView(
        await tools.documentSymbols('src/widget.ts'), 'src/widget.ts',
      ),
      widgetWorkspaceSymbols: workspaceSymbolView(
        await tools.workspaceSymbols('Widget'), fixture.cwd, dependencyRoot,
      ),
      tsxLabelDefinitions: locationView(
        await tools.definitions(tsxLabelTarget), fixture.cwd, dependencyRoot,
      ),
      unicodeWidgetDefinitions: locationView(
        await tools.definitions(unicodeWidgetTarget), fixture.cwd, dependencyRoot,
      ),
      moduleValueDefinitions: locationView(
        await tools.definitions(moduleReferenceTarget), fixture.cwd, dependencyRoot,
      ),
      commonValueDefinitions: locationView(
        await tools.definitions(commonReferenceTarget), fixture.cwd, dependencyRoot,
      ),
      hoverIdentifiesWidget: widgetHover !== null && JSON.stringify(widgetHover).includes('Widget'),
      runCalleesDepth2: callView(
        await tools.callees(runLineTarget, { depth: 2 }), fixture.cwd, dependencyRoot,
      ),
      leafCallersDepth2: callView(
        await tools.callers(leafTarget, { depth: 2 }), fixture.cwd, dependencyRoot,
      ),
      externalDefinitions: locationView(
        await tools.definitions(externalTarget), fixture.cwd, dependencyRoot,
      ),
      externalDependencyDefinitions: locationView(
        await tools.definitions(externalTarget, { includeDependencies: true }), fixture.cwd, dependencyRoot,
      ),
      nonSymbolDefinitions: locationView(
        await tools.definitions(nonSymbolTarget), fixture.cwd, dependencyRoot,
      ),
    };

    assert.deepEqual(actual, golden);
    await assert.rejects(tools.declarations(widgetTarget), {
      message: 'LSP server does not support textDocument/declaration',
    });
  } finally {
    try {
      await session.close();
    } finally {
      sandboxes.cleanup();
    }
  }
});
