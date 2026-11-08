import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface TapeHistoryTrack {
  id: number;
  title: string;
  album_id: number;
  album_title: string;
  play_count: number;
  duration_seconds: number;
  artists_display: string;
  cover_album_id: number;
  bpm?: number;
}

interface HistoryEntry { played_at: string; track: TapeHistoryTrack; }
type StoreFile = { version: 1; users: Record<string, HistoryEntry[]> };

export interface PlayHistoryStore {
  record(owner: string, track: TapeHistoryTrack): Promise<void>;
  ids(owner: string, limit?: number): Promise<number[]>;
  recent(owner: string, limit?: number): Promise<TapeHistoryTrack[]>;
  stats(owner: string): Promise<{ plays_total: number; tracks_listened: number }>;
}

/** Local recent-play records, capped to 500 entries per owner; stores metadata only, never audio. */
export class JsonPlayHistoryStore implements PlayHistoryStore {
  private state: StoreFile | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(directory = './data') {
    this.filePath = path.resolve(directory, 'play-history.json');
  }

  record(owner: string, track: TapeHistoryTrack): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      const key = normalizeOwner(owner);
      const entries = this.state!.users[key] ?? [];
      entries.unshift({ played_at: new Date().toISOString(), track: { ...track } });
      this.state!.users[key] = entries.slice(0, 500);
      await this.persist();
    });
  }

  ids(owner: string, limit = 20): Promise<number[]> {
    return this.exclusive(async () => {
      await this.load();
      const ids: number[] = [];
      for (const entry of this.state!.users[normalizeOwner(owner)] ?? []) {
        if (!ids.includes(entry.track.id)) ids.push(entry.track.id);
        if (ids.length >= limit) break;
      }
      return ids;
    });
  }

  recent(owner: string, limit = 20): Promise<TapeHistoryTrack[]> {
    return this.exclusive(async () => {
      await this.load();
      const seen = new Set<number>();
      const tracks: TapeHistoryTrack[] = [];
      for (const entry of this.state!.users[normalizeOwner(owner)] ?? []) {
        if (seen.has(entry.track.id)) continue;
        seen.add(entry.track.id);
        tracks.push({ ...entry.track });
        if (tracks.length >= limit) break;
      }
      return tracks;
    });
  }

  stats(owner: string): Promise<{ plays_total: number; tracks_listened: number }> {
    return this.exclusive(async () => {
      await this.load();
      const entries = this.state!.users[normalizeOwner(owner)] ?? [];
      return { plays_total: entries.length, tracks_listened: new Set(entries.map((entry) => entry.track.id)).size };
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<void> {
    if (this.state) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoreFile>;
      if (parsed.version !== 1 || !parsed.users || typeof parsed.users !== 'object' || Array.isArray(parsed.users)) {
        throw new Error('Unexpected play-history database format.');
      }
      const users: Record<string, HistoryEntry[]> = {};
      for (const [owner, entries] of Object.entries(parsed.users)) {
        if (Array.isArray(entries)) users[owner] = entries.filter(isHistoryEntry).slice(0, 500);
      }
      this.state = { version: 1, users };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = { version: 1, users: {} };
        return;
      }
      throw new Error('Cannot load the Tape play-history database; the existing file was left untouched.');
    }
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    try { await chmod(this.filePath, 0o600); } catch { /* Windows ACLs control access instead of POSIX mode bits. */ }
  }
}

function normalizeOwner(owner: string): string {
  return owner.trim().toLowerCase();
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<HistoryEntry>;
  const track = entry.track as Partial<TapeHistoryTrack> | undefined;
  return typeof entry.played_at === 'string'
    && !!track
    && Number.isSafeInteger(track.id)
    && typeof track.title === 'string'
    && Number.isSafeInteger(track.album_id)
    && typeof track.album_title === 'string'
    && Number.isFinite(track.duration_seconds)
    && typeof track.artists_display === 'string'
    && Number.isSafeInteger(track.cover_album_id);
}
