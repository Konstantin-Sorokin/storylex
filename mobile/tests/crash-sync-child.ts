// A disposable child process killed by sync.test.ts after SQLite commit.
import { randomUUID } from 'node:crypto';
import { AccountRepository, migrateAccount } from '../src/data/account-repository.ts';
import { LessonRun } from '../src/domain/lesson-run.ts';
import { currentTask } from '../src/domain/lesson.ts';
import { TestDatabase } from './sqlite.ts';
import { fixture } from './fixtures.ts';

const [path, userId] = process.argv.slice(2);
if (!path || !userId) throw new Error('Missing test arguments');
const db = new TestDatabase(path);
const deviceId = await migrateAccount(db, userId, randomUUID());
const repo = new AccountRepository(db, userId, deviceId, randomUUID);
const f = await fixture();
const run = new LessonRun({ productId: f.source.product_id, revisionId: f.manifest.revision_id, source: f.source, lesson: f.source.lessons[0]! },
  'lesson', (result) => repo.save(result));
while (!run.session.finished) {
  const task = currentTask(run.session);
  if (task.kind === 'pairs') for (const item of task.left) { run.pair('left', item.id); run.pair('right', item.id); }
  else await run.answer(task.question.correct_option_id);
  if (!run.session.finished) run.next();
}
process.stdout.write(JSON.stringify({ productId: f.source.product_id, lessonId: f.source.lessons[0]!.id, deviceId }) + '\n');
setInterval(() => {}, 1000); // Parent SIGKILLs us without close/checkpoint/Continue.
