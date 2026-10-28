import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DiffChanges } from '../../app/ports.js';
import type { LineRange } from '../../app/rule.js';
import { traversablePath } from '../filesystem/project.js';

interface RawRecord {
  readonly oldMode: string;
  readonly newMode: string;
  readonly status: string;
  readonly path: string;
}

interface ParsedBlock {
  ranges: LineRange[];
  binary: boolean;
  hunk: { oldExpected: number; newExpected: number; oldSeen: number; newSeen: number } | undefined;
}

const INVALID_DIFF = 'Cannot collect changed lines: invalid Git diff output.';
const CONFLICTS = 'Cannot collect changed lines: resolve Git conflicts first.';

async function git(
  root: string,
  args: readonly string[],
  consume: (chunk: string) => void,
  env?: Readonly<Record<string, string | undefined>>,
  stdin?: string,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn('git', [...args], {
    cwd: root,
    env,
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let parserError: unknown;
  let stdinError: Error | undefined;
  let settled = false;
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    if (parserError !== undefined) return;
    try {
      consume(chunk);
    } catch (error) {
      parserError = error;
    }
  });
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
  child.stdin?.on('error', error => { stdinError = error; });
  child.on('error', error => {
    if (settled) return;
    settled = true;
    reject(new Error(`Cannot run Git: ${error.message}`, { cause: error }));
  });
  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    if (parserError !== undefined) reject(parserError);
    else if (stdinError !== undefined) reject(new Error(`Cannot write to Git stdin: ${stdinError.message}`, { cause: stdinError }));
    else if (code === 0) resolve();
    else reject(new Error(`Git ${args[0]} failed: ${stderr.trim() || signal || `exit ${code}`}`));
  });
  if (stdin !== undefined) child.stdin!.end(stdin);
  return promise;
}

function invalidDiff(): Error {
  return new Error(INVALID_DIFF);
}

class DiffParser {
  private phase: 'metadata' | 'path' | 'patch' = 'metadata';
  private readonly records: RawRecord[] = [];
  private pendingMode: Pick<RawRecord, 'oldMode' | 'newMode' | 'status'> | undefined;

  private nulPending = '';
  private patchPending = '';
  private expectedBlocks = 0;
  private currentBlock: ParsedBlock | undefined;
  private readonly selectedBlocks: ParsedBlock[] = [];
  private rawIndex = 0;
  private blockIndex = 0;
  private typeDelete = false;

  consume(chunk: string): void {
    let rest = chunk;
    if (this.phase !== 'patch') {
      const patch = this.consumeRaw(rest);
      if (patch === undefined) return;
      rest = patch;
    }
    const text = this.patchPending + rest;

    let lineStart = 0;
    let newline: number;
    while ((newline = text.indexOf('\n', lineStart)) !== -1) {
      this.consumePatchLine(text.slice(lineStart, newline).replace(/\r$/, ''));
      lineStart = newline + 1;
    }
    this.patchPending = text.slice(lineStart);
  }

  finish(): readonly ParsedBlock[] {
    if (this.phase === 'metadata' && this.nulPending !== '' || this.phase === 'path') throw invalidDiff();
    if (this.phase === 'metadata' && this.records.length === 0 && this.nulPending === '') return [];
    if (this.phase !== 'patch') throw invalidDiff();
    if (this.patchPending !== '') {
      this.consumePatchLine(this.patchPending.replace(/\r$/, ''));
      this.patchPending = '';
    }
    this.finishBlock();
    if (this.blockIndex !== this.expectedBlocks) {
      throw invalidDiff();
    }
    if (this.rawIndex !== this.records.length || this.typeDelete) throw invalidDiff();
    return this.selectedBlocks;
  }

  get rawRecords(): readonly RawRecord[] { return this.records; }

  private consumeRaw(chunk: string): string | undefined {
    this.nulPending += chunk;
    let nul: number;
    while ((nul = this.nulPending.indexOf('\0')) !== -1) {
      const value = this.nulPending.slice(0, nul);
      this.nulPending = this.nulPending.slice(nul + 1);
      if (this.phase === 'metadata') {
        if (value === '') {
          this.expectedBlocks = this.records.reduce((count, record) => count + (record.status === 'T' ? 2 : 1), 0);
          this.phase = 'patch';
          const patch = this.nulPending;
          this.nulPending = '';
          return patch;
        }
        const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(?:[0-9]+)?$/.exec(value);
        if (match === null) throw invalidDiff();
        this.pendingMode = { oldMode: match[1]!, newMode: match[2]!, status: match[5]! };
        this.phase = 'path';
      } else if (this.phase === 'path') {
        if (value === '' || this.pendingMode === undefined) throw invalidDiff();
        this.records.push({ ...this.pendingMode, path: value });
        this.pendingMode = undefined;
        this.phase = 'metadata';
      } else throw invalidDiff();
    }
    return undefined;
  }


  private consumePatchLine(line: string): void {
    if (line.startsWith('diff --git ')) {
      this.finishBlock();
      if (this.blockIndex >= this.expectedBlocks) throw invalidDiff();
      this.currentBlock = { ranges: [], binary: false, hunk: undefined };
      return;
    }
    if (this.currentBlock === undefined) {
      if (line !== '') throw invalidDiff();
      return;
    }
    if (line.startsWith('Binary files ') && line.endsWith(' differ') || line === 'GIT binary patch') {
      this.currentBlock.binary = true;
      return;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (hunk === null && line.startsWith('@@')) throw invalidDiff();
    if (hunk !== null) {
      const newStart = Number(hunk[3]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      this.currentBlock.hunk = {
        oldExpected: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newExpected: newCount,
        oldSeen: 0,
        newSeen: 0,
      };
      if (newCount > 0) {
        const range = { start: newStart, end: newStart + newCount - 1 };
        const previous = this.currentBlock.ranges.at(-1);
        if (previous !== undefined && range.start <= previous.end + 1) {
          this.currentBlock.ranges[this.currentBlock.ranges.length - 1] = {
            start: previous.start,
            end: Math.max(previous.end, range.end),
          };
        } else this.currentBlock.ranges.push(range);
      }
      this.finishHunkIfComplete();
      return;
    }
    if (line.startsWith('\\ No newline at end of file')) return;
    const active = this.currentBlock.hunk;
    if (active !== undefined) {
      const marker = line[0];
      if (marker === ' ') { active.oldSeen++; active.newSeen++; }
      else if (marker === '+') active.newSeen++;
      else if (marker === '-') active.oldSeen++;
      else throw invalidDiff();
      if (active.oldSeen > active.oldExpected || active.newSeen > active.newExpected) throw invalidDiff();
      this.finishHunkIfComplete();
    }
  }

  private finishHunk(): void {
    const hunk = this.currentBlock?.hunk;
    if (hunk !== undefined && (hunk.oldSeen !== hunk.oldExpected || hunk.newSeen !== hunk.newExpected)) {
      throw invalidDiff();
    }
    if (this.currentBlock !== undefined) this.currentBlock.hunk = undefined;
  }

  private finishHunkIfComplete(): void {
    const hunk = this.currentBlock?.hunk;
    if (hunk !== undefined && hunk.oldSeen === hunk.oldExpected && hunk.newSeen === hunk.newExpected) {
      this.currentBlock!.hunk = undefined;
    }
  }

  private finishBlock(): void {
    if (this.currentBlock === undefined) return;
    this.finishHunk();
    const record = this.records[this.rawIndex];
    if (record === undefined) throw invalidDiff();
    if (record.status === 'T') {
      if (this.typeDelete) {
        this.selectedBlocks.push(this.currentBlock);
        this.typeDelete = false;
        this.rawIndex++;
      } else this.typeDelete = true;
    } else {
      this.selectedBlocks.push(this.currentBlock);
      this.rawIndex++;
    }
    this.blockIndex++;
    this.currentBlock = undefined;
  }
}

async function collectNulPaths(
  root: string,
  args: readonly string[],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  let pending = '';
  const paths: string[] = [];
  await git(root, args, chunk => {
    const records = (pending + chunk).split('\0');
    pending = records.pop()!;
    for (const path of records) if (path !== '') paths.push(path);
  }, env);
  if (pending !== '') throw invalidDiff();
  return paths;
}

async function readAttributes(
  root: string,
  paths: readonly string[],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<ReadonlyMap<string, boolean>> {
  const attributed = new Map<string, boolean>();
  if (paths.length === 0) return attributed;
  let pending = '';
  const fields: string[] = [];
  await git(root, ['check-attr', '-z', '--stdin', 'filter', 'working-tree-encoding'], chunk => {
    const records = (pending + chunk).split('\0');
    pending = records.pop()!;
    fields.push(...records);
  }, env, `${paths.join('\0')}\0`);
  if (pending !== '' || fields.length % 3 !== 0) throw invalidDiff();
  for (let index = 0; index < fields.length; index += 3) {
    const path = fields[index]!;
    const attribute = fields[index + 1]!;
    const value = fields[index + 2]!;
    if (attribute !== 'filter' && attribute !== 'working-tree-encoding') throw invalidDiff();
    if (value !== 'unspecified' && value !== 'unset') attributed.set(path, true);
  }
  return attributed;
}

async function untrackedLines(absolute: string): Promise<readonly LineRange[] | undefined> {
  const stats = await lstat(absolute);
  if (!stats.isFile()) return undefined;
  let prefixBytes = 0;
  let binary = false;
  let byteCount = 0;
  let lfCount = 0;
  let lastByte = -1;
  for await (const chunk of createReadStream(absolute)) {
    const bytes = chunk as Buffer;
    const inspectCount = Math.min(bytes.length, Math.max(0, 8000 - prefixBytes));
    if (!binary && bytes.subarray(0, inspectCount).includes(0)) binary = true;
    prefixBytes += inspectCount;
    byteCount += bytes.length;
    for (const byte of bytes) if (byte === 0x0a) lfCount++;
    if (bytes.length > 0) lastByte = bytes[bytes.length - 1]!;
  }
  if (binary) return undefined;
  const lineCount = byteCount === 0 ? 0 : lfCount + (lastByte === 0x0a ? 0 : 1);
  return lineCount === 0 ? [] : [{ start: 1, end: lineCount }];
}

export async function collectChanges(
  root: string,
  base: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<DiffChanges> {
  let tree = '';
  try {
    await git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{tree}`], chunk => {
      tree += chunk;
    }, env);
  } catch (error) {
    throw new Error(`Cannot resolve Git base ${base}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  let conflicts = false;
  await git(root, ['ls-files', '--unmerged', '-z', '--', '.'], () => { conflicts = true; }, env);
  if (conflicts) throw new Error(CONFLICTS);

  const inherited = env ?? process.env;
  const diffEnv: Record<string, string | undefined> = { ...inherited };
  delete diffEnv.GIT_DIFF_OPTS;
  const parser = new DiffParser();
  await git(root, [
    'diff', '--relative', '--raw', '-z', '--patch', '--unified=0', '--inter-hunk-context=0',
    '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short', '-O/dev/null',
    '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ',
    tree.trim(), '--', '.',
  ], chunk => parser.consume(chunk), diffEnv);
  const blocks = parser.finish();
  const records = parser.rawRecords;
  const trackedPaths = records.filter(record => record.newMode.startsWith('100')).map(record => record.path);
  const attributes = await readAttributes(root, trackedPaths, env);
  const changedFiles = new Set<string>();
  const lineResults = new Map<string, readonly LineRange[] | undefined>();
  let selectedBlock = 0;
  for (const record of records) {
    const physical = await traversablePath(root, record.path);
    const currentBlock = blocks[selectedBlock++];
    if (physical === undefined) continue;
    changedFiles.add(physical);
    const isCurrent = record.newMode !== '000000';
    if (!isCurrent) {
      if (!lineResults.has(physical)) lineResults.set(physical, []);
      continue;
    }
    if (!record.newMode.startsWith('100')) {
      lineResults.set(physical, undefined);
    } else if (currentBlock === undefined || currentBlock.binary) {
      lineResults.set(physical, undefined);
    } else if (currentBlock.ranges.length === 0) {
      lineResults.set(physical, []);
    } else if (attributes.get(record.path) === true) {
      lineResults.set(physical, undefined);
    } else {
      lineResults.set(physical, currentBlock.ranges);
    }
  }

  const untracked = await collectNulPaths(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], env);
  for (const path of untracked) {
    const physical = await traversablePath(root, path);
    if (physical === undefined) continue;
    const lines = await untrackedLines(join(root, ...path.split('/')));
    changedFiles.add(physical);
    if (lines === undefined) {
      lineResults.set(physical, undefined);
    } else {
      lineResults.set(physical, lines);
    }
  }
  const changedLines = new Map<string, readonly LineRange[]>();
  for (const [path, ranges] of lineResults) {
    if (ranges !== undefined) changedLines.set(path, ranges);
  }
  return { changedFiles, changedLines };
}
