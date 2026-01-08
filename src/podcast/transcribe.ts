/**
 * Podcast transcription using mlx-whisper or faster-whisper
 *
 * Workflow:
 * 1. Detect podcast URL type
 * 2. Fetch audio URL from podcast page/RSS
 * 3. Download audio to temp file
 * 4. Transcribe with mlx-whisper (macOS) or faster-whisper (Linux/VPS)
 * 5. Clean up and return transcript
 */

import { spawn, execSync } from 'child_process';
import { existsSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir, platform } from 'os';

const TEMP_DIR = join(tmpdir(), 'podcast-transcribe');

// Podcast URL patterns
const PODCAST_PATTERNS = {
  pocketCasts: /pca\.st\/episode\/([a-f0-9-]+)/i,
  apple: /podcasts\.apple\.com\/.*\/podcast\/.*\/id(\d+).*i=(\d+)/i,
  spotify: /open\.spotify\.com\/episode\/([a-zA-Z0-9]+)/i,
  overcast: /overcast\.fm\/\+([a-zA-Z0-9]+)/i,
};

export interface PodcastInfo {
  title: string;
  show: string;
  audioUrl: string;
  duration?: string;
  description?: string;
  readMoreUrl?: string;
}

export interface TranscriptionResult {
  success: boolean;
  transcript?: string;
  error?: string;
  podcastInfo?: PodcastInfo;
}

/**
 * Check if a URL is a podcast episode
 */
export function isPodcastUrl(url: string): boolean {
  return Object.values(PODCAST_PATTERNS).some(pattern => pattern.test(url));
}

/**
 * Get podcast type from URL
 */
export function getPodcastType(url: string): string | null {
  for (const [type, pattern] of Object.entries(PODCAST_PATTERNS)) {
    if (pattern.test(url)) return type;
  }
  return null;
}

/**
 * Fetch podcast info and audio URL from a Pocket Casts episode page
 */
async function fetchPocketCastsInfo(url: string): Promise<PodcastInfo | null> {
  try {
    // Fetch the episode page
    const response = await fetch(url);
    const html = await response.text();

    // Extract title from og:title or page title
    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    const title = titleMatch?.[1] || 'Unknown Episode';

    // Extract show name
    const showMatch = html.match(/<meta property="og:site_name" content="([^"]+)"/);
    const show = showMatch?.[1] || 'Unknown Podcast';

    // Extract audio URL - look for various patterns
    // Pocket Casts typically has the audio URL in a data attribute or script
    const audioMatch = html.match(/(?:src|url|audio)['":\s]+['"]?(https?:\/\/[^'">\s]+\.(?:mp3|m4a|opus|ogg)[^'">\s]*)/i);

    // "Read more" often points to the podcast's own site (sometimes includes transcript)
    const readMoreMatch = html.match(/href="(https?:\/\/[^"]+)"[^>]*>\s*Read more\s*<\/a>/i);
    const readMoreUrl = readMoreMatch?.[1];

    if (!audioMatch) {
      // Try to find it in JSON-LD or other structured data
      const jsonLdMatch = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
      if (jsonLdMatch) {
        try {
          const jsonLd = JSON.parse(jsonLdMatch[1]);
          if (jsonLd.contentUrl) {
            return { title, show, audioUrl: jsonLd.contentUrl, readMoreUrl };
          }
        } catch {}
      }

      // No direct audio URL found; still return metadata so callers can follow readMoreUrl.
      return { title, show, audioUrl: '', readMoreUrl };
    }

    return { title, show, audioUrl: audioMatch[1], readMoreUrl };
  } catch (error) {
    console.error('Error fetching Pocket Casts info:', error);
    return null;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : _m;
    });
}

function stripHtml(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<\/(p|div|section|article|header|footer|li|h1|h2|h3|h4|h5|h6)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

async function fetchTranscriptFromReadMore(readMoreUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(readMoreUrl);
    const html = await resp.text();

    const marker = 'id="transcript"';
    const idx = html.indexOf(marker);
    if (idx === -1) return null;

    const start = html.lastIndexOf('<div', idx);
    if (start === -1) return null;

    const end = html.indexOf('</div>', idx);
    if (end === -1) return null;

    const slice = html.slice(start, end + '</div>'.length);
    const text = stripHtml(slice);
    if (!text) return null;
    if (text.length < 2000) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Fetch podcast info via RSS feed lookup
 * Uses Podcast Index API or direct RSS parsing
 */
async function fetchViaRss(showName: string, episodeTitle: string): Promise<PodcastInfo | null> {
  // TODO: Implement RSS feed lookup via Podcast Index API
  // For now, return null and let callers handle the fallback
  return null;
}

/**
 * Download audio file to temp directory
 */
async function downloadAudio(audioUrl: string, filename: string): Promise<string | null> {
  mkdirSync(TEMP_DIR, { recursive: true });
  const tempPath = join(TEMP_DIR, filename);

  try {
    console.log(`Downloading audio from ${audioUrl}...`);

    // Use curl for reliable downloads with progress
    execSync(`curl -L -o "${tempPath}" "${audioUrl}"`, {
      timeout: 300000, // 5 minute timeout for large files
      stdio: 'pipe'
    });

    if (existsSync(tempPath)) {
      return tempPath;
    }
    return null;
  } catch (error) {
    console.error('Error downloading audio:', error);
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
    return null;
  }
}

/**
 * Transcribe audio file using mlx-whisper (macOS)
 */
async function transcribeWithMlxWhisper(audioPath: string): Promise<string | null> {
  const outputPath = audioPath.replace(/\.[^.]+$/, '.txt');

  try {
    console.log(`Transcribing ${audioPath} with mlx_whisper...`);

    const env = { ...process.env, PATH: `${process.env.PATH}:/Users/joshlevine/.local/bin` };
    const result = await runCommand(
      'mlx_whisper',
      [audioPath, '--model', 'large-v3', '--output-format', 'txt', '--output-dir', TEMP_DIR],
      { timeoutMs: 1800000, env } // 30 minute timeout for long podcasts
    );

    if (!result.ok) {
      console.error('mlx_whisper failed:', result.stderr);
      return null;
    }

    // Read the transcript
    if (existsSync(outputPath)) {
      const transcript = readFileSync(outputPath, 'utf-8');
      // Clean up output file
      unlinkSync(outputPath);
      return transcript.trim();
    }

    return null;
  } catch (error) {
    console.error('Error transcribing with mlx_whisper:', error);
    return null;
  }
}

/**
 * Transcribe audio file using faster-whisper (Linux/VPS)
 */
async function transcribeWithFasterWhisper(audioPath: string): Promise<string | null> {
  const venvPython = join(homedir(), 'whisper-venv', 'bin', 'python');

  try {
    console.log(`Transcribing ${audioPath} with faster-whisper...`);

    // Use 'base' model for speed on VPS, beam_size=5 for accuracy
    const script = [
      'import sys',
      'from faster_whisper import WhisperModel',
      "model = WhisperModel('base', device='cpu', compute_type='int8')",
      'segments, _ = model.transcribe(sys.argv[1], beam_size=5)',
      "print(' '.join(s.text.strip() for s in segments))",
    ].join('\n');

    const result = await runCommand(venvPython, ['-c', script, audioPath], {
      timeoutMs: 1800000, // 30 minute timeout for long podcasts
      env: { ...process.env, OMP_NUM_THREADS: '4' },
    });

    if (!result.ok) {
      console.error('faster-whisper failed:', result.stderr);
      return null;
    }

    return result.stdout.trim() || null;
  } catch (error) {
    console.error('Error transcribing with faster-whisper:', error);
    return null;
  }
}

/**
 * Transcribe audio file using the best available method
 */
export async function transcribeAudioFile(audioPath: string): Promise<string | null> {
  const method = await getTranscriptionMethod();

  if (!method) {
    console.error('No transcription method available');
    return null;
  }

  console.log(`Using transcription method: ${method}`);

  if (method === 'mlx_whisper') {
    return await transcribeWithMlxWhisper(audioPath);
  } else if (method === 'faster-whisper') {
    return await transcribeWithFasterWhisper(audioPath);
  }

  return null;
}

/**
 * Clean up temp files
 */
function cleanup(audioPath: string): void {
  try {
    if (existsSync(audioPath)) {
      unlinkSync(audioPath);
    }
  } catch {}
}

/**
 * Main transcription function
 * Takes a podcast URL and returns the transcript
 */
export async function transcribePodcast(
  url: string,
  onProgress?: (message: string) => void
): Promise<TranscriptionResult> {
  const progress = onProgress || console.log;

  // Detect podcast type
  const podcastType = getPodcastType(url);
  if (!podcastType) {
    return { success: false, error: 'Not a recognized podcast URL' };
  }

  progress(`Detected ${podcastType} podcast URL`);

  // Fetch podcast info based on type
  let podcastInfo: PodcastInfo | null = null;

  if (podcastType === 'pocketCasts') {
    progress('Fetching episode info from Pocket Casts...');
    podcastInfo = await fetchPocketCastsInfo(url);
  }

  // If we couldn't get info directly, we can't proceed
  if (!podcastInfo) {
    return {
      success: false,
      error: 'Could not fetch podcast info.'
    };
  }

  progress(`Found: "${podcastInfo.title}" from ${podcastInfo.show}`);

  // Prefer an explicit transcript if available on the podcast's own site.
  if (podcastInfo.readMoreUrl) {
    progress('Checking for transcript on the episode page...');
    const transcript = await fetchTranscriptFromReadMore(podcastInfo.readMoreUrl);
    if (transcript) {
      progress('Transcript found.');
      return { success: true, transcript, podcastInfo };
    }
  }

  if (!podcastInfo.audioUrl) {
    return {
      success: false,
      error: 'Could not find an audio URL or embedded transcript for this podcast.'
    };
  }

  // Generate temp filename
  const filename = `podcast-${Date.now()}.mp3`;

  // Download audio
  progress('Downloading audio file (this may take a few minutes)...');
  const audioPath = await downloadAudio(podcastInfo.audioUrl, filename);

  if (!audioPath) {
    return { success: false, error: 'Failed to download audio file' };
  }

  try {
    // Transcribe
    progress('Transcribing with mlx-whisper (this may take 5-15 minutes)...');
    const transcript = await transcribeAudioFile(audioPath);

    if (!transcript) {
      return { success: false, error: 'Transcription failed' };
    }

    progress('Transcription complete!');

    return {
      success: true,
      transcript,
      podcastInfo
    };
  } finally {
    // Always clean up
    cleanup(audioPath);
  }
}

// ============== Transcription Method Detection ==============

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
 * Check if any whisper transcription method is available (legacy compatibility)
 */
export function isWhisperAvailable(): boolean {
  // This is a sync check - returns true if we've cached a method
  // For proper async checking, use getTranscriptionMethod()
  if (cachedMethod !== undefined) return cachedMethod !== null;

  // Sync fallback: check mlx_whisper on macOS
  if (platform() === 'darwin') {
    try {
      const { execSync } = require('child_process');
      execSync('which mlx_whisper', { stdio: 'pipe' });
      return true;
    } catch {}
  }

  // Check for faster-whisper venv
  const venvPython = join(homedir(), 'whisper-venv', 'bin', 'python');
  return existsSync(venvPython);
}
