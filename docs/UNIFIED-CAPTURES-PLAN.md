# Blips: A File-First Design

> Inspired by Andy Matuschak's blips concept

## Core Insight

From Andy's video: Blips are "little noticings that seem important, even precious in that moment, but which often fizzle away." They need **gradual attention** - not one sitting, but "little sprinkles of attention" over time.

The key innovation is **moves** - scaffolded microtasks that help advance a blip when you don't know what to do next.

## Design Principles

1. **Vault is the source of truth** - Blips live in Obsidian where user can browse/edit directly
2. **Frontmatter for metadata** - Progressive disclosure: scan frontmatter for listings, load body for depth
3. **Moves drive evolution** - Not lifecycle states, but suggested next actions
4. **Discord for capture, Obsidian for flow** - Low-energy phone → high-energy desktop
5. **Clippings become blips** - Web Clipper content gets blip frontmatter added

---

## 1. Storage: The Vault

```
Vault/
├── Blips/
│   ├── 2025-12-31-tea-ceremony.md       # thought
│   ├── 2025-12-31-zhengdong-letter.md   # captured article
│   └── 2025-12-31-scaling-thesis.md     # from web clipper
├── Clippings/                            # Web Clipper destination
│   └── (Claude processes these → Blips/)
├── Projects/                             # Where blips graduate
├── Daily/
└── ...
```

**Why vault storage:**
- User can browse/edit blips in Obsidian
- Wikilinks work natively: `[[other-blip]]`
- Graph view shows connections
- Claude navigates the same way: `ls`, `cat`, `grep`
- Web Clipper content integrates naturally

---

## 2. Blip Format

Everything is a blip. Some have URL content, some are just thoughts.

### Thought/Idea (no URL)

```markdown
---
title: Tea ceremony
status: active
created: 2025-12-31
touched: 2025-12-31
tags: [learning, culture]
related: [weekend-plans]
---

Saw a beautiful photo of a tea ceremony. Want to learn more about the philosophy behind it.

## Log

- **2025-12-31**: Captured from Discord
- **2025-12-31**: Found this article looks good: https://...
- **2026-01-02**: The key insight is wabi-sabi - finding beauty in imperfection
```

### Article/URL Content

```markdown
---
title: "The Parallel Economy"
status: active
created: 2025-12-31
touched: 2025-12-31
source: https://kyla.substack.com/p/the-parallel-economy
author: "[[kyla scanlon]]"
published: 2025-02-19
tags: [economics, politics]
related: []
---

Interesting take on manufactured recessions and ideological capitalism.

## Content

The administration appears to be intentionally engineering economic volatility...

## Highlights

> "When a parallel economy offers ideological shelter from the storm, it creates the perfect conditions for capital extraction"

## Log

- **2025-12-31**: Clipped from web
- **2025-12-31**: This connects to my thinking about [[economic-anxiety]]
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | The blip name |
| `status` | yes | `active` \| `snoozed` \| `archived` \| `bumped` |
| `created` | yes | When captured |
| `touched` | yes | Last interaction (for surfacing) |
| `tags` | no | For discovery |
| `related` | no | Explicit links to other blips |
| `source` | no | URL if from web |
| `author` | no | For articles |
| `published` | no | Original publish date |
| `snoozed_until` | no | If status=snoozed |
| `bumped_to` | no | If status=bumped, path to project |

---

## 3. Clippings → Blips

Web Clipper saves to `Clippings/` with this format:

```yaml
---
title: "Article Title"
source: "https://..."
author:
  - "[[Author Name]]"
published: 2025-02-19
created: 2025-03-12
description: "Brief description"
tags:
  - "clippings"
---
[content]
```

**Claude's job:** Periodically scan `Clippings/`, and for each new file:

1. Add blip fields: `status: active`, `touched: <created>`, `related: []`
2. Move to `Blips/` with date-prefixed filename
3. Optionally add a `## Log` section

```typescript
async function processClippings(): Promise<void> {
  const clippings = await glob('Vault/Clippings/*.md');

  for (const file of clippings) {
    const { frontmatter, body } = parseFrontmatter(await readFile(file));

    // Add blip fields
    frontmatter.status = 'active';
    frontmatter.touched = frontmatter.created;
    frontmatter.related = [];

    // Generate new path
    const date = frontmatter.created;
    const slug = slugify(frontmatter.title);
    const newPath = `Vault/Blips/${date}-${slug}.md`;

    // Write with log section
    const newBody = body + '\n\n## Log\n\n- **' + date + '**: Clipped from web';
    await writeFile(newPath, serializeFrontmatter(frontmatter) + newBody);

    // Remove from Clippings
    await unlink(file);
  }
}
```

---

## 4. Moves: The Core Mechanic

Moves are **scaffolded next actions** Claude suggests when surfacing a blip.

| Move | When to suggest | What Claude does |
|------|-----------------|------------------|
| **Find a link** | Blip mentions wanting to learn/read something | Search web, suggest URLs |
| **Break it down** | Blip is a big goal/project | Suggest smaller first steps |
| **Connect** | Similar blips exist | Show related blips, ask if connected |
| **Collect examples** | Blip is about an aesthetic/pattern | Help gather examples over time |
| **Decide** | Blip has multiple options | Quick voting/ranking exercise |
| **Summarize** | Long article content | Extract key points |
| **Annotate** | Article with no highlights yet | Ask what stood out |
| **Bump to project** | Ready for focused work | Move to Projects/ folder |

### Example Interaction

```
Claude: Here's a blip that hasn't been touched in a week:

  # The Parallel Economy

  source: https://kyla.substack.com/...
  touched: 2025-03-12

  Interesting take on manufactured recessions...

  ## Log
  - 2025-03-12: Clipped from web

---

I notice you clipped this but haven't annotated it yet. I could help you:

1. **Summarize** - Pull out the key arguments
2. **Annotate** - What stood out? Any reactions?
3. **Connect** - This might relate to your [[economic-anxiety]] blip
4. **Snooze** - Come back to this later

What would you like?
```

---

## 5. Surfacing: Simple and Human

### Morning Check-in

Claude scans `Vault/Blips/` and picks 2-3 to surface:

```typescript
async function getMorningBlips(): Promise<BlipSummary[]> {
  const files = await glob('Vault/Blips/*.md');

  const blips = await Promise.all(files.map(async f => {
    const { frontmatter } = parseFrontmatter(await readFile(f));
    return {
      path: f,
      title: frontmatter.title,
      status: frontmatter.status,
      touched: new Date(frontmatter.touched),
      snoozedUntil: frontmatter.snoozed_until,
      hasLog: await fileContains(f, '## Log'),
    };
  }));

  const now = new Date();

  // Filter: active, or snoozed but ready
  const surfaceable = blips.filter(b =>
    b.status === 'active' ||
    (b.status === 'snoozed' && new Date(b.snoozedUntil) <= now)
  );

  // Sort by last touched (oldest first)
  return surfaceable
    .sort((a, b) => a.touched - b.touched)
    .slice(0, 3);
}
```

### On-Demand Browse

User: "show me my blips"

Claude lists all active blips with one-line summaries from frontmatter.

### Snooze and Archive

Simple frontmatter updates:

```yaml
# Snooze for 2 weeks
status: snoozed
snoozed_until: 2026-01-15
```

```yaml
# Archive (won't surface)
status: archived
```

```yaml
# Bumped to a project
status: bumped
bumped_to: Projects/Tea Ceremony Research.md
```

---

## 6. Capture Flow

### Discord → Blip

User posts in #captures: `Tea ceremony looks beautiful, want to learn more`

Claude creates `Vault/Blips/2025-12-31-tea-ceremony.md`:

```markdown
---
title: Tea ceremony
status: active
created: 2025-12-31
touched: 2025-12-31
tags: []
related: []
---

Tea ceremony looks beautiful, want to learn more

## Log

- **2025-12-31**: Captured from Discord
```

### Discord → Blip with URL

User posts: `https://zhengdongwang.com/... interesting take on AI`

Claude:
1. Fetches the URL content
2. Creates blip with content embedded

```markdown
---
title: "Zhengdong Wang: 2025 Letter"
status: active
created: 2025-12-31
touched: 2025-12-31
source: https://zhengdongwang.com/2025/12/30/2025-letter.html
author: Zhengdong Wang
tags: [ai, scaling]
related: []
---

Interesting take on AI compute scaling.

## Content

[Full article text...]

## Log

- **2025-12-31**: Captured from Discord
```

### Web Clipper → Blip

1. User clips article via Obsidian Web Clipper → saves to `Clippings/`
2. Claude (via scheduled task or on-demand) processes `Clippings/`
3. Adds blip frontmatter, moves to `Blips/`

---

## 7. Connections: Grep + Wikilinks

No complex linking system. Just:

1. **Wikilinks in body**: `[[weekend-plans]]`, `[[kyla scanlon]]`
2. **`related` in frontmatter**: explicit connections
3. **Claude greps for patterns**:

```bash
grep -r "tea" Vault/Blips/
grep -r "economy" Vault/Blips/
```

When surfacing, Claude:
1. Extracts key terms from the blip
2. Greps for related blips
3. Suggests connections: "This might relate to [[economic-anxiety]]"

---

## 8. Bumping to Projects

When a blip is ready for focused work:

1. User says "bump this to a project"
2. Claude creates/updates note in `Projects/`
3. Updates blip: `status: bumped`, `bumped_to: Projects/...`

The blip becomes a pointer; the project note is the working document.

---

## 9. Implementation

### Module: `src/blips/`

```
src/blips/
├── index.ts          # Exports
├── files.ts          # Read/write blip files in vault
├── surface.ts        # Pick blips to show
├── clippings.ts      # Process Clippings/ → Blips/
├── moves.ts          # Move suggestions
└── parse.ts          # Frontmatter + log parsing
```

### Key Functions

```typescript
// files.ts
export async function listBlips(): Promise<BlipSummary[]>;
export async function readBlip(path: string): Promise<Blip>;
export async function createBlip(title: string, content: string, source?: string): Promise<string>;
export async function appendToLog(path: string, entry: string): Promise<void>;
export async function updateStatus(path: string, status: BlipStatus): Promise<void>;

// surface.ts
export async function getBlipsToSurface(count: number): Promise<BlipSummary[]>;
export async function findRelated(blipPath: string): Promise<string[]>;

// clippings.ts
export async function processClippings(): Promise<number>; // returns count processed
```

### Config

```typescript
// src/config.ts
export const VAULT_PATH = '~/Library/Mobile Documents/iCloud~md~Obsidian/Documents/Personal';
export const BLIPS_DIR = `${VAULT_PATH}/Blips`;
export const CLIPPINGS_DIR = `${VAULT_PATH}/Clippings`;
export const PROJECTS_DIR = `${VAULT_PATH}/Projects`;
```

---

## 10. What We're NOT Doing

| Over-engineering | Why skip it |
|------------------|-------------|
| Separate `~/.assistant/blips/` | Vault IS the storage |
| Maturity states | Log shows evolution naturally |
| Engagement scores | Claude reads the log and judges |
| JSON indexes | Frontmatter scanning is fast enough |
| Bidirectional link tracking | Wikilinks + grep work fine |
| Complex surfacing algorithms | Oldest-first + human judgment |

---

## 11. Success Criteria

1. **Capture is frictionless** - Discord/Web Clipper → blip in seconds
2. **Files are in the vault** - User can browse in Obsidian
3. **Clippings auto-convert** - Web Clipper content becomes blips
4. **Claude navigates easily** - `ls`, `cat`, `grep` on vault files
5. **Moves feel helpful** - Suggested actions advance the blip
6. **Annotations accumulate** - Log grows with "sprinkles of attention"
7. **Connections emerge** - Related blips surface naturally
