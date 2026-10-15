import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { mapConcurrent } from '../../app/concurrency.ts';
import type { Diagnostics } from '../../app/ports/diagnostics.ts';
import type {
  DiffSourceJob,
  DiffSourceRequest,
  SourceRepository,
  TreeSourceJob,
  TreeSourceRequest,
} from '../../app/ports/sources.ts';
import type { FileInput, RuleInput } from '../../app/rule/types.ts';
import { branchDiff, readBranchFile } from '../git/diff.ts';

interface SourceCandidate {
  readonly absolute: string;
  readonly logical: string;
}

const SKIPPED_DIRECTORIES: Record<string, true> = {
  '.git': true,
  node_modules: true,
  '.rulekeeper': true,
};

const DIFF_HEAD_MODES: Record<string, true> = { '100644': true, '100755': true, '000000': true };

type SkipReason =
  | 'no_rule'
  | 'rule_descriptor'
  | 'excluded_directory'
  | 'symlink'
  | 'not_a_file'
  | 'outside_target'
  | 'head_mode';

type SkipReporter = (file: string, reason: SkipReason) => void;

function logicalPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/');
}

function skipReporter(counts: Map<string, number>, diagnostics: Diagnostics | undefined): SkipReporter | undefined {
  if (diagnostics === undefined) return undefined;
  const verbose = diagnostics.verbose;
  return (file, reason) => {
    const key = `skipped_${reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (verbose !== undefined) verbose('source.skipped', { file, reason });
  };
}

function reportDiscovered(
  mode: 'tree' | 'diff',
  candidates: number,
  selected: number,
  counts: ReadonlyMap<string, number>,
  diagnostics: Diagnostics | undefined,
): void {
  if (diagnostics === undefined) return;
  const fields = new Map<string, string | number>([
    ['mode', mode],
    ['candidates', candidates],
    ['selected', selected],
  ]);
  for (const [reason, count] of counts) fields.set(reason, count);
  diagnostics.important('sources.discovered', Object.fromEntries(fields));
}

async function collectSources(directory: string, files: string[], onSkip: SkipReporter | undefined): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      onSkip?.(logicalPath(join(directory, entry.name)), 'symlink');
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES[entry.name] === true) onSkip?.(logicalPath(path), 'excluded_directory');
      else await collectSources(path, files, onSkip);
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      onSkip?.(logicalPath(path), 'not_a_file');
    }
  }
}

async function resolveSources(target: string, onSkip: SkipReporter | undefined): Promise<SourceCandidate[]> {
  const absolute = resolve(target);
  let stats: Stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Source path ${absolute} does not exist`, { cause: error });
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Source path ${absolute} is a symbolic link; point check at the real file or directory`);
  }

  const files: string[] = [];
  if (stats.isDirectory()) await collectSources(absolute, files, onSkip);
  else if (stats.isFile()) files.push(absolute);
  else throw new Error(`Source path ${absolute} is neither a file nor a directory`);

  const realRoot = await realpath(absolute);
  return files
    .map((path) => ({
      absolute: realRoot === absolute ? path : join(realRoot, relative(absolute, path)),
      logical: logicalPath(path),
    }))
    .sort((a, b) => (a.logical < b.logical ? -1 : a.logical > b.logical ? 1 : 0));
}

async function treeJobs(
  request: TreeSourceRequest,
  diagnostics: Diagnostics | undefined,
): Promise<readonly TreeSourceJob[]> {
  const counts = new Map<string, number>();
  const onSkip = skipReporter(counts, diagnostics);
  const verbose = diagnostics?.verbose;
  const sources = await resolveSources(request.target, onSkip);
  const jobs: TreeSourceJob[] = [];
  for (const source of sources) {
    if (request.rulePaths.has(source.absolute)) {
      onSkip?.(source.logical, 'rule_descriptor');
      continue;
    }

    const rules = request.select(source.logical);
    if (rules.length === 0) {
      onSkip?.(source.logical, 'no_rule');
      continue;
    }
    if (verbose !== undefined) verbose('source.selected', { file: source.logical, rules: rules.length });
    jobs.push({
      kind: 'tree',
      logical: source.logical,
      rules,
      read: async (): Promise<FileInput> => ({
        filepath: source.logical,
        source: await readFile(source.absolute, 'utf8'),
      }),
    });
  }
  reportDiscovered('tree', sources.length, jobs.length, counts, diagnostics);
  return jobs;
}

async function diffJobs(
  request: DiffSourceRequest,
  diagnostics: Diagnostics | undefined,
): Promise<readonly DiffSourceJob[]> {
  const branch = await branchDiff(request.base);
  diagnostics?.important('diff.branch', {
    repo: branch.repoRoot,
    head: branch.head,
    merge_base: branch.mergeBase,
    changed_files: branch.files.length,
    requested_base: request.base ?? 'default',
  });
  const targetAbsolute = resolve(request.target);
  const targetWithinRepo = relative(branch.repoRoot, targetAbsolute);
  if (targetWithinRepo !== '' && (targetWithinRepo === '..' || targetWithinRepo.startsWith(`..${sep}`) || isAbsolute(targetWithinRepo))) {
    throw new Error(`Source path ${targetAbsolute} is outside the repository ${branch.repoRoot}`);
  }

  const counts = new Map<string, number>();
  const onSkip = skipReporter(counts, diagnostics);
  const verbose = diagnostics?.verbose;
  const jobs: DiffSourceJob[] = [];
  for (const file of branch.files) {
    if (DIFF_HEAD_MODES[file.headMode] !== true) {
      onSkip?.(file.filepath, 'head_mode');
      continue;
    }
    if (file.filepath.split('/').some(segment => SKIPPED_DIRECTORIES[segment] === true)) {
      onSkip?.(file.filepath, 'excluded_directory');
      continue;
    }
    const absolute = join(branch.repoRoot, file.filepath);
    if (request.rulePaths.has(absolute)) {
      onSkip?.(file.filepath, 'rule_descriptor');
      continue;
    }
    if (absolute !== targetAbsolute && !absolute.startsWith(targetAbsolute + sep)) {
      onSkip?.(file.filepath, 'outside_target');
      continue;
    }
    const logical = logicalPath(absolute);

    const rules = request.select(logical);
    if (rules.length === 0) {
      onSkip?.(file.filepath, 'no_rule');
      continue;
    }

    const previous = logicalPath(join(branch.repoRoot, file.previousPath));
    if (verbose !== undefined) verbose('source.selected', { file: logical, mode: 'diff', rules: rules.length });
    jobs.push({
      kind: 'diff',
      logical,
      previous,
      rules,
      read: async (): Promise<RuleInput> => {
        const snapshot = await readBranchFile(branch, file);
        return { filepath: logical, diff: snapshot.diff, head: snapshot.head, base: snapshot.base };
      },
    });
  }
  reportDiscovered('diff', branch.files.length, jobs.length, counts, diagnostics);
  return jobs;
}

export function createSourceRepository(): SourceRepository {
  return {
    async identities(paths, concurrency, diagnostics): Promise<readonly string[]> {
      const verbose = diagnostics?.verbose;
      return await mapConcurrent(paths, concurrency, async (filepath) => {
        const identity = await realpath(filepath);
        if (verbose !== undefined && identity !== filepath) {
          verbose('rules.identity', { rule_file: filepath, resolved: identity });
        }
        return identity;
      });
    },

    treeJobs: (request, diagnostics) => treeJobs(request, diagnostics),

    diffJobs: (request, diagnostics) => diffJobs(request, diagnostics),
  };
}
