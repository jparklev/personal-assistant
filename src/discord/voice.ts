/**
 * Discord Voice Message Handling
 *
 * Downloads and transcribes voice message attachments from Discord
 * using OpenAI's gpt-4o-mini-transcribe model.
 */

import type { Message, Attachment } from 'discord.js';

const OPENAI_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const TRANSCRIPTION_TIMEOUT_MS = 120000;

/**
 * Check if an attachment is a voice message
 */
export function isVoiceMessage(attachment: Attachment): boolean {
  const contentType = attachment.contentType || '';
  const name = attachment.name || '';

  return (
    contentType.startsWith('audio/') ||
    name.endsWith('.ogg') ||
    name.endsWith('.mp3') ||
    name.endsWith('.wav') ||
    name.endsWith('.m4a') ||
    name.endsWith('.webm') ||
    (attachment as any).duration !== undefined
  );
}

/**
 * Extract voice message attachments from a Discord message
 */
export function getVoiceAttachments(message: Message): Attachment[] {
  return Array.from(message.attachments.values()).filter(isVoiceMessage);
}

// Simple queue to avoid concurrent transcriptions
let transcriptionQueue: Promise<void> = Promise.resolve();

function queue<T>(fn: () => Promise<T>): Promise<T> {
  const next = transcriptionQueue.then(fn, fn);
  transcriptionQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * Download audio from Discord attachment
 */
async function downloadAudio(attachment: Attachment): Promise<Buffer | null> {
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      console.error(`Failed to download attachment: ${response.status}`);
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error('Error downloading attachment:', error);
    return null;
  }
}

/**
 * Transcribe audio using OpenAI's gpt-4o-mini-transcribe
 */
async function transcribeWithOpenAI(audioBuffer: Buffer, filename: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY not set');
    return null;
  }

  try {
    // Use native FormData with Blob (works correctly with fetch in Bun/Node)
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), filename);
    formData.append('model', OPENAI_TRANSCRIPTION_MODEL);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);

    try {
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('OpenAI transcription error:', response.status, error);
        return null;
      }

      const result = await response.json();
      return result.text?.trim() || null;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.error('Transcription timed out');
    } else {
      console.error('Error transcribing with OpenAI:', error);
    }
    return null;
  }
}

export interface TranscriptionResult {
  success: boolean;
  transcript?: string;
  error?: string;
  durationMs?: number;
}

/**
 * Transcribe a Discord voice message attachment
 */
export async function transcribeVoiceMessage(attachment: Attachment): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: 'OPENAI_API_KEY not configured',
    };
  }

  return await queue(async () => {
    const startTime = Date.now();

    // Download the audio
    const audioBuffer = await downloadAudio(attachment);
    if (!audioBuffer) {
      return {
        success: false,
        error: 'Failed to download voice message',
      };
    }

    // Transcribe
    const filename = attachment.name || 'voice.ogg';
    const transcript = await transcribeWithOpenAI(audioBuffer, filename);

    if (!transcript) {
      return {
        success: false,
        error: 'Transcription failed',
      };
    }

    return {
      success: true,
      transcript,
      durationMs: Date.now() - startTime,
    };
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
