import { openDatabaseAsync } from 'expo-sqlite';
import type { Database } from './database.ts';

export async function openContentDatabase(): Promise<{ database: Database; close: () => Promise<void> }> {
  const name = 'storylex-public-v1.db';
  const reader = await openDatabaseAsync(name, { useNewConnection: true });
  const database: Database = {
    execAsync: (sql) => reader.execAsync(sql),
    runAsync: (sql, ...params) => reader.runAsync(sql, ...params),
    getFirstAsync: <T,>(sql: string, ...params: (string | number | null)[]) => reader.getFirstAsync<T>(sql, ...params),
    getAllAsync: <T,>(sql: string, ...params: (string | number | null)[]) => reader.getAllAsync<T>(sql, ...params),
    async withExclusiveTransactionAsync(task) {
      // Foreign keys are connection-local and must be enabled BEFORE BEGIN.
      // A dedicated writer also keeps screen queries outside the transaction.
      const writer = await openDatabaseAsync(name, { useNewConnection: true });
      try {
        await writer.execAsync('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        await writer.withTransactionAsync(() => task(writer));
      } finally { await writer.closeAsync(); }
    },
  };
  return { database, close: () => reader.closeAsync() };
}
