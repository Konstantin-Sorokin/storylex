import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/data/database.ts';
import { ContentRepository } from '../src/data/content-repository.ts';
import { ContentDownloader } from '../src/infrastructure/downloader.ts';
import { hash } from './fixtures.ts';
import { TestDatabase } from './sqlite.ts';

test('published Django HTTP -> hash/schema checks -> SQLite -> close/reopen -> offline chapter', {
  skip: !process.env.STORYLEX_TEST_API_URL,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storylex-live-'));
  const path = join(directory, 'content.db');
  let db = new TestDatabase(path);
  try {
    await migrate(db);
    const repository = new ContentRepository(db);
    assert.deepEqual(await new ContentDownloader(repository, process.env.STORYLEX_TEST_API_URL!, hash).prepare(), []);
    const catalog = await repository.catalog();
    const product = catalog?.products.find((entry) => entry.trial_enabled);
    assert.ok(product);
    const manifest = await repository.activeManifest(product.id);
    assert.ok(manifest?.documents[0]);
    const document = await repository.document(product.id, manifest.documents[0].section_id);
    assert.equal(document?.lessons.length, manifest.counts.lessons);
    db.close();
    db = new TestDatabase(path);
    await migrate(db);
    const offline = new ContentRepository(db);
    assert.deepEqual(await offline.document(product.id, manifest.documents[0].section_id), document);
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});
