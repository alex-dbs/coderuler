import type { RunEvent } from '../../app/ports.js';
import type { TextWriter } from './reports.js';

const FRAMES = ['-', '\\', '|', '/'];
const FRAME_INTERVAL = 80;
const CLEAR_LINE = '\r\u001b[2K';

export interface TerminalCapabilities {
  readonly color: boolean;
  readonly interactive: boolean;
  readonly columns?: number;
  readonly stdoutColumns?: number;
}

interface TerminalStreams {
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly columns?: number;
  readonly stdoutColumns?: number;
}

export function terminalCapabilities(
  streams: TerminalStreams,
  env: Readonly<Record<string, string | undefined>>,
): TerminalCapabilities {
  const forced = env.FORCE_COLOR?.toLowerCase();
  const color = forced !== undefined
    ? forced !== '0' && forced !== 'false'
    : env.NO_COLOR === undefined && env.TERM !== 'dumb' && streams.stdoutIsTTY;
  return {
    color,
    interactive: streams.stdoutIsTTY && streams.stderrIsTTY && env.TERM !== 'dumb',
    get columns() { return streams.columns ?? 80; },
    get stdoutColumns() { return streams.stdoutColumns ?? streams.columns ?? 80; },
  };
}

export function createProgress(write: TextWriter, columns: () => number = () => 80) {
  let frame = 0;
  let active = true;
  let drawn = false;
  let progress: Extract<RunEvent, { type: 'progress' }> | undefined;

  const draw = () => {
    const width = Math.max(0, Math.floor(columns()) - 1);
    if (width === 0) {
      if (drawn) write(CLEAR_LINE);
      drawn = false;
      return;
    }
    const spinner = FRAMES[frame % FRAMES.length]!;
    frame += 1;
    let text = `${spinner} Loading rules`;
    if (progress !== undefined) {
      const label = progress.phase === 'selection' ? 'Scanning' : 'Evaluating';
      const units = progress.phase === 'selection' ? 'rules' : 'subjects';
      const counts = `${progress.completed}/${progress.total} ${units}`;
      const barWidth = Math.min(24, width - label.length - counts.length - 7);
      if (barWidth >= 3) {
        const filled = progress.total === 0
          ? 0
          : Math.min(barWidth, Math.floor(barWidth * progress.completed / progress.total));
        text = `${spinner} ${label} [${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}] ${counts}`;
      } else {
        text = `${spinner} ${counts}`;
      }
    }
    write(`${CLEAR_LINE}${text.slice(0, width)}`);
    drawn = true;
  };

  draw();
  const timer = setInterval(draw, FRAME_INTERVAL);
  return {
    emit(event: RunEvent): void {
      if (!active || event.type !== 'progress') return;
      progress = event;
      draw();
    },
    stop(): void {
      if (!active) return;
      active = false;
      clearInterval(timer);
      if (drawn) write(CLEAR_LINE);
    },
  };
}
