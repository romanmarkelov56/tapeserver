export interface AppConfig {
  soundCloudClientId: string;
  soundCloudAccessToken?: string;
  tapeUserEmail: string;
  tapeUserPassword: string;
  tapeJwtSecret: string;
  tapeDataDir: string;
  tapeRequireAuth: boolean;
  host: string;
  port: number;
}

export const config: AppConfig = {
  soundCloudClientId: process.env.SOUNDCLOUD_CLIENT_ID ?? '',
  soundCloudAccessToken: process.env.SOUNDCLOUD_ACCESS_TOKEN,
  tapeUserEmail: process.env.TAPE_USER_EMAIL ?? 'owner@tape.local',
  tapeUserPassword: process.env.TAPE_USER_PASSWORD ?? '',
  tapeJwtSecret: process.env.TAPE_JWT_SECRET ?? '',
  tapeDataDir: process.env.TAPE_DATA_DIR ?? './data',
  tapeRequireAuth: (process.env.TAPE_REQUIRE_AUTH ?? 'true').toLowerCase() !== 'false',
  // Render and other container hosts require binding to all network interfaces.
  host: process.env.HOST ?? '0.0.0.0',
  port: readPort(process.env.PORT),
};

function readPort(value?: string): number {
  const port = value === undefined ? 8787 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer from 1 to 65535');
  return port;
}
