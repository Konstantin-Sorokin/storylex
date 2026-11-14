import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContentRepository } from '../src/data/content-repository.ts';
import { migrate } from '../src/data/database.ts';
import { AccountRepository, migrateAccount } from '../src/data/account-repository.ts';
import { ContentDownloader } from '../src/infrastructure/downloader.ts';
import { devSession, SyncCoordinator } from '../src/infrastructure/sync.ts';
import { LessonRun } from '../src/domain/lesson-run.ts';
import { currentTask } from '../src/domain/lesson.ts';
import { TestDatabase } from './sqlite.ts';
import { hash } from './fixtures.ts';

test('real Django publication -> offline runner -> reopen -> lost POST response -> retry -> second device union', {
  skip: !process.env.STORYLEX_TEST_SYNC_URL,
}, async () => {
  const base = process.env.STORYLEX_TEST_SYNC_URL!;
  const token = process.env.STORYLEX_TEST_SYNC_TOKEN!;
  const userId = await devSession(base, token);
  const dir = mkdtempSync(join(tmpdir(), 'storylex-live-sync-'));
  const contentDb = new TestDatabase(join(dir, 'content.db'));
  let accountDb = new TestDatabase(join(dir, 'account.db'));
  const secondDb = new TestDatabase();
  const coordinators: SyncCoordinator[] = [];
  try {
    await migrate(contentDb);
    const content = new ContentRepository(contentDb);
    assert.deepEqual(await new ContentDownloader(content, base, hash).prepare(), []);
    const catalog = await content.catalog(); const product = catalog?.products[0]; assert.ok(product);
    const manifest = await content.activeManifest(product.id); assert.ok(manifest);
    const device = await migrateAccount(accountDb, userId, randomUUID());
    let repo = new AccountRepository(accountDb, userId, device, randomUUID);
    const ids = manifest.documents.flatMap((d) => d.lesson_ids); assert.ok(ids.length >= 2);
    const pin = await content.pinLesson(product.id, ids[0]!);
    const run = new LessonRun(pin.context, 'lesson', (result) => repo.save(result));
    // No network path exists between the runner and its SQLite commit.
    while (!run.session.finished) {
      const task = currentTask(run.session);
      if (task.kind === 'pairs') for (const item of task.left) { run.pair('left', item.id); run.pair('right', item.id); }
      else await run.answer(task.question.correct_option_id);
      if (!run.session.finished) run.next();
    }
    assert.equal(run.saveState, 'saved'); const original = await repo.pending(); assert.equal(original.length, 1);
    await pin.release(); accountDb.close(); accountDb = new TestDatabase(join(dir, 'account.db'));
    assert.equal(await migrateAccount(accountDb, userId, randomUUID()), device);
    repo = new AccountRepository(accountDb, userId, device, randomUUID);
    assert.deepEqual(await repo.pending(), original); assert.ok((await repo.completed(product.id)).has(ids[0]!));
    let lose = true;
    const losingFetch: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/sync/operations') && lose) {
        assert.equal(response.status, 200); await response.text(); lose = false;
        throw new Error('lost real HTTP response after commit');
      }
      return response;
    };
    const sync = new SyncCoordinator(repo, base, () => token, () => {}, losingFetch); coordinators.push(sync);
    await assert.rejects(sync.sync(), /lost real/); assert.deepEqual(await repo.pending(), original);
    await sync.sync(); assert.equal((await repo.pending()).length, 0); assert.equal(await repo.cursor(), '1');
    const otherDevice = await migrateAccount(secondDb, userId, randomUUID());
    const other = new AccountRepository(secondDb, userId, otherDevice, randomUUID);
    const syncOther = new SyncCoordinator(other, base, () => token); coordinators.push(syncOther);
    await syncOther.sync(); assert.ok((await other.completed(product.id)).has(ids[0]!));
    const secondPin = await content.pinLesson(product.id, ids[1]!);
    await other.save({ productId: product.id, lessonId: ids[1]!, sectionId: secondPin.context.source.section_id,
      revisionId: manifest.revision_id, completedAt: new Date().toISOString(), taskCount: 16, answers: Array(15).fill({}) });
    await secondPin.release(); await syncOther.sync(); await sync.sync();
    assert.deepEqual(await repo.completed(product.id), new Set(ids));
    assert.deepEqual(await other.completed(product.id), new Set(ids));
    assert.equal(await repo.cursor(), '2'); assert.equal(await other.cursor(), '2');
  } finally {
    for (const sync of coordinators) await sync.stop();
    accountDb.close(); secondDb.close(); contentDb.close(); rmSync(dir, { recursive: true });
  }
});
