import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerChoice, clearPairError, continueSession, createSession, currentTask, progress, selectPair, type ExerciseType, type Session } from '../src/domain/lesson.ts';
import { fixture } from './fixtures.ts';

function completePairs(state: Session): Session {
  const task = currentTask(state);
  assert.equal(task.kind, 'pairs');
  if (task.kind !== 'pairs') throw new Error('Expected pairs');
  for (const item of task.right) {
    state = selectPair(state, 'right', item.id);
    state = selectPair(state, 'left', item.id);
  }
  return state;
}

function answer(state: Session, correct = true): Session {
  const task = currentTask(state);
  if (task.kind === 'pairs') return completePairs(state);
  const id = correct ? task.question.correct_option_id : task.question.options.find((option) => option.id !== task.question.correct_option_id)?.id;
  assert.ok(id);
  return answerChoice(state, id, () => 0.25);
}

test('scheduler has exactly W/R/E for each of 5 items, W first, stable order, no adjacent item, pairs at 13', async () => {
  const f = await fixture();
  const lesson = f.source.lessons[0]!;
  const before = JSON.stringify(lesson);
  const permutations = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const state = createSession(lesson, 'revision-' + index);
    assert.equal(state.tasks.length, 16);
    assert.equal(state.tasks[12]?.kind, 'pairs');
    const seen = new Map<string, ExerciseType[]>();
    let previous: string | null = null;
    for (const task of state.tasks) {
      if (task.kind === 'pairs') { previous = null; continue; }
      assert.notEqual(task.item.id, previous);
      const types = seen.get(task.item.id) ?? [];
      if (!types.length) assert.equal(task.type, 'word_to_translation');
      seen.set(task.item.id, [...types, task.type]); previous = task.item.id;
      assert.equal(task.question.options.length, 4);
      assert.ok(task.question.options.some((option) => option.id === task.question.correct_option_id));
    }
    assert.equal(seen.size, 5);
    for (const types of seen.values()) assert.deepEqual(new Set(types), new Set(['word_to_translation', 'context_ru_to_en', 'context_en_to_ru']));
    const signature = (s: Session) => s.tasks.map((t) => t.kind === 'pairs' ? 'pairs' : t.item.id + t.type);
    assert.deepEqual(signature(state), signature(createSession(lesson, 'revision-' + index)));
    permutations.add(JSON.stringify(signature(state)));
  }
  assert.ok(permutations.size > 5);
  assert.equal(JSON.stringify(lesson), before);
});

test('answer positions change per attempt, duplicate answers and premature Continue do not advance', async () => {
  const f = await fixture(); const lesson = f.source.lessons[0]!;
  let state = createSession(lesson, f.manifest.revision_id, 'lesson', () => 0.1);
  const other = createSession(lesson, f.manifest.revision_id, 'lesson', () => 0.9);
  const a = currentTask(state); const b = currentTask(other);
  assert.ok(a.kind === 'choice' && b.kind === 'choice');
  assert.notDeepEqual(a.question.options, b.question.options);
  assert.equal(continueSession(state), state);
  assert.throws(() => answerChoice(state, 'foreign-option'), /Ответ/);
  state = answer(state);
  assert.equal(state.index, 0);
  assert.equal(state.feedback?.correct, true);
  assert.equal(answerChoice(state, a.question.options[0]!.id), state);
  state = continueSession(state);
  assert.equal(state.index, 1); assert.equal(state.feedback, null);
  assert.throws(() => createSession({ ...lesson, items: lesson.items.slice(0, 4) }, 'rev'), /пять/);
});

test('pairs support either column first, selection replacement, transient errors, and progress counts the whole task once', async () => {
  const f = await fixture();
  let state = createSession(f.source.lessons[0]!, f.manifest.revision_id);
  while (currentTask(state).kind !== 'pairs') state = continueSession(answer(state));
  const task = currentTask(state); assert.ok(task.kind === 'pairs');
  const a = task.left[0]!.id; const b = task.left[1]!.id;
  const before = progress(state);
  state = selectPair(state, 'left', a);
  state = selectPair(state, 'left', b);
  assert.equal(state.pairs.left, b);
  state = selectPair(state, 'right', a);
  assert.equal(state.pairs.wrong, true);
  assert.equal(selectPair(state, 'right', b), state);
  state = clearPairError(state);
  assert.equal(state.pairs.left, null); assert.equal(state.pairs.right, null);
  assert.deepEqual(state.mistakes, {});
  state = selectPair(selectPair(state, 'right', a), 'left', a);
  assert.equal(progress(state), before);
  assert.equal(selectPair(state, 'left', a), state);
  for (const item of task.left.slice(1)) state = selectPair(selectPair(state, 'left', item.id), 'right', item.id);
  assert.equal(state.feedback?.correct, true); assert.equal(state.index, 12);
  assert.ok(Math.abs(progress(state) - before - 0.05) < 1e-10);
  assert.deepEqual(state.mistakes, {});
  assert.equal(continueSession(state).index, 13);
});

test('0..5 correction items produce 16..21 tasks; progress never retreats or hits 100% early, even when corrections are wrong', async () => {
  const f = await fixture(); const lesson = f.source.lessons[0]!;
  for (let count = 0; count <= 5; count++) {
    let state = createSession(lesson, f.manifest.revision_id);
    const wrong = new Set(lesson.items.slice(0, count).map((item) => item.id));
    let previous = 0;
    while (!state.finished) {
      const task = currentTask(state);
      const correct = task.kind === 'pairs' || !wrong.has(task.item.id);
      state = answer(state, correct);
      const next = progress(state);
      assert.ok(next >= previous); assert.equal(next === 1, state.finished);
      previous = next;
      if (!state.finished) state = continueSession(state);
    }
    assert.equal(state.tasks.length, 16 + count);
    assert.equal(state.answers.length, 15 + count);
    assert.equal(continueSession(state), state);
    assert.equal(state.answers.filter((entry) => entry.corrective).length, count);
    const corrective = state.tasks.slice(16);
    assert.equal(new Set(corrective.map((task) => task.kind === 'choice' ? task.item.id : '')).size, count);
    for (const task of corrective) assert.ok(task.kind === 'choice' && task.type === 'context_ru_to_en');
  }
});

test('correction repeats hardest WRONG question R > E > W, with fresh choices and no recursive practice', async () => {
  const f = await fixture(); const lesson = f.source.lessons[0]!;
  const wrongTypes: ExerciseType[] = ['word_to_translation', 'context_en_to_ru', 'context_ru_to_en'];
  let state = createSession(lesson, f.manifest.revision_id, 'lesson', () => 0.9);
  while (!state.finished) {
    const task = currentTask(state);
    const itemIndex = task.kind === 'choice' ? lesson.items.findIndex((item) => item.id === task.item.id) : -1;
    const shouldFail = task.kind === 'choice' && (task.corrective || (itemIndex < 3 && task.type === wrongTypes[itemIndex]));
    state = answer(state, !shouldFail);
    if (!state.finished) state = continueSession(state);
  }
  assert.equal(state.tasks.length, 19);
  for (const task of state.tasks.slice(16)) {
    assert.ok(task.kind === 'choice');
    const index = lesson.items.findIndex((item) => item.id === task.item.id);
    assert.equal(task.type, wrongTypes[index]);
    const original = state.tasks.find((entry) => entry.kind === 'choice' && entry.item.id === task.item.id && entry.type === task.type);
    assert.ok(original?.kind === 'choice');
    assert.notDeepEqual(original.question.options, task.question.options);
  }
});

test('short repeat has exactly 5 contextual questions, ignores all errors and starts fresh after abandonment', async () => {
  const f = await fixture(); const lesson = f.source.lessons[0]!;
  let state = createSession(lesson, f.manifest.revision_id, 'repeat');
  const original = state;
  assert.equal(new Set(state.tasks.map((task) => task.kind === 'choice' ? task.item.id : '')).size, 5);
  for (const task of state.tasks) assert.ok(task.kind === 'choice' && task.type !== 'word_to_translation');
  while (!state.finished) { state = answer(state, false); if (!state.finished) state = continueSession(state); }
  assert.equal(state.tasks.length, 5); assert.equal(state.answers.length, 5);
  assert.deepEqual(state.mistakes, {}); assert.equal(progress(state), 1);
  assert.equal(createSession(lesson, f.manifest.revision_id, 'repeat').index, 0);
  assert.equal(original.index, 0);
});
