/**
 * Atomic JSON state file read/write for the state/ directory.
 * State files are local caches — the database (CT120) is the source of truth.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

// src/helpers/ → up 2 = strategist/
const STRATEGIST_DIR = dirname(dirname(import.meta.dir));
const STATE_DIR = join(STRATEGIST_DIR, "state");

/**
 * Read a JSON state file. Returns null if file doesn't exist.
 */
export async function readState<T>(filename: string): Promise<T | null> {
  try {
    const content = await readFile(join(STATE_DIR, filename), "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Write a JSON state file atomically (write to .tmp, then rename).
 */
export async function writeState<T>(
  filename: string,
  data: T
): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });

  const filePath = join(STATE_DIR, filename);
  const tmpPath = `${filePath}.tmp`;

  await writeFile(tmpPath, JSON.stringify(data, null, 2));

  // Atomic rename
  const { rename } = await import("fs/promises");
  await rename(tmpPath, filePath);
}

/**
 * Check if a state file exists and how old it is.
 * Returns age in seconds, or null if file doesn't exist.
 */
export async function stateAge(filename: string): Promise<number | null> {
  try {
    const { stat } = await import("fs/promises");
    const stats = await stat(join(STATE_DIR, filename));
    return (Date.now() - stats.mtimeMs) / 1000;
  } catch {
    return null;
  }
}

/**
 * Get the absolute path to the state directory.
 */
export function getStateDir(): string {
  return STATE_DIR;
}
