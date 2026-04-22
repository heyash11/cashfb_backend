import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { ephemeralStats, initJwtKeys, isEphemeralMode } from './shared/jwt/signer.js';

async function main(): Promise<void> {
  await initJwtKeys();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'cashfb api listening');
  });

  function shutdown(signal: string): void {
    logger.info({ signal }, 'shutting down');
    if (isEphemeralMode()) {
      const stats = ephemeralStats();
      logger.warn(
        { accessIssued: stats.accessIssued, refreshIssued: stats.refreshIssued },
        `[jwt] ephemeral keys: process served ${stats.accessIssued} auth sessions, ${stats.refreshIssued} refreshes.`,
      );
    }
    server.close(() => {
      logger.info('http closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('forced shutdown after 10s');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal boot error');
  process.exit(1);
});
