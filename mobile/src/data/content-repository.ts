import type { Catalog, Manifest, Source } from '../domain/content.ts';
import { parseCatalog, parseManifest, parseSource, requireValid } from '../domain/validation.ts';
import type { Database } from './database.ts';
import type { LessonContext } from '../domain/lesson-run.ts';

export class ContentRepository {
  private readonly db: Database;
  private readonly pins = new Map<string, number>();

  constructor(db: Database) { this.db = db; }

  async catalog(): Promise<Catalog | null> {
    const row = await this.db.getFirstAsync<{ json: string }>('SELECT json FROM catalog_state WHERE id = 1');
    return row ? parseCatalog(JSON.parse(row.json)) : null;
  }

  async saveCatalog(catalog: Catalog): Promise<void> {
    parseCatalog(catalog);
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      await tx.runAsync('INSERT INTO catalog_state (id, revision_id, json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision_id=excluded.revision_id, json=excluded.json', catalog.catalog_revision, JSON.stringify(catalog));
    });
  }

  async blob(hash: string): Promise<{ text: string; byteSize: number } | null> {
    const row = await this.db.getFirstAsync<{ json: string; byte_size: number }>('SELECT json, byte_size FROM document_blobs WHERE sha256 = ?', hash);
    return row ? { text: row.json, byteSize: row.byte_size } : null;
  }

  async saveBlob(hash: string, byteSize: number, text: string): Promise<void> {
    // Only downloader-verified immutable bytes reach this method.
    await this.db.runAsync('INSERT INTO document_blobs (sha256, byte_size, json) VALUES (?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET byte_size=excluded.byte_size, json=excluded.json', hash, byteSize, text);
  }

  async activeManifest(productId: string): Promise<Manifest | null> {
    const row = await this.db.getFirstAsync<{ manifest: string }>(
      `SELECT v.manifest FROM package_versions v JOIN active_packages a
       ON v.product_id = a.product_id AND v.revision_id = a.revision_id AND v.scope = a.scope
       WHERE a.product_id = ? AND a.scope = 'trial'`, productId);
    return row ? parseManifest(JSON.parse(row.manifest)) : null;
  }

  async activate(manifest: Manifest, documents: Source[]): Promise<void> {
    parseManifest(manifest);
    requireValid(manifest.scope === 'trial' && manifest.documents.length === documents.length);
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<{ json: string }>('SELECT json FROM catalog_state WHERE id = 1');
      const catalog = row ? parseCatalog(JSON.parse(row.json)) : null;
      const product = catalog?.products.find((entry) => entry.id === manifest.product_id);
      requireValid(product && product.revision_id === manifest.revision_id);
      requireValid(product.trial_enabled && product.availability === 'available');
      await tx.runAsync('INSERT INTO package_versions (product_id, revision_id, scope, manifest) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', manifest.product_id, manifest.revision_id, manifest.scope, JSON.stringify(manifest));
      for (let index = 0; index < documents.length; index++) {
        const document = documents[index];
        const descriptor = manifest.documents[index];
        requireValid(document && descriptor);
        parseSource(document);
        requireValid(document.product_id === manifest.product_id && document.section_id === descriptor.section_id);
        requireValid(document.lessons.map((lesson) => lesson.id).join() === descriptor.lesson_ids.join());
        const blob = await tx.getFirstAsync<{ json: string }>('SELECT json FROM document_blobs WHERE sha256 = ?', descriptor.sha256);
        requireValid(blob && JSON.stringify(JSON.parse(blob.json)) === JSON.stringify(document));
        await tx.runAsync('INSERT INTO package_documents (product_id, revision_id, scope, artifact_id, sha256) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', manifest.product_id, manifest.revision_id, manifest.scope, descriptor.artifact_id, descriptor.sha256);
        for (const lesson of document.lessons) {
          await tx.runAsync('INSERT INTO lesson_index (product_id, revision_id, scope, lesson_id, section_id, position, sha256) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', manifest.product_id, manifest.revision_id, manifest.scope, lesson.id, document.section_id, lesson.position, descriptor.sha256);
        }
      }
      const table = this.pins.has(manifest.product_id) ? 'ready_packages' : 'active_packages';
      await tx.runAsync(`INSERT INTO ${table} (product_id, scope, revision_id) VALUES (?, ?, ?) ON CONFLICT(product_id, scope) DO UPDATE SET revision_id=excluded.revision_id`, manifest.product_id, manifest.scope, manifest.revision_id);
      if (table === 'active_packages') await tx.runAsync('DELETE FROM ready_packages WHERE product_id = ? AND scope = ?', manifest.product_id, manifest.scope);
    });
  }

  async document(productId: string, sectionId: string | null): Promise<Source | null> {
    const catalog = await this.catalog();
    const product = catalog?.products.find((entry) => entry.id === productId);
    if (!product?.trial_enabled || product.availability !== 'available') return null;
    const row = await this.db.getFirstAsync<{ json: string }>(
      `SELECT b.json FROM document_blobs b JOIN lesson_index l ON l.sha256 = b.sha256
       JOIN active_packages a ON a.product_id = l.product_id AND a.revision_id = l.revision_id AND a.scope = l.scope
       WHERE a.product_id = ? AND a.scope = 'trial' AND l.section_id IS ? LIMIT 1`, productId, sectionId);
    return row ? parseSource(JSON.parse(row.json)) : null;
  }

  async pinLesson(productId: string, lessonId: string): Promise<{ context: LessonContext; release: () => Promise<void> }> {
    this.pins.set(productId, (this.pins.get(productId) ?? 0) + 1);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      const count = (this.pins.get(productId) ?? 1) - 1;
      if (count > 0) { this.pins.set(productId, count); return; }
      this.pins.delete(productId);
      await this.activateReady(productId);
    };
    try {
      const snapshot: { context?: LessonContext } = {};
      // Use the same serialized writer as activation. An already-running update
      // commits before this snapshot; later updates see the in-memory pin.
      await this.db.withExclusiveTransactionAsync(async (tx) => {
        const catalogRow = await tx.getFirstAsync<{ json: string }>('SELECT json FROM catalog_state WHERE id = 1');
        const product = catalogRow ? parseCatalog(JSON.parse(catalogRow.json)).products.find((entry) => entry.id === productId) : null;
        requireValid(product?.trial_enabled && product.availability === 'available', 'Пробный урок недоступен.');
        const row = await tx.getFirstAsync<{ json: string; revision_id: string; manifest: string }>(
          `SELECT b.json, a.revision_id, v.manifest FROM lesson_index l
           JOIN active_packages a ON a.product_id = l.product_id AND a.revision_id = l.revision_id AND a.scope = l.scope
           JOIN package_versions v ON v.product_id = a.product_id AND v.revision_id = a.revision_id AND v.scope = a.scope
           JOIN document_blobs b ON b.sha256 = l.sha256
           WHERE a.product_id = ? AND a.scope = 'trial' AND l.lesson_id = ?`, productId, lessonId);
        requireValid(row, 'Урок не загружен. Обновите материалы в настройках.');
        const manifest = parseManifest(JSON.parse(row.manifest));
        const source = parseSource(JSON.parse(row.json));
        const lesson = source.lessons.find((entry) => entry.id === lessonId);
        requireValid(lesson && source.product_id === productId);
        requireValid(manifest.product_id === productId && manifest.revision_id === row.revision_id && manifest.scope === 'trial');
        requireValid(manifest.documents.some((document) => document.section_id === source.section_id && document.lesson_ids.includes(lessonId)));
        snapshot.context = { productId, revisionId: row.revision_id, source, lesson };
      });
      requireValid(snapshot.context);
      return { context: snapshot.context, release };
    } catch (error) { await release(); throw error; }
  }

  async activateReady(productId?: string): Promise<void> {
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      const rows = await tx.getAllAsync<{ product_id: string; revision_id: string; scope: string }>(
        'SELECT product_id, revision_id, scope FROM ready_packages' + (productId ? ' WHERE product_id = ?' : ''),
        ...(productId ? [productId] : []));
      for (const row of rows) {
        if (this.pins.has(row.product_id)) continue;
        const catalogRow = await tx.getFirstAsync<{ json: string }>('SELECT json FROM catalog_state WHERE id = 1');
        const product = catalogRow ? parseCatalog(JSON.parse(catalogRow.json)).products.find((entry) => entry.id === row.product_id) : null;
        if (product?.revision_id !== row.revision_id || !product.trial_enabled || product.availability !== 'available') continue;
        await tx.runAsync(`INSERT INTO active_packages (product_id, scope, revision_id) VALUES (?, ?, ?)
          ON CONFLICT(product_id, scope) DO UPDATE SET revision_id=excluded.revision_id`, row.product_id, row.scope, row.revision_id);
        await tx.runAsync('DELETE FROM ready_packages WHERE product_id = ? AND scope = ?', row.product_id, row.scope);
      }
    });
  }
}
