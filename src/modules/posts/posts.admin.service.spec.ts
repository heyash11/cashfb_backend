import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { PostModel } from '../../shared/models/Post.model.js';
import { MODELS } from '../../shared/models/index.js';
import { AdminPostService } from './posts.admin.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('AdminPostService', () => {
  it('create: persists post with schema defaults and actor as createdBy', async () => {
    const admin = new Types.ObjectId();
    const svc = new AdminPostService();

    const post = await svc.create(
      {
        title: 'Today Post',
        dayKey: '2026-04-23',
        scheduledAt: new Date('2026-04-23T12:00:00Z'),
      },
      admin,
    );

    expect(post.title).toBe('Today Post');
    expect(post.status).toBe('DRAFT');
    expect(post.coinReward).toBe(1);
    expect(post.tier).toBe('PUBLIC');
    expect(String(post.createdBy)).toBe(String(admin));
  });

  it('create: respects provided status + coinReward + description', async () => {
    const admin = new Types.ObjectId();
    const svc = new AdminPostService();

    const post = await svc.create(
      {
        title: 'Live Post',
        description: 'with description',
        dayKey: '2026-04-23',
        scheduledAt: new Date('2026-04-23T12:00:00Z'),
        status: 'LIVE',
        coinReward: 5,
      },
      admin,
    );

    expect(post.status).toBe('LIVE');
    expect(post.coinReward).toBe(5);
    expect(post.description).toBe('with description');
  });

  it('update: patches fields and returns the post', async () => {
    const admin = new Types.ObjectId();
    const svc = new AdminPostService();
    const created = await svc.create(
      {
        title: 'Before',
        dayKey: '2026-04-23',
        scheduledAt: new Date(),
      },
      admin,
    );

    const updated = await svc.update(created._id, { title: 'After', status: 'LIVE' }, admin);

    expect(updated?.title).toBe('After');
    expect(updated?.status).toBe('LIVE');
  });

  it('update: returns null for non-existent post', async () => {
    const svc = new AdminPostService();
    const result = await svc.update(new Types.ObjectId(), { title: 'X' }, new Types.ObjectId());
    expect(result).toBeNull();
  });

  it('delete: removes the post and returns true', async () => {
    const admin = new Types.ObjectId();
    const svc = new AdminPostService();
    const created = await svc.create(
      { title: 'To Delete', dayKey: '2026-04-23', scheduledAt: new Date() },
      admin,
    );

    const result = await svc.delete(created._id, admin);
    expect(result).toBe(true);
    expect(await PostModel.findById(created._id)).toBeNull();
  });

  it('delete: returns false for non-existent post', async () => {
    const svc = new AdminPostService();
    const result = await svc.delete(new Types.ObjectId(), new Types.ObjectId());
    expect(result).toBe(false);
  });

  it('listByDate: filters by dayKey plus optional status', async () => {
    const admin = new Types.ObjectId();
    const svc = new AdminPostService();
    await svc.create({ title: 'A', dayKey: '2026-04-22', scheduledAt: new Date() }, admin);
    await svc.create(
      { title: 'B', dayKey: '2026-04-22', scheduledAt: new Date(), status: 'LIVE' },
      admin,
    );
    await svc.create({ title: 'C', dayKey: '2026-04-23', scheduledAt: new Date() }, admin);

    const all = await svc.listByDate('2026-04-22');
    expect(all).toHaveLength(2);

    const live = await svc.listByDate('2026-04-22', 'LIVE');
    expect(live).toHaveLength(1);
    expect(live[0]?.title).toBe('B');
  });
});
