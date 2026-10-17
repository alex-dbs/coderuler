import type { BigIntStats } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import type { Project } from '../../app/ports.js';
import { parseCsv } from '../scope/csv.js';
import { parseJson } from '../scope/json.js';
import { parseYaml } from '../scope/yaml.js';

const SKIPPED_ANY_DEPTH: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.rulekeeper',
  'old',
]);

const ROOT_GENERATED: ReadonlySet<string> = new Set(['dist', 'coverage']);

const GLOB_MAGIC = /[*?[\]{}]/;

export interface ProjectOptions {
  readonly excludeFiles?: readonly string[];
}

export interface ProjectTarget {
  readonly root: string;
  readonly path: string;
  readonly kind: 'file' | 'directory';
  contains(filepath: string): boolean;
}

interface InventoryFile {
  readonly path: string;
  readonly absolute: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function helperPath(root: string, input: string): string {
  if (input.length === 0) throw new Error('Project path must not be empty');
  if (isAbsolute(input)) {
    throw new Error(`Project path ${input} must be relative to the project root`);
  }
  const absolute = resolve(root, input);
  const relativePath = relative(root, absolute);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Project path ${input} is outside the project root`);
  }
  return absolute;
}

async function lstatOrUndefined(absolute: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(absolute, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

async function assertPathBoundary(root: string, absolute: string, display: string): Promise<void> {
  const relativePath = relative(root, absolute);
  const segments = relativePath === '' ? [] : relativePath.split(sep);
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const candidate = join(root, ...segments.slice(0, index + 1));
    const stats = await lstatOrUndefined(candidate);
    if (stats === undefined) continue;
    if (!last && stats.isSymbolicLink()) {
      throw new Error(`Project path ${display} passes through a symbolic link at ${segment}/`);
    }
    if (!stats.isDirectory()) continue;
    const actual = basename(await realpath(candidate));
    if (SKIPPED_ANY_DEPTH.has(actual) || (index === 0 && ROOT_GENERATED.has(actual))) {
      throw new Error(
        last
          ? `Project path ${display} targets the reserved directory ${actual}/`
          : `Project path ${display} is inside the reserved directory ${actual}/`,
      );
    }
  }
}

async function assertPatternAllowed(root: string, pattern: string): Promise<void> {
  if (pattern.length === 0) throw new Error('Project glob pattern must not be empty');
  if (isAbsolute(pattern)) {
    throw new Error(`Project glob pattern ${pattern} must be relative to the project root`);
  }
  const segments = pattern.split('/');
  for (const segment of segments) {
    if (segment === '..') throw new Error(`Project glob pattern ${pattern} escapes the project root`);
  }
  for (const [index, segment] of segments.entries()) {
    if (GLOB_MAGIC.test(segment)) break;
    const candidate = join(root, ...segments.slice(0, index + 1));
    if (candidate === root) continue;
    const stats = await lstatOrUndefined(candidate);
    if (stats?.isSymbolicLink() === true) break;
    if (stats?.isDirectory() !== true) continue;
    const actual = basename(await realpath(candidate));
    if (SKIPPED_ANY_DEPTH.has(actual) || (dirname(candidate) === root && ROOT_GENERATED.has(actual))) {
      throw new Error(`Project glob pattern ${pattern} targets the reserved directory ${actual}/`);
    }
  }
}

async function walkInventory(
  directory: string,
  prefix: string,
  files: InventoryFile[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIPPED_ANY_DEPTH.has(entry.name) || (prefix === '' && ROOT_GENERATED.has(entry.name))) {
        continue;
      }
      await walkInventory(join(directory, entry.name), relativePath, files);
    } else if (entry.isFile()) {
      files.push({ path: relativePath, absolute: join(directory, entry.name) });
    }
  }
}

export function createProject(root: string, options: ProjectOptions = {}): Project {
  const resolvedRoot = resolve(root);
  const excludeFiles = new Set((options.excludeFiles ?? []).map((file) => resolve(file)));
  const textCache = new Map<string, Promise<string>>();
  let physicalRootPromise: Promise<string> | undefined;
  let inventoryPromise: Promise<readonly InventoryFile[]> | undefined;

  async function readSource(absolute: string, display: string): Promise<string> {
    const cached = textCache.get(absolute);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<string> => {
      await assertPathBoundary(resolvedRoot, absolute, display);
      let stats;
      try {
        stats = await lstat(absolute);
      } catch (error) {
        throw new Error(`Project file ${display} could not be read: ${describe(error)}`, {
          cause: error,
        });
      }
      if (stats.isSymbolicLink()) {
        throw new Error(`Project path ${display} is a symbolic link; read the real file`);
      }
      if (!stats.isFile()) throw new Error(`Project file ${display} is not a file`);
      let data: Buffer;
      try {
        data = await readFile(absolute);
      } catch (error) {
        throw new Error(`Project file ${display} could not be read: ${describe(error)}`, {
          cause: error,
        });
      }
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
      } catch (error) {
        throw new Error(`Project file ${display} is not valid UTF-8`, { cause: error });
      }
    })();
    textCache.set(absolute, pending);
    return pending;
  }

  const globFiles = async (patterns: string | readonly string[]): Promise<readonly string[]> => {
    const list = typeof patterns === 'string' ? [patterns] : patterns;
    for (const pattern of list) await assertPatternAllowed(resolvedRoot, pattern);
    if (list.length === 0) return [];
    const files = await (inventoryPromise ??= (async (): Promise<readonly InventoryFile[]> => {
      const physical = await (physicalRootPromise ??= realpath(resolvedRoot));
      const collected: InventoryFile[] = [];
      await walkInventory(physical, '', collected);
      return collected.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    })());
    const matched: string[] = [];
    for (const file of files) {
      if (excludeFiles.has(file.absolute)) continue;
      if (list.some((pattern) => matchesGlob(file.path, pattern))) matched.push(file.path);
    }
    return matched;
  };

  return {
    root: resolvedRoot,

    glob: globFiles,

    hasFiles: async (patterns) => (await globFiles(patterns)).length > 0,

    async stat(path) {
      const absolute = helperPath(resolvedRoot, path);
      await assertPathBoundary(resolvedRoot, absolute, path);
      let stats;
      try {
        stats = await lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new Error(`Project path ${path} could not be inspected: ${describe(error)}`, {
          cause: error,
        });
      }
      if (stats.isSymbolicLink()) {
        throw new Error(`Project path ${path} is a symbolic link; use the real path`);
      }
      if (stats.isFile()) return { kind: 'file' };
      if (stats.isDirectory()) return { kind: 'directory' };
      throw new Error(`Project path ${path} is neither a file nor a directory`);
    },

    async readText(path) {
      return readSource(helperPath(resolvedRoot, path), path);
    },

    async readJson(path) {
      const source = await readSource(helperPath(resolvedRoot, path), path);
      try {
        return parseJson(source);
      } catch (error) {
        throw new Error(`Project file ${path} is not strict JSON: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    async readYaml(path) {
      const source = await readSource(helperPath(resolvedRoot, path), path);
      try {
        return parseYaml(source);
      } catch (error) {
        throw new Error(`Project file ${path} is not valid YAML: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    async readCsv(path, options) {
      const source = await readSource(helperPath(resolvedRoot, path), path);
      try {
        return parseCsv(source, options);
      } catch (error) {
        throw new Error(`Project file ${path} is not valid CSV: ${describe(error)}`, {
          cause: error,
        });
      }
    },
  };
}

async function assertAliasTarget(
  physicalRoot: string,
  absolute: string,
  display: string,
): Promise<void> {
  const rootStats = await lstat(physicalRoot, { bigint: true });
  const segments = absolute.split(sep).filter(segment => segment !== '');
  let current: string = sep;
  let enteredRoot = false;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const candidate = join(current, segment);
    let stats = await lstatOrUndefined(candidate);
    if (stats?.isSymbolicLink() === true) {
      if (last) {
        throw new Error(
          `Check target ${display} is a symbolic link; point check at the real file or directory`,
        );
      }
      if (enteredRoot) {
        throw new Error(`Check target ${display} passes through a symbolic link at ${segment}/`);
      }
      current = await realpath(candidate);
      stats = await lstatOrUndefined(current);
    } else {
      current = candidate;
    }
    if (!enteredRoot && stats?.dev === rootStats.dev && stats.ino === rootStats.ino) {
      enteredRoot = true;
    }
  }
  if (!enteredRoot) throw new Error(`Check target ${display} is outside the project root`);
}

export async function resolveTarget(root: string, target: string): Promise<ProjectTarget> {
  const resolvedRoot = resolve(root);
  const physicalRoot = await realpath(resolvedRoot);
  const input = target.length === 0 ? '.' : target;
  const absolute = isAbsolute(input) ? resolve(input) : helperPath(resolvedRoot, input);
  const spelled = relative(resolvedRoot, absolute);
  const insideLexically = spelled !== '..' && !spelled.startsWith(`..${sep}`) && !isAbsolute(spelled);
  if (insideLexically) {
    await assertPathBoundary(resolvedRoot, absolute, input);
  } else {
    await assertAliasTarget(physicalRoot, absolute, input);
  }

  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Check target ${input} does not exist`, { cause: error });
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Check target ${input} is a symbolic link; point check at the real file or directory`,
    );
  }
  const physical = await realpath(absolute);
  const escaped = relative(physicalRoot, physical);
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`Check target ${input} leaves the project root through a symbolic link`);
  }
  await assertPathBoundary(physicalRoot, physical, input);
  const relativePath = escaped === '' ? '.' : escaped.split(sep).join('/');
  const kind: 'file' | 'directory' | undefined = stats.isDirectory()
    ? 'directory'
    : stats.isFile()
      ? 'file'
      : undefined;
  if (kind === undefined) throw new Error(`Check target ${input} is neither a file nor a directory`);
  return {
    root: physicalRoot,
    path: relativePath,
    kind,
    contains(filepath: string): boolean {
      if (kind === 'file') return filepath === relativePath;
      return (
        relativePath === '.' ||
        filepath === relativePath ||
        filepath.startsWith(`${relativePath}/`)
      );
    },
  };
}
