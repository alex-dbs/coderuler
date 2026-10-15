import { relative, resolve } from 'node:path';

import type { Context, DecisionGrouping } from '../rule/types.ts';
import type { ScopeMatch } from '../scope/types.ts';

export interface GroupDescriptor {
  readonly type: 'file' | 'folder' | 'project';
  readonly path: string;
}

export interface GroupedFile {
  readonly filepath: string;
  readonly scopes: readonly ScopeMatch[];
}

export interface GroupedContext {
  readonly group: GroupDescriptor;
  readonly files: readonly GroupedFile[];
}

export type DecisionContext = Context | GroupedContext;

interface MutableFile {
  readonly filepath: string;
  readonly scopes: ScopeMatch[];
}

function relativeToRoot(filepath: string, root: string): string {
  const rel = relative(root, resolve(root, filepath)).replaceAll('\\', '/');
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith('../')) {
    throw new Error(`Grouped scope file "${filepath}" is outside the project root "${root}"`);
  }
  return rel;
}

function folderAncestor(relPath: string, level: number): string {
  const segments = relPath.split('/');
  segments.pop();
  const keep = segments.length + level;
  if (keep <= 0) return '.';
  return segments.slice(0, keep).join('/');
}

export function groupContexts(
  contexts: readonly Context[],
  grouping: DecisionGrouping,
  cwd: string,
): readonly DecisionContext[] {
  if (grouping.group_by === 'scope') return contexts;

  const type = grouping.group_by;
  const level = grouping.group_by === 'folder' ? grouping.level ?? 0 : 0;
  const root = resolve(cwd);

  // Groups and their files are keyed by their descriptor path: one group per path, one file per
  // filepath within it, so a filepath split across non-contiguous contexts still lands in one file.
  const order: GroupDescriptor[] = [];
  const groups = new Map<string, { files: MutableFile[]; byFile: Map<string, MutableFile> }>();

  for (const { filepath, scope } of contexts) {
    let path: string;
    if (type === 'file') path = filepath;
    else if (type === 'project') {
      relativeToRoot(filepath, root);
      path = '.';
    } else path = folderAncestor(relativeToRoot(filepath, root), level);

    let bucket = groups.get(path);
    if (bucket === undefined) {
      bucket = { files: [], byFile: new Map() };
      groups.set(path, bucket);
      order.push({ type, path });
    }
    let file = bucket.byFile.get(filepath);
    if (file === undefined) {
      file = { filepath, scopes: [] };
      bucket.byFile.set(filepath, file);
      bucket.files.push(file);
    }
    file.scopes.push(scope);
  }

  return order.map(group => ({ group, files: groups.get(group.path)!.files }));
}
