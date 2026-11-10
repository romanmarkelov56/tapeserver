import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { config as defaultConfig } from './config.js';
import { SoundCloudApiError, SoundCloudClient } from './soundcloud/client.js';
import { JsonFavoritesStore, type FavoritesStore, type TapeLikedTrack } from './favorites-store.js';
import { JsonPlayHistoryStore, type PlayHistoryStore, type TapeHistoryTrack } from './history-store.js';
import type { Track, Artist, Album } from './types.js';
import { TapeTokenService, type TapeSessionClaims } from './tape-auth.js';

type TapeSoundCloudClient = Pick<SoundCloudClient,
  'searchTracks' | 'searchArtists' | 'searchAlbums' | 'getArtistById' | 'getArtistTracks' | 'getRelatedTracks' | 'getAlbumById' | 'getTrackById' | 'getStreamUrl'>;

export interface ServerConfig {
  soundCloudClientId?: string;
  soundCloudAccessToken?: string;
  tapeUserEmail?: string;
  tapeUserPassword?: string;
  tapeJwtSecret?: string;
  tapeDataDir?: string;
  tapeRequireAuth?: boolean;
  historyStore?: PlayHistoryStore;
  host?: string;
  port?: number;
  listen?: boolean;
  soundCloudClient?: TapeSoundCloudClient;
  mediaFetch?: typeof fetch;
  favoritesStore?: FavoritesStore;
}

type SearchQuery = { q?: string; limit?: string | number; offset?: string | number };
type TrackParams = { id: string };
type TrackIdParams = { track_id: string };
type CoverParams = { id: string };
type StreamQuery = { token?: string };
type LoginBody = { email?: string; password?: string };
type RefreshBody = { refresh_token?: string };
type PlayBody = { track_id?: string | number };

const tapeApiPrefix = '/api/v1';
const authFailure = { error: 'Authentication required.' };

export async function createMusicStreamerServer(options: ServerConfig = {}): Promise<FastifyInstance> {
  const host = options.host ?? defaultConfig.host;
  const port = options.port ?? defaultConfig.port;
  const userEmail = options.tapeUserEmail ?? defaultConfig.tapeUserEmail;
  const userPassword = options.tapeUserPassword ?? defaultConfig.tapeUserPassword;
  const jwtSecret = options.tapeJwtSecret ?? defaultConfig.tapeJwtSecret;
  const requireAuth = options.tapeRequireAuth ?? defaultConfig.tapeRequireAuth;
  const dataDir = options.tapeDataDir ?? defaultConfig.tapeDataDir;
  const favorites = options.favoritesStore ?? new JsonFavoritesStore(dataDir);
  const history = options.historyStore ?? new JsonPlayHistoryStore(dataDir);
  const client = options.soundCloudClient ?? new SoundCloudClient(
    options.soundCloudClientId ?? defaultConfig.soundCloudClientId,
    options.soundCloudAccessToken ?? defaultConfig.soundCloudAccessToken,
  );
  const mediaFetch = options.mediaFetch ?? fetch;

  if (requireAuth && !userPassword) throw new Error('Set TAPE_USER_PASSWORD and TAPE_JWT_SECRET before starting; Tape authentication is required by default.');
  if (userPassword && userPassword.length < 8) throw new Error('TAPE_USER_PASSWORD must contain at least 8 characters');
  const tokenService = userPassword ? new TapeTokenService(jwtSecret) : null;
  const revokedRefreshTokens = new Set<string>();
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.addHook('onRequest', async (request) => {
    const routeOrPath = request.routeOptions.url ?? request.url.split('?')[0];
    if (routeOrPath.startsWith(`${tapeApiPrefix}/`)) {
      console.info(`[Tape request] ${request.method} ${routeOrPath}`);
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    const routeOrPath = request.routeOptions.url ?? request.url.split('?')[0];
    if (routeOrPath.startsWith(`${tapeApiPrefix}/`)) {
      console.info(`[Tape response] ${request.method} ${routeOrPath} -> ${reply.statusCode}`);
    }
  });

  // Cache short-lived signed media URLs to avoid resolving the same track on every AVPlayer request.
  const streamUrlCache = new Map<string, { url: string; expiresAt: number }>();
  const streamUrlInflight = new Map<string, Promise<string>>();
  let soundCloudRateLimitedUntil = 0;
  const streamUrlCacheTtlMs = 2 * 60_000;

  async function resolveStreamUrl(trackId: string): Promise<string> {
    const cached = streamUrlCache.get(trackId);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    if (cached) streamUrlCache.delete(trackId);

    const pending = streamUrlInflight.get(trackId);
    if (pending) return pending;

    if (soundCloudRateLimitedUntil > Date.now()) {
      const error = new SoundCloudApiError('SoundCloud rate limit cooldown is active; retry later', 429);
      throw error;
    }

    const resolving = client.getStreamUrl(trackId).then((url) => {
      streamUrlCache.set(trackId, { url, expiresAt: Date.now() + streamUrlCacheTtlMs });
      // Keep the in-memory cache bounded on long-running instances.
      if (streamUrlCache.size > 500) {
        const oldestKey = streamUrlCache.keys().next().value;
        if (oldestKey !== undefined) streamUrlCache.delete(oldestKey);
      }
      return url;
    }).catch((error: unknown) => {
      if (error instanceof SoundCloudApiError && error.statusCode === 429) {
        soundCloudRateLimitedUntil = Date.now() + 30_000;
      }
      throw error;
    }).finally(() => {
      streamUrlInflight.delete(trackId);
    });

    streamUrlInflight.set(trackId, resolving);
    return resolving;
  }

  let recommendationCache: { expiresAt: number; tracks: Track[] } | null = null;

  async function recommendationPool(): Promise<Track[]> {
    if (recommendationCache && recommendationCache.expiresAt > Date.now()) return recommendationCache.tracks;
    const queries = ['lofi', 'chill', 'ambient', 'indie', 'jazz', 'electronic', 'house', 'hip hop'];
    for (let i = queries.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [queries[i], queries[j]] = [queries[j], queries[i]];
    }
    const tracks = new Map<string, Track>();
    for (const query of queries.slice(0, 3)) {
      try {
        for (const track of await client.searchTracks({ query, limit: 50, offset: 0 })) tracks.set(track.id, track);
      } catch {}
    }
    if (tracks.size === 0) {
      try { for (const track of await client.searchTracks({ query: 'music', limit: 50, offset: 0 })) tracks.set(track.id, track); }
      catch {}
    }
    recommendationCache = { tracks: [...tracks.values()], expiresAt: Date.now() + (tracks.size ? 3 : 0.25) * 60_000 };
    return recommendationCache.tracks;
  }

  let albumCache: { expiresAt: number; albums: Album[] } | null = null;
  async function albumPool(): Promise<Album[]> {
    if (albumCache && albumCache.expiresAt > Date.now()) return albumCache.albums;

    // Use playlists published by SoundCloud's own editorial profile only.
    // Public API search is free with the public client_id; it is not personalized.
    const officialOwners = new Set(['soundcloud', 'soundcloud go', 'soundcloud charts']);
    const albums = new Map<string, Album>();
    try {
      const results = await client.searchAlbums({ query: 'SoundCloud', limit: 50, offset: 0 });
      for (const album of results) {
        if (officialOwners.has(album.artist.trim().toLowerCase())) albums.set(album.id, album);
      }
    } catch (error) {
      console.warn('[Tape home] Unable to load SoundCloud editorial playlists:', error instanceof Error ? error.message : 'unknown error');
    }

    const sortedAlbums = [...albums.values()].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    albumCache = { albums: sortedAlbums, expiresAt: Date.now() + (albums.size ? 30 : 2) * 60_000 };
    return albumCache.albums;
  }

  let vibeCache: { key: string; expiresAt: number; tracks: Track[] } | null = null;
  async function myVibePool(): Promise<Track[]> {
    const [recentIds, likedIds] = await Promise.all([history.ids(userEmail, 10), favorites.ids(userEmail)]);
    const seeds = [...new Set([...recentIds, ...likedIds])].slice(0, 5);
    if (seeds.length === 0) return recommendationPool();
    const key = seeds.join(',');
    if (vibeCache?.key === key && vibeCache.expiresAt > Date.now()) return vibeCache.tracks;
    const relatedLists = await Promise.all(seeds.slice(0, 3).map((id) => client.getRelatedTracks(String(id), 30).catch(() => [])));
    const tracks = new Map<string, Track>();
    const seedSet = new Set(seeds.map(String));
    for (const related of relatedLists) {
      for (const track of related) if (!seedSet.has(track.id)) tracks.set(track.id, track);
    }
    if (tracks.size < 30) {
      for (const track of await recommendationPool()) if (!seedSet.has(track.id) && !tracks.has(track.id)) tracks.set(track.id, track);
    }
    vibeCache = { key, tracks: [...tracks.values()], expiresAt: Date.now() + 3 * 60_000 };
    return vibeCache.tracks;
  }

  const requireSession = (request: FastifyRequest, reply: FastifyReply, queryToken?: string) =>
    !requireAuth || authenticate(request, reply, tokenService, queryToken) !== null;

  app.get(`${tapeApiPrefix}/public/stats`, async () => {
    const albums = await albumPool();
    const sampleAlbums = albums.slice(0, 12).map(toTapeAlbumSummary).filter((album): album is TapeAlbumSummary => album !== null);
    return {
      tracks_count: 0,
      sample_covers: sampleAlbums.map((album) => album.id),
      sample_albums: sampleAlbums,
    };
  });

  app.get(`${tapeApiPrefix}/auth/login`, async (_request, reply) =>
    reply.header('allow', 'POST').code(405).send({ error: 'Use POST with email and password to sign in.' }));

  app.post<{ Body: LoginBody }>(`${tapeApiPrefix}/auth/login`, async (request, reply) => {
    if (!tokenService) return reply.code(503).send({ error: 'Set TAPE_USER_PASSWORD and a 32+ character TAPE_JWT_SECRET to enable Tape sign-in.' });
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (email !== userEmail.toLowerCase() || !constantTimeStringEqual(password, userPassword)) {
      return reply.code(401).send({ error: 'Invalid email or password.' });
    }
    return tokenService.issuePair(userEmail);
  });

  app.post<{ Body: LoginBody }>(`${tapeApiPrefix}/auth/register`, async (request, reply) => {
    if (!tokenService) return reply.code(503).send({ error: 'Set TAPE_USER_PASSWORD and a 32+ character TAPE_JWT_SECRET to enable Tape sign-in.' });
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (password.length < 8) return reply.code(400).send({ error: 'Password must contain at least 8 characters.' });
    if (email !== userEmail.toLowerCase() || !constantTimeStringEqual(password, userPassword)) {
      return reply.code(403).send({ error: 'Public registration is disabled. Use the account configured by the server owner.' });
    }
    return tokenService.issuePair(userEmail);
  });

  app.post<{ Body: RefreshBody }>(`${tapeApiPrefix}/auth/refresh`, async (request, reply) => {
    if (!tokenService) return reply.code(503).send({ error: 'Tape sign-in is not configured.' });
    const refreshToken = request.body?.refresh_token;
    if (typeof refreshToken !== 'string') return reply.code(400).send({ error: 'refresh_token is required.' });
    const claims = tokenService.verify(refreshToken, 'refresh');
    if (!claims || revokedRefreshTokens.has(claims.jti)) return reply.code(401).send({ error: 'Invalid or expired refresh token.' });
    revokedRefreshTokens.add(claims.jti);
    return tokenService.issuePair(userEmail);
  });

  app.post<{ Body: RefreshBody }>(`${tapeApiPrefix}/auth/logout`, async (request, reply) => {
    if (!tokenService) return reply.code(204).send();
    const refreshToken = request.body?.refresh_token;
    if (typeof refreshToken === 'string') {
      const claims = tokenService.verify(refreshToken, 'refresh');
      if (claims) revokedRefreshTokens.add(claims.jti);
    }
    return reply.code(204).send();
  });

  app.get(`${tapeApiPrefix}/auth/me`, async (request, reply) => {
    const claims = authenticate(request, reply, tokenService);
    if (!claims) return;
    try {
      return {
        id: 1,
        email: userEmail,
        tg_username: null,
        tg_first_name: null,
        role: 'user',
        has_access: true,
        avatar_url: null,
        emoji_url: null,
        logs_requested: false,
        liked_track_ids: await favorites.ids(userEmail),
      };
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.get<{ Querystring: SearchQuery }>(`${tapeApiPrefix}/library/search`, async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
    if (!query || query.length > 300) return reply.code(400).send({ error: 'q must contain 1 to 300 characters.' });
    let limit: number;
    let offset: number;
    try {
      limit = parseInteger(request.query.limit, 25, 1, 50);
      offset = parseInteger(request.query.offset, 0, 0, 10_000);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid pagination.' });
    }
    try {
      const [tracks, artists, albums] = await Promise.all([
        client.searchTracks({ query, limit, offset }),
        client.searchArtists({ query, limit, offset }),
        client.searchAlbums({ query, limit, offset }),
      ]);
      return {
        artists: artists.map(toTapeArtistSummary).filter((artist): artist is TapeArtistSummary => artist !== null),
        albums: albums.map(toTapeAlbumSummary).filter((album): album is TapeAlbumSummary => album !== null),
        tracks: tracks.map(toTapeTopTrack).filter((track): track is TapeTopTrack => track !== null),
        layout_fixed: true,
        query,
      };
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.get<{ Querystring: { limit?: string; exclude_ids?: string } }>(`${tapeApiPrefix}/library/tracks/random`, async (request, reply) => {
    if (!requireSession(request, reply)) return;
    let limit: number;
    try { limit = parseInteger(request.query.limit, 10, 1, 50); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid limit.' }); }
    const excluded = new Set((request.query.exclude_ids ?? '').split(',').map((id) => Number(id)).filter(Number.isSafeInteger));
    try {
      const found = await myVibePool();
      const pool = found.map(toTapeQueueTrack).filter((track): track is TapeQueueTrack => track !== null && !excluded.has(track.id));
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, limit);
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  // Proxy the original SoundCloud media file so AVPlayer can download byte ranges.
  app.get<{ Params: TrackParams; Querystring: StreamQuery }>(`${tapeApiPrefix}/library/tracks/:id/stream`, async (request, reply) => {
    if (!requireSession(request, reply, request.query.token)) return;
    if (tapeId(request.params.id) === null) return reply.code(400).send({ error: 'Invalid SoundCloud track ID.' });
    try {
      console.info(`[Tape stream] Resolving SoundCloud audio for track ${request.params.id}`);
      const mediaUrl = await resolveStreamUrl(request.params.id);
      if (!isTrustedMediaUrl(mediaUrl)) {
        console.error(`[Tape stream] Rejected untrusted media URL for track ${request.params.id}`);
        return reply.code(502).send({ error: 'SoundCloud returned an untrusted media URL.' });
      }
      console.info(`[Tape stream] Resolved media host ${new URL(mediaUrl).hostname} for track ${request.params.id}`);

      const headers = new Headers();
      const range = request.headers.range;
      if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) {
        headers.set('Range', range);
      }

      const controller = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) controller.abort();
      });
      const upstream = await mediaFetch(mediaUrl, {
        method: request.method,
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });

      // Fetch follows redirects; validate the final destination as well as the signed URL.
      if (upstream.url && !isTrustedMediaUrl(upstream.url)) {
        await upstream.body?.cancel().catch(() => undefined);
        return reply.code(502).send({ error: 'SoundCloud redirected to an untrusted media URL.' });
      }

      const contentType = upstream.headers.get('content-type') ?? '';
      console.info(`[Tape stream] Upstream status ${upstream.status}, content-type ${contentType || 'unknown'}, track ${request.params.id}`);
      if (/mpegurl|vnd\.apple\.mpegurl/i.test(contentType)) {
        // HLS playlists contain relative segment/key URLs. Redirect the player to
        // SoundCloud's signed playlist URL so AVPlayer resolves those URLs against
        // the original CDN origin instead of this API route.
        const playlistUrl = upstream.url || mediaUrl;
        if (!isTrustedMediaUrl(playlistUrl)) {
          await upstream.body?.cancel().catch(() => undefined);
          console.error(`[Tape stream] Rejected untrusted HLS playlist URL for track ${request.params.id}`);
          return reply.code(502).send({ error: 'SoundCloud returned an untrusted HLS playlist URL.' });
        }
        await upstream.body?.cancel().catch(() => undefined);
        console.info(`[Tape stream] Redirecting HLS playback to trusted SoundCloud CDN for track ${request.params.id}`);
        return reply.code(302).header('Cache-Control', 'no-store').header('Location', playlistUrl).send();
      }

      for (const name of ['accept-ranges', 'content-range', 'content-length', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value) reply.header(name, value);
      }
      reply.header('Content-Type', contentType || 'audio/mpeg');
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      reply.header('X-Content-Type-Options', 'nosniff');

      if (upstream.status === 206 && !upstream.headers.has('content-range')) {
        await upstream.body?.cancel().catch(() => undefined);
        return reply.code(502).send({ error: 'SoundCloud returned an invalid partial-content response.' });
      }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined);
        if (upstream.status === 416) return reply.code(416).send();
        return reply.code(upstream.status >= 400 ? upstream.status : 502).send({ error: 'Unable to retrieve SoundCloud audio.' });
      }

      reply.code(upstream.status);
      if (request.method === 'HEAD' || !upstream.body) return reply.send();
      return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      console.error(`[Tape stream] Failed for track ${request.params.id}:`, error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error');
      if (error instanceof SoundCloudApiError && error.statusCode === 429) {
        const retrySeconds = Math.max(1, Math.ceil((soundCloudRateLimitedUntil - Date.now()) / 1000));
        reply.header('Retry-After', String(retrySeconds));
      }
      return sendApiError(reply, error);
    }
  });

  app.get<{ Params: CoverParams }>(`${tapeApiPrefix}/library/cover/:id`, async (request, reply) => {
    if (tapeId(request.params.id) === null) return reply.code(404).send();
    try {
      // Playlist artwork can be stale or inaccessible; fall back to its first track.
      try {
        const album = await client.getAlbumById(request.params.id);
        if (await sendArtwork(album.artworkUrl, reply)) return reply;
      } catch (error) {
        console.warn(`[Tape artwork] Album cover lookup failed for ${request.params.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      if (await sendCover(request, reply)) return reply;
      return reply.code(404).send();
    } catch (error) { return sendApiError(reply, error); }
  });
  app.get<{ Params: CoverParams }>(`${tapeApiPrefix}/library/track-cover/:id`, async (request, reply) => {
    if (tapeId(request.params.id) === null) return reply.code(404).send();
    try {
      if (await sendCover(request, reply)) return reply;
      return reply.code(404).send();
    } catch (error) { return sendApiError(reply, error); }
  });
  app.get<{ Params: CoverParams }>(`${tapeApiPrefix}/library/artist-cover/:id`, sendArtistCover);

  async function sendCover(request: { params: CoverParams }, reply: FastifyReply): Promise<boolean> {
    const track = await client.getTrackById(request.params.id);
    return sendArtwork(track.artworkUrl, reply);
  }

  async function sendArtistCover(request: { params: CoverParams }, reply: FastifyReply) {
    if (tapeId(request.params.id) === null) return reply.code(404).send();
    try {
      const artist = await client.getArtistById(request.params.id);
      if (await sendArtwork(artist.artworkUrl, reply)) return reply;
      return reply.code(404).send();
    } catch (error) { return sendApiError(reply, error); }
  }

  async function sendArtwork(artworkUrl: string | undefined, reply: FastifyReply): Promise<boolean> {
    if (!artworkUrl || !isTrustedArtworkUrl(artworkUrl)) return false;
    // Try a larger SoundCloud CDN variant first, then the exact URL from the API.
    const highResolutionUrl = artworkUrl.replace(/-large(?=\.(?:jpg|jpeg|png|webp)(?:\?|$))/i, '-t500x500');
    for (const candidate of [...new Set([highResolutionUrl, artworkUrl])]) {
      let upstream: Response;
      try {
        upstream = await mediaFetch(candidate, {
          redirect: 'follow',
          headers: { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'user-agent': 'Tape/1.0' },
        });
      } catch (error) {
        console.warn(`[Tape artwork] CDN request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        continue;
      }
      const contentType = upstream.headers.get('content-type') ?? '';
      if (!upstream.ok || !contentType.toLowerCase().startsWith('image/') || !upstream.body) {
        await upstream.body?.cancel().catch(() => undefined);
        continue;
      }
      reply.header('Cache-Control', 'public, max-age=2592000, immutable');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.type(contentType);
      const length = upstream.headers.get('content-length');
      if (length) reply.header('Content-Length', length);
      reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
      return true;
    }
    return false;
  }

  app.get(`${tapeApiPrefix}/library/artists`, async (request, reply) => {
    if (!requireSession(request, reply)) return;
    try {
      const artists = await client.searchArtists({ query: 'music', limit: 50, offset: 0 });
      return artists.map(toTapeArtistSummary).filter((artist): artist is TapeArtistSummary => artist !== null);
    } catch (error) { return sendApiError(reply, error); }
  });

  app.get<{ Params: TrackParams }>(`${tapeApiPrefix}/library/artists/:id`, async (request, reply) => {
    if (!requireSession(request, reply)) return;
    if (tapeId(request.params.id) === null) return reply.code(404).send();
    try {
      const artist = await client.getArtistById(request.params.id);
      const id = tapeId(artist.id);
      if (id === null) return reply.code(404).send();
      return {
        id,
        name: artist.name,
        bio: artist.biography ?? null,
        cover_rev: 1,
        is_subscribed: false,
        subscribers_count: artist.followersCount,
        monthly_listeners: artist.monthlyListeners,
        albums: artist.albums.map(toTapeArtistAlbum).filter((album): album is TapeArtistAlbum => album !== null),
      };
    } catch (error) { return sendApiError(reply, error); }
  });

  app.get<{ Params: TrackParams }>(`${tapeApiPrefix}/library/artists/:id/top-tracks`, async (request, reply) => {
    if (!requireSession(request, reply)) return;
    if (tapeId(request.params.id) === null) return reply.code(404).send();
    try {
      const tracks = await client.getArtistTracks(request.params.id, 50);
      return tracks.sort((a, b) => (b.playbackCount ?? 0) - (a.playbackCount ?? 0)).slice(0, 20)
        .map(toTapeTopTrack).filter((track): track is TapeTopTrack => track !== null);
    } catch (error) { return sendApiError(reply, error); }
  });

  app.get<{ Params: TrackParams }>(`${tapeApiPrefix}/library/albums/:id`, async (request, reply) => {
    if (!requireSession(request, reply)) return;
    if (tapeId(request.params.id) === null) return reply.code(404).send();
    try {
      let album: Album;
      try {
        album = await client.getAlbumById(request.params.id);
      } catch (error) {
        if (!(error instanceof SoundCloudApiError) || error.statusCode !== 404) throw error;
        const track = await client.getTrackById(request.params.id);
        album = {
          id: track.albumId ?? track.id,
          title: track.albumTitle || track.title,
          artistId: track.artistId ?? track.id,
          artist: track.artist,
          trackCount: 1,
          releaseType: 'single',
          tracks: [track],
        };
      }
      const id = tapeId(album.id);
      const artistId = tapeId(album.artistId);
      if (id === null || artistId === null) return reply.code(404).send();
      return {
        id,
        title: album.title,
        ...(album.year ? { year: album.year } : {}),
        artist_id: artistId,
        artists_display: album.artist,
        tracks: album.tracks.map((track, index) => {
          const trackId = tapeId(track.id);
          return trackId === null ? null : { id: trackId, title: track.title, duration_seconds: toSeconds(track.durationMs), track_number: index + 1, artists_display: track.artist };
        }).filter((track): track is NonNullable<typeof track> => track !== null),
      };
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.get(`${tapeApiPrefix}/library/liked`, async (request, reply) => {
    if (!authenticate(request, reply, tokenService)) return;
    try {
      return await favorites.list(userEmail);
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post<{ Params: TrackIdParams }>(`${tapeApiPrefix}/library/liked/:track_id`, async (request, reply) => {
    if (!authenticate(request, reply, tokenService)) return;
    if (tapeId(request.params.track_id) === null) return reply.code(400).send({ error: 'Invalid SoundCloud track ID.' });
    try {
      const track = await client.getTrackById(request.params.track_id);
      const favorite = toTapeLikedTrack(track);
      if (!favorite) return reply.code(400).send({ error: 'This SoundCloud track cannot be represented by Tape.' });
      await favorites.toggle(userEmail, favorite);
      return reply.code(204).send();
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  const recordPlay = async (request: FastifyRequest<{ Body: PlayBody }>, reply: FastifyReply) => {
    if (!authenticate(request, reply, tokenService)) return;
    const trackId = tapeId(String(request.body?.track_id ?? ''));
    if (trackId === null) return reply.code(400).send({ error: 'track_id must be a SoundCloud track ID.' });
    try {
      const track = toTapeTopTrack(await client.getTrackById(String(trackId)));
      if (!track) return reply.code(400).send({ error: 'This SoundCloud track cannot be represented by Tape.' });
      await history.record(userEmail, track);
      vibeCache = null;
      return reply.code(204).send();
    } catch (error) { return sendApiError(reply, error); }
  };

  app.post<{ Body: PlayBody }>(`${tapeApiPrefix}/library/plays`, recordPlay);
  app.post<{ Body: PlayBody }>(`${tapeApiPrefix}/me/playback`, recordPlay);

  app.get(`${tapeApiPrefix}/library/me/stats`, async (request, reply) => {
    if (!authenticate(request, reply, tokenService)) return;
    try { return { ...await history.stats(userEmail), liked_count: (await favorites.list(userEmail)).length }; }
    catch (error) { return sendApiError(reply, error); }
  });

  app.get(`${tapeApiPrefix}/library/me/top-tracks`, async (request, reply) => {
    if (!authenticate(request, reply, tokenService)) return;
    try {
      const tracks = await myVibePool();
      return [...tracks].sort((a, b) => (b.playbackCount ?? 0) - (a.playbackCount ?? 0)).slice(0, 20)
        .map(toTapeTopTrack).filter((track): track is TapeTopTrack => track !== null);
    } catch (error) { return sendApiError(reply, error); }
  });

  app.get(`${tapeApiPrefix}/library/me/recent`, async (request, reply) => {
    if (!authenticate(request, reply, tokenService)) return;
    return history.recent(userEmail, 30);
  });

  app.get('/health', async () => ({ ok: true, service: 'tape-soundcloud-adapter' }));

  if (options.listen !== false) await app.listen({ host, port });
  return app;
}

interface TapeArtistSummary { id: number; name: string; }
interface TapeAlbumSummary { id: number; title: string; artist: string; year?: number; }
interface TapeArtistAlbum { id: number; title: string; year?: number; track_count: number; release_type: 'album' | 'ep' | 'single'; }

interface TapeTopTrack {
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

interface TapeQueueTrack {
  id: number;
  title: string;
  artist: string;
  artists_display: string;
  album: string;
  duration_seconds: number;
  cover_album_id: number;
  bpm?: number;
}

function toTapeArtistSummary(artist: Artist): TapeArtistSummary | null {
  const id = tapeId(artist.id);
  return id === null ? null : { id, name: artist.name };
}

function toTapeAlbumSummary(album: Album): TapeAlbumSummary | null {
  const id = tapeId(album.id);
  if (id === null) return null;
  return { id, title: album.title, artist: album.artist, ...(album.year ? { year: album.year } : {}) };
}

function toTapeArtistAlbum(album: Album): TapeArtistAlbum | null {
  const id = tapeId(album.id);
  if (id === null) return null;
  return {
    id,
    title: album.title,
    ...(album.year ? { year: album.year } : {}),
    track_count: album.trackCount,
    release_type: album.releaseType,
  };
}

function toTapeTopTrack(track: Track): TapeTopTrack | null {
  const id = tapeId(track.id);
  if (id === null) return null;
  const albumId = tapeId(track.albumId ?? '') ?? id;
  return {
    id,
    title: track.title,
    album_id: albumId,
    album_title: track.albumTitle || 'Singles',
    play_count: track.playbackCount ?? 0,
    duration_seconds: toSeconds(track.durationMs),
    artists_display: track.artist,
    cover_album_id: albumId,
    bpm: track.bpm,
  };
}

function toTapeQueueTrack(track: Track): TapeQueueTrack | null {
  const id = tapeId(track.id);
  if (id === null || !track.artist.trim()) return null;
  const albumId = tapeId(track.albumId ?? '') ?? id;
  return {
    id,
    title: track.title,
    artist: track.artist,
    artists_display: track.artist,
    album: track.albumTitle || 'Singles',
    duration_seconds: toSeconds(track.durationMs),
    cover_album_id: albumId,
    bpm: track.bpm,
  };
}

function toTapeLikedTrack(track: Track): TapeLikedTrack | null {
  const id = tapeId(track.id);
  if (id === null || !track.artist.trim()) return null;
  return { id, title: track.title, artist: track.artist, album: track.albumTitle || 'Singles', duration_seconds: toSeconds(track.durationMs) };
}

function tapeId(value: string): number | null {
  if (!/^\d{1,16}$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function toSeconds(durationMs: number): number {
  return Math.max(0, Math.round(durationMs / 1000));
}

function parseInteger(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected integer between ${min} and ${max}.`);
  return parsed;
}

function authenticate(request: FastifyRequest, reply: FastifyReply, tokenService: TapeTokenService | null, queryToken?: string): TapeSessionClaims | null {
  if (!tokenService) {
    void reply.code(503).send({ error: 'Tape sign-in is not configured.' });
    return null;
  }
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1] ?? queryToken;
  const claims = token ? tokenService.verify(token, 'access') : null;
  if (!claims) {
    void reply.code(401).send(authFailure);
    return null;
  }
  return claims;
}

function constantTimeStringEqual(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function isTrustedMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && (host === 'sndcdn.com' || host.endsWith('.sndcdn.com') || host === 'soundcloud.com' || host.endsWith('.soundcloud.com') || host === 'soundcloud.cloud' || host.endsWith('.soundcloud.cloud'));
  } catch { return false; }
}

function isTrustedArtworkUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && (host === 'sndcdn.com' || host.endsWith('.sndcdn.com'));
  } catch { return false; }
}

function sendApiError(reply: FastifyReply, error: unknown) {
  if (error instanceof SoundCloudApiError) {
    const status = error.statusCode === 401 ? 502 : error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 502;
    return reply.code(status).send({ error: error.message });
  }
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  return reply.code(502).send({ error: message.slice(0, 300) });
}
