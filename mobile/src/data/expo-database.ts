import { openDatabaseAsync } from 'expo-sqlite';
import type { Database } from './database.ts';

export async function openLocalDatabase(name: string): Promise<{ database: Database; close: () => Promise<void> }> {
  const reader = await openDatabaseAsync(name, { useNewConnection: true });
  try {
    await reader.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
    const writer = await openDatabaseAsync(name, { useNewConnection: true });
    try {
      await writer.execAsync('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    } catch (error) { await writer.closeAsync(); throw error; }
    // One serialized writer. Reads cannot accidentally join its transaction.
    let pending = Promise.resolve();
    function write<T>(operation: () => Promise<T>): Promise<T> {
      const next = pending.then(operation);
      pending = next.then(() => {}, () => {});
      return next;
    }
    const database: Database = {
      execAsync: (sql) => write(() => writer.execAsync(sql)),
      runAsync: (sql, ...params) => write(() => writer.runAsync(sql, ...params)),
      getFirstAsync: <T,>(sql: string, ...params: (string | number | null)[]) => reader.getFirstAsync<T>(sql, ...params),
      getAllAsync: <T,>(sql: string, ...params: (string | number | null)[]) => reader.getAllAsync<T>(sql, ...params),
      withExclusiveTransactionAsync: (task) => write(() => writer.withTransactionAsync(() => task(writer))),
    };
    return { database, close: async () => { await pending; await writer.closeAsync(); await reader.closeAsync(); } };
  } catch (error) { await reader.closeAsync(); throw error; }
}

export const openContentDatabase = () => openLocalDatabase('storylex-public-v1.db');
