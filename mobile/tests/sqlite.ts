import { DatabaseSync } from 'node:sqlite';
import type { Bind, Database, SqlExecutor } from '../src/data/database.ts';

export class TestDatabase implements Database {
  readonly native: DatabaseSync;
  failOn: string | null = null;
  constructor(path = ':memory:') { this.native = new DatabaseSync(path); }
  async execAsync(sql: string) { this.native.exec(sql); }
  async runAsync(sql: string, ...params: Bind[]) {
    if (this.failOn && sql.includes(this.failOn)) throw new Error('Simulated disk failure');
    return this.native.prepare(sql).run(...params);
  }
  async getFirstAsync<T>(sql: string, ...params: Bind[]): Promise<T | null> {
    return (this.native.prepare(sql).get(...params) as T | undefined) ?? null;
  }
  async getAllAsync<T>(sql: string, ...params: Bind[]): Promise<T[]> {
    return this.native.prepare(sql).all(...params) as T[];
  }
  async withExclusiveTransactionAsync(task: (transaction: SqlExecutor) => Promise<void>): Promise<void> {
    this.native.exec('BEGIN IMMEDIATE');
    try {
      await task(this);
      this.native.exec('COMMIT');
    } catch (error) {
      this.native.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.native.close(); }
}
