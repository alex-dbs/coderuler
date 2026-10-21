import { spawn } from 'node:child_process';

import { traversablePath } from '../filesystem/project.js';

async function git(
  root: string,
  args: readonly string[],
  consume: (chunk: string) => void,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', [...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', consume);
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', error => reject(new Error(`Cannot run Git: ${error.message}`, { cause: error })));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Git ${args[0]} failed: ${stderr.trim() || signal || `exit ${code}`}`));
    });
  });
}

export async function changedFiles(
  root: string,
  base: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<ReadonlySet<string>> {
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

  const paths = new Set<string>();
  const collectPaths = async (args: readonly string[]): Promise<void> => {
    let pending = '';
    await git(root, args, chunk => {
      const records = (pending + chunk).split('\0');
      pending = records.pop()!;
      for (const path of records) paths.add(path);
    }, env);
  };
  await collectPaths([
    'diff', '--relative', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
    tree.trim(), '--', '.',
  ]);
  await collectPaths(['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
  const changed = new Set<string>();
  for (const path of paths) {
    const physical = await traversablePath(root, path);
    if (physical !== undefined) changed.add(physical);
  }
  return changed;
}
