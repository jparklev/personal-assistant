import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../config';
import { canonicalizeBlipSource } from '../blips';
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter';

type CaptureInfo = { filename: string; url: string; canonicalUrl: string };

function usage(): never {
  console.error('Usage: bun run src/tools/blips-cleanup.ts [--apply]');
  process.exit(2);
}

function isTestHarnessBlip(raw: string, source?: string, title?: string): boolean {
  if (title && title.toLowerCase() === 'example domain') return true;
  if (/Captured from test harness\./i.test(raw)) return true;
  return false;
}

function listMarkdownFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.md'));
}

function buildCaptureIndex(capturesDir: string): Map<string, CaptureInfo> {
  const out = new Map<string, CaptureInfo>();
  if (!existsSync(capturesDir)) return out;

  for (const filename of listMarkdownFiles(capturesDir)) {
    const path = join(capturesDir, filename);
    let url = '';
    try {
      const raw = readFileSync(path, 'utf-8');
      const { frontmatter } = parseFrontmatter<any>(raw);
      url = typeof frontmatter?.url === 'string' ? frontmatter.url : '';
    } catch {
      continue;
    }
    const canonicalUrl = canonicalizeBlipSource(url);
    if (!canonicalUrl) continue;

    const existing = out.get(canonicalUrl);
    if (!existing) {
      out.set(canonicalUrl, { filename, url, canonicalUrl });
      continue;
    }

    const existingHasTest = /\bmcp_test=/i.test(existing.url);
    const nextHasTest = /\bmcp_test=/i.test(url);
    if (existingHasTest && !nextHasTest) {
      out.set(canonicalUrl, { filename, url, canonicalUrl });
      continue;
    }

    // Otherwise keep whichever filename is lexicographically smaller (stable).
    if (filename < existing.filename) out.set(canonicalUrl, { filename, url, canonicalUrl });
  }

  return out;
}

function ensureFullCaptureLine(content: string, captureFilename: string): string {
  const line = `- Full capture: ~/.assistant/captures/${captureFilename}`;
  if (content.includes(line)) return content;

  const marker = '## Capture';
  const idx = content.indexOf(marker);
  if (idx === -1) return content.trimEnd() + `\n\n## Capture\n\n${line}\n`;

  const afterMarker = content.slice(idx + marker.length);
  const before = content.slice(0, idx + marker.length);
  return (before + `\n\n${line}\n` + afterMarker).trimEnd() + '\n';
}

type BlipFile = {
  filename: string;
  path: string;
  title: string;
  source: string;
  canonicalSource: string;
  frontmatter: any;
  content: string;
  raw: string;
};

function scoreBlip(b: BlipFile): number {
  let score = 0;
  const status = typeof b.frontmatter.status === 'string' ? b.frontmatter.status : '';
  // Content quality wins; status is secondary.
  if (status === 'bumped') score += 20;
  if (status === 'snoozed') score += 5;
  if (status === 'archived') score += 1;

  if (Array.isArray(b.frontmatter.tags) && b.frontmatter.tags.length > 0) score += 3;
  if (typeof b.frontmatter.capture === 'string' && b.frontmatter.capture) score += 8;
  if (typeof b.frontmatter.bumped_to === 'string' && b.frontmatter.bumped_to) score += 10;

  if (/Captured from test harness\./i.test(b.raw)) score -= 50;

  const clen = (b.content || '').trim().length;
  score += Math.min(120, Math.floor(clen / 40));

  return score;
}

function uniqueDestPath(dir: string, filename: string): string {
  let out = join(dir, filename);
  if (!existsSync(out)) return out;
  const base = filename.replace(/\.md$/i, '');
  for (let i = 2; i < 1000; i++) {
    out = join(dir, `${base}-${i}.md`);
    if (!existsSync(out)) return out;
  }
  return join(dir, `${base}-${Date.now()}.md`);
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (args.includes('-h') || args.includes('--help')) usage();
  if (args.length > 0 && !apply) {
    // allow future flags; for now only --apply exists.
    for (const a of args) if (a !== '--apply') usage();
  }

  const cfg = loadConfig();
  const blipsDir = cfg.blipsDir;
  const trashDir = join(blipsDir, '_Trash', 'test-harness');
  const dupDir = join(blipsDir, '_Duplicates', 'by-source');
  const capturesDir = join(cfg.assistantDir, 'captures');

  const captureByUrl = buildCaptureIndex(capturesDir);

  const files = listMarkdownFiles(blipsDir);
  const blips: BlipFile[] = [];
  let touched = 0;
  let moved = 0;
  let captureAdded = 0;
  let sourceCanonicalized = 0;
  let captureLineAdded = 0;

  for (const filename of files) {
    const path = join(blipsDir, filename);
    let raw = '';
    let frontmatter: any;
    let content: string;

    try {
      raw = readFileSync(path, 'utf-8');
      const parsed = parseFrontmatter<any>(raw);
      frontmatter = parsed.frontmatter || {};
      content = parsed.content || '';
    } catch {
      continue;
    }

    const title = typeof frontmatter.title === 'string' ? frontmatter.title : filename.replace(/\.md$/i, '');
    const source = typeof frontmatter.source === 'string' ? frontmatter.source : '';
    const canonicalSource = source ? canonicalizeBlipSource(source) : '';

    blips.push({ filename, path, title, source, canonicalSource, frontmatter, content, raw });
  }

  // Pass 1: trash obvious test harness blips
  const kept: BlipFile[] = [];
  for (const b of blips) {
    if (isTestHarnessBlip(b.raw, b.source, b.title)) {
      console.log(`TRASH ${b.filename}`);
      if (apply) {
        mkdirSync(trashDir, { recursive: true });
        renameSync(b.path, uniqueDestPath(trashDir, b.filename));
      }
      moved++;
      continue;
    }
    kept.push(b);
  }

  // Pass 2: dedupe by canonical source (keep best-scoring blip)
  const bySource = new Map<string, BlipFile[]>();
  for (const b of kept) {
    if (!b.canonicalSource) continue;
    const list = bySource.get(b.canonicalSource) || [];
    list.push(b);
    bySource.set(b.canonicalSource, list);
  }

  for (const [source, group] of bySource) {
    if (group.length <= 1) continue;

    const sorted = group.slice().sort((a, b) => scoreBlip(b) - scoreBlip(a));
    const substantive = sorted.filter((b) => (b.content || '').trim().length >= 500 && !/Captured from test harness\./i.test(b.raw));
    const keepers = (substantive.length > 0 ? substantive : sorted).slice(0, 2);
    const keepSet = new Set(keepers.map((b) => b.filename));

    for (const extra of sorted) {
      if (keepSet.has(extra.filename)) continue;
      console.log(`DUP  ${extra.filename} -> keep ${keepers.map((k) => k.filename).join(', ')}`);
      if (apply) {
        const dir = join(dupDir, source.replace(/[^a-z0-9]+/gi, '-').slice(0, 80) || 'source');
        mkdirSync(dir, { recursive: true });
        renameSync(extra.path, uniqueDestPath(dir, extra.filename));
      }
      moved++;
    }
  }

  // Pass 3: canonicalize source, backfill capture, and ensure capture line
  for (const b of kept) {
    if (!existsSync(b.path)) continue; // may have been moved during dedupe

    let changed = false;
    const frontmatter = b.frontmatter;
    let content = b.content;

    const source = typeof frontmatter.source === 'string' ? frontmatter.source : '';
    if (source) {
      const canon = canonicalizeBlipSource(source);
      if (canon && canon !== source) {
        frontmatter.source = canon;
        changed = true;
        sourceCanonicalized++;
      }
    }

    if (frontmatter.source && (!frontmatter.capture || typeof frontmatter.capture !== 'string')) {
      const cap = captureByUrl.get(canonicalizeBlipSource(frontmatter.source));
      if (cap) {
        frontmatter.capture = cap.filename;
        changed = true;
        captureAdded++;
      }
    }

    if (typeof frontmatter.capture === 'string' && frontmatter.capture) {
      const next = ensureFullCaptureLine(content, frontmatter.capture);
      if (next !== content) {
        content = next;
        changed = true;
        captureLineAdded++;
      }
    }

    if (changed) {
      console.log(`FIX  ${b.filename}`);
      touched++;
      if (apply) writeFileSync(b.path, serializeFrontmatter(frontmatter, content), 'utf-8');
    }
  }

  console.log('');
  console.log(`Scanned: ${files.length}`);
  console.log(`Trash moved: ${moved}`);
  console.log(`Files modified: ${touched}`);
  console.log(`- canonicalized source: ${sourceCanonicalized}`);
  console.log(`- added capture field: ${captureAdded}`);
  console.log(`- added capture line: ${captureLineAdded}`);
  console.log(apply ? 'Applied.' : 'Dry run (no changes). Use --apply to write/move.');
}

main();
