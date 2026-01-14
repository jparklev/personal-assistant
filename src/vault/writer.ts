import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isoDateForAssistant } from '../time';

const WRITABLE_FOLDERS = ['Note Inbox.md', 'Daily/', 'Drafts/'];

export class VaultWriter {
  constructor(
    private vaultPath: string,
    private writableFolders: string[] = WRITABLE_FOLDERS
  ) {}

  // Check if a path is writable
  private isWritable(relativePath: string): boolean {
    return this.writableFolders.some((folder) => {
      if (folder.endsWith('/')) {
        return relativePath.startsWith(folder);
      }
      return relativePath === folder;
    });
  }

  // Append content to a file (for inbox, daily notes)
  append(relativePath: string, content: string): boolean {
    if (!this.isWritable(relativePath)) {
      console.error(`[VaultWriter] Cannot write to ${relativePath}: not in writable folders`);
      return false;
    }

    const fullPath = join(this.vaultPath, relativePath);

    try {
      // Ensure directory exists
      mkdirSync(dirname(fullPath), { recursive: true });

      // Append with newline
      const toAppend = content.endsWith('\n') ? content : content + '\n';
      appendFileSync(fullPath, toAppend, 'utf-8');
      return true;
    } catch (err) {
      console.error(`[VaultWriter] Failed to append to ${relativePath}:`, err);
      return false;
    }
  }

  // Write a new file (for drafts, promoted blips)
  write(relativePath: string, content: string): boolean {
    if (!this.isWritable(relativePath)) {
      console.error(`[VaultWriter] Cannot write to ${relativePath}: not in writable folders`);
      return false;
    }

    const fullPath = join(this.vaultPath, relativePath);

    // Don't overwrite existing files
    if (existsSync(fullPath)) {
      console.error(`[VaultWriter] Cannot overwrite existing file ${relativePath}`);
      return false;
    }

    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
      return true;
    } catch (err) {
      console.error(`[VaultWriter] Failed to write ${relativePath}:`, err);
      return false;
    }
  }

  // Append to today's daily note
  appendToToday(content: string): boolean {
    const date = isoDateForAssistant(new Date());
    return this.append(`Daily/${date}.md`, content);
  }

  // Add item to Note Inbox
  addToInbox(item: string): boolean {
    const line = `- ${item}\n`;
    return this.append('Note Inbox.md', line);
  }

  // Create a draft file from a blip
  createDraft(title: string, content: string): boolean {
    // Sanitize title for filename
    const filename = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    const path = `Drafts/${filename}.md`;
    const fullContent = `# ${title}\n\n${content}`;
    return this.write(path, fullContent);
  }

  // Ensure Drafts folder exists
  ensureDraftsFolder(): void {
    const draftsPath = join(this.vaultPath, 'Drafts');
    if (!existsSync(draftsPath)) {
      mkdirSync(draftsPath, { recursive: true });
    }
  }
}
