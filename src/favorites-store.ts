import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

export interface TapeLikedTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration_seconds: number;
}

export interface FavoritesStore {
  list(owner: string): Promise<TapeLikedTrack[]>;
  ids(owner: string): Promise<number[]>;
  toggle(owner: string, track: TapeLikedTrack): Promise<'added' | 'removed'>;
}

type StoreFile = { version: 1; users: Record<string, TapeLikedTrack[]> };

/** Local durable Tape favorites; SoundCloud content is never copied to disk beyond small track metadata. */
export class JsonFavoritesStore implements FavoritesStore {
  private state: StoreFile | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(directory = './data') {
    this.filePath = path.resolve(directory, 'favorites.json');
  }

  list(owner: string): Promise<TapeLikedTrack[]> {
    return this.exclusive(async () => {
      await this.load();
      return (this.state!.users[normalizeOwner(owner)] ?? []).map((track) => ({ ...track }));
    });
  }

  ids(owner: string): Promise<number[]> {
    return this.exclusive(async () => {
      await this.load();
      return (this.state!.users[normalizeOwner(owner)] ?? []).map((track) => track.id);
    });
  }

  toggle(owner: string, track: TapeLikedTrack): Promise<'added' | 'removed'> {
    return this.exclusive(async () => {
      await this.load();
      const key = normalizeOwner(owner);
      const tracks = this.state!.users[key] ?? [];
      const existing = tracks.findIndex((item) => item.id === track.id);
      if (existing >= 0) {
        tracks.splice(existing, 1);
        this.state!.users[key] = tracks;
        await this.persist();
        return 'removed';
      }
      this.state!.users[key] = [{ ...track }, ...tracks];
      await this.persist();
      return 'added';
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
        throw new Error('Unexpected favorites database format.');
      }
      const users: Record<string, TapeLikedTrack[]> = {};
      for (const [owner, tracks] of Object.entries(parsed.users)) {
        if (Array.isArray(tracks)) users[owner] = tracks.filter(isLikedTrack).map((track) => ({ ...track }));
      }
      this.state = { version: 1, users };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = { version: 1, users: {} };
        return;
      }
      throw new Error('Cannot load the Tape favorites database; the existing file was left untouched.');
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

function isLikedTrack(value: unknown): value is TapeLikedTrack {
  if (!value || typeof value !== 'object') return false;
  const track = value as Partial<TapeLikedTrack>;
  return Number.isSafeInteger(track.id)
    && typeof track.title === 'string'
    && typeof track.artist === 'string'
    && typeof track.album === 'string'
    && Number.isFinite(track.duration_seconds);
}
