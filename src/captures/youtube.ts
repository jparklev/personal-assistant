import { execSync } from 'child_process';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { transcribeAudioFile, getTranscriptionMethod } from '../podcast/transcribe';

const TEMP_DIR = join(tmpdir(), 'youtube-transcribe');

function isYtDlpAvailable(): boolean {
  try {
    execSync('which yt-dlp', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function newestFile(prefix: string): string | null {
  try {
    const files = readdirSync(TEMP_DIR)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, stat: statSync(join(TEMP_DIR, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (files.length === 0) return null;
    return join(TEMP_DIR, files[0].f);
  } catch {
    return null;
  }
}

export interface YoutubeTranscriptResult {
  success: boolean;
  title?: string;
  author?: string;
  transcript?: string;
  error?: string;
}

export async function transcribeYoutube(
  url: string,
  onProgress?: (msg: string) => void
): Promise<YoutubeTranscriptResult> {
  const progress = onProgress || (() => {});

  if (!isYtDlpAvailable()) {
    return { success: false, error: 'yt-dlp not found on PATH' };
  }
  const transcriptionMethod = await getTranscriptionMethod();
  if (!transcriptionMethod) {
    return { success: false, error: 'No transcription method available (need mlx_whisper or faster-whisper)' };
  }

  mkdirSync(TEMP_DIR, { recursive: true });
  const prefix = `youtube-${Date.now()}`;
  const template = join(TEMP_DIR, `${prefix}.%(ext)s`);

  let title = 'YouTube';
  let author: string | undefined;
  try {
    title = execSync(`yt-dlp --no-warnings --no-playlist --print title "${url}"`, { stdio: 'pipe' })
      .toString()
      .trim() || title;
  } catch {}
  try {
    const uploader = execSync(`yt-dlp --no-warnings --no-playlist --print uploader "${url}"`, { stdio: 'pipe' })
      .toString()
      .trim();
    if (uploader) author = uploader;
  } catch {}

  progress(`Downloading audio for "${title}"...`);
  try {
    execSync(`yt-dlp --no-warnings --no-playlist -x --audio-format mp3 -o "${template}" "${url}"`, {
      stdio: 'pipe',
      timeout: 20 * 60 * 1000,
    });
  } catch (e: any) {
    return { success: false, error: e?.message || 'yt-dlp download failed' };
  }

  const audioPath = newestFile(prefix);
  if (!audioPath) {
    return { success: false, error: 'Downloaded audio file not found' };
  }

  progress(`Transcribing with ${transcriptionMethod} (this may take a while)...`);
  let transcript: string | null = null;
  try {
    transcript = await transcribeAudioFile(audioPath);
  } finally {
    try {
      if (existsSync(audioPath)) unlinkSync(audioPath);
    } catch {}
  }

  if (!transcript) return { success: false, error: 'Transcription failed' };
  return { success: true, title, author, transcript };
}

