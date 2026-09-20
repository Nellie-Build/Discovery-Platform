import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import type { CrawlerRuntimeSnapshot } from './types.js';

/**
 * Small, safe helpers for explaining why a crawl engine did not work: a sanitised error
 * description, a compact phase timeline and a runtime snapshot of booleans. Nothing here runs a
 * shell command, reads an environment variable or includes a request header, token or query string.
 */

const MESSAGE_LIMIT = 1000;
const CAUSE_LIMIT = 500;
const STACK_LINES = 8;
const STACK_LIMIT = 2000;

/** Keeps a URL's origin and path but never its query string or fragment (which may hold tokens). */
export function stripUrlQueries(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#'"`)>\]]+)[?#][^\s'"`)>\]]*/gi, '$1?…');
}

const clip = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  try { return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

export interface DescribedError {
  crawlerErrorName: string;
  crawlerErrorMessage: string;
  crawlerErrorCode?: string;
  crawlerErrorCause?: string;
  crawlerErrorStack?: string;
}

/** A bounded, sanitised description of a thrown value. */
export function describeError(error: unknown): DescribedError {
  const described: DescribedError = {
    crawlerErrorName: error instanceof Error ? error.name : typeof error,
    crawlerErrorMessage: clip(stripUrlQueries(messageOf(error)), MESSAGE_LIMIT),
  };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' || typeof code === 'number') described.crawlerErrorCode = String(code).slice(0, 100);
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause !== undefined && cause !== null) {
    const name = cause instanceof Error ? cause.name : typeof cause;
    described.crawlerErrorCause = clip(stripUrlQueries(`${name}: ${messageOf(cause)}`), CAUSE_LIMIT);
  }
  if (error instanceof Error && error.stack) {
    // Only the first frames; the first line repeats the message, which is already bounded above.
    described.crawlerErrorStack = clip(stripUrlQueries(error.stack.split('\n').slice(0, STACK_LINES).join('\n')), STACK_LIMIT);
  }
  return described;
}

/** Records when each milestone of an engine's start-up was reached, and which operation is in progress. */
export class PhaseTracker {
  private readonly startedAt = Date.now();
  readonly phases: { phase: string; ms: number }[] = [];
  /** The operation currently running; if it throws, this is the failure phase. */
  operation = 'not_started';
  lastPhase = 'not_started';

  /** Starts an operation (e.g. `queue_open`) — a failure from now on is attributed to it. */
  begin(operation: string) { this.operation = operation; }

  /** A milestone was reached. */
  mark(phase: string) {
    this.lastPhase = phase;
    if (this.phases.length < 20) this.phases.push({ phase, ms: Date.now() - this.startedAt });
  }
}

async function canAccess(target: string, mode: number): Promise<boolean> {
  try { await access(target, mode); return true; } catch { return false; }
}

async function readNumber(file: string): Promise<number | null> {
  try {
    const value = (await readFile(file, 'utf8')).trim();
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch { return null; }
}

/** Facts about the environment a crawl engine runs in, as booleans and plain numbers. */
export async function collectRuntimeSnapshot(): Promise<CrawlerRuntimeSnapshot> {
  const snapshot: CrawlerRuntimeSnapshot = {
    nodeVersion: process.version, platform: process.platform, arch: process.arch,
    procReadable: await canAccess('/proc/meminfo', constants.R_OK),
    cgroupReadable: (await canAccess('/sys/fs/cgroup/memory.max', constants.R_OK)) || (await canAccess('/sys/fs/cgroup/memory/memory.limit_in_bytes', constants.R_OK)),
    tmpWritable: false,
    cwdWritable: await canAccess(process.cwd(), constants.W_OK),
    storageDirPresent: existsSync(path.join(process.cwd(), 'storage')),
    osTotalMemoryMb: Math.round(totalmem() / 1048576),
    memoryLimitDetectedMb: null,
  };
  try {
    const directory = await mkdtemp(path.join(tmpdir(), 'discovery-diag-'));
    snapshot.tmpWritable = true;
    await rm(directory, { recursive: true, force: true });
  } catch { snapshot.tmpWritable = false; }
  const limit = (await readNumber('/sys/fs/cgroup/memory.max')) ?? (await readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  // "max" (no limit) is not a number; a limit far above physical memory means "unlimited" too.
  if (limit !== null && limit > 0 && limit < 1e13) snapshot.memoryLimitDetectedMb = Math.round(limit / 1048576);
  return snapshot;
}
