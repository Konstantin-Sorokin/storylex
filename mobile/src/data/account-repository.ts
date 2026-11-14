import type { Database, SqlExecutor } from './database.ts';
import type { LessonResult } from './learning-repository.ts';
import type { ChangePage, CompletionOperation, CompletionState, Receipt } from '../domain/sync.ts';

export async function migrateAccount(db: Database, userId: string, newDeviceId: string): Promise<string> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  let device = '';
  await db.withExclusiveTransactionAsync(async (tx) => {
    const version = (await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    if (version > 1) throw new Error('Обновите приложение: персональная база создана более новой версией.');
    if (version === 0) await tx.execAsync(`
      CREATE TABLE account_state (id INTEGER PRIMARY KEY CHECK(id = 1), user_id TEXT NOT NULL,
        device_id TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, cursor TEXT NOT NULL DEFAULT '0', last_sync TEXT);
      CREATE TABLE lesson_completions (lesson_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
        result_json TEXT, confirmed_json TEXT, server_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE outbox (operation_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE,
        operation_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'acked', 'terminal')), receipt_json TEXT);
      PRAGMA user_version = 1;`);
    await tx.runAsync('INSERT INTO account_state (id, user_id, device_id) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING', userId, newDeviceId);
    const row = await tx.getFirstAsync<{ user_id: string; device_id: string }>('SELECT * FROM account_state WHERE id = 1');
    if (!row || row.user_id !== userId) throw new Error('Персональная база принадлежит другому аккаунту.');
    device = row.device_id;
  });
  return device;
}

async function merge(tx: SqlExecutor, state: CompletionState): Promise<void> {
  // Completion is a union. A stale pull cannot remove local pending results or
  // replace a newer confirmation from POST. Results keep their pinned revision.
  await tx.runAsync(`INSERT INTO lesson_completions (lesson_id, product_id, confirmed_json, server_revision)
    VALUES (?, ?, ?, ?) ON CONFLICT(lesson_id) DO UPDATE SET confirmed_json = excluded.confirmed_json,
    server_revision = excluded.server_revision WHERE excluded.server_revision > lesson_completions.server_revision`,
  state.lesson_id, state.product_id, JSON.stringify(state), state.revision);
}

export class AccountRepository {
  private readonly db: Database;
  readonly userId: string;
  readonly deviceId: string;
  private readonly uuid: () => string;
  private readonly changed: () => void;
  constructor(db: Database, userId: string, deviceId: string, uuid: () => string, changed = () => {}) {
    this.db = db; this.userId = userId; this.deviceId = deviceId; this.uuid = uuid; this.changed = changed;
  }
  async completed(productId: string): Promise<Set<string>> {
    return new Set((await this.db.getAllAsync<{ lesson_id: string }>('SELECT lesson_id FROM lesson_completions WHERE product_id = ?', productId)).map((row) => row.lesson_id));
  }
  async save(result: LessonResult): Promise<void> {
    if (result.taskCount < 16 || result.taskCount > 21 || result.answers.length !== result.taskCount - 1) throw new Error('Неполный результат урока нельзя сохранить.');
    const operationId = this.uuid();
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      if (await tx.getFirstAsync('SELECT lesson_id FROM lesson_completions WHERE lesson_id = ?', result.lessonId)) return;
      const row = await tx.getFirstAsync<{ sequence: number }>('SELECT sequence FROM account_state WHERE id = 1');
      if (!row || row.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Не удалось выделить номер операции.');
      const sequence = row.sequence + 1;
      const operation: CompletionOperation = { operation_id: operationId, sequence, type: 'lesson.complete', occurred_at: result.completedAt,
        payload: { product_id: result.productId, lesson_id: result.lessonId, content_revision_id: result.revisionId } };
      await tx.runAsync('INSERT INTO lesson_completions (lesson_id, product_id, result_json) VALUES (?, ?, ?)', result.lessonId, result.productId, JSON.stringify(result));
      await tx.runAsync('INSERT INTO outbox (operation_id, sequence, operation_json) VALUES (?, ?, ?)', operationId, sequence, JSON.stringify(operation));
      await tx.runAsync('UPDATE account_state SET sequence = ? WHERE id = 1', sequence);
    });
    this.changed();
  }
  async pending(): Promise<CompletionOperation[]> {
    return (await this.db.getAllAsync<{ operation_json: string }>("SELECT operation_json FROM outbox WHERE status = 'pending' ORDER BY sequence LIMIT 100")).map((row) => JSON.parse(row.operation_json) as CompletionOperation);
  }
  async acknowledge(operations: CompletionOperation[], receipts: Receipt[], active: () => boolean): Promise<void> {
    if (receipts.length !== operations.length || new Set(receipts.map((r) => r.operation_id)).size !== receipts.length) throw new Error('Неполные квитанции sync. Очередь сохранена.');
    const byId = new Map(operations.map((op) => [op.operation_id, op]));
    for (const receipt of receipts) {
      const op = byId.get(receipt.operation_id);
      if (!op || (receipt.status !== 'rejected' && (receipt.state.lesson_id !== op.payload.lesson_id || receipt.state.product_id !== op.payload.product_id || receipt.change_revision !== receipt.state.revision))) throw new Error('Квитанция не соответствует операции.');
    }
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      if (!active()) throw new Error('Контекст аккаунта закрыт.');
      for (const receipt of receipts) {
        if (receipt.status !== 'rejected') await merge(tx, receipt.state);
        await tx.runAsync('UPDATE outbox SET status = ?, receipt_json = ? WHERE operation_id = ? AND status = ?',
          receipt.status === 'rejected' ? 'terminal' : 'acked', JSON.stringify(receipt), receipt.operation_id, 'pending');
      }
    });
  }
  async cursor(): Promise<string> {
    return (await this.db.getFirstAsync<{ cursor: string }>('SELECT cursor FROM account_state WHERE id = 1'))?.cursor ?? '0';
  }
  async applyPage(page: ChangePage, after: string, through: string | null, active: () => boolean): Promise<void> {
    let last = BigInt(after);
    const top = BigInt(page.through_cursor);
    if (top < last || (through !== null && through !== page.through_cursor)) throw new Error('Изменилась граница sync.');
    for (const change of page.changes) {
      const position = BigInt(change.cursor);
      if (position !== last + 1n || position > top || change.id !== change.state.lesson_id || BigInt(change.state.revision) !== position) throw new Error('Неверный порядок изменений sync.');
      last = position;
    }
    if (String(last) !== page.next_cursor || page.has_more !== (last < top) || (page.has_more && page.changes.length === 0)) throw new Error('Некорректная страница sync.');
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      if (!active()) throw new Error('Контекст аккаунта закрыт.');
      const row = await tx.getFirstAsync<{ cursor: string }>('SELECT cursor FROM account_state WHERE id = 1');
      if (row?.cursor !== after) throw new Error('Курсор уже изменился.');
      for (const change of page.changes) await merge(tx, change.state);
      await tx.runAsync('UPDATE account_state SET cursor = ? WHERE id = 1', page.next_cursor);
    });
  }
  async finish(active: () => boolean): Promise<void> {
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      if (!active()) throw new Error('Контекст аккаунта закрыт.');
      const pending = await tx.getFirstAsync('SELECT operation_id FROM outbox WHERE status = ?', 'pending');
      if (!pending) await tx.runAsync('UPDATE account_state SET last_sync = ? WHERE id = 1', new Date().toISOString());
    });
  }
  async status(): Promise<{ pending: number; terminal: number; last_sync: string | null; codes: string[] }> {
    const rows = await this.db.getAllAsync<{ status: string; receipt_json: string | null }>("SELECT status, receipt_json FROM outbox WHERE status != 'acked'");
    return { pending: rows.filter((r) => r.status === 'pending').length, terminal: rows.filter((r) => r.status === 'terminal').length,
      last_sync: (await this.db.getFirstAsync<{ last_sync: string | null }>('SELECT last_sync FROM account_state WHERE id = 1'))?.last_sync ?? null,
      codes: rows.flatMap((r) => r.receipt_json ? [String((JSON.parse(r.receipt_json) as { code: string }).code)] : []) };
  }
}
