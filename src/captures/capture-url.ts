import { saveCapture, detectContentType, type CaptureMetadata } from './index';
import { transcribePodcast, isWhisperAvailable } from '../podcast/transcribe';
import { transcribeYoutube } from './youtube';

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

function extractTitle(html: string): string | null {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (og?.[1]) return decodeHtmlEntities(og[1].trim());
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) return decodeHtmlEntities(title[1].trim());
  return null;
}

const MAX_RAW_CHARS = 1_000_000;

export type CaptureUrlResult =
  | { success: true; capturePath: string; captureFilename: string; meta: CaptureMetadata }
  | { success: false; error: string };

export async function captureUrlToFile(
  url: string,
  onProgress?: (msg: string) => void
): Promise<CaptureUrlResult> {
  const progress = onProgress || (() => {});
  const type = detectContentType(url);
  const capturedAt = new Date().toISOString();

  if (type === 'podcast') {
    if (!isWhisperAvailable()) return { success: false, error: 'mlx_whisper not available' };
    progress('Fetching audio + transcribing podcast…');
    const res = await transcribePodcast(url, progress);
    if (!res.success || !res.transcript) return { success: false, error: res.error || 'Podcast transcription failed' };

    const title = res.podcastInfo?.title || 'Podcast';
    const author = res.podcastInfo?.show;
    const content = [
      `## Podcast`,
      '',
      res.podcastInfo?.show ? `**Show:** ${res.podcastInfo.show}` : '',
      res.podcastInfo?.title ? `**Episode:** ${res.podcastInfo.title}` : '',
      res.podcastInfo?.audioUrl ? `**Audio:** ${res.podcastInfo.audioUrl}` : '',
      '',
      `## Transcript`,
      '',
      res.transcript,
    ].filter(Boolean).join('\n');

    const meta: CaptureMetadata = {
      title,
      url,
      type: 'podcast',
      capturedAt,
      description: res.podcastInfo?.description,
      author,
    };
    const saved = saveCapture(meta, content);
    if (!saved.success || !saved.filePath) return { success: false, error: saved.error || 'Failed to save capture' };
    return { success: true, capturePath: saved.filePath, captureFilename: saved.filePath.split('/').pop()!, meta };
  }

  if (type === 'youtube') {
    progress('Downloading + transcribing YouTube…');
    const res = await transcribeYoutube(url, progress);
    if (!res.success || !res.transcript) return { success: false, error: res.error || 'YouTube transcription failed' };
    const meta: CaptureMetadata = {
      title: res.title || 'YouTube',
      url,
      type: 'youtube',
      capturedAt,
      author: res.author,
    };
    const content = [`## Transcript`, '', res.transcript].join('\n');
    const saved = saveCapture(meta, content);
    if (!saved.success || !saved.filePath) return { success: false, error: saved.error || 'Failed to save capture' };
    return { success: true, capturePath: saved.filePath, captureFilename: saved.filePath.split('/').pop()!, meta };
  }

  if (type === 'pdf') {
    // Reasonable fallback: store a pointer; implementing PDF extraction is separate.
    const meta: CaptureMetadata = {
      title: 'PDF',
      url,
      type: 'pdf',
      capturedAt,
    };
    const content = `PDF capture not implemented yet.\n\nSource: ${url}`;
    const saved = saveCapture(meta, content);
    if (!saved.success || !saved.filePath) return { success: false, error: saved.error || 'Failed to save capture' };
    return { success: true, capturePath: saved.filePath, captureFilename: saved.filePath.split('/').pop()!, meta };
  }

  progress('Fetching page…');
  let html = '';
  try {
    const resp = await fetch(url);
    html = await resp.text();
  } catch (e: any) {
    return { success: false, error: e?.message || 'Fetch failed' };
  }

  const title = extractTitle(html) || url;
  const text = stripHtml(html);
  const raw = html.length > MAX_RAW_CHARS ? html.slice(0, MAX_RAW_CHARS) + '\n\n<!-- truncated -->\n' : html;

  const meta: CaptureMetadata = {
    title,
    url,
    type: 'article',
    capturedAt,
  };
  const content = [
    `## Extracted Text`,
    '',
    text,
    '',
    `## Raw HTML`,
    '',
    raw,
  ].join('\n');

  const saved = saveCapture(meta, content);
  if (!saved.success || !saved.filePath) return { success: false, error: saved.error || 'Failed to save capture' };
  return { success: true, capturePath: saved.filePath, captureFilename: saved.filePath.split('/').pop()!, meta };
}
