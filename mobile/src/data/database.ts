// The subset of expo-sqlite used by repositories. Tests execute the same SQL
// against Node's built-in SQLite, without a mock query engine or extra driver.
export type Bind = string | number | null;
export interface SqlExecutor {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: Bind[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: Bind[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: Bind[]): Promise<T[]>;
}
export interface Database extends SqlExecutor {
  withExclusiveTransactionAsync(task: (transaction: SqlExecutor) => Promise<void>): Promise<void>;
}

const migrations = [
  `CREATE TABLE catalog_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     revision_id TEXT NOT NULL,
     json TEXT NOT NULL
   );
   CREATE TABLE document_blobs (
     sha256 TEXT PRIMARY KEY,
     byte_size INTEGER NOT NULL CHECK (byte_size > 0),
     json TEXT NOT NULL
   );
   CREATE TABLE package_versions (
     product_id TEXT NOT NULL,
     revision_id TEXT NOT NULL,
     scope TEXT NOT NULL CHECK (scope IN ('trial', 'full')),
     manifest TEXT NOT NULL,
     PRIMARY KEY (product_id, revision_id, scope)
   );
   CREATE TABLE package_documents (
     product_id TEXT NOT NULL,
     revision_id TEXT NOT NULL,
     scope TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     sha256 TEXT NOT NULL REFERENCES document_blobs(sha256),
     PRIMARY KEY (product_id, revision_id, scope, artifact_id),
     FOREIGN KEY (product_id, revision_id, scope) REFERENCES package_versions(product_id, revision_id, scope)
   );
   CREATE TABLE lesson_index (
     product_id TEXT NOT NULL,
     revision_id TEXT NOT NULL,
     scope TEXT NOT NULL,
     lesson_id TEXT NOT NULL,
     section_id TEXT,
     position INTEGER NOT NULL,
     sha256 TEXT NOT NULL REFERENCES document_blobs(sha256),
     PRIMARY KEY (product_id, revision_id, scope, lesson_id),
     FOREIGN KEY (product_id, revision_id, scope) REFERENCES package_versions(product_id, revision_id, scope)
   );
   CREATE TABLE active_packages (
     product_id TEXT NOT NULL,
     scope TEXT NOT NULL,
     revision_id TEXT NOT NULL,
     PRIMARY KEY (product_id, scope),
     FOREIGN KEY (product_id, revision_id, scope) REFERENCES package_versions(product_id, revision_id, scope)
   );`,
];

export async function migrate(db: Database): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  await db.withExclusiveTransactionAsync(async (tx) => {
    const row = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    const version = row?.user_version ?? 0;
    if (version > migrations.length) throw new Error('Обновите приложение: база данных создана более новой версией.');
    for (let index = version; index < migrations.length; index++) {
      const sql = migrations[index];
      if (sql === undefined) throw new Error('Миграция отсутствует.');
      await tx.execAsync(sql);
      await tx.execAsync(`PRAGMA user_version = ${index + 1}`);
    }
  });
}
