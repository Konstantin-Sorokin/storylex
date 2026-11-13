import type { Database } from './database.ts';
import type { Answer } from '../domain/lesson.ts';

// Local development results only. Account completions + atomic outbox are stage 1.5.
// Keep these out of the shared public content database and future real accounts.
export type LessonResult = {
  productId: string;
  sectionId: string | null;
  lessonId: string;
  revisionId: string;
  completedAt: string;
  taskCount: number;
  answers: Answer[];
};

export async function migrateLearning(db: Database): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  await db.withExclusiveTransactionAsync(async (tx) => {
    const row = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    const version = row?.user_version ?? 0;
    if (version > 1) throw new Error('Обновите приложение: база результатов создана более новой версией.');
    if (version === 0) {
      await tx.execAsync(`CREATE TABLE lesson_results (
        product_id TEXT NOT NULL,
        lesson_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (product_id, lesson_id)
      ); PRAGMA user_version = 1;`);
    }
  });
}

export class LearningRepository {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }

  async completed(productId: string): Promise<Set<string>> {
    const rows = await this.db.getAllAsync<{ lesson_id: string }>('SELECT lesson_id FROM lesson_results WHERE product_id = ?', productId);
    return new Set(rows.map((row) => row.lesson_id));
  }

  async save(result: LessonResult): Promise<void> {
    if (result.taskCount < 16 || result.taskCount > 21 || result.answers.length !== result.taskCount - 1) {
      throw new Error('Неполный результат урока нельзя сохранить.');
    }
    // One atomic row contains both completed status and result. Retries preserve
    // the first committed revision/time/result, including an ambiguous response.
    await this.db.runAsync(`INSERT INTO lesson_results (product_id, lesson_id, revision_id, completed_at, result_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(product_id, lesson_id) DO NOTHING`,
    result.productId, result.lessonId, result.revisionId, result.completedAt, JSON.stringify(result));
  }
}
