import type {
  DocumentSymbol,
  Hover,
  Location,
  LspCall,
  LspCallOptions,
  LspOptions,
  LspReferenceOptions,
  LspTarget,
  LspTools,
  SymbolInformation,
  WorkspaceSymbol,
} from './rule.js';
import type { LspBackend, LspBackendFactory, Project } from './ports.js';

export function createRunLsp(
  project: Project,
  createBackend?: LspBackendFactory,
): { readonly tools: LspTools; close(): Promise<void> } {
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let startup: Promise<LspBackend> | undefined;
  let backend: LspBackend | undefined;
  let backendClose: Promise<void> | undefined;
  let closeFailure: unknown;
  let hasCloseFailure = false;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const closedError = (): Error => new Error('LSP session is closed');

  const closeBackend = (owned: LspBackend): Promise<void> => {
    if (backendClose === undefined) {
      backendClose = Promise.resolve().then(() => owned.close());
      void backendClose.catch(error => {
        closeFailure = error;
        hasCloseFailure = true;
      });
    }
    return backendClose;
  };

  const getBackend = (): Promise<LspBackend> => {
    if (closed) return Promise.reject(closedError());
    if (startup !== undefined) return startup;

    if (createBackend === undefined) {
      startup = Promise.reject(new Error('LSP is not configured for this run'));
      void startup.catch(() => undefined);
      return startup;
    }

    startup = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw closedError();
      const created = await createBackend(project, controller.signal);
      backend = created;
      if (closed) {
        await closeBackend(created);
        throw closedError();
      }
      return created;
    });
    void startup.catch(() => undefined);
    return startup;
  };

  const observe = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const rejectCall = <T>(error: unknown): Promise<T> => observe(Promise.reject(error));

  const invoke = <T>(operation: (active: LspBackend) => Promise<T>): Promise<T> =>
    observe(Promise.resolve().then(async () => {
      if (closed) throw closedError();
      const active = await getBackend();
      if (closed || controller.signal.aborted) throw closedError();
      return operation(active);
    }));

  const validateTarget = (target: LspTarget): void => {
    if (!Number.isSafeInteger(target.line) || target.line < 1) {
      throw new Error('LSP line must be a positive safe integer');
    }
    if (target.column !== undefined && (!Number.isSafeInteger(target.column) || target.column < 1)) {
      throw new Error('LSP column must be a positive safe integer');
    }
  };

  const withTarget = <T>(
    target: LspTarget,
    operation: (active: LspBackend) => Promise<T>,
  ): Promise<T> => {
    if (closed) return rejectCall(closedError());
    try {
      validateTarget(target);
    } catch (error) {
      return rejectCall(error);
    }
    return invoke(operation);
  };

  const withGraph = (
    target: LspTarget,
    options: LspCallOptions,
    operation: (active: LspBackend) => Promise<readonly LspCall[]>,
  ): Promise<readonly LspCall[]> => {
    if (closed) return rejectCall(closedError());
    if (!Number.isSafeInteger(options.depth) || options.depth < 0) {
      return rejectCall(new Error('LSP call depth must be a nonnegative safe integer'));
    }
    try {
      validateTarget(target);
    } catch (error) {
      return rejectCall(error);
    }
    if (options.depth === 0) return Promise.resolve([]);
    return invoke(operation);
  };

  const tools: LspTools = {
    definitions: (target: LspTarget, options?: LspOptions): Promise<readonly Location[]> =>
      withTarget(target, active => active.definitions(target, options)),
    declarations: (target: LspTarget, options?: LspOptions): Promise<readonly Location[]> =>
      withTarget(target, active => active.declarations(target, options)),
    typeDefinitions: (target: LspTarget, options?: LspOptions): Promise<readonly Location[]> =>
      withTarget(target, active => active.typeDefinitions(target, options)),
    implementations: (target: LspTarget, options?: LspOptions): Promise<readonly Location[]> =>
      withTarget(target, active => active.implementations(target, options)),
    references: (target: LspTarget, options?: LspReferenceOptions): Promise<readonly Location[]> =>
      withTarget(target, active => active.references(target, options)),
    hover: (target: LspTarget, options?: LspOptions): Promise<Hover | null> =>
      withTarget(target, active => active.hover(target, options)),
    documentSymbols: (
      filepath: string,
      options?: LspOptions,
    ): Promise<readonly DocumentSymbol[] | readonly SymbolInformation[]> =>
      invoke(active => active.documentSymbols(filepath, options)),
    workspaceSymbols: (
      query: string,
      options?: LspOptions,
    ): Promise<readonly (SymbolInformation | WorkspaceSymbol)[]> => {
      if (closed) return rejectCall(closedError());
      return query.length === 0 ? Promise.resolve([]) : invoke(active => active.workspaceSymbols(query, options));
    },
    callers: (target: LspTarget, options: LspCallOptions): Promise<readonly LspCall[]> =>
      withGraph(target, options, active => active.callers(target, options)),
    callees: (target: LspTarget, options: LspCallOptions): Promise<readonly LspCall[]> =>
      withGraph(target, options, active => active.callees(target, options)),
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    controller.abort();
    closePromise = Promise.resolve().then(async () => {
      if (startup !== undefined) {
        try {
          backend = await startup;
        } catch {
          // The request reports startup failures. There is no backend to close.
        }
      }
      if (backend !== undefined) {
        try {
          await closeBackend(backend);
        } catch {
          // Preserve the close failure after pending calls settle.
        }
      }
      await Promise.allSettled([...pending]);
      if (hasCloseFailure) throw closeFailure;
    });
    void closePromise.catch(() => undefined);
    return closePromise;
  };

  return { tools, close };
}
