import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_REPORT_PATH = join('benchmarks', 'manual.md');

const CHECK_TARGET = 'tests/manual';

const RULES_PATH = '.rulekeeper';

const MISSING = '—';

const PASS = 'PASS';

const VIOLATION = 'VIOLATION';

const TITLE = '# Rulekeeper benchmark';

const SEPARATOR = /^:?-{3,}:?$/;

const CELL_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '|': '\\|',
  '`': '\\`',
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '\n': '\\n',
  '\r': '\\r',
};

const CELL_UNESCAPES: Record<string, string> = { '\\': '\\', '|': '|', '`': '`', n: '\n', r: '\r' };

const CELL_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>' };

export interface Verification {
  readonly rule: string;
  readonly verification: string;
  readonly score: string;
}

export interface ReportRow {
  readonly rule: string;
  readonly verification: string;
  readonly cells: readonly string[];
}

export interface ReportTable {
  readonly columns: readonly string[];
  readonly rows: readonly ReportRow[];
}

interface RolledColumn {
  readonly label: string;
  readonly cells: ReadonlyMap<string, string>;
}

interface CheckRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireMapping(value: unknown, where: string): Record<string, unknown> {
  if (!isMapping(value)) throw new Error(`${where} is not an object`);
  return value;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} is not a string`);
  return value;
}

function requireNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where} is not a number`);
  return value;
}

function requireBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${where} is not a boolean`);
  return value;
}

const IDENTITY_QUOTING = /[\s"'\\]/;

function identityComponent(text: string): string {
  return text === '' || IDENTITY_QUOTING.test(text) ? JSON.stringify(text) : text;
}

function identityOf(decision: Record<string, unknown>, where: string): string {
  if (decision.group !== undefined) {
    const group = requireMapping(decision.group, `${where}.group`);
    const type = requireString(group.type, `${where}.group.type`);
    const path = identityComponent(requireString(group.path, `${where}.group.path`));
    return `group ${type} ${path}`;
  }
  const filepath = identityComponent(requireString(decision.filepath, `${where}.filepath`));
  const scopeId = identityComponent(requireString(decision.scopeId, `${where}.scopeId`));
  return `scope ${filepath} ${scopeId}`;
}

export function collectVerifications(payload: unknown, root: string): Verification[] {
  if (!Array.isArray(payload)) throw new Error('check output is not a JSON array of rules');
  const verifications: Verification[] = [];
  payload.forEach((entry: unknown, index: number) => {
    const where = `check output rule ${index}`;
    const rule = requireMapping(entry, where);
    const ruleFile = requireString(rule.ruleFile, `${where}.ruleFile`);
    if (!Array.isArray(rule.decisions)) throw new Error(`${where}.decisions is not an array`);
    rule.decisions.forEach((value: unknown, position: number) => {
      const at = `${where}.decisions[${position}]`;
      const decision = requireMapping(value, at);
      const probability = requireNumber(decision.probability, `${at}.probability`);
      const model = requireString(decision.model, `${at}.model`);
      const follows = requireBoolean(decision.follows, `${at}.follows`);
      verifications.push({
        rule: relative(root, ruleFile),
        verification: identityOf(decision, at),
        score: `${String(probability)} (${model}) ${follows ? PASS : VIOLATION}`,
      });
    });
  });
  return verifications;
}

export function escapeCell(text: string): string {
  return text.replace(/[\\|`&<>\n\r]/g, character => CELL_ESCAPES[character] ?? character);
}

export function unescapeCell(text: string): string {
  return text.replace(/&amp;|&lt;|&gt;|\\(.)/g, (match: string, escaped: string | undefined) => {
    const entity = CELL_ENTITIES[match];
    if (entity !== undefined) return entity;
    const decoded = escaped === undefined ? undefined : CELL_UNESCAPES[escaped];
    if (decoded === undefined) throw new Error(`benchmark report cell carries the unknown escape "${match}"`);
    return decoded;
  });
}

function rowKey(rule: string, verification: string): string {
  return `${rule}\u0000${verification}`;
}

function splitRowCells(text: string): string[] {
  const cells: string[] = [];
  let current = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === undefined) break;
    if (character === '\\') {
      const escaped = text[index + 1];
      current += escaped === undefined ? character : `\\${escaped}`;
      index += escaped === undefined ? 1 : 2;
      continue;
    }
    index += 1;
    if (character === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current);
  return cells;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    throw new Error(`benchmark report carries a line that is not a table row: ${trimmed}`);
  }
  return splitRowCells(trimmed.slice(1, -1)).map(cell => {
    const unpadded = cell.startsWith(' ') && cell.endsWith(' ') && cell.length > 1 ? cell.slice(1, -1) : cell;
    return unescapeCell(unpadded);
  });
}

function renderRow(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

function renderReport(table: ReportTable): string {
  const lines = [
    TITLE,
    '',
    `- Command: \`node index.ts check ${CHECK_TARGET} --rules ${RULES_PATH} --json\``,
    '- Score: the verdict the decision reported, preceded by the unrounded probability it returned and the model that returned it in parentheses, for example `0.4881 (jev-latest) PASS` or `0 (regex) VIOLATION`; a cell an earlier script wrote keeps its bare score.',
    `- Missing: \`${MISSING}\` means the run reported no verification for that rule and that scope or group.`,
    '- Columns: UTC ISO-8601 run timestamps. The rightmost column is the current run and the one before it the previous run; a row is kept while either of those two runs reported it.',
    '',
    renderRow(['Rule', 'Verification', ...table.columns]),
    renderRow(['---', '---', ...table.columns.map(() => '---')]),
  ];
  for (const row of table.rows) lines.push(renderRow([row.rule, row.verification, ...row.cells]));
  return `${lines.join('\n')}\n`;
}

export function parseReport(text: string): ReportTable {
  const lines = text.split('\n');
  const first = lines.find(line => line.trim() !== '');
  if (first === undefined) throw new Error('benchmark report is empty');
  if (first.trim() !== TITLE) throw new Error(`benchmark report does not start with "${TITLE}"`);

  const headerAt = lines.findIndex(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) return false;
    const cells = splitRow(line);
    return cells[0] === 'Rule' && cells[1] === 'Verification';
  });
  if (headerAt < 0) throw new Error(`benchmark report has no table with the Rule and Verification columns`);

  const header = splitRow(lines[headerAt] ?? '');
  if (header.length < 3) throw new Error('benchmark report table carries no score column');

  const separator = lines[headerAt + 1];
  const separatorCells = separator === undefined ? [] : splitRow(separator);
  if (separatorCells.length !== header.length || !separatorCells.every(cell => SEPARATOR.test(cell))) {
    throw new Error('benchmark report table is missing its separator row');
  }

  const rows: ReportRow[] = [];
  for (const line of lines.slice(headerAt + 2)) {
    if (line.trim() === '') break;
    const cells = splitRow(line);
    if (cells.length !== header.length) {
      throw new Error(`benchmark report row carries ${cells.length} cells, expected ${header.length}`);
    }
    const rule = cells[0];
    const verification = cells[1];
    if (rule === undefined || verification === undefined || rule.trim() === '' || verification.trim() === '') {
      throw new Error('benchmark report row carries no rule or verification');
    }
    rows.push({ rule, verification, cells: cells.slice(2) });
  }
  return { columns: header.slice(2), rows };
}

function rolledColumn(table: ReportTable): RolledColumn {
  const index = table.columns.length - 1;
  const label = table.columns[index];
  if (label === undefined) throw new Error('benchmark report carries no score column');
  const cells = new Map<string, string>();
  for (const row of table.rows) {
    const cell = row.cells[index];
    if (cell !== undefined) cells.set(rowKey(row.rule, row.verification), cell);
  }
  return { label, cells };
}

export function updateReport(previousText: string | undefined, verifications: readonly Verification[], now: string): string {
  const previous = previousText === undefined || previousText.trim() === '' ? undefined : parseReport(previousText);
  const rolled = previous === undefined ? undefined : rolledColumn(previous);

  const identities = new Map<string, { rule: string; verification: string }>();
  for (const row of previous?.rows ?? []) {
    identities.set(rowKey(row.rule, row.verification), { rule: row.rule, verification: row.verification });
  }
  const current = new Map<string, string>();
  for (const verification of verifications) {
    const key = rowKey(verification.rule, verification.verification);
    identities.set(key, { rule: verification.rule, verification: verification.verification });
    current.set(key, verification.score);
  }

  const ordered = [...identities].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const rows: ReportRow[] = [];
  for (const [key, identity] of ordered) {
    const previousCell = rolled?.cells.get(key) ?? MISSING;
    const currentCell = current.get(key) ?? MISSING;
    if (previousCell === MISSING && currentCell === MISSING) continue;
    rows.push({
      rule: identity.rule,
      verification: identity.verification,
      cells: rolled === undefined ? [currentCell] : [previousCell, currentCell],
    });
  }

  return renderReport({ columns: rolled === undefined ? [now] : [rolled.label, now], rows });
}

function runCheck(env: NodeJS.ProcessEnv): Promise<CheckRun> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<CheckRun>();
  const child = spawn(
    process.execPath,
    [join(ROOT, 'index.ts'), 'check', CHECK_TARGET, '--rules', RULES_PATH, '--json'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('error', reject);
  child.on('close', (status: number | null) => {
    settle({ status, stdout, stderr });
  });
  return promise;
}

function parseCheckOutput(stdout: string, reportPath: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`check output is not JSON (${reason}); ${reportPath} left unchanged`, { cause: error });
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const reportPath = resolve(ROOT, argv[2] ?? DEFAULT_REPORT_PATH);
  const run = await runCheck(process.env);
  if (run.status !== 0) {
    if (run.stderr !== '') process.stderr.write(run.stderr.endsWith('\n') ? run.stderr : `${run.stderr}\n`);
    throw new Error(`check exited with status ${String(run.status)}; ${reportPath} left unchanged`);
  }

  const verifications = collectVerifications(parseCheckOutput(run.stdout, reportPath), ROOT);
  const now = new Date().toISOString();
  const previous = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : undefined;
  const report = updateReport(previous, verifications, now);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report, 'utf8');
  process.stderr.write(`benchmark: ${verifications.length} verifications at ${now} -> ${reportPath}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv);
  } catch (error) {
    process.stderr.write(`benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
