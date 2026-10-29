import { dirname, join } from 'node:path';
import type { ProjectContext } from '@alex-dbs/coderuler';

export async function goVersionAtLeast(
  filepath: string,
  context: ProjectContext,
  major: number,
  minor: number,
): Promise<boolean> {
  let directory = dirname(filepath);
  while (true) {
    const modulePath = join(directory, 'go.mod');
    if ((await context.project.stat(modulePath))?.kind === 'file') {
      const source = await context.project.readText(modulePath);
      const version = /^[ \t]*go[ \t]+([0-9]+)\.([0-9]+)(?:\.[0-9]+)?(?:[a-z]+[0-9]+)?[ \t]*(?:\/\/[^\r\n]*)?\r?$/m.exec(source);
      if (!version) return false;
      const moduleMajor = Number(version[1]);
      const moduleMinor = Number(version[2]);
      return moduleMajor > major || (moduleMajor === major && moduleMinor >= minor);
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}
