import { spawn } from 'node:child_process';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@alex-dbs/rulekeeper';
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
  readonly version: string;
};

export const installedVersion = manifest.version;

const UPDATE_INSTRUCTIONS = 'Self-update requires the active global npm installation. For project-local installs, run npm install --save-dev @alex-dbs/rulekeeper@latest. Otherwise use your package manager or reinstall with npm install --global @alex-dbs/rulekeeper@latest.';

async function findNpm(env: NodeJS.ProcessEnv): Promise<string> {
  const path = process.platform === 'win32'
    ? Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1]
    : env.PATH;
  for (const directory of (path ?? '').split(delimiter)) {
    if (directory === '') continue;
    const shim = join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    try {
      await access(shim, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      const executable = await realpath(shim);
      const cli = process.platform === 'win32'
        ? join(dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : executable;
      if (basename(cli) !== 'npm-cli.js') {
        throw new Error('The active npm executable is not a supported npm installation; update Rulekeeper using your package manager.');
      }
      await access(cli, fsConstants.R_OK);
      return cli;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('npm was not found on PATH; install npm or update Rulekeeper using your package manager.');
}

function runNpm(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  capture: boolean,
): Promise<{ readonly status: number; readonly stdout: string }> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<{ readonly status: number; readonly stdout: string }>();
  const child = spawn(process.execPath, [executable, ...args], {
    cwd,
    env,
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  });
  let stdout = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => { stdout += text; });
  child.once('error', reject);
  child.once('close', (code, signal) => {
    settle({ status: code ?? 128 + (signal === null ? 0 : osConstants.signals[signal]), stdout });
  });
  return promise;
}

export function createToolUpdater(cwd: string, env: NodeJS.ProcessEnv): () => Promise<number> {
  return async () => {
    const packageRoot = await realpath(PACKAGE_ROOT);
    if (basename(dirname(packageRoot)) !== '@alex-dbs' || basename(dirname(dirname(packageRoot))) !== 'node_modules') {
      throw new Error(UPDATE_INSTRUCTIONS);
    }
    const executable = await findNpm(env);
    const root = await runNpm(executable, ['root', '--global'], cwd, env, true);
    if (root.status !== 0) return root.status;
    const globalRoot = root.stdout.trim();
    let activePackage: string;
    try {
      activePackage = await realpath(join(globalRoot, PACKAGE_NAME));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      throw new Error(UPDATE_INSTRUCTIONS);
    }
    if (activePackage !== packageRoot || join(await realpath(globalRoot), PACKAGE_NAME) !== packageRoot) {
      throw new Error(UPDATE_INSTRUCTIONS);
    }
    const prefix = await runNpm(executable, ['prefix', '--global'], cwd, env, true);
    if (prefix.status !== 0) return prefix.status;
    const globalPrefix = prefix.stdout.trim();
    const expectedRoot = process.platform === 'win32'
      ? join(globalPrefix, 'node_modules')
      : join(globalPrefix, 'lib', 'node_modules');
    if (resolve(globalRoot) !== resolve(expectedRoot)) {
      throw new Error('The active npm global prefix does not match this installation; update Rulekeeper using your package manager.');
    }
    const result = await runNpm(executable, ['install', '--global', '--prefix', globalPrefix, `${PACKAGE_NAME}@latest`], cwd, env, false);
    return result.status;
  };
}
