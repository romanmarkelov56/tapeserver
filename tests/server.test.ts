import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { JsonFavoritesStore } from '../src/favorites-store.js';
import type { Track, Artist, Album } from '../src/types.js';
import { createMusicStreamerServer } from '../src/server.js';

const track: Track = {
  id: '123', title: 'Demo', artist: 'Artist', durationMs: 10_500,
  permalinkUrl: 'https://soundcloud.com/artist/demo', artworkUrl: 'https://i1.sndcdn.com/image.jpg',
  albumTitle: 'Demo EP', playbackCount: 42,
};
const relatedTrack: Track = {
  id: '987', title: 'Related Tune', artist: 'Similar Artist', durationMs: 180_000,
  permalinkUrl: 'https://soundcloud.com/similar/related-tune', albumTitle: 'Related Set', playbackCount: 12,
};
const album: Album = {
  id: '456', title: 'Demo EP', artistId: '77', artist: 'Artist', artworkUrl: 'https://i1.sndcdn.com/album.jpg',
  year: 2024, trackCount: 1, releaseType: 'single', tracks: [track],
};
const artist: Artist = {
  id: '77', name: 'Artist', biography: 'SoundCloud artist', artworkUrl: 'https://i1.sndcdn.com/artist.jpg',
  followersCount: 500, monthlyListeners: 0, albums: [album], tracks: [track],
};
const temporaryDirectories: string[] = [];

function testClient() {
  const calls: { search?: { query: string; limit?: number; offset?: number }; track?: string; stream?: string; streamCalls?: number; related?: string[] } = {};
  return {
    calls,
    client: {
      searchTracks: async (params: { query: string; limit?: number; offset?: number }) => { calls.search = params; return [track]; },
      searchArtists: async () => [artist],
      searchAlbums: async () => [album],
      getArtistById: async () => artist,
      getArtistTracks: async () => [track],
      getRelatedTracks: async (id: string) => { calls.related = [...(calls.related ?? []), id]; return [relatedTrack]; },
      getAlbumById: async () => album,\n      getAlbumArtworkById: async () => album,
      getTrackById: async (id: string) => { calls.track = id; return track; },
      getStreamUrl: async (id: string) => { calls.stream = id; calls.streamCalls = (calls.streamCalls ?? 0) + 1; return 'https://cf-media.sndcdn.com/demo.mp3?signature=private'; },
    },
  };
}

const tapeAuth = {
  tapeUserEmail: 'owner@example.test',
  tapeUserPassword: 'a-strong-test-password',
  tapeJwtSecret: 'a-test-jwt-secret-that-is-at-least-32-characters-long',
};

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'tape-favorites-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function login(app: Awaited<ReturnType<typeof createMusicStreamerServer>>) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: tapeAuth.tapeUserEmail, password: tapeAuth.tapeUserPassword } });
  assert.equal(response.statusCode, 200);
  return response.json().access_token as string;
}

describe('Tape-compatible SoundCloud server', () => {
  let app: Awaited<ReturnType<typeof createMusicStreamerServer>> | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('fails closed when required Tape credentials are missing', async () => {
    await assert.rejects(createMusicStreamerServer({ listen: false, tapeRequireAuth: true, tapeUserPassword: '', tapeJwtSecret: '' }), /Set TAPE_USER_PASSWORD and TAPE_JWT_SECRET/);
  });

  it('keeps the connection probe public and fills the Home samples from SoundCloud', async () => {
    const mock = testClient();
    app = await createMusicStreamerServer({ listen: false, soundCloudClient: mock.client, ...tapeAuth });
    const response = await app.inject({ method: 'GET', url: '/api/v1/public/stats' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      tracks_count: 0,
      sample_covers: [],
      sample_albums: [],
    });
  });

  it('blocks anonymous search and maps authenticated SoundCloud results to Tape shape', async () => {
    const mock = testClient();
    app = await createMusicStreamerServer({ listen: false, soundCloudClient: mock.client, ...tapeAuth });
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/library/search?q=demo' })).statusCode, 401);
    const accessToken = await login(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/library/search?q=demo&limit=8', headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      artists: [{ id: 77, name: 'Artist' }],
      albums: [{ id: 456, title: 'Demo EP', artist: 'Artist', year: 2024 }],
      tracks: [{ id: 123, title: 'Demo', album_id: 123, album_title: 'Demo EP', play_count: 42, duration_seconds: 11, artists_display: 'Artist', cover_album_id: 123 }],
      layout_fixed: true, query: 'demo',
    });
    assert.deepEqual(mock.calls.search, { query: 'demo', limit: 8, offset: 0 });
  });

  it('falls back to the original artwork URL when the 500px CDN variant is unavailable', async () => {
    const mock = testClient();
    mock.client.getTrackById = async () => ({ ...track, artworkUrl: 'https://i1.sndcdn.com/cover-large.jpg' });
    const requested: string[] = [];
    const mediaFetch: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('-t500x500')) return new Response('blocked', { status: 403 });
      return new Response(Buffer.from('image'), { headers: { 'content-type': 'image/jpeg' } });
    };
    app = await createMusicStreamerServer({ listen: false, soundCloudClient: mock.client, mediaFetch, ...tapeAuth });
    const response = await app.inject({ method: 'GET', url: '/api/v1/library/track-cover/123' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.deepEqual(requested, [
      'https://i1.sndcdn.com/cover-t500x500.jpg',
      'https://i1.sndcdn.com/cover-large.jpg',
    ]);
  });

  it('falls back to a track cover when a playlist artwork URL is unavailable', async () => {
    const mock = testClient();
    mock.client.getAlbumById = async () => ({ ...album, artworkUrl: 'https://i1.sndcdn.com/blocked-album.jpg' });
    mock.client.getTrackById = async () => ({ ...track, artworkUrl: 'https://i1.sndcdn.com/working-track.jpg' });
    const requested: string[] = [];
    const mediaFetch: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('blocked-album')) return new Response('blocked', { status: 403 });
      return new Response(Buffer.from('image'), { headers: { 'content-type': 'image/jpeg' } });
    };
    app = await createMusicStreamerServer({ listen: false, soundCloudClient: mock.client, mediaFetch, ...tapeAuth });
    const response = await app.inject({ method: 'GET', url: '/api/v1/library/cover/456' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.deepEqual(requested, [
      'https://i1.sndcdn.com/blocked-album.jpg',
      'https://i1.sndcdn.com/working-track.jpg',
    ]);
  });

  it('serves SoundCloud artist pages, discography, top tracks, and album tracklists', async () => {
    const mock = testClient();
    const mediaFetch: typeof fetch = async () => new Response(Buffer.from('image'), { headers: { 'content-type': 'image/jpeg' } });
    app = await createMusicStreamerServer({ listen: false, soundCloudClient: mock.client, mediaFetch, ...tapeAuth });
    const accessToken = await login(app);
    const headers = { authorization: `Bearer ${accessToken}` };
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/library/artists', headers })).json(), [{ id: 77, name: 'Artist' }]);
    const profile = await app.inject({ method: 'GET', url: '/api/v1/library/artists/77', headers });
    assert.equal(profile.statusCode, 200);
    assert.deepEqual(profile.json(), {
      id: 77, name: 'Artist', bio: 'SoundCloud artist', cover_rev: 1, is_subscribed: false,
      subscribers_count: 500, monthly_listeners: 0,
      albums: [{ id: 456, title: 'Demo EP', year: 2024, track_count: 1, release_type: 'single' }],
    });
    const topTracks = await app.inject({ method: 'GET', url: '/api/v1/library/artists/77/top-tracks', headers });
    assert.deepEqual(topTracks.json().map((item: { id: number }) => item.id), [123]);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/library/artist-cover/77' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/library/cover/456' })).statusCode, 200);
    const release = await app.inject({ method: 'GET', url: '/api/v1/library/albums/456', headers });
    assert.equal(release.statusCode, 200);
    assert.deepEqual(release.json(), {
      id: 456, title: 'Demo EP', year: 2024, artist_id: 77, artists_display: 'Artist',
      tracks: [{ id: 123, title: 'Demo', duration_seconds: 11, track_number: 1, artists_display: 'Artist' }],
    });
  });

  it('builds an album page from its track when SoundCloud denies playlist access', async () => {
    const mock = testClient();
    mock.client.getAlbumById = async () => { throw new SoundCloudApiError('SoundCloud denied access to this resource', 403); };
    mock.client.getTrackById = async () => ({ ...track, albumId: '456', albumTitle: 'Demo EP' });
    app = await createMusicStreamerServer({ listen: false, soundCloudClient: mock.client, ...tapeAuth });
    const accessToken = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/library/albums/456',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      id: 456, title: 'Demo EP', artist_id: 77, artists_display: 'Artist',
      tracks: [{ id: 123, title: 'Demo', duration_seconds: 11, track_number: 1, artists_display: 'Artist' }],
    });
  });

  it('signs in to Tape and persists favorites locally across store restarts', async () => {
    const mock = testClient();
    const directory = await makeTempDirectory();
    app = await createMusicStreamerServer({ listen: false, soundCloudClient: mock.client, tapeDataDir: directory, ...tapeAuth });
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/library/liked' })).statusCode, 401);
    const loginProbe = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    assert.equal(loginProbe.statusCode, 405);
    assert.equal(loginProbe.headers.allow, 'POST');

    const publicSignup = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'attacker@example.test', password: 'some-valid-length-password' },
    });
    assert.equal(publicSignup.statusCode, 403);
    const ownerSignup = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { email: tapeAuth.tapeUserEmail, password: tapeAuth.tapeUserPassword },
    });
    assert.equal(ownerSignup.statusCode, 200);
    assert.ok(ownerSignup.json().access_token);

    const accessToken = await login(app);
    const headers = { authorization: `Bearer ${accessToken}` };
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().has_access, true);
    assert.deepEqual(me.json().liked_track_ids, []);

    const added = await app.inject({ method: 'POST', url: '/api/v1/library/liked/123', headers });
    assert.equal(added.statusCode, 204);
    assert.equal(mock.calls.track, '123');
    const favorites = await app.inject({ method: 'GET', url: '/api/v1/library/liked', headers });
    assert.deepEqual(favorites.json(), [{ id: 123, title: 'Demo', artist: 'Artist', album: 'Demo EP', duration_seconds: 11 }]);

    const vibe = await app.inject({ method: 'GET', url: '/api/v1/library/tracks/random?limit=5', headers });
    assert.equal(vibe.statusCode, 200);
    assert.deepEqual(vibe.json().map((item: { id: number }) => item.id), [987]);
    assert.deepEqual(mock.calls.related, ['123']);

    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/library/plays', headers, payload: { track_id: 123 } })).statusCode, 204);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/library/me/recent', headers })).json().map((item: { id: number }) => item.id), [123]);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/library/me/stats', headers })).json(), { plays_total: 1, tracks_listened: 1, liked_count: 1 });

    const restartedStore = new JsonFavoritesStore(directory);
    assert.deepEqual(await restartedStore.ids(tapeAuth.tapeUserEmail), [123]);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers })).json().liked_track_ids, [123]);

    const removed = await app.inject({ method: 'POST', url: '/api/v1/library/liked/123', headers });
    assert.equal(removed.statusCode, 204);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/library/liked', headers })).json(), []);
  });

  it('requires a query access token for AVPlayer and forwards HTTP Range', async () => {
    const mock = testClient();
    let seenRange: string | null = null;
    const mediaFetch: typeof fetch = async (_input, init) => {
      seenRange = new Headers(init?.headers).get('range');
      return new Response(Buffer.from('data'), {
        status: 206,
        headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-3/100', 'accept-ranges': 'bytes', 'content-length': '4' },
      });
    };
    app = await createMusicStreamerServer({ listen: false, soundCloudClient: mock.client, mediaFetch, ...tapeAuth });
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/library/tracks/123/stream' })).statusCode, 401);
    const accessToken = await login(app);
    const response = await app.inject({ method: 'GET', url: `/api/v1/library/tracks/123/stream?token=${accessToken}`, headers: { range: 'bytes=0-3' } });
    assert.equal(response.statusCode, 206);
    assert.equal(seenRange, 'bytes=0-3');
    assert.equal(response.headers['content-range'], 'bytes 0-3/100');
    assert.match(response.headers['cache-control'] ?? '', /public/);
    assert.equal(response.body, 'data');
    assert.equal(mock.calls.stream, '123');
  });

  it('reuses a resolved SoundCloud stream URL for repeated requests to the same track', async () => {
    const mock = testClient();
    const mediaFetch: typeof fetch = async () => new Response(Buffer.from('audio'), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg', 'content-length': '5' },
    });
    app = await createMusicStreamerServer({ listen: false, soundCloudClient: mock.client, mediaFetch, ...tapeAuth });
    const accessToken = await login(app);
    const url = `/api/v1/library/tracks/123/stream?token=${accessToken}`;

    const first = await app.inject({ method: 'GET', url });
    const second = await app.inject({ method: 'GET', url });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(mock.calls.streamCalls, 1);
  });

  it('provides a nonempty personalized recommendation pool and validates search inputs after login', async () => {
    const mock = testClient();
    app = await createMusicStreamerServer({ listen: false, soundCloudClient: mock.client, ...tapeAuth });
    const accessToken = await login(app);
    const headers = { authorization: `Bearer ${accessToken}` };
    const random = await app.inject({ method: 'GET', url: '/api/v1/library/tracks/random?limit=2', headers });
    assert.equal(random.statusCode, 200);
    assert.deepEqual(random.json()[0], { id: 123, title: 'Demo', artist: 'Artist', artists_display: 'Artist', album: 'Demo EP', duration_seconds: 11, cover_album_id: 123 });
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/library/search?q=', headers })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/library/search?q=demo&limit=nope', headers })).statusCode, 400);
  });
});
