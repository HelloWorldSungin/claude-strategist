/**
 * Wrapper around Claude CLI spawning.
 *
 * Two modes:
 * - local: Spawn claude -p on CT100 (cwd = trading-signal-ai root)
 * - remote: SSH to CT110 and spawn claude there (for /research)
 */

import { spawn } from "bun";
import { resolve, dirname } from "path";
import type { ClaudeRunResult, ClaudeRunMode } from "../types";

// strategist/src/helpers/ → up 2 = strategist/ → up 1 = trading-signal-ai/
const STRATEGIST_DIR = dirname(dirname(import.meta.dir));
const PROJECT_ROOT =
  process.env.PROJECT_ROOT || resolve(STRATEGIST_DIR, "..");

const CLAUDE_PATH = process.env.CLAUDE_PATH || "/home/strategist/.local/bin/claude";
const CT110_HOST = process.env.CT110_HOST || "192.168.68.110";
const CT110_PROJECT_ROOT =
  process.env.CT110_PROJECT_ROOT ||
  "/opt/ArkNode-AI/projects/trading-signal-ai";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Run Claude CLI locally on CT100.
 * cwd is set to trading-signal-ai root so Claude has access to CLAUDE.md, agents, skills.
 */
export async function runClaudeLocal(
  prompt: string,
  options?: { timeoutMs?: number; allowedTools?: string[] }
): Promise<ClaudeRunResult> {
  const startTime = Date.now();
  const timeout = options?.timeoutMs || TIMEOUT_MS;

  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "text", "--dangerously-skip-permissions"];

  if (options?.allowedTools) {
    for (const tool of options.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }

  console.log(
    `[claude-runner] Local spawn: ${prompt.substring(0, 80)}...`
  );
  console.log(`[claude-runner] cwd: ${PROJECT_ROOT}`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
      },
    });

    // Timeout handling
    const timeoutId = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, timeout);

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    clearTimeout(timeoutId);

    const duration_ms = Date.now() - startTime;

    if (exitCode !== 0) {
      console.error(`[claude-runner] Exit ${exitCode}: ${stderr}`);
    }

    return {
      output: output.trim(),
      exitCode,
      duration_ms,
      error: exitCode !== 0 ? stderr || `Exit code ${exitCode}` : null,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    const errMsg =
      error instanceof Error ? error.message : "Unknown spawn error";
    console.error(`[claude-runner] Spawn error: ${errMsg}`);
    return {
      output: "",
      exitCode: 1,
      duration_ms,
      error: errMsg,
    };
  }
}

/**
 * Run Claude CLI remotely on CT110 via SSH.
 * Used for /research commands that need GPU access.
 */
export async function runClaudeRemote(
  prompt: string,
  options?: {
    timeoutMs?: number;
    branch?: string;
    allowedTools?: string[];
  }
): Promise<ClaudeRunResult> {
  const startTime = Date.now();
  const timeout = options?.timeoutMs || TIMEOUT_MS * 2; // Double timeout for remote

  // Escape the prompt for SSH
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  // Build the remote command
  let remoteCmd = `cd ${CT110_PROJECT_ROOT}`;

  // Optionally set up a branch
  if (options?.branch) {
    remoteCmd += ` && git fetch origin && git checkout -b ${options.branch} origin/master 2>/dev/null || git checkout ${options.branch}`;
  }

  // Source env and run claude
  remoteCmd += ` && source /etc/trading-signal-ai.env`;
  remoteCmd += ` && claude -p '${escapedPrompt}' --output-format text`;

  if (options?.allowedTools) {
    for (const tool of options.allowedTools) {
      remoteCmd += ` --allowedTools '${tool}'`;
    }
  }

  console.log(
    `[claude-runner] Remote spawn on CT110: ${prompt.substring(0, 80)}...`
  );

  try {
    const proc = spawn(
      ["ssh", `root@${CT110_HOST}`, remoteCmd],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      }
    );

    const timeoutId = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, timeout);

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    clearTimeout(timeoutId);

    const duration_ms = Date.now() - startTime;

    return {
      output: output.trim(),
      exitCode,
      duration_ms,
      error: exitCode !== 0 ? stderr || `Exit code ${exitCode}` : null,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    const errMsg =
      error instanceof Error ? error.message : "Unknown SSH error";
    console.error(`[claude-runner] SSH error: ${errMsg}`);
    return {
      output: "",
      exitCode: 1,
      duration_ms,
      error: errMsg,
    };
  }
}

/**
 * Get the project root path (for reference).
 */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
