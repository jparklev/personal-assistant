import { execFileSync } from 'child_process';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CommandResult {
  ok: boolean;
  output: string;
}

export interface ValidationStep {
  name: string;
  command: string;
  ok: boolean;
  output: string;
}

export interface ValidationGateResult {
  ok: boolean;
  steps: ValidationStep[];
}

export interface MetaAutomationResult {
  changedFiles: string[];
  validation: ValidationGateResult | null;
  committed: boolean;
  pushed: boolean;
  commitHash?: string;
  message: string;
}

function run(args: string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): CommandResult {
  try {
    const output = execFileSync(args[0], args.slice(1), {
      cwd,
      timeout: timeoutMs,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return { ok: true, output: output || '' };
  } catch (err: any) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
    const message = err?.message || String(err);
    return { ok: false, output: `${stdout}${stderr}${message}` };
  }
}

function parseStatusPath(raw: string): string | null {
  const line = raw.trimEnd();
  if (!line) return null;
  if (line.startsWith('?? ')) return line.slice(3).trim();
  if (line.length < 4) return null;

  const payload = line.slice(3).trim();
  if (!payload) return null;

  const renameIdx = payload.indexOf(' -> ');
  if (renameIdx !== -1) {
    return payload.slice(renameIdx + 4).trim();
  }
  return payload;
}

export function listDirtyFiles(cwd: string): string[] {
  const result = run(['git', 'status', '--porcelain'], cwd);
  if (!result.ok || !result.output) return [];

  const out = new Set<string>();
  for (const line of result.output.split('\n')) {
    const path = parseStatusPath(line);
    if (path) out.add(path);
  }
  return [...out];
}

export function findNewDirtyFiles(cwd: string, baselineDirtyFiles: string[]): string[] {
  const baseline = new Set(baselineDirtyFiles);
  const after = listDirtyFiles(cwd);
  return after.filter((path) => !baseline.has(path));
}

export function runValidationGate(cwd: string): ValidationGateResult {
  const steps: Array<{ name: string; command: string; args: string[] }> = [
    { name: 'tests', command: 'bun test tests', args: ['bun', 'test', 'tests'] },
    { name: 'typecheck', command: 'bun run typecheck', args: ['bun', 'run', 'typecheck'] },
    { name: 'build', command: 'bun run build', args: ['bun', 'run', 'build'] },
  ];

  const results: ValidationStep[] = [];
  for (const step of steps) {
    const result = run(step.args, cwd);
    results.push({
      name: step.name,
      command: step.command,
      ok: result.ok,
      output: result.output,
    });
    if (!result.ok) {
      return { ok: false, steps: results };
    }
  }

  return { ok: true, steps: results };
}

function stageFiles(cwd: string, files: string[]): CommandResult {
  if (files.length === 0) return { ok: true, output: '' };
  return run(['git', 'add', '--', ...files], cwd);
}

export function runMetaAutomation(opts: {
  cwd: string;
  baselineDirtyFiles: string[];
  commitMessage: string;
}): MetaAutomationResult {
  const changedFiles = findNewDirtyFiles(opts.cwd, opts.baselineDirtyFiles);
  if (changedFiles.length === 0) {
    return {
      changedFiles,
      validation: null,
      committed: false,
      pushed: false,
      message: 'No repository changes detected.',
    };
  }

  const validation = runValidationGate(opts.cwd);
  if (!validation.ok) {
    const failed = validation.steps.find((s) => !s.ok);
    return {
      changedFiles,
      validation,
      committed: false,
      pushed: false,
      message: `Validation failed at ${failed?.name || 'unknown step'}.`,
    };
  }

  const addResult = stageFiles(opts.cwd, changedFiles);
  if (!addResult.ok) {
    return {
      changedFiles,
      validation,
      committed: false,
      pushed: false,
      message: 'Failed to stage changed files.',
    };
  }

  const stagedCheck = run(['git', 'diff', '--cached', '--name-only'], opts.cwd);
  if (!stagedCheck.ok || !stagedCheck.output.trim()) {
    return {
      changedFiles,
      validation,
      committed: false,
      pushed: false,
      message: 'No staged changes to commit.',
    };
  }

  const commitResult = run(['git', 'commit', '-m', opts.commitMessage], opts.cwd);
  if (!commitResult.ok) {
    return {
      changedFiles,
      validation,
      committed: false,
      pushed: false,
      message: 'Validation passed but commit failed.',
    };
  }

  const hashResult = run(['git', 'rev-parse', '--short', 'HEAD'], opts.cwd);
  const commitHash = hashResult.ok ? hashResult.output.split('\n')[0]?.trim() : undefined;

  const pushResult = run(['git', 'push'], opts.cwd);
  return {
    changedFiles,
    validation,
    committed: true,
    pushed: pushResult.ok,
    commitHash,
    message: pushResult.ok ? 'Committed and pushed successfully.' : 'Committed locally, push failed.',
  };
}

export function formatMetaAutomationSummary(result: MetaAutomationResult): string {
  const lines: string[] = ['**Meta Gate**'];

  if (result.changedFiles.length === 0) {
    lines.push('- changes: none');
    lines.push('- validation: skipped');
    return lines.join('\n');
  }

  lines.push(`- changes: ${result.changedFiles.length} file(s)`);
  lines.push(`- validation: ${result.validation?.ok ? 'passed' : 'failed'}`);

  if (result.validation && !result.validation.ok) {
    const failed = result.validation.steps.find((s) => !s.ok);
    if (failed) lines.push(`- failed step: ${failed.name}`);
  }

  lines.push(`- commit: ${result.committed ? result.commitHash || 'created' : 'skipped'}`);
  lines.push(`- push: ${result.committed ? (result.pushed ? 'ok' : 'failed') : 'skipped'}`);
  lines.push(`- status: ${result.message}`);
  return lines.join('\n');
}
