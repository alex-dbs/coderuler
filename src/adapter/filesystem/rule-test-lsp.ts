import type { MessagePort } from 'node:worker_threads';

import { createRunLsp } from '../../app/lsp.js';
import type { LspTools } from '../../app/rule.js';
import type { LspBackend, LspBackendFactory, Project } from '../../app/ports.js';

type LspMethod = keyof LspTools;
type RpcMethod = LspMethod | 'close';
type RpcCall<Method extends LspMethod> = {
  readonly id: number;
  readonly method: Method;
  readonly args: Parameters<LspTools[Method]>;
};
type RpcRequest = { [Method in LspMethod]: RpcCall<Method> }[LspMethod]
  | { readonly id: number; readonly method: 'close'; readonly args: [] };
type RpcResponse =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: string };
type RpcArgs<Method extends RpcMethod> = Method extends LspMethod
  ? Parameters<LspTools[Method]>
  : [];
type RpcResult<Method extends RpcMethod> = Method extends LspMethod
  ? Awaited<ReturnType<LspTools[Method]>>
  : void;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function send(port: MessagePort, response: RpcResponse): void {
  try {
    port.postMessage(response);
  } catch {
    // A peer can close its port while an operation is settling.
  }
}

export function createRuleTestLspHost(
  port: MessagePort,
  project: Project,
  createBackend?: LspBackendFactory,
): { close(): Promise<void> } {
  const facade = createRunLsp(project, createBackend);
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const onRequest = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    const candidate = value as { readonly id?: unknown; readonly args?: unknown };
    if (!Number.isSafeInteger(candidate.id) || !Array.isArray(candidate.args)) return;
    const request = value as RpcRequest;
    void (async () => {
      try {
        let result: unknown;
        switch (request.method) {
          case 'definitions': result = await facade.tools.definitions(...request.args); break;
          case 'declarations': result = await facade.tools.declarations(...request.args); break;
          case 'typeDefinitions': result = await facade.tools.typeDefinitions(...request.args); break;
          case 'implementations': result = await facade.tools.implementations(...request.args); break;
          case 'references': result = await facade.tools.references(...request.args); break;
          case 'hover': result = await facade.tools.hover(...request.args); break;
          case 'documentSymbols': result = await facade.tools.documentSymbols(...request.args); break;
          case 'workspaceSymbols': result = await facade.tools.workspaceSymbols(...request.args); break;
          case 'callers': result = await facade.tools.callers(...request.args); break;
          case 'callees': result = await facade.tools.callees(...request.args); break;
          case 'close': await facade.close(); result = undefined; break;
          default: throw new Error('Unsupported rule-test LSP method');
        }
        send(port, { id: request.id, result });
      } catch (error) {
        send(port, { id: request.id, error: describe(error) });
      }
    })();
  };
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    port.off('message', onRequest);
    closePromise = (async () => {
      try {
        await facade.close();
      } finally {
        port.close();
      }
    })();
    return closePromise;
  };
  const onPortClose = (): void => {
    if (!closed) void close().catch(() => undefined);
  };

  port.on('message', onRequest);
  port.once('close', onPortClose);
  port.start();
  return { close };
}

export function createRuleTestLspBackend(port: MessagePort, signal: AbortSignal): LspBackend {
  let nextId = 0;
  let portClosed = false;
  let signalAborted = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const onResponse = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    const candidate = value as { readonly id?: unknown };
    if (!Number.isSafeInteger(candidate.id)) return;
    const response = value as RpcResponse;
    const request = pending.get(response.id);
    if (request === undefined) return;
    pending.delete(response.id);
    if ('error' in response) request.reject(new Error(response.error));
    else request.resolve(response.result);
  };
  const onPortClose = (): void => {
    if (portClosed) return;
    portClosed = true;
    rejectPending(new Error('Rule test LSP host closed'));
  };
  const onAbort = (): void => {
    signalAborted = true;
    rejectPending(signal.reason instanceof Error ? signal.reason : new Error('Rule test LSP backend aborted'));
  };

  port.on('message', onResponse);
  port.once('close', onPortClose);
  port.start();
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  const request = <Method extends RpcMethod>(
    method: Method,
    args: RpcArgs<Method>,
    allowAborted = false,
  ): Promise<RpcResult<Method>> => {
    if (portClosed) return Promise.reject(new Error('Rule test LSP host closed'));
    if (signalAborted && !allowAborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Rule test LSP backend aborted'));
    }
    const id = nextId++;
    const deferred = Promise.withResolvers<RpcResult<Method>>();
    pending.set(id, {
      resolve: value => deferred.resolve(value as RpcResult<Method>),
      reject: deferred.reject,
    });
    try {
      port.postMessage({ id, method, args } as RpcRequest);
    } catch (error) {
      pending.delete(id);
      deferred.reject(error instanceof Error ? error : new Error(describe(error)));
    }
    return deferred.promise;
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      try {
        await request('close', [], true);
      } finally {
        signal.removeEventListener('abort', onAbort);
        port.off('message', onResponse);
        port.off('close', onPortClose);
        port.close();
        onPortClose();
      }
    })();
    return closePromise;
  };

  return {
    definitions: (target, options) => request('definitions', [target, options]),
    declarations: (target, options) => request('declarations', [target, options]),
    typeDefinitions: (target, options) => request('typeDefinitions', [target, options]),
    implementations: (target, options) => request('implementations', [target, options]),
    references: (target, options) => request('references', [target, options]),
    hover: (target, options) => request('hover', [target, options]),
    documentSymbols: (filepath, options) => request('documentSymbols', [filepath, options]),
    workspaceSymbols: (query, options) => request('workspaceSymbols', [query, options]),
    callers: (target, options) => request('callers', [target, options]),
    callees: (target, options) => request('callees', [target, options]),
    close,
  };
}
