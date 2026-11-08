export interface Track {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  permalinkUrl: string;
  artworkUrl?: string;
  artistId?: string;
  artistArtworkUrl?: string;
  albumId?: string;
  albumTitle?: string;
  playbackCount?: number;
  bpm?: number;
  access?: string;
  streamable?: boolean;
}

export interface SearchParams {
  query: string;
  limit?: number;
  offset?: number;
}

export interface Artist {
  id: string;
  name: string;
  biography?: string;
  artworkUrl?: string;
  followersCount: number;
  monthlyListeners: number;
  albums: Album[];
  tracks: Track[];
}

export interface Album {
  id: string;
  title: string;
  artistId: string;
  artist: string;
  artworkUrl?: string;
  year?: number;
  trackCount: number;
  releaseType: 'album' | 'ep' | 'single';
  tracks: Track[];
}
