import type { Lesson, Source } from './content.ts';
import { answerChoice, clearPairError, continueSession, createSession, selectPair, type Mode, type Random, type Session } from './lesson.ts';
import type { LessonResult } from '../data/learning-repository.ts';

export type LessonContext = { productId: string; revisionId: string; source: Source; lesson: Lesson };
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function lessonEntry(context: LessonContext, completed: ReadonlySet<string>, requestedMode?: string): {
  mode: Mode; alreadyCompleted: boolean; nextId: string | null;
} {
  if (requestedMode !== undefined && requestedMode !== 'repeat') throw new Error('Неизвестный режим урока.');
  const done = completed.has(context.lesson.id);
  if (requestedMode === 'repeat' && !done) throw new Error('Повторение доступно после завершения урока.');
  if (!done && context.source.lessons.some((lesson) => lesson.position < context.lesson.position && !completed.has(lesson.id))) {
    throw new Error('Сначала завершите предыдущий урок.');
  }
  return { mode: requestedMode === 'repeat' ? 'repeat' : 'lesson', alreadyCompleted: done && requestedMode !== 'repeat',
    nextId: context.source.lessons.find((lesson) => lesson.id !== context.lesson.id && !completed.has(lesson.id))?.id ?? null };
}

// Shared by the screen and tests: the last answer starts persistence immediately,
// without waiting for Continue, effects, navigation, or the summary screen.
export class LessonRun {
  session: Session;
  saveState: SaveState = 'idle';
  saveError: string | null = null;
  private pending: Promise<void> | null = null;
  private result: LessonResult | null = null;
  readonly context: LessonContext;
  private readonly save: (result: LessonResult) => Promise<void>;
  private readonly changed: () => void;
  private readonly random: Random;
  private readonly now: () => string;

  constructor(context: LessonContext, mode: Mode,
    save: (result: LessonResult) => Promise<void>,
    changed: () => void = () => {},
    random: Random = Math.random,
    now: () => string = () => new Date().toISOString()) {
    this.context = context;
    this.save = save;
    this.changed = changed;
    this.random = random;
    this.now = now;
    this.session = createSession(context.lesson, context.revisionId, mode, random);
  }

  answer(optionId: string): Promise<void> {
    this.session = answerChoice(this.session, optionId, this.random);
    this.changed();
    return this.persist();
  }

  pair(side: 'left' | 'right', itemId: string): void {
    this.session = selectPair(this.session, side, itemId);
    this.changed();
  }

  clearPairError(): void { this.session = clearPairError(this.session); this.changed(); }
  next(): void { this.session = continueSession(this.session); this.changed(); }

  persist(): Promise<void> {
    if (!this.session.finished || this.session.mode === 'repeat' || this.saveState === 'saved') return Promise.resolve();
    if (this.pending) return this.pending;
    this.result ??= { productId: this.context.productId, sectionId: this.context.source.section_id,
      lessonId: this.context.lesson.id, revisionId: this.context.revisionId, completedAt: this.now(),
      taskCount: this.session.tasks.length, answers: this.session.answers };
    this.saveState = 'saving';
    this.saveError = null;
    this.changed();
    const result = this.result;
    this.pending = Promise.resolve().then(() => this.save(result)).then(() => {
      this.saveState = 'saved';
    }).catch((error: unknown) => {
      this.saveState = 'error';
      this.saveError = error instanceof Error ? error.message : 'Ошибка записи SQLite.';
    }).finally(() => { this.pending = null; this.changed(); });
    return this.pending;
  }
}
