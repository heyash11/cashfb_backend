import mongoose from 'mongoose';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { ephemeralStats, initJwtKeys, isEphemeralMode } from './shared/jwt/signer.js';
import { installProcessHandlers } from './shared/process-handlers.js';

async function main(): Promise<void> {
  installProcessHandlers();
  await initJwtKeys();

  await mongoose.connect(env.MONGO_URI);
  logger.info('[api] mongo connected');

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
      mongoose
        .disconnect()
        .then(() => {
          logger.info('[api] mongo disconnected');
          process.exit(0);
        })
        .catch((err: unknown) => {
          logger.error({ err }, '[api] mongo disconnect failed');
          process.exit(1);
        });
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
