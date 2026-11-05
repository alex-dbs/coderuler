import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, type SgNode, type SgRoot } from '@ast-grep/napi';
import {
  ApplyWorkspaceEditRequest,
  CallHierarchyIncomingCallsRequest,
  CallHierarchyOutgoingCallsRequest,
  CallHierarchyPrepareRequest,
  DeclarationRequest,
  DefinitionRequest,
  DidOpenTextDocumentNotification,
  DocumentSymbolRequest,
  ExitNotification,
  HoverRequest,
  ImplementationRequest,
  InitializeRequest,
  InitializedNotification,
  ReferencesRequest,
  ShowMessageRequest,
  ShutdownRequest,
  SymbolKind,
  TypeDefinitionRequest,
  WorkspaceSymbolRequest,
  type ProtocolRequestType,
  type RequestParam,
  type ProtocolConnection,
  type CallHierarchyItem,
  type CallHierarchyIncomingCall,
  type CallHierarchyOutgoingCall,
  type DocumentSymbol,
  type Hover,
  type Location,
  type LocationLink,
  type Position,
  type Range,
  type ServerCapabilities,
  type SymbolInformation,
  type WorkspaceFolder,
  type WorkspaceSymbol,
} from 'vscode-languageserver-protocol';
import { createProtocolConnection } from 'vscode-languageserver-protocol/node';
import type { LspCall, LspCallOptions, LspOptions, LspReferenceOptions, LspTarget, LspTools } from '../../app/rule.js';
import type { LspBackend, Project } from '../../app/ports.js';
import { resolveAstGrepLanguage } from '../scope/astgrep-languages.js';
import { textLineSpan, type LineSpan } from '../scope/lines.js';

interface DeclarationResult {
  readonly source: string;
  readonly lines: LineSpan;
  readonly range: Range;
}

export interface LspServerOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly languageId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
}

interface TextIndex {
  readonly lineStarts: readonly number[];
  readonly lineEnds: readonly number[];
  readonly lineCount: number;
  position(line: number, column: number): Position;
  offset(position: Position): number;
}

interface Document {
  readonly uri: string;
  readonly text: string;
  readonly index: TextIndex;
}

interface SymbolDeclaration {
  readonly name: string;
  readonly kind: number;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly hasFullRange: boolean;
}

interface GraphNode {
  readonly item: CallHierarchyItem;
  readonly depth: number;
}

const DEFAULT_OPTIONS: LspServerOptions = {
  command: 'gopls',
  args: ['serve'],
  languageId: 'go',
};
const MAX_STDERR_BYTES = 8 * 1024;
const SHUTDOWN_GRACE_MS = 2_000;
const AST_DECLARATION_KINDS: Readonly<Record<string, true>> = {
  function_declaration: true,
  method_declaration: true,
  var_declaration: true,
  const_declaration: true,
  type_declaration: true,
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function createTextIndex(text: string): TextIndex {
  const lineStarts = [0];
  const lineEnds: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) {
      lineEnds.push(index);
      if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
      lineStarts.push(index + 1);
    }
  }
  lineEnds.push(text.length);

  const offset = (position: Position): number => {
    if (!Number.isSafeInteger(position.line) || position.line < 0 || position.line >= lineStarts.length) {
      throw new Error(`LSP position line ${position.line + 1} is outside the document`);
    }
    if (!Number.isSafeInteger(position.character) || position.character < 0) {
      throw new Error('LSP position character must be a nonnegative safe integer');
    }
    const start = lineStarts[position.line]!;
    const end = lineEnds[position.line]!;
    if (position.character > end - start) {
      throw new Error(`LSP position column ${position.character + 1} is outside line ${position.line + 1}`);
    }
    return start + position.character;
  };

  return {
    lineStarts,
    lineEnds,
    lineCount: lineStarts.length,
    position(line: number, column: number): Position {
      if (!Number.isSafeInteger(line) || line < 1) {
        throw new Error('LSP line must be a positive safe integer');
      }
      if (!Number.isSafeInteger(column) || column < 1) {
        throw new Error('LSP column must be a positive safe integer');
      }
      const zeroLine = line - 1;
      if (zeroLine >= lineStarts.length) throw new Error(`LSP line ${line} is outside the document`);
      const character = column - 1;
      if (character > lineEnds[zeroLine]! - lineStarts[zeroLine]!) {
        throw new Error(`LSP column ${column} is outside line ${line}`);
      }
      return { line: zeroLine, character };
    },
    offset,
  };
}

function isWithinRoot(root: string, filepath: string): boolean {
  const relativePath = relative(root, filepath);
  if (relativePath === '') return true;
  const firstSegment = relativePath.split(sep)[0];
  return firstSegment !== '..' && !isAbsolute(relativePath);
}

function comparePosition(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function compareRanges(left: Range, right: Range): number {
  return comparePosition(left.start, right.start) || comparePosition(left.end, right.end);
}

function rangeContains(outer: Range, inner: Range): boolean {
  return comparePosition(outer.start, inner.start) <= 0 && comparePosition(outer.end, inner.end) >= 0;
}

function rangeStrictlyContains(outer: Range, inner: Range): boolean {
  return rangeContains(outer, inner) && compareRanges(outer, inner) !== 0;
}

function sameRange(left: Range, right: Range): boolean {
  return compareRanges(left, right) === 0;
}

function normalizeLocations(result: unknown): readonly Location[] {
  if (result === null || result === undefined) return [];
  const values: readonly unknown[] = Array.isArray(result) ? result : [result];
  const normalized: Location[] = [];
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue;
    if ('targetUri' in value && 'targetSelectionRange' in value) {
      const link = value as LocationLink;
      normalized.push({ uri: link.targetUri, range: link.targetSelectionRange });
    } else if ('uri' in value && 'range' in value) {
      normalized.push(value as Location);
    }
  }
  return normalized;
}

function isDocumentSymbol(value: DocumentSymbol | SymbolInformation): value is DocumentSymbol {
  return 'selectionRange' in value;
}

function flattenSymbols(
  symbols: readonly DocumentSymbol[] | readonly SymbolInformation[],
): readonly SymbolDeclaration[] {
  const declarations: SymbolDeclaration[] = [];
  const visit = (symbol: DocumentSymbol): void => {
    declarations.push({
      name: symbol.name,
      kind: symbol.kind,
      range: symbol.range,
      selectionRange: symbol.selectionRange,
      hasFullRange: true,
    });
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) visit(symbol);
    else declarations.push({
      name: symbol.name,
      kind: symbol.kind,
      range: symbol.location.range,
      selectionRange: symbol.location.range,
      hasFullRange: false,
    });
  }
  return declarations;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createError(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

export async function createLspBackend(
  project: Project,
  signal: AbortSignal,
  options?: LspServerOptions,
): Promise<LspBackend> {
  const settings = options ?? DEFAULT_OPTIONS;
  const timeoutMs = settings.requestTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('LSP requestTimeoutMs must be a positive safe integer');
  }
  if (signal.aborted) throw createError('LSP startup was aborted', signal.reason);

  const root = resolve(project.root);
  const rootUri = pathToFileURL(root).href;
  const workspaceFolder: WorkspaceFolder = { uri: rootUri, name: basename(root) };
  const child = spawn(settings.command, [...(settings.args ?? [])], {
    cwd: root,
    env: settings.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = Buffer.alloc(0);
  let terminalError: Error | undefined;
  let initialized = false;
  let closing = false;
  let processClosed = false;
  let releasePromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let connection: ProtocolConnection | undefined;
  let capabilities: ServerCapabilities | undefined;
  const controller = new AbortController();
  const documentPromises = new Map<string, Promise<Document>>();
  const symbolPromises = new Map<string, Promise<readonly DocumentSymbol[] | readonly SymbolInformation[]>>();
  const astPromises = new Map<string, Promise<SgRoot>>();

  const { promise: processClosedPromise, resolve: resolveProcessClosed } = Promise.withResolvers<void>();

  const stderrText = (): string => stderr.toString('utf8').trim();
  const withStderr = (error: unknown): Error => {
    const message = describe(error);
    const detail = stderrText();
    return createError(detail === '' ? message : `${message}\nLSP stderr (latest ${MAX_STDERR_BYTES} bytes):\n${detail}`, error);
  };
  const closedError = (): Error => terminalError ?? new Error('LSP session is closed');

  const cleanup = (graceful: boolean): Promise<void> => {
    if (releasePromise !== undefined) return releasePromise;
    releasePromise = (async (): Promise<void> => {
      if (graceful && initialized && !processClosed && connection !== undefined) {
        const shutdown = (async (): Promise<void> => {
          try {
            await connection!.sendRequest(ShutdownRequest.type);
            await connection!.sendNotification(ExitNotification.type);
          } catch {
            // A bounded process release below handles failed shutdown handshakes.
          }
        })();
        void shutdown.catch(() => undefined);
      } else if (!processClosed) {
        child.kill('SIGTERM');
      }

      if (!processClosed) {
        const { promise: expired, resolve: resolveExpired } = Promise.withResolvers<'timeout'>();
        const releaseTimer = setTimeout(() => resolveExpired('timeout'), SHUTDOWN_GRACE_MS);
        const closed = processClosedPromise.then(() => 'closed' as const);
        const result = await Promise.race([closed, expired]);
        clearTimeout(releaseTimer);
        if (result === 'timeout' && !processClosed) child.kill('SIGKILL');
        if (!processClosed) await processClosedPromise;
      }

      connection?.dispose();
      signal.removeEventListener('abort', onRunAbort);
      child.removeAllListeners('error');
      child.removeAllListeners('close');
      child.stderr?.removeAllListeners('data');
    })();
    return releasePromise;
  };

  const fail = (error: unknown): void => {
    if (terminalError !== undefined || closing) return;
    terminalError = withStderr(error);
    controller.abort(terminalError);
    void cleanup(false).catch(() => undefined);
  };

  const onRunAbort = (): void => {
    if (!closing) fail(createError('LSP session was aborted', signal.reason));
  };
  signal.addEventListener('abort', onRunAbort, { once: true });
  if (signal.aborted) onRunAbort();

  child.stderr?.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderr = Buffer.concat([stderr, bytes]).subarray(-MAX_STDERR_BYTES);
  });
  child.once('error', (error) => {
    fail(createError(`LSP process '${settings.command}' failed: ${describe(error)}`, error));
  });
  child.once('close', (code, processSignal) => {
    processClosed = true;
    resolveProcessClosed();
    if (!closing && terminalError === undefined) {
      fail(createError(`LSP process exited unexpectedly (code ${String(code)}, signal ${String(processSignal)})`));
    }
  });

  const bounded = <T>(method: string, operation: () => Promise<T>): Promise<T> => {
    if (terminalError !== undefined || closing || controller.signal.aborted) {
      return Promise.reject(closedError());
    }
    let abortListener: (() => void) | undefined;
    const { promise: aborted, reject: rejectAbort } = Promise.withResolvers<never>();
    abortListener = (): void => rejectAbort(closedError());
    controller.signal.addEventListener('abort', abortListener, { once: true });

    let operationPromise: Promise<T>;
    try {
      operationPromise = operation();
    } catch (error) {
      operationPromise = Promise.reject(error);
    }

    const { promise: timeout, reject: rejectTimeout } = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      const error = createError(`LSP request ${method} timed out after ${timeoutMs}ms`);
      rejectTimeout(error);
      fail(error);
    }, timeoutMs);
    return Promise.race([operationPromise, aborted, timeout]).finally(() => {
      clearTimeout(timer);
      if (abortListener !== undefined) controller.signal.removeEventListener('abort', abortListener);
    });
  };

  const ensureAvailable = (): void => {
    if (terminalError !== undefined || closing || controller.signal.aborted) throw closedError();
    if (connection === undefined) throw new Error('LSP connection is not initialized');
  };

  const assertCapability = (method: string, capability: keyof ServerCapabilities): void => {
    ensureAvailable();
    if (capabilities?.[capability] === undefined || capabilities[capability] === false) {
      throw new Error(`LSP server does not support ${method}`);
    }
  };

  const request = <P, R, PR, E, RO>(
    type: ProtocolRequestType<P, R, PR, E, RO>,
    method: string,
    params: RequestParam<P>,
    capability?: keyof ServerCapabilities,
  ): Promise<R> => {
    ensureAvailable();
    if (capability !== undefined) assertCapability(method, capability);
    return bounded(method, () => connection!.sendRequest(type, params));
  };

  const notify = (method: string, operation: () => Promise<void>): Promise<void> => {
    ensureAvailable();
    return bounded(method, operation);
  };

  try {
    connection = createProtocolConnection(child.stdout!, child.stdin!);
    connection.onError((details) => {
      const [error, message, code] = details;
      fail(createError(
        `LSP transport failed${message !== undefined && 'method' in message ? ` for ${message.method}` : ''}${code === undefined ? '' : ` (${code})`}: ${describe(error)}`,
        error,
      ));
    });
    connection.onClose(() => {
      if (!closing && terminalError === undefined) fail(new Error('LSP transport closed unexpectedly'));
    });
    connection.onRequest(ApplyWorkspaceEditRequest.type, () => ({
      applied: false,
      failureReason: 'Read-only LSP session',
    }));
    connection.onRequest(ShowMessageRequest.type, () => null);
    connection.listen();

    const initializeResult = await bounded('initialize', () => connection!.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri,
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
      },
      workspaceFolders: [workspaceFolder],
    }));
    capabilities = initializeResult.capabilities;
    await notify('initialized', () => connection!.sendNotification(InitializedNotification.type, {}));
    initialized = true;
  } catch (error) {
    fail(error);
    await cleanup(false).catch(() => undefined);
    throw terminalError ?? withStderr(error);
  }

  const canonicalPathFromUri = (uri: string): string => {
    let filepath: string;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== 'file:') throw new Error(`Unsupported LSP source URI scheme '${parsed.protocol}'`);
      filepath = fileURLToPath(parsed);
    } catch (error) {
      throw createError(`Invalid LSP file URI '${uri}': ${describe(error)}`, error);
    }
    return resolve(filepath);
  };

  const isAllowedUri = (uri: string, includeDependencies: boolean): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch (error) {
      throw createError(`Invalid LSP URI '${uri}': ${describe(error)}`, error);
    }
    if (parsed.protocol !== 'file:') return includeDependencies;
    return includeDependencies || isWithinRoot(root, canonicalPathFromUri(uri));
  };

  const documentForPath = (filepath: string, includeDependencies: boolean): Promise<Document> => {
    const absolute = resolve(root, filepath);
    const relativePath = isWithinRoot(root, absolute) ? relative(root, absolute) : undefined;
    if (relativePath === undefined && !includeDependencies) {
      return Promise.reject(new Error(`LSP source is outside the project: ${filepath}`));
    }
    const uri = pathToFileURL(absolute).href;
    const cached = documentPromises.get(uri);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<Document> => {
      let text: string;
      if (relativePath !== undefined) text = await project.readText(relativePath);
      else {
        const data = await readFile(absolute);
        try {
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
        } catch (error) {
          throw createError(`LSP source '${absolute}' is not valid UTF-8`, error);
        }
      }
      const document: Document = {
        uri,
        text,
        index: createTextIndex(text),
      };
      await notify('textDocument/didOpen', () => connection!.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId: settings.languageId, version: 1, text },
      }));
      return document;
    })();
    documentPromises.set(uri, pending);
    return pending;
  };

  const documentForUri = (uri: string, includeDependencies: boolean): Promise<Document> => {
    if (!isAllowedUri(uri, includeDependencies)) {
      return Promise.reject(new Error(`LSP source is outside the project: ${uri}`));
    }
    if (!uri.startsWith('file:')) {
      return Promise.reject(new Error(`LSP source URI is not a file URI: ${uri}`));
    }
    return documentForPath(canonicalPathFromUri(uri), includeDependencies);
  };


  const filterLocations = (result: unknown, includeDependencies: boolean): readonly Location[] =>
    normalizeLocations(result).filter(location => isAllowedUri(location.uri, includeDependencies));

  const symbolQuery = async (
    document: Document,
    includeDependencies: boolean,
  ): Promise<readonly DocumentSymbol[] | readonly SymbolInformation[]> => {
    assertCapability('textDocument/documentSymbol', 'documentSymbolProvider');
    let pending = symbolPromises.get(document.uri);
    if (pending === undefined) {
      pending = request(DocumentSymbolRequest.type, 'textDocument/documentSymbol', {
        textDocument: { uri: document.uri },
      }, 'documentSymbolProvider').then(result => result ?? []);
      symbolPromises.set(document.uri, pending);
    }
    const symbols = await pending;
    if (symbols.every(isDocumentSymbol)) return symbols;
    return (symbols as readonly SymbolInformation[]).filter(symbol =>
      isAllowedUri(symbol.location.uri, includeDependencies),
    );
  };

  const astFor = (document: Document): Promise<SgRoot> => {
    let pending = astPromises.get(document.uri);
    if (pending === undefined) {
      pending = Promise.resolve().then(() => parse(resolveAstGrepLanguage('go'), document.text));
      astPromises.set(document.uri, pending);
    }
    return pending;
  };
  const astNodeRange = (node: SgNode): Range => {
    const native = node.range();
    return {
      start: { line: native.start.line, character: native.start.column },
      end: { line: native.end.line, character: native.end.column },
    };
  };


  const rangeOffsets = (document: Document, range: Range): { readonly start: number; readonly end: number } => {
    const start = document.index.offset(range.start);
    const end = document.index.offset(range.end);
    if (end < start) throw new Error('LSP source range ends before it starts');
    return { start, end };
  };

  const declarationFromRange = (
    document: Document,
    range: Range,
  ): { readonly source: string; readonly lines: LineSpan } => {
    const { start, end } = rangeOffsets(document, range);
    const source = document.text.slice(start, end);
    if (source.length === 0) throw new Error('LSP declaration range is empty');
    return { source, lines: textLineSpan(range.start.line + 1, source) };
  };

  const bestSymbolRange = (
    document: Document,
    declarations: readonly SymbolDeclaration[],
    selectionRange: Range,
  ): Range | undefined => {
    const completeDeclarations = declarations.filter(symbol => symbol.hasFullRange);
    const exact = completeDeclarations.filter(symbol => sameRange(symbol.selectionRange, selectionRange));
    const matching = exact.length > 0
      ? exact
      : completeDeclarations.filter(symbol => rangeContains(symbol.selectionRange, selectionRange));
    return matching
      .map(symbol => {
        const offsets = rangeOffsets(document, symbol.range);
        return { range: symbol.range, length: offsets.end - offsets.start };
      })
      .sort((left, right) => left.length - right.length || compareRanges(left.range, right.range))[0]?.range;
  };

  const astDeclarationRange = async (document: Document, selectionRange: Range): Promise<{
    readonly range: Range;
    readonly source: string;
    readonly startLine: number;
  } | undefined> => {
    const rootNode = (await astFor(document)).root();
    const selectionStart = selectionRange.start;
    const selectionEnd = selectionRange.end;
    let best: { readonly node: SgNode; readonly range: Range; readonly length: number } | undefined;
    const pendingNodes: SgNode[] = [rootNode];
    while (pendingNodes.length > 0) {
      const node = pendingNodes.pop()!;
      for (const child of node.children()) pendingNodes.push(child);
      if (AST_DECLARATION_KINDS[String(node.kind())] !== true) continue;
      const range = astNodeRange(node);
      if (!rangeContains(range, { start: selectionStart, end: selectionEnd })) continue;
      const offsets = rangeOffsets(document, range);
      const length = offsets.end - offsets.start;
      if (best === undefined || length < best.length) best = { node, range, length };
    }
    if (best === undefined) return undefined;
    const range = astNodeRange(best.node);
    const native = best.node.range();
    return { range, source: best.node.text(), startLine: native.start.line + 1 };
  };

  const declarationSource = async (
    item: CallHierarchyItem,
    includeDependencies: boolean,
  ): Promise<DeclarationResult> => {
    const document = await documentForUri(item.uri, includeDependencies);
    if (settings.languageId === 'go' && item.kind === SymbolKind.Variable) {
      const astDeclaration = await astDeclarationRange(document, item.selectionRange);
      if (astDeclaration !== undefined) {
        return {
          source: astDeclaration.source,
          lines: textLineSpan(astDeclaration.startLine, astDeclaration.source),
          range: astDeclaration.range,
        };
      }
    }
    const documentSymbolProvider = capabilities?.documentSymbolProvider;
    if (documentSymbolProvider !== undefined && documentSymbolProvider !== false) {
      const symbols = await symbolQuery(document, includeDependencies);
      const declarations = flattenSymbols(symbols);
      const symbolRange = bestSymbolRange(document, declarations, item.selectionRange);
      if (symbolRange !== undefined) {
        return { ...declarationFromRange(document, symbolRange), range: symbolRange };
      }
    }

    if (rangeStrictlyContains(item.range, item.selectionRange)) {
      return { ...declarationFromRange(document, item.range), range: item.range };
    }
    if (settings.languageId === 'go') {
      const astDeclaration = await astDeclarationRange(document, item.selectionRange);
      if (astDeclaration !== undefined) {
        return {
          source: astDeclaration.source,
          lines: textLineSpan(astDeclaration.startLine, astDeclaration.source),
          range: astDeclaration.range,
        };
      }
    }
    throw new Error(`Could not find the full declaration for LSP call hierarchy item '${item.name}' at ${item.uri}`);
  };

  const itemIdentity = (item: CallHierarchyItem): string => {
    const filepath = canonicalPathFromUri(item.uri);
    const selection = item.selectionRange;
    return `${filepath}\0${selection.start.line}:${selection.start.character}-${selection.end.line}:${selection.end.character}`;
  };

  const itemPath = (item: CallHierarchyItem): string => {
    const filepath = canonicalPathFromUri(item.uri);
    const relativePath = relative(root, filepath);
    return isWithinRoot(root, filepath) ? relativePath : filepath;
  };

  const symbolsForTarget = async (
    document: Document,
    targetLine: number,
    includeDependencies: boolean,
  ): Promise<readonly SymbolDeclaration[]> => {
    const symbols = flattenSymbols(await symbolQuery(document, includeDependencies));
    const line = targetLine - 1;
    const sortCandidates = (candidates: readonly SymbolDeclaration[]): readonly SymbolDeclaration[] =>
      [...candidates].sort((left, right) => {
        const leftRange = rangeOffsets(document, left.range);
        const rightRange = rangeOffsets(document, right.range);
        const leftSize = leftRange.end - leftRange.start;
        const rightSize = rightRange.end - rightRange.start;
        return leftSize - rightSize ||
          comparePosition(left.selectionRange.start, right.selectionRange.start) ||
          left.kind - right.kind ||
          compareText(left.name, right.name);
      });
    const candidates = symbols.filter(symbol =>
      (settings.languageId !== 'go' || symbol.hasFullRange) &&
      (symbol.kind === SymbolKind.Function || symbol.kind === SymbolKind.Method) &&
      symbol.name.trim() !== '' &&
      symbol.range.start.line <= line &&
      symbol.range.end.line >= line,
    );
    if (candidates.length > 0 || settings.languageId !== 'go') {
      return sortCandidates(candidates);
    }

    const pendingNodes: SgNode[] = [(await astFor(document)).root()];
    const astCandidates: SymbolDeclaration[] = [];
    while (pendingNodes.length > 0) {
      const node = pendingNodes.pop()!;
      for (const child of node.children()) pendingNodes.push(child);
      const nodeKind = String(node.kind());
      if (
        nodeKind !== 'function_declaration' &&
        nodeKind !== 'method_declaration' &&
        nodeKind !== 'method_elem'
      ) continue;
      const range = astNodeRange(node);
      if (range.start.line > line || range.end.line < line) continue;
      const nameNode = node.field('name');
      if (nameNode === null) continue;
      const name = nameNode.text();
      if (name.trim() === '') continue;
      astCandidates.push({
        name,
        kind: nodeKind === 'function_declaration' ? SymbolKind.Function : SymbolKind.Method,
        range,
        selectionRange: astNodeRange(nameNode),
        hasFullRange: true,
      });
    }
    return sortCandidates(astCandidates);
  };

  const prepareRoots = async (
    target: LspTarget,
    includeDependencies: boolean,
  ): Promise<readonly CallHierarchyItem[]> => {
    const document = await documentForPath(target.filepath, includeDependencies);
    let position: Position;
    if (target.column !== undefined) position = document.index.position(target.line, target.column);
    else {
      if (!Number.isSafeInteger(target.line) || target.line < 1 || target.line > document.index.lineCount) {
        throw new Error(`LSP line ${target.line} is outside the document`);
      }
      const candidates = await symbolsForTarget(document, target.line, includeDependencies);
      if (candidates.length === 0) return [];
      position = candidates[0]!.selectionRange.start;
    }
    const prepared = await request(CallHierarchyPrepareRequest.type, 'textDocument/prepareCallHierarchy', {
      textDocument: { uri: document.uri },
      position,
    }, 'callHierarchyProvider');
    return prepared ?? [];
  };

  const traverse = async (
    target: LspTarget,
    options: LspCallOptions,
    direction: 'callers' | 'callees',
  ): Promise<readonly LspCall[]> => {
    if (!Number.isSafeInteger(options.depth) || options.depth < 0) {
      throw new Error('LSP call depth must be a nonnegative safe integer');
    }
    if (options.depth === 0) return [];
    const includeDependencies = options.includeDependencies === true;
    const roots = await prepareRoots(target, includeDependencies);
    if (roots.length === 0) return [];
    const permittedRoots = roots.filter(item => isAllowedUri(item.uri, includeDependencies));
    const rootIdentities = new Set(permittedRoots.map(itemIdentity));
    const accepted = new Map<string, GraphNode>();
    const expanded = new Set<string>();
    const queue: GraphNode[] = [];

    for (const item of permittedRoots) {
      const identity = itemIdentity(item);
      if (!expanded.has(identity)) {
        expanded.add(identity);
        queue.push({ item, depth: 0 });
      }
    }

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!;
      if (current.depth >= options.depth) continue;
      const response: readonly (CallHierarchyIncomingCall | CallHierarchyOutgoingCall)[] = direction === 'callers'
        ? (await request(CallHierarchyIncomingCallsRequest.type, 'callHierarchy/incomingCalls', { item: current.item }, 'callHierarchyProvider')) ?? []
        : (await request(CallHierarchyOutgoingCallsRequest.type, 'callHierarchy/outgoingCalls', { item: current.item }, 'callHierarchyProvider')) ?? [];
      for (const edge of response) {
        const item = direction === 'callers'
          ? (edge as CallHierarchyIncomingCall).from
          : (edge as CallHierarchyOutgoingCall).to;
        if (!isAllowedUri(item.uri, includeDependencies)) continue;
        const identity = itemIdentity(item);
        const depth = current.depth + 1;
        if (!rootIdentities.has(identity)) {
          const previous = accepted.get(identity);
          if (previous === undefined || depth < previous.depth) accepted.set(identity, { item, depth });
        }
        if (!expanded.has(identity)) {
          expanded.add(identity);
          queue.push({ item, depth });
        }
      }
    }

    const results: { readonly call: LspCall; readonly declarationPosition: Position }[] = [];
    for (const node of accepted.values()) {
      const declaration = await declarationSource(node.item, includeDependencies);
      results.push({
        call: {
          name: node.item.name,
          filepath: itemPath(node.item),
          source: declaration.source,
          lines: declaration.lines,
          depth: node.depth,
        },
        declarationPosition: declaration.range.start,
      });
    }
    results.sort((left, right) =>
      left.call.depth - right.call.depth ||
      compareText(left.call.filepath, right.call.filepath) ||
      comparePosition(left.declarationPosition, right.declarationPosition) ||
      compareText(left.call.name, right.call.name),
    );
    return results.map(result => result.call);
  };

  const navigate = async (
    method: string,
    capability: keyof ServerCapabilities,
    type: ProtocolRequestType<unknown, unknown, unknown, unknown, unknown>,
    target: LspTarget,
    options?: LspOptions,
  ): Promise<readonly Location[]> => {
    const includeDependencies = options?.includeDependencies === true;
    const document = await documentForPath(target.filepath, includeDependencies);
    const position = document.index.position(target.line, target.column ?? 1);
    const result = await request(type, method, {
      textDocument: { uri: document.uri },
      position,
    }, capability);
    return filterLocations(result, includeDependencies);
  };

  const tools: LspTools = {
    definitions: (target: LspTarget, options?: LspOptions) =>
      navigate('textDocument/definition', 'definitionProvider', DefinitionRequest.type, target, options),
    declarations: (target: LspTarget, options?: LspOptions) =>
      navigate('textDocument/declaration', 'declarationProvider', DeclarationRequest.type, target, options),
    typeDefinitions: (target: LspTarget, options?: LspOptions) =>
      navigate('textDocument/typeDefinition', 'typeDefinitionProvider', TypeDefinitionRequest.type, target, options),
    implementations: (target: LspTarget, options?: LspOptions) =>
      navigate('textDocument/implementation', 'implementationProvider', ImplementationRequest.type, target, options),
    references: async (target: LspTarget, options?: LspReferenceOptions) => {
      const includeDependencies = options?.includeDependencies === true;
      const document = await documentForPath(target.filepath, includeDependencies);
      const position = document.index.position(target.line, target.column ?? 1);
      const result = await request(ReferencesRequest.type, 'textDocument/references', {
        textDocument: { uri: document.uri },
        position,
        context: { includeDeclaration: options?.includeDeclaration ?? false },
      }, 'referencesProvider');
      return filterLocations(result, includeDependencies);
    },
    hover: async (target: LspTarget, options?: LspOptions): Promise<Hover | null> => {
      const includeDependencies = options?.includeDependencies === true;
      const document = await documentForPath(target.filepath, includeDependencies);
      const position = document.index.position(target.line, target.column ?? 1);
      const result = await request(HoverRequest.type, 'textDocument/hover', {
        textDocument: { uri: document.uri },
        position,
      }, 'hoverProvider');
      return result ?? null;
    },
    documentSymbols: async (filepath: string, options?: LspOptions) => {
      const document = await documentForPath(filepath, options?.includeDependencies === true);
      return symbolQuery(document, options?.includeDependencies === true);
    },
    workspaceSymbols: async (query: string, options?: LspOptions): Promise<readonly (SymbolInformation | WorkspaceSymbol)[]> => {
      if (query.length === 0) return [];
      const result = await request(WorkspaceSymbolRequest.type, 'workspace/symbol', { query }, 'workspaceSymbolProvider');
      const includeDependencies = options?.includeDependencies === true;
      return (result ?? []).filter(symbol => isAllowedUri(symbol.location.uri, includeDependencies));
    },
    callers: (target: LspTarget, options: LspCallOptions) => traverse(target, options, 'callers'),
    callees: (target: LspTarget, options: LspCallOptions) => traverse(target, options, 'callees'),
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closing = true;
    controller.abort(new Error('LSP session is closed'));
    closePromise = cleanup(initialized && terminalError === undefined);
    return closePromise;
  };

  return { ...tools, close };
}
