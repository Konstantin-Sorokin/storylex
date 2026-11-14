import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AccountRepository, migrateAccount } from '../src/data/account-repository.ts';
import { LearningRepository, migrateLearning, type LessonResult } from '../src/data/learning-repository.ts';
import { parsePage, parseReceipts, type CompletionOperation, type CompletionState, type Receipt } from '../src/domain/sync.ts';
import { SyncCoordinator } from '../src/infrastructure/sync.ts';
import { TestDatabase } from './sqlite.ts';
import { fixture } from './fixtures.ts';
import { LessonRun } from '../src/domain/lesson-run.ts';
import { currentTask } from '../src/domain/lesson.ts';

const BASE = 'http://sync.test/api/v1/';
const date = '2026-01-01T12:00:00Z';
async function setup(path?: string, userId: string = randomUUID()) {
  const db = new TestDatabase(path);
  const device = await migrateAccount(db, userId, randomUUID());
  const repo = new AccountRepository(db, userId, device, randomUUID);
  const f = await fixture();
  const result: LessonResult = { productId: f.source.product_id, lessonId: f.source.lessons[0]!.id,
    sectionId: f.source.section_id, revisionId: f.manifest.revision_id, completedAt: date, taskCount: 16, answers: Array(15).fill({}) };
  return { db, repo, result, f };
}
function state(op: CompletionOperation, revision = 1): CompletionState {
  return { product_id: op.payload.product_id, lesson_id: op.payload.lesson_id, completed: true, trial_revision: op.payload.content_revision_id,
    client_completed_at: op.occurred_at, accepted_at: date, revision };
}
function receipt(op: CompletionOperation, revision = 1): Receipt {
  return { operation_id: op.operation_id, status: 'applied', state: state(op, revision), change_revision: revision };
}
function fakeServer(userId: string) {
  let lose = false; let offline = false; let posts = 0; let failPull = false;
  const inbox = new Map<string, Receipt>(); const states = new Map<string, CompletionState>();
  const fetcher: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    if (offline) throw new Error('offline');
    if (u.pathname.endsWith('/dev/session')) return Response.json({ user_id: userId });
    if (u.pathname.endsWith('/operations')) {
      posts++;
      const body = JSON.parse(String(init?.body)) as { operations: CompletionOperation[] };
      const results = body.operations.map((op) => {
        const known = inbox.get(op.operation_id); if (known) return known;
        const existing = states.get(op.payload.lesson_id);
        const r: Receipt = existing ? { operation_id: op.operation_id, status: 'noop', state: existing, change_revision: existing.revision } : receipt(op, states.size + 1);
        inbox.set(op.operation_id, r); if (r.status !== 'rejected') states.set(op.payload.lesson_id, r.state);
        return r;
      });
      if (lose) { lose = false; throw new Error('lost response after server commit'); }
      return Response.json({ results, server_time: date });
    }
    if (u.pathname.endsWith('/changes')) {
      if (failPull) throw new Error('pull interrupted');
      const after = Number(u.searchParams.get('after') ?? 0);
      const through = Number(u.searchParams.get('through_cursor') ?? states.size);
      const changes = [...states.values()].filter((s) => s.revision > after && s.revision <= through).map((s) => ({ cursor: String(s.revision), entity: 'lesson_completion', id: s.lesson_id, state: s }));
      return Response.json({ changes, next_cursor: String(through), through_cursor: String(through), has_more: false });
    }
    throw new Error('unexpected request');
  };
  return { fetcher, inbox, states, posts: () => posts, lose: () => { lose = true; }, offline: (v: boolean) => { offline = v; }, failPull: (v: boolean) => { failPull = v; } };
}

test('last runner answer commits account completion + outbox before Continue; repeat does not enqueue', async () => {
  const s = await setup();
  try {
    const context = { productId: s.result.productId, revisionId: s.result.revisionId, source: s.f.source, lesson: s.f.source.lessons[0]! };
    const run = new LessonRun(context, 'lesson', (result) => s.repo.save(result));
    while (!run.session.finished) {
      const task = currentTask(run.session);
      if (task.kind === 'pairs') for (const item of task.left) { run.pair('left', item.id); run.pair('right', item.id); }
      else await run.answer(task.question.correct_option_id);
      if (!run.session.finished) run.next();
    }
    assert.equal(run.saveState, 'saved'); assert.equal(run.session.index, 15);
    assert.equal((await s.repo.pending()).length, 1);
    assert.equal((await s.repo.completed(s.result.productId)).size, 1);
    await run.persist(); await s.repo.save(s.result); assert.equal((await s.repo.pending()).length, 1);
    const repeat = new LessonRun(context, 'repeat', () => { throw new Error('repeat must not save'); });
    while (!repeat.session.finished) {
      const task = currentTask(repeat.session); assert.ok(task.kind === 'choice');
      await repeat.answer(task.question.correct_option_id); if (!repeat.session.finished) repeat.next();
    }
    assert.equal((await s.repo.pending()).length, 1);
  } finally { s.db.close(); }
});

test('disk failure rolls back completion, sequence and outbox together; retry succeeds', async () => {
  const s = await setup();
  try {
    s.db.failOn = 'INSERT INTO outbox'; await assert.rejects(s.repo.save(s.result), /disk/);
    assert.equal((await s.repo.completed(s.result.productId)).size, 0); assert.equal((await s.repo.pending()).length, 0);
    assert.equal((await s.db.getFirstAsync<{ sequence: number }>('SELECT sequence FROM account_state'))?.sequence, 0);
    s.db.failOn = null; await s.repo.save(s.result); assert.equal((await s.repo.pending())[0]?.sequence, 1);
  } finally { s.db.close(); }
});

test('completion and operation survive process restart; old dev results stay separate; account mismatch and future schema preserve data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'storylex-sync-')); const path = join(dir, 'account.db');
  const s = await setup(path); const old = new TestDatabase();
  try {
    await migrateLearning(old); await new LearningRepository(old).save(s.result);
    assert.equal((await s.repo.completed(s.result.productId)).size, 0);
    await s.repo.save(s.result); const operations = await s.repo.pending();
    s.db.close(); const db = new TestDatabase(path);
    try {
      const device = await migrateAccount(db, s.repo.userId, randomUUID());
      const repo = new AccountRepository(db, s.repo.userId, device, randomUUID);
      assert.equal(device, s.repo.deviceId); assert.deepEqual(await repo.pending(), operations);
      assert.equal((await repo.completed(s.result.productId)).size, 1);
      await assert.rejects(migrateAccount(db, randomUUID(), randomUUID()), /другому/);
      await db.execAsync('PRAGMA user_version = 99');
      await assert.rejects(migrateAccount(db, s.repo.userId, randomUUID()), /новой/);
      assert.deepEqual(await repo.pending(), operations);
    } finally { db.close(); }
    assert.equal((await new LearningRepository(old).completed(s.result.productId)).size, 1);
  } finally { old.close(); rmSync(dir, { recursive: true }); }
});

test('offline and lost response replay exact command; interrupted pull retains cursor and resumes', async () => {
  const s = await setup(); const server = fakeServer(s.repo.userId);
  const sync = new SyncCoordinator(s.repo, BASE, () => 'token', () => {}, server.fetcher);
  try {
    await s.repo.save(s.result); const ops = await s.repo.pending();
    server.offline(true); await assert.rejects(sync.sync(), /offline/); assert.deepEqual(await s.repo.pending(), ops);
    server.offline(false); server.lose(); await assert.rejects(sync.sync(), /lost response/);
    assert.deepEqual(await s.repo.pending(), ops); assert.equal(server.states.size, 1);
    server.failPull(true); await assert.rejects(sync.sync(), /pull interrupted/);
    assert.equal((await s.repo.pending()).length, 0); assert.equal(await s.repo.cursor(), '0');
    assert.equal((await s.repo.status()).last_sync, null);
    server.failPull(false); await sync.sync();
    assert.equal(await s.repo.cursor(), '1'); assert.equal(server.inbox.size, 1); assert.ok((await s.repo.status()).last_sync);
  } finally { await sync.stop(); s.db.close(); }
});

test('two clients merge completions without erasing pending local results', async () => {
  const a = await setup(); const b = await setup(undefined, a.repo.userId); const server = fakeServer(a.repo.userId);
  const sa = new SyncCoordinator(a.repo, BASE, () => 't', () => {}, server.fetcher);
  const sb = new SyncCoordinator(b.repo, BASE, () => 't', () => {}, server.fetcher);
  try {
    const later = { ...a.result, lessonId: randomUUID() };
    await a.repo.save(a.result); await b.repo.save(later); await sb.sync(); await sa.sync(); await sb.sync();
    assert.deepEqual(await a.repo.completed(a.result.productId), new Set([a.result.lessonId, later.lessonId]));
    assert.deepEqual(await b.repo.completed(a.result.productId), await a.repo.completed(a.result.productId));
    assert.equal(server.states.size, 2); assert.equal(await a.repo.cursor(), '2'); assert.equal(await b.repo.cursor(), '2');
  } finally { await sa.stop(); await sb.stop(); a.db.close(); b.db.close(); }
});

test('stale pull preserves newer POST state; failed page rolls back cursor; malformed boundary is rejected', async () => {
  const s = await setup();
  try {
    await s.repo.save(s.result); const ops = await s.repo.pending(); const op = ops[0]!;
    await s.repo.acknowledge(ops, [receipt(op, 2)], () => true);
    const page = parsePage({ changes: [{ cursor: '1', entity: 'lesson_completion', id: op.payload.lesson_id, state: { ...state(op), trial_revision: null } }], next_cursor: '1', through_cursor: '2', has_more: true });
    s.db.failOn = 'UPDATE account_state SET cursor';
    await assert.rejects(s.repo.applyPage(page, '0', null, () => true), /disk/); assert.equal(await s.repo.cursor(), '0');
    s.db.failOn = null; await s.repo.applyPage(page, '0', null, () => true);
    const stored = await s.db.getFirstAsync<{ confirmed_json: string; result_json: string }>('SELECT * FROM lesson_completions');
    assert.equal(JSON.parse(stored!.confirmed_json).revision, 2); assert.equal(JSON.parse(stored!.result_json).revisionId, s.result.revisionId);
    await assert.rejects(s.repo.applyPage({ ...page, through_cursor: '3' }, '1', '2', () => true), /граница/);
    assert.equal(await s.repo.cursor(), '1');
  } finally { s.db.close(); }
});

test('terminal rejection is retained for diagnostics and does not erase completion or block later operation', async () => {
  const s = await setup();
  try {
    await s.repo.save(s.result); await s.repo.save({ ...s.result, lessonId: randomUUID() }); const ops = await s.repo.pending();
    await s.repo.acknowledge(ops, [{ operation_id: ops[0]!.operation_id, status: 'rejected', code: 'invalid_completion' }, receipt(ops[1]!)], () => true);
    const status = await s.repo.status(); assert.equal(status.pending, 0); assert.equal(status.terminal, 1);
    assert.deepEqual(status.codes, ['invalid_completion']); assert.equal((await s.repo.completed(s.result.productId)).size, 2);
  } finally { s.db.close(); }
});

test('invalid receipts and failed acknowledgement leave queue unchanged; closed context cannot commit', async () => {
  const s = await setup();
  try {
    await s.repo.save(s.result); const ops = await s.repo.pending(); const r = receipt(ops[0]!);
    assert.throws(() => parseReceipts({ results: [{ ...r, state: { completed: false } }], server_time: date }));
    assert.throws(() => parsePage({ changes: [], next_cursor: 1 }));
    await assert.rejects(s.repo.acknowledge(ops, [], () => true), /Неполные/);
    await assert.rejects(s.repo.acknowledge(ops, [{ ...r, operation_id: randomUUID() }], () => true), /соответствует/);
    s.db.failOn = 'UPDATE outbox'; await assert.rejects(s.repo.acknowledge(ops, [r], () => true), /disk/);
    assert.equal((await s.repo.pending()).length, 1);
    assert.equal((await s.db.getFirstAsync<{ confirmed_json: string | null }>('SELECT confirmed_json FROM lesson_completions'))?.confirmed_json, null);
    s.db.failOn = null; await assert.rejects(s.repo.acknowledge(ops, [r], () => false), /закрыт/);
    assert.equal((await s.repo.pending()).length, 1);
  } finally { s.db.close(); }
});

test('401, wrong account and unsupported response preserve pending operations', async () => {
  const s = await setup();
  try {
    await s.repo.save(s.result); const ops = await s.repo.pending();
    const unsupported: typeof fetch = async (url) => String(url).endsWith('/dev/session') ? Response.json({ user_id: s.repo.userId }) : Response.json({ results: [{ operation_id: ops[0]!.operation_id, status: 'new_protocol' }], server_time: date });
    for (const fetcher of [async () => new Response('', { status: 401 }), async () => Response.json({ user_id: randomUUID() }), unsupported]) {
      const sync = new SyncCoordinator(s.repo, BASE, () => 't', () => {}, fetcher);
      await assert.rejects(sync.sync()); assert.deepEqual(await s.repo.pending(), ops); await sync.stop();
    }
  } finally { s.db.close(); }
});

test('coordinator serializes concurrent triggers and discards a delayed response after stop', async () => {
  const s = await setup(); const server = fakeServer(s.repo.userId);
  try {
    await s.repo.save(s.result); let release: (() => void) | undefined;
    const delayed: typeof fetch = async (url, init) => {
      const response = await server.fetcher(url, init);
      if (String(url).endsWith('/operations')) await new Promise<void>((resolve) => { release = resolve; });
      return response;
    };
    const sync = new SyncCoordinator(s.repo, BASE, () => 't', () => {}, delayed);
    const first = sync.sync(); const second = sync.sync(); assert.equal(first, second);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    const stopped = sync.stop(); release(); await assert.rejects(first, /закрыт/); await stopped;
    assert.equal((await s.repo.pending()).length, 1); assert.equal(await s.repo.cursor(), '0'); assert.equal(server.posts(), 1);
  } finally { s.db.close(); }
});

test('SIGKILL after last answer commit, without closing SQLite or Continue, preserves completion and one command', async () => {
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'storylex-kill-')); const path = join(dir, 'account.db');
  const userId = randomUUID();
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT; // Child is an application, not a test worker.
  const child = spawn(process.execPath, ['tests/crash-sync-child.ts', path, userId], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  try {
    let output = '';
    const committed = await new Promise<{ productId: string; lessonId: string; deviceId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child did not commit: ' + stderr)), 15000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Child exited before SIGKILL: ' + stderr)); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.trim()) as { productId: string; lessonId: string; deviceId: string }); }
      });
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGKILL'); assert.equal(await exited, 'SIGKILL');
    const db = new TestDatabase(path);
    try {
      const deviceId = await migrateAccount(db, userId, randomUUID()); assert.equal(deviceId, committed.deviceId);
      const repo = new AccountRepository(db, userId, deviceId, randomUUID);
      assert.ok((await repo.completed(committed.productId)).has(committed.lessonId));
      assert.equal((await repo.pending()).length, 1); assert.equal((await repo.pending())[0]!.payload.lesson_id, committed.lessonId);
    } finally { db.close(); }
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true }); }
});
