import { spawn } from 'node:child_process';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SymbolKind,
  type CallHierarchyIncomingCall,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type Location,
  type Position,
  type Range,
} from 'vscode-languageserver-protocol';
import type { LspTarget } from '../../app/rule.js';
import type { Project } from '../../app/ports.js';

interface ParsedMethod {
  readonly name: string;
  readonly range: Range;
  readonly selectionRange: Range;
}

interface ParsedCall {
  readonly name: string;
  readonly range: Range;
  readonly owner: number | null;
  readonly attributeWrite: boolean;
}

interface ParsedDocument {
  readonly uri: string;
  readonly methods: readonly ParsedMethod[];
  readonly calls: readonly ParsedCall[];
}

interface SourceDocument {
  readonly uri: string;
  readonly text: string;
  readonly lineCount: number;
  position(line: number, column: number): Position;
  offset(position: Position): number;
}

interface HelperFile {
  readonly uri: string;
  readonly source: string;
}

interface RubyCallGraphOptions {
  readonly project: Project;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly documentForPath: (filepath: string, includeDependencies: boolean) => Promise<SourceDocument>;
  readonly resolveDefinitions: (
    uri: string,
    position: Position,
    includeDependencies: boolean,
  ) => Promise<readonly Location[]>;
}

interface RubyCallGraph {
  roots(target: LspTarget, includeDependencies: boolean): Promise<readonly CallHierarchyItem[]>;
  incoming(item: CallHierarchyItem, includeDependencies: boolean): Promise<readonly CallHierarchyIncomingCall[]>;
  outgoing(item: CallHierarchyItem, includeDependencies: boolean): Promise<readonly CallHierarchyOutgoingCall[]>;
  close(): Promise<void>;
}

const MAX_STDERR_BYTES = 8 * 1024;
const HELPER_KILL_GRACE_MS = 250;

type HelperRequest =
  | { readonly action: 'parse'; readonly files: readonly HelperFile[] }
  | { readonly action: 'dependencies' };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function comparePosition(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function rangeContainsPosition(range: Range, position: Position): boolean {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) < 0;
}

function sameRange(left: Range, right: Range): boolean {
  return comparePosition(left.start, right.start) === 0 && comparePosition(left.end, right.end) === 0;
}

function isPosition(value: unknown): value is Position {
  if (
    typeof value !== 'object' || value === null || !('line' in value) || !('character' in value) ||
    typeof value.line !== 'number' || typeof value.character !== 'number'
  ) return false;
  return Number.isSafeInteger(value.line) && Number.isSafeInteger(value.character);
}

function isRange(value: unknown): value is Range {
  if (typeof value !== 'object' || value === null || !('start' in value) || !('end' in value)) return false;
  return isPosition(value.start) && isPosition(value.end);
}

function parsedDocument(value: unknown): ParsedDocument {
  if (
    typeof value !== 'object' || value === null ||
    !('uri' in value) || typeof value.uri !== 'string' ||
    !('methods' in value) || !Array.isArray(value.methods) ||
    !('calls' in value) || !Array.isArray(value.calls)
  ) throw new Error('Ruby call graph helper returned an invalid document');
  const methods = value.methods.map((method: unknown) => {
    if (
      typeof method !== 'object' || method === null || !('name' in method) || typeof method.name !== 'string' ||
      !('range' in method) || !isRange(method.range) ||
      !('selectionRange' in method) || !isRange(method.selectionRange)
    ) throw new Error(`Ruby call graph helper returned an invalid method in '${value.uri}'`);
    return { name: method.name, range: method.range, selectionRange: method.selectionRange };
  });
  const calls = value.calls.map((call: unknown) => {
    if (
      typeof call !== 'object' || call === null || !('name' in call) || typeof call.name !== 'string' ||
      !('range' in call) || !isRange(call.range) ||
      !('owner' in call) || (call.owner !== null && (typeof call.owner !== 'number' || !Number.isSafeInteger(call.owner))) ||
      !('attributeWrite' in call) || typeof call.attributeWrite !== 'boolean'
    ) throw new Error(`Ruby call graph helper returned an invalid call in '${value.uri}'`);
    return { name: call.name, range: call.range, owner: call.owner, attributeWrite: call.attributeWrite };
  });
  return { uri: value.uri, methods, calls };
}

function helperResponse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error('Ruby call graph helper returned invalid JSON', { cause: error });
  }
}

function itemForMethod(document: ParsedDocument, method: ParsedMethod): CallHierarchyItem {
  return {
    name: method.name,
    kind: SymbolKind.Method,
    uri: document.uri,
    range: method.range,
    selectionRange: method.selectionRange,
  };
}

function methodKey(uri: string, selectionRange: Range): string {
  let source = uri;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'file:') source = resolve(fileURLToPath(parsed));
  } catch {
    // Keep malformed or non-file URIs distinct.
  }
  return `${source}\0${selectionRange.start.line}:${selectionRange.start.character}-${selectionRange.end.line}:${selectionRange.end.character}`;
}

export function createRubyCallGraph(options: RubyCallGraphOptions): RubyCallGraph {
  const { project, root, signal, timeoutMs } = options;
  const helperPath = fileURLToPath(new URL('./ruby-calls.rb', import.meta.url));
  const parsePromises = new Map<string, Promise<ParsedDocument>>();
  const definitionPromises = new Map<string, Promise<readonly Location[]>>();
  const activeHelpers = new Set<Promise<unknown>>();
  let helperEnvironment: Promise<{ readonly env: NodeJS.ProcessEnv | undefined; readonly bundled: boolean }> | undefined;
  let projectSources: Promise<readonly SourceDocument[]> | undefined;
  let dependencySources: Promise<readonly SourceDocument[]> | undefined;

  const environmentForHelper = (): Promise<{ readonly env: NodeJS.ProcessEnv | undefined; readonly bundled: boolean }> => {
    helperEnvironment ??= (async () => {
      const baseEnvironment = options.env ?? process.env;
      const composed = await project.stat('.ruby-lsp/Gemfile');
      if (composed?.kind === 'file') {
        const env = { ...baseEnvironment, BUNDLE_GEMFILE: resolve(root, '.ruby-lsp/Gemfile') };
        return { env, bundled: true };
      }
      if (baseEnvironment.BUNDLE_GEMFILE !== undefined) {
        return { env: options.env, bundled: true };
      }
      const projectGemfile = await project.stat('Gemfile');
      if (projectGemfile?.kind === 'file') {
        const env = { ...baseEnvironment, BUNDLE_GEMFILE: resolve(root, 'Gemfile') };
        return { env, bundled: true };
      }
      return { env: options.env, bundled: false };
    })();
    return helperEnvironment;
  };

  const runHelper = async (request: HelperRequest): Promise<unknown> => {
    if (signal.aborted) throw new Error('Ruby call graph helper was aborted', { cause: signal.reason });
    const environment = await environmentForHelper();
    if (signal.aborted) throw new Error('Ruby call graph helper was aborted', { cause: signal.reason });
    const args = environment.bundled ? ['-rbundler/setup', helperPath] : [helperPath];
    const child = spawn('ruby', args, {
      cwd: root,
      env: environment.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result = Promise.withResolvers<unknown>();
    activeHelpers.add(result.promise);
    void result.promise.then(
      () => activeHelpers.delete(result.promise),
      () => activeHelpers.delete(result.promise),
    );
    {
      const stdout: Buffer[] = [];
      let stderr = Buffer.alloc(0);
      let failure: Error | undefined;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => terminate(new Error(`Ruby call graph helper timed out after ${timeoutMs}ms`)), timeoutMs);
      const abort = (): void => terminate(new Error('Ruby call graph helper was aborted', { cause: signal.reason }));
      const cleanUp = (): void => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
      };
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanUp();
        if (error !== undefined) result.reject(error);
        else result.resolve(value);
      };
      const terminate = (error: Error): void => {
        if (failure === undefined) failure = error;
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          child.kill('SIGTERM');
        } catch {
          // The close event reports the final process state.
        }
        killTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, HELPER_KILL_GRACE_MS);
      };

      signal.addEventListener('abort', abort, { once: true });
      child.stdout!.on('data', (chunk: Buffer | string) => {
        stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr!.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderr = Buffer.concat([stderr, bytes]).subarray(-MAX_STDERR_BYTES);
      });
      child.once('error', error => {
        const processError = new Error(`Ruby call graph helper failed to start: ${describe(error)}`, { cause: error });
        if (child.pid === undefined) finish(processError);
        else terminate(processError);
      });
      child.once('close', (code, processSignal) => {
        if (failure !== undefined) {
          finish(failure);
          return;
        }
        if (code !== 0) {
          const details = stderr.toString('utf8').trim();
          finish(new Error(
            details === ''
              ? `Ruby call graph helper exited with code ${String(code)} and signal ${String(processSignal)}`
              : `Ruby call graph helper exited with code ${String(code)} and signal ${String(processSignal)}\n${details}`,
          ));
          return;
        }
        try {
          finish(undefined, helperResponse(Buffer.concat(stdout).toString('utf8')));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(describe(error), { cause: error }));
        }
      });
      child.stdin!.once('error', error => terminate(new Error(`Could not send data to Ruby call graph helper: ${describe(error)}`, { cause: error })));
      child.stdin!.end(JSON.stringify(request));
    }
    return result.promise;
  };

  const parseDocuments = (sources: readonly SourceDocument[]): Promise<readonly ParsedDocument[]> => {
    const unique = new Map(sources.map(source => [source.uri, source]));
    const pending: {
      readonly source: SourceDocument;
      readonly resolve: (document: ParsedDocument) => void;
      readonly reject: (error: unknown) => void;
    }[] = [];
    for (const source of unique.values()) {
      if (parsePromises.has(source.uri)) continue;
      const deferred = Promise.withResolvers<ParsedDocument>();
      parsePromises.set(source.uri, deferred.promise);
      pending.push({ source, resolve: deferred.resolve, reject: deferred.reject });
    }

    if (pending.length > 0) {
      const batch = (async (): Promise<ReadonlyMap<string, ParsedDocument>> => {
        const response = await runHelper({
          action: 'parse',
          files: pending.map(({ source }) => ({ uri: source.uri, source: source.text })),
        });
        if (
          typeof response !== 'object' || response === null ||
          !('documents' in response) || !Array.isArray(response.documents)
        ) throw new Error('Ruby call graph helper returned an invalid parse response');
        const documents = response.documents.map(parsedDocument);
        const byUri = new Map(documents.map(document => [document.uri, document]));
        for (const { source } of pending) {
          if (!byUri.has(source.uri)) throw new Error(`Ruby call graph helper omitted '${source.uri}'`);
        }
        return byUri;
      })();
      void batch.then(
        documents => {
          for (const entry of pending) entry.resolve(documents.get(entry.source.uri)!);
        },
        error => {
          for (const entry of pending) entry.reject(error);
        },
      );
    }

    return Promise.all([...unique.keys()].map(uri => parsePromises.get(uri)!));
  };

  const parsedForPath = async (filepath: string, includeDependencies: boolean): Promise<{
    readonly source: SourceDocument;
    readonly parsed: ParsedDocument;
  }> => {
    const source = await options.documentForPath(filepath, includeDependencies);
    const [parsed] = await parseDocuments([source]);
    return { source, parsed: parsed! };
  };

  const sourceForItem = async (item: CallHierarchyItem, includeDependencies: boolean): Promise<{
    readonly parsed: ParsedDocument;
    readonly method: ParsedMethod;
  } | undefined> => {
    let filepath: string;
    try {
      const uri = new URL(item.uri);
      if (uri.protocol !== 'file:') return undefined;
      filepath = fileURLToPath(uri);
    } catch {
      return undefined;
    }
    const { parsed } = await parsedForPath(filepath, includeDependencies);
    const method = parsed.methods.find(candidate => sameRange(candidate.selectionRange, item.selectionRange));
    return method === undefined ? undefined : { parsed, method };
  };

  const definitionsAt = (uri: string, position: Position, includeDependencies: boolean): Promise<readonly Location[]> => {
    const key = `${uri}\0${position.line}:${position.character}\0${includeDependencies ? '1' : '0'}`;
    let pending = definitionPromises.get(key);
    if (pending === undefined) {
      pending = Promise.resolve().then(() => options.resolveDefinitions(uri, position, includeDependencies));
      definitionPromises.set(key, pending);
    }
    return pending;
  };

  const methodsForLocations = async (
    locations: readonly Location[],
    includeDependencies: boolean,
  ): Promise<readonly CallHierarchyItem[]> => {
    const items = new Map<string, CallHierarchyItem>();
    for (const location of locations) {
      let filepath: string;
      try {
        const uri = new URL(location.uri);
        if (uri.protocol !== 'file:') continue;
        filepath = fileURLToPath(uri);
      } catch {
        continue;
      }
      // Ruby LSP can resolve builtin methods to RBS declarations, which Prism cannot parse.
      if (extname(filepath) !== '.rb') continue;
      const { parsed } = await parsedForPath(filepath, includeDependencies);
      for (const method of parsed.methods) {
        if (!sameRange(method.selectionRange, location.range)) continue;
        const item = itemForMethod(parsed, method);
        items.set(methodKey(item.uri, item.selectionRange), item);
      }
    }
    return [...items.values()];
  };

  const resolveCall = async (
    document: ParsedDocument,
    call: ParsedCall,
    includeDependencies: boolean,
  ): Promise<readonly CallHierarchyItem[]> => {
    const locations = await definitionsAt(document.uri, call.range.start, includeDependencies);
    const methods = await methodsForLocations(locations, includeDependencies);
    return call.attributeWrite
      ? methods.filter(method => method.name === call.name)
      : methods;
  };
  const documentsForScan = async (includeDependencies: boolean): Promise<readonly SourceDocument[]> => {
    projectSources ??= project.glob('**/*.rb').then(paths => Promise.all(
      [...new Set(paths)].sort().map(filepath => options.documentForPath(filepath, false)),
    ));
    const projectDocuments = await projectSources;
    if (!includeDependencies) return projectDocuments;

    dependencySources ??= (async () => {
      const response = await runHelper({ action: 'dependencies' });
      if (
        typeof response !== 'object' || response === null ||
        !('paths' in response) || !Array.isArray(response.paths)
      ) throw new Error('Ruby call graph helper returned an invalid dependency response');
      const paths: string[] = [];
      for (const path of response.paths) {
        if (typeof path !== 'string' || !isAbsolute(path) || extname(path) !== '.rb') {
          throw new Error('Ruby call graph helper returned an invalid dependency path');
        }
        paths.push(path);
      }
      return Promise.all([...new Set(paths)].sort().map(filepath => options.documentForPath(filepath, true)));
    })();
    return [...projectDocuments, ...await dependencySources];
  };

  const roots = async (target: LspTarget, includeDependencies: boolean): Promise<readonly CallHierarchyItem[]> => {
    const { source, parsed } = await parsedForPath(target.filepath, includeDependencies);
    if (target.column === undefined) {
      if (!Number.isSafeInteger(target.line) || target.line < 1 || target.line > source.lineCount) {
        throw new Error(`LSP line ${target.line} is outside the document`);
      }
      const line = target.line - 1;
      const candidates = parsed.methods.filter(method => method.range.start.line <= line && method.range.end.line >= line);
      candidates.sort((left, right) => {
        const leftSize = source.offset(left.range.end) - source.offset(left.range.start);
        const rightSize = source.offset(right.range.end) - source.offset(right.range.start);
        return leftSize - rightSize || comparePosition(left.range.start, right.range.start);
      });
      return candidates[0] === undefined ? [] : [itemForMethod(parsed, candidates[0])];
    }

    const position = source.position(target.line, target.column);
    const calls = parsed.calls.filter(call => rangeContainsPosition(call.range, position));
    calls.sort((left, right) =>
      source.offset(left.range.end) - source.offset(left.range.start) -
      (source.offset(right.range.end) - source.offset(right.range.start)),
    );
    const selectedCall = calls[0];
    if (selectedCall !== undefined) return resolveCall(parsed, selectedCall, includeDependencies);

    const methods = parsed.methods.filter(method => rangeContainsPosition(method.selectionRange, position));
    const candidates = methods.length > 0
      ? methods
      : parsed.methods.filter(method => rangeContainsPosition(method.range, position));
    candidates.sort((left, right) =>
      source.offset(left.range.end) - source.offset(left.range.start) -
      (source.offset(right.range.end) - source.offset(right.range.start)),
    );
    return candidates[0] === undefined ? [] : [itemForMethod(parsed, candidates[0])];
  };

  const outgoing = async (
    item: CallHierarchyItem,
    includeDependencies: boolean,
  ): Promise<readonly CallHierarchyOutgoingCall[]> => {
    const owner = await sourceForItem(item, includeDependencies);
    if (owner === undefined) return [];
    const ownerIndex = owner.parsed.methods.indexOf(owner.method);
    const calls = owner.parsed.calls.filter(call => call.owner === ownerIndex);
    const edges = new Map<string, CallHierarchyOutgoingCall>();
    for (const call of calls) {
      for (const target of await resolveCall(owner.parsed, call, includeDependencies)) {
        const key = methodKey(target.uri, target.selectionRange);
        edges.set(key, { to: target, fromRanges: [call.range] });
      }
    }
    return [...edges.values()];
  };

  const incoming = async (
    item: CallHierarchyItem,
    includeDependencies: boolean,
  ): Promise<readonly CallHierarchyIncomingCall[]> => {
    const target = await sourceForItem(item, includeDependencies);
    if (target === undefined) return [];
    const targetKey = methodKey(target.parsed.uri, target.method.selectionRange);
    const documents = await documentsForScan(includeDependencies);
    const parsedDocuments = await parseDocuments(documents);
    const callers = new Map<string, CallHierarchyIncomingCall>();
    for (const document of parsedDocuments) {
      for (const call of document.calls) {
        if (call.name !== target.method.name || call.owner === null) continue;
        const owner = document.methods[call.owner];
        if (owner === undefined) continue;
        const locations = await definitionsAt(document.uri, call.range.start, includeDependencies);
        const resolvesToTarget = locations.some(location => methodKey(location.uri, location.range) === targetKey);
        if (!resolvesToTarget) continue;
        const caller = itemForMethod(document, owner);
        callers.set(methodKey(caller.uri, caller.selectionRange), { from: caller, fromRanges: [call.range] });
      }
    }
    return [...callers.values()];
  };
  const close = async (): Promise<void> => {
    await Promise.allSettled([...activeHelpers]);
  };
  return { roots, incoming, outgoing, close };
}
