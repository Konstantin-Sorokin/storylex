import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrate } from '../src/data/database.ts';
import { ContentRepository } from '../src/data/content-repository.ts';
import { ContentDownloader, verifyText } from '../src/infrastructure/downloader.ts';
import { parseCatalog, parseManifest, parseSource } from '../src/domain/validation.ts';
import { TestDatabase } from './sqlite.ts';
import { BASE, corrected, fixture, hash, server } from './fixtures.ts';

test('clean migration, repeated migration and close/reopen preserve actual chapter and lesson UUIDs offline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storylex-mobile-'));
  const path = join(directory, 'content.db');
  let db = new TestDatabase(path);
  try {
    await migrate(db);
    const f = await fixture();
    const repository = new ContentRepository(db);
    const http = server(f);
    assert.deepEqual(await new ContentDownloader(repository, BASE, hash, http.fetcher).prepare(), []);
    assert.equal(http.calls.length, 5);
    db.close();
    db = new TestDatabase(path);
    await migrate(db);
    const offline = new ContentRepository(db);
    assert.deepEqual(await offline.catalog(), f.catalog);
    assert.deepEqual(await offline.document(f.source.product_id, f.source.section_id), f.source);
    assert.deepEqual(await offline.activeManifest(f.source.product_id), f.manifest);
    assert.equal(await db.getFirstAsync('PRAGMA user_version').then((row) => JSON.stringify(row)), '{"user_version":2}');
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});

test('future database version is refused without deleting data', async () => {
  const db = new TestDatabase();
  try {
    await migrate(db);
    await db.execAsync("INSERT INTO catalog_state VALUES (1, 'keep', '{}'); PRAGMA user_version = 99;");
    await assert.rejects(migrate(db), /Обновите приложение/);
    assert.equal((await db.getFirstAsync<{ revision_id: string }>('SELECT revision_id FROM catalog_state'))?.revision_id, 'keep');
  } finally { db.close(); }
});

test('foreign keys prevent an active package without a complete package version', async () => {
  const db = new TestDatabase();
  try {
    await migrate(db);
    await assert.rejects(db.runAsync("INSERT INTO active_packages VALUES ('missing', 'trial', 'missing')"), /FOREIGN KEY/);
  } finally { db.close(); }
});

test('hash, size, Unicode and malformed source are checked before activation', async () => {
  const f = await fixture();
  await verifyText(f.text, f.descriptor, hash);
  await assert.rejects(verifyText(f.text + ' ', f.descriptor, hash));
  await assert.rejects(verifyText(f.text, { ...f.descriptor, sha256: '0'.repeat(64) }, hash));
  const wrong = structuredClone(f.source);
  wrong.lessons[0]!.items.pop();
  assert.throws(() => parseSource(wrong));
  const answer = structuredClone(f.source);
  answer.lessons[0]!.items[0]!.exercises.context_ru_to_en.correct_option_id = f.source.product_id;
  assert.throws(() => parseSource(answer));
  const duplicate = structuredClone(f.source);
  duplicate.lessons[0]!.items[1]!.id = duplicate.lessons[0]!.items[0]!.id;
  assert.throws(() => parseSource(duplicate));
  assert.throws(() => parseManifest({ ...f.manifest, lesson_engine_version: 2 }));
  assert.throws(() => parseCatalog({ ...f.catalog, schema_version: 2 }));
});

test('corrupt or incompatible catalogue keeps previous catalogue and active chapter', async () => {
  const db = new TestDatabase();
  try {
    await migrate(db);
    const repository = new ContentRepository(db);
    const first = await fixture();
    await new ContentDownloader(repository, BASE, hash, server(first).fetcher).prepare();
    const next = await fixture(corrected(first.source), 2);
    next.head.sha256 = '0'.repeat(64);
    await assert.rejects(new ContentDownloader(repository, BASE, hash, server(next).fetcher).prepare());
    assert.deepEqual(await repository.catalog(), first.catalog);
    assert.deepEqual(await repository.document(first.source.product_id, first.source.section_id), first.source);
    next.head.sha256 = await hash(next.catalogText);
    next.head.catalog_revision = first.catalog.catalog_revision;
    await assert.rejects(new ContentDownloader(repository, BASE, hash, server(next).fetcher).prepare());
    assert.deepEqual(await repository.catalog(), first.catalog);
    next.head.catalog_revision = next.catalog.catalog_revision;
    next.catalogText = JSON.stringify({ ...next.catalog, schema_version: 2 });
    next.head.sha256 = await hash(next.catalogText);
    next.head.byte_size = Buffer.byteLength(next.catalogText, 'utf8');
    await assert.rejects(new ContentDownloader(repository, BASE, hash, server(next).fetcher).prepare());
    assert.deepEqual(await repository.catalog(), first.catalog);
  } finally { db.close(); }
});

test('interrupted document request leaves old package, retry resumes and does not duplicate indices', async () => {
  const db = new TestDatabase();
  try {
    await migrate(db);
    const repository = new ContentRepository(db);
    const first = await fixture();
    await new ContentDownloader(repository, BASE, hash, server(first).fetcher).prepare();
    const next = await fixture(corrected(first.source), 2);
    const http = server(next);
    const downloader = new ContentDownloader(repository, BASE, hash, async (url, init) => {
      if (url.toString().includes('/content/artifacts/')) throw new Error('Network interrupted');
      return http.fetcher(url, init);
    });
    assert.equal((await downloader.prepare()).length, 1);
    assert.deepEqual(await repository.activeManifest(first.source.product_id), first.manifest);
    assert.deepEqual(await repository.document(first.source.product_id, first.source.section_id), first.source);
    const retry = new ContentDownloader(repository, BASE, hash, http.fetcher);
    assert.deepEqual(await retry.prepare(), []);
    assert.deepEqual(await retry.prepare(), []);
    assert.deepEqual(await repository.document(first.source.product_id, first.source.section_id), next.source);
    assert.equal((await db.getFirstAsync<{ n: number }>('SELECT count(*) n FROM active_packages'))?.n, 1);
    assert.equal((await db.getFirstAsync<{ n: number }>('SELECT count(*) n FROM lesson_index'))?.n, 2);
  } finally { db.close(); }
});

test('disk failure rolls back manifest, lesson indices and active pointer; verified blob survives and is reused', async () => {
  const db = new TestDatabase();
  try {
    await migrate(db);
    const repository = new ContentRepository(db);
    const first = await fixture();
    await new ContentDownloader(repository, BASE, hash, server(first).fetcher).prepare();
    const next = await fixture(corrected(first.source), 2);
    db.failOn = 'INSERT INTO lesson_index';
    assert.equal((await new ContentDownloader(repository, BASE, hash, server(next).fetcher).prepare()).length, 1);
    assert.deepEqual(await repository.activeManifest(first.source.product_id), first.manifest);
    assert.equal((await db.getFirstAsync<{ n: number }>('SELECT count(*) n FROM package_versions'))?.n, 1);
    assert.ok(await repository.blob(next.descriptor.sha256));
    db.failOn = null;
    const http = server(next);
    assert.deepEqual(await new ContentDownloader(repository, BASE, hash, http.fetcher).prepare(), []);
    assert.equal(http.calls.some((url) => url.includes('artifacts') || url.includes('downloads')), false);
    assert.deepEqual(await repository.activeManifest(first.source.product_id), next.manifest);
  } finally { db.close(); }
});

test('source identity, lesson list, hash, schema and full scope mismatches never replace working package', async () => {
  const db = new TestDatabase();
  try {
    await migrate(db);
    const repository = new ContentRepository(db);
    const first = await fixture();
    await new ContentDownloader(repository, BASE, hash, server(first).fetcher).prepare();
    for (const mutate of [
      (next: Awaited<ReturnType<typeof fixture>>) => { next.descriptor.sha256 = '0'.repeat(64); },
      (next: Awaited<ReturnType<typeof fixture>>) => { next.manifest.scope = 'full'; },
      (next: Awaited<ReturnType<typeof fixture>>) => { next.descriptor.lesson_ids = [first.source.product_id]; },
      (next: Awaited<ReturnType<typeof fixture>>) => { next.text = '{}'; },
      (next: Awaited<ReturnType<typeof fixture>>) => {
        next.text = JSON.stringify({ ...next.source, lessons: [] });
        next.descriptor.sha256 = '';
      },
    ]) {
      const next = await fixture(corrected(first.source), 2);
      mutate(next);
      if (next.descriptor.sha256 === '') {
        next.descriptor.sha256 = await hash(next.text);
        next.descriptor.byte_size = Buffer.byteLength(next.text, 'utf8');
      }
      assert.equal((await new ContentDownloader(repository, BASE, hash, server(next).fetcher).prepare()).length, 1);
      assert.deepEqual(await repository.activeManifest(first.source.product_id), first.manifest);
    }
  } finally { db.close(); }
});

test('duplicate preparation shares one request sequence; completed package is not re-downloaded on retry', async () => {
  const db = new TestDatabase();
  try {
    await migrate(db);
    const f = await fixture();
    const http = server(f);
    const downloader = new ContentDownloader(new ContentRepository(db), BASE, hash, http.fetcher);
    const one = downloader.prepare();
    const two = downloader.prepare();
    assert.equal(one, two);
    await Promise.all([one, two]);
    assert.equal(http.calls.length, 5);
    await downloader.prepare();
    assert.equal(http.calls.length, 6);
  } finally { db.close(); }
});

test('corrupt staging cache is repaired from verified download', async () => {
  const db = new TestDatabase();
  try {
    await migrate(db);
    const repository = new ContentRepository(db);
    const f = await fixture();
    await repository.saveBlob(f.descriptor.sha256, f.descriptor.byte_size, '{}');
    assert.deepEqual(await new ContentDownloader(repository, BASE, hash, server(f).fetcher).prepare(), []);
    assert.deepEqual(await repository.document(f.source.product_id, f.source.section_id), f.source);
  } finally { db.close(); }
});

test('unexpected URL origin and disabled local trial are blocked', async () => {
  const db = new TestDatabase();
  try {
    await migrate(db);
    const repository = new ContentRepository(db);
    const f = await fixture();
    f.head.url = 'http://other.test/secret';
    await assert.rejects(new ContentDownloader(repository, BASE, hash, server(f).fetcher).prepare(), /Недопустимый адрес/);
    f.head.url = BASE + 'catalog/revisions/' + f.catalog.catalog_revision;
    await new ContentDownloader(repository, BASE, hash, server(f).fetcher).prepare();
    f.catalog.products[0]!.trial_enabled = false;
    await repository.saveCatalog(f.catalog);
    assert.equal(await repository.document(f.source.product_id, f.source.section_id), null);
  } finally { db.close(); }
});
