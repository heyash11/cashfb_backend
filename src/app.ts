import express, { type Express, type Request, type Response } from 'express';
import { env } from './config/env.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      ts: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      env: env.NODE_ENV,
    });
  });

  return app;
}
