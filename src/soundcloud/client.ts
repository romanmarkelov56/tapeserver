import type { Track, SearchParams, Artist, Album } from '../types.js';
import { SoundCloudClientIdResolver } from './client-id-resolver.js';

type FetchLike = typeof fetch;
type RawTrack = Record<string, any>;

export class SoundCloudApiError extends Error {
  constructor(message: string, readonly statusCode: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'SoundCloudApiError';
  }
}

/** SoundCloud adapter. Signed media URLs are resolved per request and never cached. */
export class SoundCloudClient {
  private readonly apiBaseUrl: string;
  private readonly apiV2BaseUrl: string;
  private readonly resolver: SoundCloudClientIdResolver;
  private readonly accessToken?: string;
  private readonly fetchFn: FetchLike;

  constructor(
    clientId = '',
    accessToken?: string,
    request: FetchLike = fetch,
    options: { apiBaseUrl?: string; apiV2BaseUrl?: string } = {},
  ) {
    const initialClientId = clientId || clientIdFromToken(accessToken);
    this.resolver = new SoundCloudClientIdResolver(initialClientId);
    this.accessToken = accessToken;
    this.fetchFn = request;
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.soundcloud.com';
    this.apiV2BaseUrl = options.apiV2BaseUrl ?? 'https://api-v2.soundcloud.com';
  }

  public async getClientId(forceRefresh = false): Promise<string> {
    return this.resolver.getClientId(forceRefresh);
  }

  public async refreshClientId(): Promise<string> {
    return this.resolver.refreshClientId();
  }

  private async request(url: URL | string, init?: RequestInit, isRetry = false): Promise<Response> {
    const targetUrl = typeof url === 'string' ? new URL(url) : new URL(url.toString());

    // Inject client_id into query params for soundcloud.com endpoints
    if (targetUrl.hostname.includes('soundcloud.com') && !targetUrl.searchParams.has('client_id')) {
      const activeClientId = await this.resolver.getClientId();
      if (activeClientId) {
        targetUrl.searchParams.set('client_id', activeClientId);
      }
    }

    const headers = new Headers(init?.headers);
    if (this.accessToken && !headers.has('Authorization')) {
      headers.set('Authorization', `OAuth ${this.accessToken}`);
    }

    const response = await this.fetchFn(targetUrl.toString(), {
      ...init,
      headers,
    });

    if (response.status === 401 && !isRetry) {
      await this.resolver.refreshClientId();
      // Retry once with refreshed client_id
      const retryUrl = new URL(targetUrl.toString());
      const newClientId = await this.resolver.getClientId();
      if (newClientId) {
        retryUrl.searchParams.set('client_id', newClientId);
      }
      return this.fetchFn(retryUrl.toString(), {
        ...init,
        headers,
      });
    }

    return response;
  }

  async searchTracks(params: SearchParams): Promise<Track[]> {
    const query = params.query.trim();
    if (!query) throw new Error('Search query must not be empty');
    const limit = clampInteger(params.limit, 20, 1, 50);
    const offset = clampInteger(params.offset, 0, 0, 10_000);
    const url = new URL('/search/tracks', this.apiV2BaseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('access', 'playable');

    let response: Response;
    try {
      response = await this.request(url, { headers: this.headers() });
    } catch {
      throw new SoundCloudApiError('Unable to reach SoundCloud API', 502);
    }
    if (!response.ok && [400, 404, 410, 422].includes(response.status)) {
      const legacy = new URL('/tracks', this.apiBaseUrl);
      legacy.searchParams.set('q', query);
      legacy.searchParams.set('limit', String(limit));
      legacy.searchParams.set('offset', String(offset));
      legacy.searchParams.set('access', 'playable');
      legacy.searchParams.set('linked_partitioning', 'true');
      response = await this.request(legacy, { headers: this.headers() });
    }
    if (!response.ok) throw await this.toApiError(response);
    const body = await response.json() as { collection?: RawTrack[] } | RawTrack[];
    const tracks = Array.isArray(body) ? body : body.collection ?? [];
    return tracks.map((item) => this.mapTrack(item)).filter((item): item is Track => item !== null);
  }

  async searchArtists(params: SearchParams): Promise<Artist[]> {
    const items = await this.searchEntities('users', params);
    return items.filter((item) => safeCount(item.track_count ?? item.tracks_count) > 0
      || safeCount(item.playlist_count ?? item.playlists_count) > 0 || item.verified === true)
      .map((item) => this.mapArtist(item)).filter((item): item is Artist => item !== null);
  }

  async searchAlbums(params: SearchParams): Promise<Album[]> {
    const items = await this.searchEntities('playlists', params);
    return items.map((item) => this.mapAlbum(item)).filter((item): item is Album => item !== null);
  }

  async getArtistById(artistId: string): Promise<Artist> {
    const id = validateTrackId(artistId);
    const raw = await this.getJson(`/users/${encodeURIComponent(id)}`);
    const artist = this.mapArtist(raw);
    if (!artist) throw new SoundCloudApiError('SoundCloud returned an invalid artist resource', 502);
    const [rawAlbums, tracks] = await Promise.all([
      this.getCollection(`/users/${encodeURIComponent(id)}/playlists`, { limit: '50', show_tracks: 'false' }).catch(() => []),
      this.getArtistTracks(id, 50).catch(() => []),
    ]);
    artist.albums = rawAlbums.map((item) => this.mapAlbum(item)).filter((item): item is Album => item !== null);
    artist.tracks = tracks;
    return artist;
  }

  async getArtistTracks(artistId: string, limit = 50): Promise<Track[]> {
    const id = validateTrackId(artistId);
    const items = await this.getCollection(`/users/${encodeURIComponent(id)}/tracks`, { limit: String(clampInteger(limit, 50, 1, 200)), access: 'playable' });
    const tracks = items.map((item) => this.mapTrack(item)).filter((item): item is Track => item !== null);
    if (tracks.length > 0) return tracks;
    const user = this.mapArtist(await this.getJson(`/users/${encodeURIComponent(id)}`));
    if (!user) return [];
    const searchResults = await this.searchTracks({ query: user.name, limit: clampInteger(limit, 50, 1, 50), offset: 0 });
    return searchResults.filter((track) => track.artistId === id || track.artist.toLowerCase() === user.name.toLowerCase());
  }

  async getRelatedTracks(trackId: string, limit = 30): Promise<Track[]> {
    const id = validateTrackId(trackId);
    const items = await this.getCollection(`/tracks/${encodeURIComponent(id)}/related`, {
      limit: String(clampInteger(limit, 30, 1, 50)),
      access: 'playable',
    });
    return items.map((item) => this.mapTrack(item)).filter((item): item is Track => item !== null);
  }

  async getAlbumArtworkById(albumId: string): Promise<Album> {
    const id = validateTrackId(albumId);
    const raw = await this.getJson(`/playlists/${encodeURIComponent(id)}`, { show_tracks: 'false' });
    const album = this.mapAlbum(raw);
    if (!album) throw new SoundCloudApiError('SoundCloud returned an invalid playlist resource', 502);
    return album;
  }

  async getAlbumById(albumId: string): Promise<Album> {
    const id = validateTrackId(albumId);
    const raw = await this.getJson(`/playlists/${encodeURIComponent(id)}`, { show_tracks: 'false' });
    const album = this.mapAlbum(raw);
    if (!album) throw new SoundCloudApiError('SoundCloud returned an invalid playlist resource', 502);

    // Playlist detail responses may contain only a small preview of the tracklist.
    // Load the dedicated tracks collection and follow SoundCloud's next_href cursor.
    const rawTracks = await this.getAllCollection(`/playlists/${encodeURIComponent(id)}/tracks`, {
      limit: '200',
      linked_partitioning: 'true',
      access: 'playable',
    });
    album.tracks = rawTracks.map((item) => this.mapTrack(item)).filter((item): item is Track => item !== null);
    album.trackCount = Number(raw.track_count) || album.tracks.length;
    return album;
  }

  async getTrackById(trackId: string): Promise<Track> {
    const id = validateTrackId(trackId);
    let response = await this.request(new URL(`/tracks/${encodeURIComponent(id)}`, this.apiV2BaseUrl), {
      headers: this.headers(),
    });
    if (!response.ok && [400, 404, 410, 422].includes(response.status)) {
      response = await this.request(new URL(`/tracks/${encodeURIComponent(id)}`, this.apiBaseUrl), {
        headers: this.headers(),
      });
    }
    if (!response.ok) throw await this.toApiError(response);
    const track = this.mapTrack(await response.json() as RawTrack);
    if (!track) throw new SoundCloudApiError('SoundCloud returned an invalid track resource', 502);
    return track;
  }

  /** Resolve one playable transcoding. Do not expose its signed URL to clients. */
  async getStreamUrl(trackId: string): Promise<string> {
    const id = validateTrackId(trackId);
    let response = await this.request(new URL(`/tracks/${encodeURIComponent(id)}`, this.apiV2BaseUrl), {
      headers: this.headers(),
    });
    let rawTrack: RawTrack;
    if (response.ok) {
      rawTrack = await response.json() as RawTrack;
    } else if ([400, 404, 410, 422].includes(response.status)) {
      response = await this.request(new URL(`/tracks/${encodeURIComponent(id)}`, this.apiBaseUrl), {
        headers: this.headers(),
      });
      if (!response.ok) throw await this.toApiError(response);
      rawTrack = await response.json() as RawTrack;
    } else {
      throw await this.toApiError(response);
    }

    if (rawTrack.access === 'blocked' || rawTrack.streamable === false) {
      throw new SoundCloudApiError('This track is not available for streaming', 403);
    }
    const transcodings: Array<Record<string, any>> = Array.isArray(rawTrack.media?.transcodings)
      ? rawTrack.media.transcodings : [];
    const candidates = transcodings
      .filter((item) => typeof item.url === 'string' && ['hls', 'progressive'].includes(item.format?.protocol))
      .sort((a, b) => Number(a.format.protocol === 'hls') - Number(b.format.protocol === 'hls'));

    for (const candidate of candidates) {
      try {
        const resolveUrl = new URL(candidate.url);
        const resolved = await this.request(resolveUrl, { headers: this.headers(), redirect: 'manual' });
        if (resolved.status >= 300 && resolved.status < 400) {
          const location = resolved.headers.get('location');
          if (location) return this.validateMediaUrl(new URL(location, resolveUrl).toString());
        }
        if (resolved.ok) {
          const payload = await resolved.json().catch(() => null) as { url?: string } | null;
          if (payload?.url) return this.validateMediaUrl(payload.url);
        }
      } catch {
        // Signed URLs are sensitive; try the next transcoding without logging details.
      }
    }

    // Documented API compatibility path: this endpoint responds with a redirect.
    const streamUrl = new URL(`/tracks/${encodeURIComponent(id)}/stream`, this.apiBaseUrl);
    const streamResponse = await this.request(streamUrl, { headers: this.headers(), redirect: 'manual' });
    if (streamResponse.status >= 300 && streamResponse.status < 400) {
      const location = streamResponse.headers.get('location');
      if (location) return this.validateMediaUrl(new URL(location, streamUrl).toString());
    }
    if (!streamResponse.ok) throw await this.toApiError(streamResponse);
    const payload = await streamResponse.json().catch(() => null) as { url?: string } | null;
    if (payload?.url) return this.validateMediaUrl(payload.url);
    throw new SoundCloudApiError('No playable SoundCloud transcoding is available for this track', 403);
  }

  private headers(): Headers {
    const headers = new Headers({ Accept: 'application/json' });
    if (this.accessToken) headers.set('Authorization', `OAuth ${this.accessToken}`);
    return headers;
  }

  private async searchEntities(kind: 'users' | 'playlists', params: SearchParams): Promise<RawTrack[]> {
    const query = params.query.trim();
    if (!query) throw new Error('Search query must not be empty');
    const limit = clampInteger(params.limit, 20, 1, 50);
    const offset = clampInteger(params.offset, 0, 0, 10_000);
    return this.getCollection(`/search/${kind}`, { q: query, limit: String(limit), offset: String(offset) }, `/${kind}`);
  }

  private async getAllCollection(path: string, params: Record<string, string> = {}): Promise<RawTrack[]> {
    const firstUrl = new URL(path, this.apiV2BaseUrl);
    for (const [key, value] of Object.entries(params)) firstUrl.searchParams.set(key, value);

    const items: RawTrack[] = [];
    const visited = new Set<string>();
    let nextUrl: URL | null = firstUrl;
    let pages = 0;

    while (nextUrl && pages < 20 && !visited.has(nextUrl.toString())) {
      visited.add(nextUrl.toString());
      pages += 1;

      let response = await this.request(nextUrl, { headers: this.headers() });
      if (!response.ok && pages === 1 && [400, 404, 410, 422].includes(response.status)) {
        const fallback = new URL(path, this.apiBaseUrl);
        for (const [key, value] of Object.entries(params)) fallback.searchParams.set(key, value);
        fallback.searchParams.set('linked_partitioning', 'true');
        response = await this.request(fallback, { headers: this.headers() });
      }
      if (!response.ok) throw await this.toApiError(response);

      const body = await response.json() as { collection?: RawTrack[]; next_href?: string } | RawTrack[];
      if (Array.isArray(body)) {
        items.push(...body);
        break;
      }
      if (Array.isArray(body.collection)) items.push(...body.collection);

      if (typeof body.next_href !== 'string' || !body.next_href) {
        nextUrl = null;
      } else {
        const candidate: URL = new URL(body.next_href, nextUrl);
        const allowedHosts = new Set([new URL(this.apiV2BaseUrl).hostname, new URL(this.apiBaseUrl).hostname]);
        if (candidate.protocol !== 'https:' || !allowedHosts.has(candidate.hostname)) {
          throw new SoundCloudApiError('SoundCloud returned an untrusted pagination URL', 502);
        }
        nextUrl = candidate;
      }
    }

    return items;
  }

  private async getCollection(path: string, params: Record<string, string> = {}, fallbackPath = path): Promise<RawTrack[]> {
    const body = await this.getJson(path, params, fallbackPath);
    if (Array.isArray(body)) return body as RawTrack[];
    return Array.isArray(body?.collection) ? body.collection as RawTrack[] : [];
  }

  private async getJson(path: string, params: Record<string, string> = {}, fallbackPath = path): Promise<RawTrack> {
    const url = new URL(path, this.apiV2BaseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response = await this.request(url, { headers: this.headers() });
    if (!response.ok && [400, 404, 410, 422].includes(response.status)) {
      const fallback = new URL(fallbackPath, this.apiBaseUrl);
      for (const [key, value] of Object.entries(params)) fallback.searchParams.set(key, value);
      fallback.searchParams.set('linked_partitioning', 'true');
      response = await this.request(fallback, { headers: this.headers() });
    }
    if (!response.ok) throw await this.toApiError(response);
    return await response.json() as RawTrack;
  }

  private mapArtist(item: RawTrack): Artist | null {
    if (item?.id === undefined || item?.id === null) return null;
    const name = item.username ?? item.full_name ?? [item.first_name, item.last_name].filter(Boolean).join(' ') ?? 'Unknown Artist';
    return {
      id: String(item.id),
      name: String(name).trim() || 'Unknown Artist',
      ...(typeof item.description === 'string' ? { biography: item.description } : {}),
      ...(typeof item.avatar_url === 'string' ? { artworkUrl: item.avatar_url.replace(/^http:/, 'https:') } : {}),
      followersCount: safeCount(item.followers_count ?? item.follower_count),
      monthlyListeners: safeCount(item.monthly_listeners),
      albums: [],
      tracks: [],
    };
  }

  private mapAlbum(item: RawTrack): Album | null {
    if (item?.id === undefined || item?.id === null || !item?.title) return null;
    const rawTracks = Array.isArray(item.tracks) ? item.tracks : [];
    const tracks = rawTracks.map((track: RawTrack) => this.mapTrack(track)).filter((track: Track | null): track is Track => track !== null);
    const trackCount = safeCount(item.track_count) || tracks.length;
    const setType = String(item.release_type ?? item.set_type ?? '').toLowerCase();
    const releaseType: Album['releaseType'] = item.is_album || setType === 'album' ? 'album' : trackCount <= 1 ? 'single' : 'ep';
    const createdAt = typeof item.created_at === 'string' ? Date.parse(item.created_at) : NaN;
    const year = Number.isFinite(createdAt) ? new Date(createdAt).getUTCFullYear() : undefined;
    const artistName = item.user?.username ?? item.user?.full_name ?? item.publisher_metadata?.artist ?? item.artist ?? 'Unknown Artist';
    const artistId = item.user?.id ?? item.user_id ?? item.creator?.id ?? item.id;
    const artwork = item.artwork_url ?? item.user?.avatar_url;
    return {
      id: String(item.id),
      title: String(item.title).trim() || 'Untitled release',
      artistId: String(artistId),
      artist: String(artistName).trim() || 'Unknown Artist',
      ...(typeof artwork === 'string' ? { artworkUrl: artwork.replace(/^http:/, 'https:') } : {}),
      ...(year ? { year } : {}),
      trackCount,
      releaseType,
      tracks,
    };
  }

  private mapTrack(item: RawTrack): Track | null {
    if (item?.id === undefined || item?.id === null || !item?.title) return null;
    const artist = item.user?.username ?? item.publisher_metadata?.artist ?? item.artist ?? 'Unknown Artist';
    const artwork = item.artwork_url ?? item.user?.avatar_url;
    const bpm = positiveNumber(item.bpm ?? item.metadata?.bpm ?? item.publisher_metadata?.bpm);
    const albumId = item.album?.id ?? item.playlist?.id;
    return {
      id: String(item.id),
      title: String(item.title).trim() || 'Unknown Track',
      artist: String(artist).trim() || 'Unknown Artist',
      durationMs: Number.isFinite(Number(item.duration)) ? Math.max(0, Number(item.duration)) : 0,
      permalinkUrl: typeof item.permalink_url === 'string' ? item.permalink_url : '',
      artworkUrl: typeof artwork === 'string' ? artwork.replace(/^http:/, 'https:') : undefined,
      artistId: item.user?.id !== undefined ? String(item.user.id) : undefined,
      artistArtworkUrl: typeof item.user?.avatar_url === 'string' ? item.user.avatar_url.replace(/^http:/, 'https:') : undefined,
      ...(albumId === undefined ? {} : { albumId: String(albumId) }),
      albumTitle: String(item.publisher_metadata?.release_title ?? item.album?.title ?? 'Singles'),
      playbackCount: Number.isFinite(Number(item.playback_count)) ? Math.max(0, Number(item.playback_count)) : 0,
      ...(bpm === undefined ? {} : { bpm }),
      access: typeof item.access === 'string' ? item.access : undefined,
      streamable: typeof item.streamable === 'boolean' ? item.streamable : undefined,
    };
  }

  private validateMediaUrl(rawUrl: string): string {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new SoundCloudApiError('SoundCloud returned an invalid media URL', 502); }
    const host = url.hostname.toLowerCase();
    const trusted = host === 'soundcloud.com' || host.endsWith('.soundcloud.com') || host === 'sndcdn.com' || host.endsWith('.sndcdn.com') || host === 'soundcloud.cloud' || host.endsWith('.soundcloud.cloud');
    if (url.protocol !== 'https:' || !trusted || url.username || url.password) {
      throw new SoundCloudApiError('SoundCloud returned an untrusted media URL', 502);
    }
    return url.toString();
  }

  private async toApiError(response: Response): Promise<SoundCloudApiError> {
    const message: Record<number, string> = {
      400: 'SoundCloud rejected the request',
      401: 'SoundCloud authentication failed; check the access token',
      403: 'SoundCloud denied access to this resource',
      404: 'SoundCloud resource was not found',
      429: 'SoundCloud rate limit reached; retry later',
    };
    const retryHeader = response.headers.get('retry-after');
    const retrySeconds = retryHeader && /^\d+$/.test(retryHeader) ? Math.min(3600, Math.max(1, Number(retryHeader))) : undefined;
    return new SoundCloudApiError(message[response.status] ?? `SoundCloud API request failed (${response.status})`, response.status, retrySeconds);
  }
}

function validateTrackId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('Invalid SoundCloud track ID');
  return value;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed)) throw new Error('Pagination values must be integers');
  return Math.min(max, Math.max(min, parsed));
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 500 ? parsed : undefined;
}

function safeCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function clientIdFromToken(token?: string): string {
  if (!token) return '';
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { client_id?: unknown };
    return typeof payload.client_id === 'string' ? payload.client_id : '';
  } catch {
    return '';
  }
}
