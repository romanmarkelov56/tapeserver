import 'dotenv/config';
import { createMusicStreamerServer } from './server.js';
import { config } from './config.js';

const server = await createMusicStreamerServer();
console.info(`[Tape + SoundCloud] Listening on http://${config.host}:${config.port}`);
console.info(`[Tape + SoundCloud] Tape probe: http://127.0.0.1:${config.port}/api/v1/public/stats`);

const shutdown = async (signal: string) => {
  console.info(`[Tape Music Streamer] ${signal} received; shutting down`);
  await server.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
