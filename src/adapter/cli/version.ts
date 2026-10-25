import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
  readonly version: string;
};

export const installedVersion = manifest.version;
