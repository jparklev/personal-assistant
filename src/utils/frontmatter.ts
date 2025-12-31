/**
 * Simple YAML frontmatter parser/serializer
 * No external dependencies - handles common cases
 */

export interface ParsedFile<T = Record<string, unknown>> {
  frontmatter: T;
  content: string;
}

/**
 * Parse a markdown file with YAML frontmatter
 */
export function parseFrontmatter<T = Record<string, unknown>>(raw: string): ParsedFile<T> {
  const lines = raw.split('\n');

  // Must start with ---
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {} as T, content: raw };
  }

  // Find closing ---
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: {} as T, content: raw };
  }

  const yamlLines = lines.slice(1, endIndex);
  const content = lines.slice(endIndex + 1).join('\n').trim();

  const frontmatter = parseYaml(yamlLines.join('\n')) as T;

  return { frontmatter, content };
}

/**
 * Serialize frontmatter + content to markdown
 */
export function serializeFrontmatter<T = Record<string, unknown>>(
  frontmatter: T,
  content: string
): string {
  const yaml = serializeYaml(frontmatter as Record<string, unknown>);
  return `---\n${yaml}---\n\n${content}`;
}

/**
 * Parse simple YAML (handles: strings, numbers, booleans, arrays, dates)
 */
function parseYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value: unknown = trimmed.slice(colonIndex + 1).trim();

    // Parse value
    if (value === '' || value === 'null' || value === '~') {
      value = null;
    } else if (value === 'true') {
      value = true;
    } else if (value === 'false') {
      value = false;
    } else if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      // Inline array: [item1, item2]
      const inner = value.slice(1, -1);
      value = inner
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          // Remove quotes if present
          if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
            return s.slice(1, -1);
          }
          return s;
        });
    } else if (typeof value === 'string' && !isNaN(Number(value)) && value !== '') {
      value = Number(value);
    } else if (typeof value === 'string') {
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
    }

    result[key] = value;
  }

  return result;
}

/**
 * Serialize object to simple YAML
 */
function serializeYaml(obj: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    if (value === null) {
      lines.push(`${key}:`);
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        const items = value.map((v) => (typeof v === 'string' ? `"${v}"` : String(v)));
        lines.push(`${key}: [${items.join(', ')}]`);
      }
    } else if (typeof value === 'string') {
      // Quote if contains special chars
      if (value.includes(':') || value.includes('#') || value.includes('\n')) {
        lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    } else if (typeof value === 'object') {
      // Nested objects - serialize inline as JSON-ish
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  return lines.join('\n') + '\n';
}
