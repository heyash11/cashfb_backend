import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('GET /health', () => {
  const app = createApp();

  it('returns 200 with the expected shape', async () => {
    const res = await request(app).get('/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(typeof res.body.ts).toBe('string');
    expect(Number.isFinite(res.body.uptime)).toBe(true);
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    expect(['development', 'test', 'production']).toContain(res.body.env);
  });
});
