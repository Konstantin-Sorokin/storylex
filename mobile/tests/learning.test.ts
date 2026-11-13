import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrate } from '../src/data/database.ts';
import { LearningRepository, migrateLearning, type LessonResult } from '../src/data/learning-repository.ts';
import { ContentRepository } from '../src/data/content-repository.ts';
import { lessonEntry, LessonRun } from '../src/domain/lesson-run.ts';
import { currentTask } from '../src/domain/lesson.ts';
import { ContentDownloader } from '../src/infrastructure/downloader.ts';
import { TestDatabase } from './sqlite.ts';
import { BASE, corrected, fixture, hash, server } from './fixtures.ts';

async function setup() {
  const content = new TestDatabase(); const local = new TestDatabase();
  await migrate(content); await migrateLearning(local);
  const f = await fixture(); const repository = new ContentRepository(content);
  await new ContentDownloader(repository, BASE, hash, server(f).fetcher).prepare();
  const pinned = await repository.pinLesson(f.source.product_id, f.source.lessons[0]!.id);
  return { content, local, f, repository, pinned, learning: new LearningRepository(local),
    close: () => { content.close(); local.close(); } };
}

async function respond(run: LessonRun, wrong = false) {
  const task = currentTask(run.session);
  if (task.kind === 'pairs') {
    for (const item of task.left) { run.pair('left', item.id); run.pair('right', item.id); }
  } else {
    const id = wrong ? task.question.options.find((option) => option.id !== task.question.correct_option_id)!.id : task.question.correct_option_id;
    await run.answer(id);
  }
}
async function reachLast(run: LessonRun) {
  while (run.session.index < 15) { await respond(run); run.next(); }
}

test('entry enforces lesson sequence and repeat access; completed restart skips congratulations and new earlier lessons keep later completions', async () => {
  const s = await setup();
  try {
    const first = s.pinned.context;
    const later = { ...first.lesson, id: 'later-lesson', position: 2 };
    const source = { ...first.source, lessons: [first.lesson, later] };
    const second = { ...first, source, lesson: later };
    assert.throws(() => lessonEntry(first, new Set(), 'unknown'), /режим/);
    assert.throws(() => lessonEntry(first, new Set(), 'repeat'), /после завершения/);
    assert.throws(() => lessonEntry(second, new Set()), /предыдущий/);
    assert.equal(lessonEntry({ ...first, source }, new Set()).nextId, later.id);
    assert.equal(lessonEntry(second, new Set([first.lesson.id])).alreadyCompleted, false);
    assert.equal(lessonEntry(first, new Set([first.lesson.id])).alreadyCompleted, true);
    assert.equal(lessonEntry(second, new Set([later.id]), 'repeat').mode, 'repeat');
    assert.equal(lessonEntry(second, new Set([later.id]), 'repeat').nextId, first.lesson.id);
  } finally { s.close(); }
});

test('last actual answer commits result BEFORE Continue; duplicate taps and ambiguous write retry preserve one original result', async () => {
  const s = await setup();
  try {
    let loseResponse = true;
    let calls = 0;
    const run = new LessonRun(s.pinned.context, 'lesson', async (result) => {
      calls++; await s.learning.save(result);
      if (loseResponse) throw new Error('Response lost after commit');
    });
    await reachLast(run);
    assert.equal((await s.learning.completed(s.f.source.product_id)).size, 0);
    await respond(run);
    assert.equal(run.session.finished, true); assert.equal(run.saveState, 'error');
    assert.ok((await s.learning.completed(s.f.source.product_id)).has(run.context.lesson.id));
    const committed = await s.local.getFirstAsync<{ result_json: string }>('SELECT result_json FROM lesson_results');
    assert.ok(committed);
    loseResponse = false;
    await Promise.all([run.persist(), run.persist(), respond(run)]);
    assert.equal(run.saveState, 'saved'); assert.equal(calls, 2);
    assert.deepEqual(await s.local.getFirstAsync('SELECT result_json FROM lesson_results'), committed);
    assert.equal((await s.local.getFirstAsync<{ n: number }>('SELECT count(*) n FROM lesson_results'))?.n, 1);
    run.next(); assert.equal(run.session.index, 15);
  } finally { s.close(); }
});

test('failed final write stays retryable, never marks lesson completed, and corrections must finish before persistence', async () => {
  const s = await setup();
  try {
    const run = new LessonRun(s.pinned.context, 'lesson', (result) => s.learning.save(result));
    while (run.session.index < 16) {
      await respond(run, true);
      if (run.session.index === 15) assert.equal(run.saveState, 'idle');
      run.next();
    }
    while (run.session.index < 20) { await respond(run, true); run.next(); }
    s.local.failOn = 'INSERT INTO lesson_results';
    await respond(run, true);
    assert.equal(run.session.finished, true); assert.equal(run.saveState, 'error');
    assert.equal((await s.learning.completed(s.f.source.product_id)).size, 0);
    assert.equal(run.session.tasks.length, 21);
    s.local.failOn = null;
    await run.persist(); assert.equal(run.saveState, 'saved');
    const row = await s.local.getFirstAsync<{ result_json: string }>('SELECT result_json FROM lesson_results');
    assert.equal(JSON.parse(row!.result_json).taskCount, 21);
  } finally { s.close(); }
});

test('unfinished process stores nothing; repeat writes nothing and preserves the original completion and result', async () => {
  const s = await setup();
  try {
    const unfinished = new LessonRun(s.pinned.context, 'lesson', (result) => s.learning.save(result));
    for (let i = 0; i < 9; i++) { await respond(unfinished); unfinished.next(); }
    assert.equal((await s.learning.completed(s.f.source.product_id)).size, 0);
    const restarted = new LessonRun(s.pinned.context, 'lesson', (result) => s.learning.save(result));
    assert.equal(restarted.session.index, 0);
    await reachLast(restarted); await respond(restarted);
    const original = await s.local.getFirstAsync('SELECT * FROM lesson_results');
    const repeat = new LessonRun(s.pinned.context, 'repeat', () => { throw new Error('Repeat must not write'); });
    while (!repeat.session.finished) { await respond(repeat, true); if (!repeat.session.finished) repeat.next(); }
    assert.equal(repeat.saveState, 'idle');
    assert.deepEqual(await s.local.getFirstAsync('SELECT * FROM lesson_results'), original);
  } finally { s.close(); }
});

test('leaving during a question, feedback, pairs or corrections persists no completion; reopening SQLite starts the lesson from the beginning offline', async () => {
  const s = await setup();
  const directory = mkdtempSync(join(tmpdir(), 'storylex-unfinished-'));
  try {
    for (const phase of ['question', 'feedback', 'pairs', 'correction'] as const) {
      const path = join(directory, `${phase}.db`);
      let db = new TestDatabase(path);
      try {
        await migrateLearning(db);
        const learning = new LearningRepository(db);
        const pin = await s.repository.pinLesson(s.f.source.product_id, s.f.source.lessons[0]!.id);
        const run = new LessonRun(pin.context, 'lesson', (result) => learning.save(result));
        const index = phase === 'pairs' ? 12 : phase === 'correction' ? 16 : 9;
        while (run.session.index < index) { await respond(run, phase === 'correction'); run.next(); }
        if (phase === 'feedback') await respond(run);
        if (phase === 'pairs') {
          const task = currentTask(run.session); assert.ok(task.kind === 'pairs');
          run.pair('left', task.left[0]!.id); run.pair('right', task.left[0]!.id);
          assert.equal(run.session.pairs.matched.length, 1);
        }
        assert.equal(run.session.finished, false);
        await run.persist(); // even an explicit request cannot save a partial run
        await pin.release(); // same cleanup as leaving the lesson screen
        db.close(); db = new TestDatabase(path);
        await migrateLearning(db);
        const reopened = new LearningRepository(db);
        const completed = await reopened.completed(run.context.productId);
        assert.equal(completed.size, 0, phase);
        assert.equal((await db.getFirstAsync<{ n: number }>('SELECT count(*) n FROM lesson_results'))?.n, 0, phase);
        const newPin = await s.repository.pinLesson(run.context.productId, run.context.lesson.id);
        const entry = lessonEntry(newPin.context, completed);
        assert.equal(entry.alreadyCompleted, false);
        const restarted = new LessonRun(newPin.context, entry.mode, (result) => reopened.save(result));
        assert.equal(restarted.session.index, 0, phase);
        assert.deepEqual(restarted.session.answers, []);
        assert.deepEqual(restarted.session.mistakes, {});
        assert.deepEqual(restarted.session.pairs.matched, []);
        assert.equal(restarted.session.feedback, null);
        assert.equal(restarted.session.tasks.length, 16);
        assert.equal(restarted.saveState, 'idle');
        await newPin.release();
      } finally { db.close(); }
    }
  } finally { s.close(); rmSync(directory, { recursive: true }); }
});

test('completed results survive close/reopen, idempotent migrations, package changes and independent product identities', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storylex-learning-'));
  const path = join(directory, 'local.db');
  let db = new TestDatabase(path);
  const s = await setup();
  try {
    await migrateLearning(db);
    const learning = new LearningRepository(db);
    const run = new LessonRun(s.pinned.context, 'lesson', (result) => learning.save(result));
    await reachLast(run); await respond(run);
    db.close(); db = new TestDatabase(path); await migrateLearning(db); await migrateLearning(db);
    const reopened = new LearningRepository(db);
    assert.ok((await reopened.completed(run.context.productId)).has(run.context.lesson.id));
    assert.equal((await reopened.completed('different-product')).size, 0);
    const stored = await db.getFirstAsync<{ result_json: string }>('SELECT result_json FROM lesson_results');
    const result = JSON.parse(stored!.result_json) as LessonResult;
    await reopened.save({ ...result, revisionId: 'new-revision', completedAt: 'different-time' });
    assert.deepEqual(await db.getFirstAsync('SELECT result_json FROM lesson_results'), stored);
    await assert.rejects(reopened.save({ ...result, taskCount: 15 }), /Неполный/);
    await db.execAsync('PRAGMA user_version = 99');
    await assert.rejects(migrateLearning(db), /новой версией/);
    assert.deepEqual(await db.getFirstAsync('SELECT result_json FROM lesson_results'), stored);
  } finally { db.close(); s.close(); rmSync(directory, { recursive: true }); }
});

test('package update is ready while lesson is pinned, release activates atomically, result retains pinned old revision', async () => {
  const s = await setup();
  try {
    const secondPin = await s.repository.pinLesson(s.f.source.product_id, s.f.source.lessons[0]!.id);
    const run = new LessonRun(s.pinned.context, 'lesson', (result) => s.learning.save(result));
    await respond(run); run.next();
    const next = await fixture(corrected(s.f.source), 2);
    await new ContentDownloader(s.repository, BASE, hash, server(next).fetcher).prepare();
    assert.deepEqual(await s.repository.activeManifest(s.f.source.product_id), s.f.manifest);
    assert.deepEqual(run.context.source, s.f.source);
    await s.pinned.release(); await s.pinned.release();
    assert.deepEqual(await s.repository.activeManifest(s.f.source.product_id), s.f.manifest);
    await reachLast(run); await respond(run);
    const row = await s.local.getFirstAsync<{ revision_id: string }>('SELECT revision_id FROM lesson_results');
    assert.equal(row?.revision_id, s.f.manifest.revision_id);
    await secondPin.release();
    assert.deepEqual(await s.repository.activeManifest(s.f.source.product_id), next.manifest);
    assert.deepEqual(await s.repository.document(s.f.source.product_id, s.f.source.section_id), next.source);
    assert.ok((await s.learning.completed(s.f.source.product_id)).has(s.f.source.lessons[0]!.id));
  } finally { s.close(); }
});

test('restart recovers prepared revision without network, rejects missing/disabled lessons, migration from content v1 keeps cached chapter', async () => {
  const s = await setup();
  try {
    // Recreate exactly the previous v1 layout with existing cached content.
    await s.content.execAsync('DROP TABLE ready_packages; PRAGMA user_version = 1;');
    await migrate(s.content);
    assert.deepEqual(await s.repository.document(s.f.source.product_id, s.f.source.section_id), s.f.source);
    const next = await fixture(corrected(s.f.source), 2);
    await new ContentDownloader(s.repository, BASE, hash, server(next).fetcher).prepare();
    // A new repository represents a restarted process: no in-memory active lesson.
    const restarted = new ContentRepository(s.content);
    await restarted.activateReady();
    assert.deepEqual(await restarted.activeManifest(s.f.source.product_id), next.manifest);
    await assert.rejects(restarted.pinLesson(s.f.source.product_id, 'unknown-lesson'), /не загружен/);
    next.catalog.products[0]!.trial_enabled = false;
    await restarted.saveCatalog(next.catalog);
    await assert.rejects(restarted.pinLesson(s.f.source.product_id, s.f.source.lessons[0]!.id), /недоступен/);
  } finally { s.close(); }
});

test('failed ready activation rolls back active pointer and keeps prepared package for retry', async () => {
  const s = await setup();
  try {
    const next = await fixture(corrected(s.f.source), 2);
    await new ContentDownloader(s.repository, BASE, hash, server(next).fetcher).prepare();
    s.content.failOn = 'DELETE FROM ready_packages';
    await assert.rejects(s.pinned.release(), /disk failure/);
    assert.deepEqual(await s.repository.activeManifest(s.f.source.product_id), s.f.manifest);
    assert.equal((await s.content.getFirstAsync<{ revision_id: string }>('SELECT revision_id FROM ready_packages'))?.revision_id, next.manifest.revision_id);
    s.content.failOn = null;
    await s.repository.activateReady();
    assert.deepEqual(await s.repository.activeManifest(s.f.source.product_id), next.manifest);
  } finally { s.close(); }
});

test('opening a cached lesson rejects unsupported engine or corrupt source without changing results or discarding content', async () => {
  const s = await setup();
  try {
    await s.content.runAsync('UPDATE package_versions SET manifest = ?', JSON.stringify({ ...s.f.manifest, lesson_engine_version: 2 }));
    await assert.rejects(s.repository.pinLesson(s.f.source.product_id, s.f.source.lessons[0]!.id), /версия|верси/);
    await s.content.runAsync('UPDATE package_versions SET manifest = ?', JSON.stringify(s.f.manifest));
    await s.content.runAsync('UPDATE document_blobs SET json = ?', '{}');
    await assert.rejects(s.repository.pinLesson(s.f.source.product_id, s.f.source.lessons[0]!.id), /формат/);
    assert.equal((await s.learning.completed(s.f.source.product_id)).size, 0);
    assert.equal((await s.content.getFirstAsync<{ n: number }>('SELECT count(*) n FROM package_versions'))?.n, 1);
  } finally { s.close(); }
});
