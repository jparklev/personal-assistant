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

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
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

/**
 * Check which transcription method is available
 */
export function getTranscriptionMethod(): TranscriptionMethod {
  // On macOS, prefer mlx_whisper (Apple Silicon optimized)
  if (platform() === 'darwin') {
    try {
      const result = spawnSync('which', ['mlx_whisper'], { encoding: 'utf-8' });
      if (result.status === 0 && result.stdout.trim()) {
        return 'mlx_whisper';
      }
    } catch {}
  }

  // Check for faster-whisper in venv (Linux VPS)
  const venvPython = join(homedir(), 'whisper-venv', 'bin', 'python');
  if (existsSync(venvPython)) {
    try {
      const result = spawnSync(venvPython, ['-c', 'import faster_whisper'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (result.status === 0) {
        return 'faster-whisper';
      }
    } catch {}
  }

  return null;
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
    writeFileSync(filepath, buffer);
    return filepath;
  } catch (error) {
    console.error('Error downloading attachment:', error);
    return null;
  }
}

/**
 * Transcribe an audio file using mlx_whisper (macOS)
 */
function transcribeWithMlxWhisper(audioPath: string): string | null {
  const baseName = audioPath.replace(/\.[^.]+$/, '');

  try {
    execSync(
      `mlx_whisper "${audioPath}" --model large-v3 --output-format txt --output-dir "${TEMP_DIR}"`,
      {
        timeout: 120000,
        stdio: 'pipe',
        env: { ...process.env, PATH: `${process.env.PATH}:/Users/joshlevine/.local/bin` },
      }
    );

    const outputPath = `${baseName}.txt`;
    if (existsSync(outputPath)) {
      const transcript = readFileSync(outputPath, 'utf-8').trim();
      unlinkSync(outputPath);
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
function transcribeWithFasterWhisper(audioPath: string): string | null {
  const venvPython = join(homedir(), 'whisper-venv', 'bin', 'python');

  try {
    // Use base model for speed on CPU; voice messages are typically short
    const result = execSync(
      `${venvPython} -c "
from faster_whisper import WhisperModel
model = WhisperModel('base', device='cpu', compute_type='int8')
segments, _ = model.transcribe('${audioPath}', beam_size=5)
print(' '.join(s.text.strip() for s in segments))
"`,
      {
        timeout: 120000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OMP_NUM_THREADS: '4', // Optimize CPU usage
        },
      }
    );

    return result.trim() || null;
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
    return transcribeWithMlxWhisper(audioPath);
  } else if (method === 'faster-whisper') {
    return transcribeWithFasterWhisper(audioPath);
  }
  return null;
}

/**
 * Clean up a temp file
 */
function cleanup(filepath: string): void {
  try {
    if (existsSync(filepath)) {
      unlinkSync(filepath);
    }
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
  const method = getTranscriptionMethod();

  if (!method) {
    return {
      success: false,
      error: 'No transcription tool available (need mlx_whisper on macOS or faster-whisper venv on Linux)',
    };
  }

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
    cleanup(audioPath);
  }
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
