import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { metricsMiddleware } from './http.js';
import { httpRequestDurationSeconds, httpRequestsTotal, registry } from './registry.js';

/**
 * Phase 9 Chunk 3 — verify the HTTP middleware records duration +
 * count with the expected labels, and that unmatched routes fold
 * into the 'unmatched' sentinel so a 404-probing attacker can't
 * explode Prometheus label cardinality.
 */
describe('metricsMiddleware', () => {
  beforeEach(() => {
    httpRequestDurationSeconds.reset();
    httpRequestsTotal.reset();
  });

  it('records a matched handler with its route template', async () => {
    const app = express();
    app.use(metricsMiddleware());
    app.get('/widgets/:id', (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get('/widgets/42').expect(200);

    const text = await registry.metrics();
    expect(text).toMatch(
      /http_requests_total\{method="GET",route="\/widgets\/:id",status_code="200"\} 1/,
    );
  });

  it("tags unmatched requests with route='unmatched' to cap cardinality", async () => {
    const app = express();
    app.use(metricsMiddleware());

    await request(app).get('/nonexistent').expect(404);

    const text = await registry.metrics();
    expect(text).toMatch(
      /http_requests_total\{method="GET",route="unmatched",status_code="404"\} 1/,
    );
  });

  it('increments the count for repeated hits on the same label set', async () => {
    const app = express();
    app.use(metricsMiddleware());
    app.get('/a', (_req, res) => {
      res.sendStatus(204);
    });

    await request(app).get('/a').expect(204);
    await request(app).get('/a').expect(204);
    await request(app).get('/a').expect(204);

    const text = await registry.metrics();
    expect(text).toMatch(/http_requests_total\{method="GET",route="\/a",status_code="204"\} 3/);
  });
});
