/**
 * Discord Voice Message Handling
 *
 * Downloads and transcribes voice message attachments from Discord.
 * Discord voice messages are .ogg files attached to messages.
 *
 * Transcription methods (in order of preference):
 * - mlx_whisper: macOS Apple Silicon (fast, local)
 * - faster-whisper: Linux/VPS via Python venv (CPU-optimized)
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir, platform } from 'os';
import type { Message, Attachment } from 'discord.js';

const TEMP_DIR = join(tmpdir(), 'discord-voice');

// Ensure temp directory exists
if (!existsSync(TEMP_DIR)) {
  mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Check if an attachment is a voice message
 */
export function isVoiceMessage(attachment: Attachment): boolean {
  // Discord voice messages have these characteristics:
  // - Content type is audio/ogg or similar
  // - Often have waveform/duration metadata
  // - File extension is typically .ogg
  const contentType = attachment.contentType || '';
  const name = attachment.name || '';

  return (
    contentType.startsWith('audio/') ||
    name.endsWith('.ogg') ||
    name.endsWith('.mp3') ||
    name.endsWith('.wav') ||
    name.endsWith('.m4a') ||
    name.endsWith('.webm') ||
    // Discord voice messages often have duration metadata
    (attachment as any).duration !== undefined
  );
}

/**
 * Extract voice message attachments from a Discord message
 */
export function getVoiceAttachments(message: Message): Attachment[] {
  return Array.from(message.attachments.values()).filter(isVoiceMessage);
}

type TranscriptionMethod = 'mlx_whisper' | 'faster-whisper' | null;

type RunResult = { ok: boolean; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type RunOptions = { env?: NodeJS.ProcessEnv; timeoutMs?: number };

async function runCommand(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return await new Promise<RunResult>((resolve) => {
    let settled = false;
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timeoutMs = opts.timeoutMs ?? 0;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
          }, timeoutMs)
        : null;

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0 && signal == null,
        code,
        signal: signal as any,
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}${String(err)}`,
      });
    });
  });
}

function queue<T>(fn: () => Promise<T>): Promise<T> {
  const next = transcriptionQueue.then(fn, fn);
  transcriptionQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

let transcriptionQueue: Promise<void> = Promise.resolve();
let cachedMethod: TranscriptionMethod | undefined;
let methodCheck: Promise<TranscriptionMethod> | null = null;

/**
 * Check which transcription method is available
 */
export async function getTranscriptionMethod(): Promise<TranscriptionMethod> {
  if (cachedMethod !== undefined) return cachedMethod;
  if (methodCheck) return await methodCheck;

  methodCheck = (async () => {
  // On macOS, prefer mlx_whisper (Apple Silicon optimized)
  if (platform() === 'darwin') {
    try {
      const result = await runCommand('which', ['mlx_whisper'], { timeoutMs: 2000 });
      if (result.ok && result.stdout.trim()) {
        cachedMethod = 'mlx_whisper';
        return 'mlx_whisper';
      }
    } catch {}
  }

  // Check for faster-whisper in venv (Linux VPS)
  const venvPython = join(homedir(), 'whisper-venv', 'bin', 'python');
  if (existsSync(venvPython)) {
    try {
      const result = await runCommand(venvPython, ['-c', 'import faster_whisper'], { timeoutMs: 5000 });
      if (result.ok) {
        cachedMethod = 'faster-whisper';
        return 'faster-whisper';
      }
    } catch {}
  }

  cachedMethod = null;
  return null;
  })();

  try {
    return await methodCheck;
  } finally {
    methodCheck = null;
  }
}

/**
 * Download an attachment to a temp file
 */
async function downloadAttachment(attachment: Attachment): Promise<string | null> {
  const ext = attachment.name?.split('.').pop() || 'ogg';
  const filename = `voice-${Date.now()}.${ext}`;
  const filepath = join(TEMP_DIR, filename);

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      console.error(`Failed to download attachment: ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(filepath, buffer);
    return filepath;
  } catch (error) {
    console.error('Error downloading attachment:', error);
    return null;
  }
}

/**
 * Transcribe an audio file using mlx_whisper (macOS)
 */
async function transcribeWithMlxWhisper(audioPath: string): Promise<string | null> {
  const baseName = audioPath.replace(/\.[^.]+$/, '');

  try {
    const env = { ...process.env, PATH: `${process.env.PATH}:/Users/joshlevine/.local/bin` };
    const result = await runCommand(
      'mlx_whisper',
      [audioPath, '--model', 'large-v3', '--output-format', 'txt', '--output-dir', TEMP_DIR],
      { timeoutMs: 120000, env }
    );
    if (!result.ok) return null;

    const outputPath = `${baseName}.txt`;
    if (existsSync(outputPath)) {
      const transcript = (await readFile(outputPath, 'utf-8')).trim();
      await rm(outputPath, { force: true });
      return transcript;
    }
    return null;
  } catch (error) {
    console.error('Error transcribing with mlx_whisper:', error);
    return null;
  }
}

/**
 * Transcribe an audio file using faster-whisper (Linux/VPS)
 */
async function transcribeWithFasterWhisper(audioPath: string): Promise<string | null> {
  const venvPython = join(homedir(), 'whisper-venv', 'bin', 'python');

  try {
    const script = [
      'import sys',
      'from faster_whisper import WhisperModel',
      "model = WhisperModel('base', device='cpu', compute_type='int8')",
      'segments, _ = model.transcribe(sys.argv[1], beam_size=5)',
      "print(' '.join(s.text.strip() for s in segments))",
    ].join('\n');

    const result = await runCommand(venvPython, ['-c', script, audioPath], {
      timeoutMs: 120000,
      env: { ...process.env, OMP_NUM_THREADS: '4' },
    });

    if (!result.ok) return null;
    return result.stdout.trim() || null;
  } catch (error) {
    console.error('Error transcribing with faster-whisper:', error);
    return null;
  }
}

/**
 * Transcribe an audio file using the available method
 */
async function transcribeFile(audioPath: string, method: TranscriptionMethod): Promise<string | null> {
  if (method === 'mlx_whisper') {
    return await transcribeWithMlxWhisper(audioPath);
  } else if (method === 'faster-whisper') {
    return await transcribeWithFasterWhisper(audioPath);
  }
  return null;
}

/**
 * Clean up a temp file
 */
async function cleanup(filepath: string): Promise<void> {
  try {
    await rm(filepath, { force: true });
  } catch {}
}

export interface TranscriptionResult {
  success: boolean;
  transcript?: string;
  error?: string;
  durationMs?: number;
  method?: string;
}

/**
 * Transcribe a Discord voice message attachment
 */
export async function transcribeVoiceMessage(attachment: Attachment): Promise<TranscriptionResult> {
  const method = await getTranscriptionMethod();

  if (!method) {
    return {
      success: false,
      error: 'No transcription tool available (need mlx_whisper on macOS or faster-whisper venv on Linux)',
    };
  }

  return await queue(async () => {
    const startTime = Date.now();

    // Download the audio
    const audioPath = await downloadAttachment(attachment);
    if (!audioPath) {
      return {
        success: false,
        error: 'Failed to download voice message',
      };
    }

    try {
      // Transcribe
      const transcript = await transcribeFile(audioPath, method);

      if (!transcript) {
        return {
          success: false,
          error: 'Transcription returned empty result',
        };
      }

      return {
        success: true,
        transcript,
        durationMs: Date.now() - startTime,
        method,
      };
    } finally {
      await cleanup(audioPath);
    }
  });
}

/**
 * Process all voice attachments in a message and return transcripts
 */
export async function transcribeMessageVoice(message: Message): Promise<{
  transcripts: string[];
  errors: string[];
}> {
  const voiceAttachments = getVoiceAttachments(message);
  const transcripts: string[] = [];
  const errors: string[] = [];

  for (const attachment of voiceAttachments) {
    const result = await transcribeVoiceMessage(attachment);
    if (result.success && result.transcript) {
      transcripts.push(result.transcript);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { transcripts, errors };
}
