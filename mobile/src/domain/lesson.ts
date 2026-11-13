import type { LearningItem, Lesson, Question } from './content.ts';

export type ExerciseType = keyof LearningItem['exercises'];
export type Mode = 'lesson' | 'repeat';
export type ChoiceTask = { kind: 'choice'; item: LearningItem; type: ExerciseType; question: Question; corrective: boolean };
export type PairsTask = { kind: 'pairs'; left: LearningItem[]; right: LearningItem[] };
export type Task = ChoiceTask | PairsTask;
export type Answer = { exerciseId: string; itemId: string; type: ExerciseType; optionId: string; correct: boolean; corrective: boolean };
export type PairState = { left: string | null; right: string | null; matched: string[]; wrong: boolean };
export type Session = {
  mode: Mode;
  lesson: Lesson;
  tasks: Task[];
  index: number;
  feedback: { correct: boolean } | null;
  answers: Answer[];
  mistakes: Partial<Record<string, ExerciseType>>;
  pairs: PairState;
  finished: boolean;
};
export type Random = () => number;
const types: ExerciseType[] = ['word_to_translation', 'context_en_to_ru', 'context_ru_to_en'];
const emptyPairs = (): PairState => ({ left: null, right: null, matched: [], wrong: false });

export function shuffle<T>(values: readonly T[], random: Random): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    const a = result[index];
    const b = result[other];
    if (a === undefined || b === undefined) throw new Error('Некорректная перестановка.');
    result[index] = b;
    result[other] = a;
  }
  return result;
}

function seededRandom(seed: string): Random {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function choice(item: LearningItem, type: ExerciseType, random: Random, corrective = false): ChoiceTask {
  const question = item.exercises[type];
  if (question.options.length !== 4 || !question.options.some((option) => option.id === question.correct_option_id)) {
    throw new Error('Некорректные варианты ответа.');
  }
  return { kind: 'choice', item, type, corrective, question: { ...question, options: shuffle(question.options, random) } };
}

export function createSession(lesson: Lesson, revisionId: string, mode: Mode = 'lesson', random: Random = Math.random): Session {
  if (lesson.items.length !== 5 || new Set(lesson.items.map((item) => item.id)).size !== 5) {
    throw new Error('В уроке должно быть пять разных учебных единиц.');
  }
  const tasks: Task[] = [];
  if (mode === 'repeat') {
    for (const item of shuffle(lesson.items, random)) {
      tasks.push(choice(item, random() < 0.5 ? 'context_ru_to_en' : 'context_en_to_ru', random));
    }
  } else {
    const items = shuffle(lesson.items, seededRandom(lesson.id + revisionId));
    // W1 W2 R1 W3 R2 W4 R3 W5 R4 E1 R5 E2 PAIRS E3 E4 E5.
    // Item order is stable for a revision; option positions are fresh per attempt.
    const schedule: [number, ExerciseType][] = [
      [0, 'word_to_translation'], [1, 'word_to_translation'], [0, 'context_ru_to_en'],
      [2, 'word_to_translation'], [1, 'context_ru_to_en'], [3, 'word_to_translation'],
      [2, 'context_ru_to_en'], [4, 'word_to_translation'], [3, 'context_ru_to_en'],
      [0, 'context_en_to_ru'], [4, 'context_ru_to_en'], [1, 'context_en_to_ru'],
      [2, 'context_en_to_ru'], [3, 'context_en_to_ru'], [4, 'context_en_to_ru'],
    ];
    schedule.forEach(([index, type], position) => {
      if (position === 12) tasks.push({ kind: 'pairs', left: shuffle(lesson.items, random), right: shuffle(lesson.items, random) });
      const item = items[index];
      if (!item) throw new Error('Неполный урок.');
      tasks.push(choice(item, type, random));
    });
  }
  return { mode, lesson, tasks, index: 0, feedback: null, answers: [], mistakes: {}, pairs: emptyPairs(), finished: false };
}

export function currentTask(session: Session): Task {
  const task = session.tasks[session.index];
  if (!task) throw new Error('Задание отсутствует.');
  return task;
}

function finishTask(session: Session, correct: boolean, random: Random): Session {
  let tasks = session.tasks;
  if (session.mode === 'lesson' && session.index === 15 && tasks.length === 16) {
    const corrections = session.lesson.items.flatMap((item) => {
      const type = session.mistakes[item.id];
      return type ? [choice(item, type, random, true)] : [];
    });
    const last = currentTask(session);
    if (corrections.length > 1 && last.kind === 'choice' && corrections[0]?.item.id === last.item.id) {
      const first = corrections.shift();
      if (first) corrections.push(first);
    }
    tasks = [...tasks, ...corrections];
  }
  return { ...session, tasks, feedback: { correct }, finished: session.index === tasks.length - 1 };
}

export function answerChoice(session: Session, optionId: string, random: Random = Math.random): Session {
  if (session.feedback || session.finished) return session;
  const task = currentTask(session);
  if (task.kind !== 'choice' || !task.question.options.some((option) => option.id === optionId)) {
    throw new Error('Ответ не относится к текущему заданию.');
  }
  const correct = optionId === task.question.correct_option_id;
  const mistakes = { ...session.mistakes };
  if (!correct && !task.corrective && session.mode === 'lesson') {
    const previous = mistakes[task.item.id];
    if (!previous || types.indexOf(task.type) > types.indexOf(previous)) mistakes[task.item.id] = task.type;
  }
  const answer: Answer = { exerciseId: task.question.id, itemId: task.item.id, type: task.type, optionId, correct, corrective: task.corrective };
  return finishTask({ ...session, mistakes, answers: [...session.answers, answer] }, correct, random);
}

export function selectPair(session: Session, side: 'left' | 'right', itemId: string): Session {
  if (session.feedback || session.finished || session.pairs.wrong) return session;
  const task = currentTask(session);
  if (task.kind !== 'pairs' || !task[side].some((item) => item.id === itemId)) throw new Error('Пара отсутствует.');
  if (session.pairs.matched.includes(itemId)) return session;
  const pairs = { ...session.pairs, [side]: itemId };
  if (pairs.left && pairs.right) {
    if (pairs.left !== pairs.right) return { ...session, pairs: { ...pairs, wrong: true } };
    pairs.matched = [...pairs.matched, itemId];
    pairs.left = null;
    pairs.right = null;
    const next = { ...session, pairs };
    return pairs.matched.length === 5 ? finishTask(next, true, Math.random) : next;
  }
  return { ...session, pairs };
}

export function clearPairError(session: Session): Session {
  return session.pairs.wrong ? { ...session, pairs: { ...session.pairs, left: null, right: null, wrong: false } } : session;
}

export function continueSession(session: Session): Session {
  if (!session.feedback || session.finished) return session;
  return { ...session, index: session.index + 1, feedback: null, pairs: emptyPairs() };
}

export function progress(session: Session): number {
  if (session.finished) return 1;
  const answered = session.index + (session.feedback ? 1 : 0);
  if (session.mode === 'repeat') return answered / 5;
  return answered <= 16 ? 0.8 * answered / 16 : 0.8 + 0.2 * (answered - 16) / (session.tasks.length - 16);
}
