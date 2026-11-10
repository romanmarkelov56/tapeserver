import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SoundCloudApiError, SoundCloudClient } from '../src/soundcloud/client.js';

const apiOptions = { apiBaseUrl: 'https://api.soundcloud.test', apiV2BaseUrl: 'https://api-v2.soundcloud.test' };

describe('SoundCloudClient', () => {
  it('searches v2 and maps metadata to the Tape model', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ collection: [{
        id: 123, title: 'Test Track', duration: 180_500, user: { id: 77, username: 'Tape Artist', avatar_url: 'http://i1.sndcdn.com/avatar.jpg' },
        artwork_url: 'http://i1.sndcdn.com/image.jpg', permalink_url: 'https://soundcloud.com/artist/test-track', access: 'playable',
        publisher_metadata: { release_title: 'Demo EP' }, playback_count: 42,
      }] });
    };
    const client = new SoundCloudClient('client-id', 'secret-token', request, apiOptions);
    const tracks = await client.searchTracks({ query: ' test ', limit: 5 });
    assert.deepEqual(tracks[0], {
      id: '123', title: 'Test Track', artist: 'Tape Artist', durationMs: 180_500,
      permalinkUrl: 'https://soundcloud.com/artist/test-track', artworkUrl: 'https://i1.sndcdn.com/image.jpg',
      artistId: '77', artistArtworkUrl: 'https://i1.sndcdn.com/avatar.jpg', albumTitle: 'Demo EP', playbackCount: 42,
      access: 'playable', streamable: undefined,
    });
    const parsed = new URL(calls[0].url);
    assert.equal(parsed.pathname, '/search/tracks');
    assert.equal(parsed.searchParams.get('q'), 'test');
    assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'OAuth secret-token');
  });

  it('searches artists and releases and loads their SoundCloud catalog details', async () => {
    const paths: string[] = [];
    const user = { id: 77, username: 'Tape Artist', full_name: 'Tape Artist', description: 'Bio', track_count: 1, followers_count: 500, avatar_url: 'http://i1.sndcdn.com/artist.jpg' };
    const playlist = { id: 456, title: 'Demo EP', user, user_id: 77, is_album: true, track_count: 1, created_at: '2024-02-03T00:00:00Z', artwork_url: 'http://i1.sndcdn.com/release.jpg' };
    const rawTrack = { id: 123, title: 'Demo', duration: 10_500, user, playback_count: 9, permalink_url: 'https://soundcloud.com/artist/demo' };
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/search/users') return Response.json({ collection: [user] });
      if (url.pathname === '/search/playlists') return Response.json({ collection: [playlist] });
      if (url.pathname === '/users/77') return Response.json(user);
      if (url.pathname === '/users/77/playlists') return Response.json({ collection: [playlist] });
      if (url.pathname === '/users/77/tracks') return Response.json({ collection: [rawTrack] });
      if (url.pathname === '/tracks/123/related') return Response.json({ collection: [rawTrack] });
      if (url.pathname === '/playlists/456') return Response.json({ ...playlist, tracks: [rawTrack] });
      if (url.pathname === '/playlists/456/tracks') return Response.json({ collection: [rawTrack] });
      throw new Error(`Unexpected request ${url.pathname}`);
    };
    const client = new SoundCloudClient('client-id', 'secret-token', request, apiOptions);
    const artists = await client.searchArtists({ query: 'tape', limit: 5 });
    const albums = await client.searchAlbums({ query: 'demo', limit: 5 });
    assert.deepEqual(artists[0], {
      id: '77', name: 'Tape Artist', biography: 'Bio', artworkUrl: 'https://i1.sndcdn.com/artist.jpg',
      followersCount: 500, monthlyListeners: 0, albums: [], tracks: [],
    });
    assert.equal(albums[0].id, '456');
    assert.equal(albums[0].releaseType, 'album');
    assert.equal(albums[0].year, 2024);
    const artist = await client.getArtistById('77');
    assert.equal(artist.albums[0].title, 'Demo EP');
    assert.equal(artist.tracks[0].id, '123');
    assert.equal((await client.getRelatedTracks('123', 5))[0].id, '123');
    const album = await client.getAlbumById('456');
    assert.equal(album.artistId, '77');
    assert.deepEqual(album.tracks.map((track) => track.title), ['Demo']);
    assert.deepEqual(paths.slice(0, 2), ['/search/users', '/search/playlists']);
  });

  it('loads all album tracks from the dedicated paginated playlist endpoint', async () => {
    const requested: URL[] = [];
    const user = { id: 77, username: 'Tape Artist' };
    const playlist = { id: 456, title: 'Full Album', user, user_id: 77, track_count: 7, is_album: true };
    const tracks = Array.from({ length: 7 }, (_, index) => ({
      id: 100 + index, title: `Track ${index + 1}`, duration: 60_000,
      user, permalink_url: `https://soundcloud.com/artist/track-${index + 1}`,
    }));
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.pathname === '/playlists/456') return Response.json(playlist);
      if (url.pathname === '/playlists/456/tracks' && !url.searchParams.has('cursor')) {
        return Response.json({ collection: tracks.slice(0, 5), next_href: 'https://api-v2.soundcloud.test/playlists/456/tracks?cursor=next&limit=200' });
      }
      if (url.pathname === '/playlists/456/tracks' && url.searchParams.get('cursor') === 'next') {
        return Response.json({ collection: tracks.slice(5) });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    };
    const client = new SoundCloudClient('client-id', 'secret-token', request, apiOptions);
    const album = await client.getAlbumById('456');
    assert.equal(album.trackCount, 7);
    assert.deepEqual(album.tracks.map((track) => track.title), tracks.map((track) => track.title));
    assert.equal(requested.filter((url) => url.pathname === '/playlists/456/tracks').length, 2);
    assert.equal(requested[1].searchParams.get('limit'), '200');
    assert.equal(requested[1].searchParams.get('linked_partitioning'), 'true');
  });

  it('resolves a SoundCloud HLS transcoding', async () => {
    const paths: string[] = [];
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input)); paths.push(url.pathname);
      if (url.pathname === '/tracks/42') return Response.json({ id: 42, title: 'Song', access: 'playable', media: { transcodings: [
        { url: 'https://api-v2.soundcloud.test/media/42/hls', format: { protocol: 'hls', mime_type: 'audio/mpeg' } },
      ] } });
      if (url.pathname === '/media/42/hls') return Response.json({ url: 'https://playback.media-streaming.soundcloud.cloud/stream.m3u8?sig=short-lived' });
      throw new Error(`Unexpected request ${url.pathname}`);
    };
    const client = new SoundCloudClient('client-id', 'secret-token', request, apiOptions);
    const url = await client.getStreamUrl('42');
    assert.match(url, /^https:\/\/playback\.media-streaming\.soundcloud\.cloud\/stream\.m3u8/);
    assert.deepEqual(paths, ['/tracks/42', '/media/42/hls']);
  });

  it('rejects blocked tracks and untrusted media hosts', async () => {
    const blockedRequest: typeof fetch = async () => Response.json({ id: 5, title: 'No', access: 'blocked' });
    const blocked = new SoundCloudClient('', '', blockedRequest, apiOptions);
    await assert.rejects(blocked.getStreamUrl('5'), (error: unknown) => error instanceof SoundCloudApiError && error.statusCode === 403);

    const unsafeRequest: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/tracks/6') return Response.json({ id: 6, title: 'Track', access: 'playable', media: { transcodings: [
        { url: 'https://api-v2.soundcloud.test/media/6/hls', format: { protocol: 'hls' } },
      ] } });
      if (url.pathname === '/media/6/hls') return Response.json({ url: 'https://attacker.example/stream' });
      if (url.pathname === '/tracks/6/stream') return new Response(null, { status: 404 });
      throw new Error('Unexpected request');
    };
    const unsafe = new SoundCloudClient('', '', unsafeRequest, apiOptions);
    await assert.rejects(unsafe.getStreamUrl('6'), SoundCloudApiError);
  });

  it('rejects malformed track IDs before making requests', async () => {
    let called = false;
    const request: typeof fetch = async () => { called = true; return Response.json({}); };
    const client = new SoundCloudClient('', '', request, apiOptions);
    await assert.rejects(client.getTrackById('../private'), /Invalid SoundCloud track ID/);
    assert.equal(called, false);
  });

  it('uses the client_id claim from a JWT when no client ID is configured', async () => {
    let requestedUrl = '';
    const request: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return Response.json({ collection: [] });
    };
    const payload = Buffer.from(JSON.stringify({ client_id: 'embedded-client-id' })).toString('base64url');
    const client = new SoundCloudClient('', `header.${payload}.signature`, request);
    await client.searchTracks({ query: 'jazz' });
    const parsedUrl = new URL(requestedUrl);
    assert.equal(parsedUrl.hostname, 'api-v2.soundcloud.com');
    assert.equal(parsedUrl.searchParams.get('client_id'), 'embedded-client-id');
  });
});
