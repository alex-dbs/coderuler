import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import type { SuppressionConfig } from '../../app/suppressions.js';
import { parseSuppressionConfig } from '../../app/suppressions.js';
import { parseYaml } from '../scope/yaml.js';

const CONFIG_PATH = '.coderuler/suppressions.yml';

function emptyConfig(): SuppressionConfig {
  return new Map();
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function readConfiguration(path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('must be a regular, non-symlinked file');
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw new Error('must be a regular file');
    return await handle.readFile('utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function loadSuppressions(root: string): Promise<SuppressionConfig> {
  try {
    const directory = join(root, '.coderuler');
    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyConfig();
      throw error;
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error('.coderuler must be a regular directory');
    }

    const source = await readConfiguration(join(directory, 'suppressions.yml'));
    if (source === undefined) return emptyConfig();
    const documents = parseYaml(source);
    if (documents.length === 0) return emptyConfig();
    if (documents.length !== 1) throw new Error('must contain exactly one nonempty YAML document');
    return parseSuppressionConfig(documents[0]);
  } catch (error) {
    throw new Error(`${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
