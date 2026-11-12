import type { Catalog, FileDescriptor, Manifest, Product, Source } from '../domain/content.ts';
import { parseCatalog, parseDownloads, parseHead, parseManifest, parseSource, requireValid } from '../domain/validation.ts';
import type { ContentRepository } from '../data/content-repository.ts';

export type HashText = (text: string) => Promise<string>;
export type Fetch = typeof fetch;
const MAX_BYTES = 10 * 1024 * 1024;

export function utf8Size(text: string): number {
  let size = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
}

export async function verifyText(text: string, descriptor: FileDescriptor, hash: HashText): Promise<void> {
  requireValid(utf8Size(text) === descriptor.byte_size && await hash(text) === descriptor.sha256,
    'Проверка размера или SHA-256 не пройдена. Сохранённая глава доступна. Повторите загрузку.');
}

export class ContentDownloader {
  private readonly base: URL;
  private readonly repository: ContentRepository;
  private readonly hash: HashText;
  private readonly fetcher: Fetch;
  private running: Promise<string[]> | null = null;

  constructor(repository: ContentRepository, apiUrl: string,
    hash: HashText, fetcher: Fetch = fetch) {
    this.repository = repository;
    this.hash = hash;
    this.fetcher = fetcher;
    this.base = new URL(apiUrl.endsWith('/') ? apiUrl : apiUrl + '/');
    requireValid(['http:', 'https:'].includes(this.base.protocol), 'Нужен HTTP(S) адрес API.');
  }

  prepare(): Promise<string[]> {
    if (this.running) return this.running;
    this.running = this.prepareAll().finally(() => { this.running = null; });
    return this.running;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, this.base);
    // Local delivery uses one backend. Do not follow a descriptor to another host.
    requireValid(url.origin === this.base.origin, 'Недопустимый адрес учебного пакета.');
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(60000) });
    requireValid(response.ok || response.status === 304, `Не удалось загрузить контент (HTTP ${response.status}).`);
    return response;
  }

  private async text(path: string): Promise<string> {
    const response = await this.request(path);
    const length = response.headers.get('Content-Length');
    requireValid(length === null || Number(length) <= MAX_BYTES, 'Документ слишком большой.');
    const text = await response.text();
    requireValid(utf8Size(text) <= MAX_BYTES, 'Документ слишком большой.');
    return text;
  }

  private async prepareAll(): Promise<string[]> {
    let catalog = await this.repository.catalog();
    const response = await this.request('catalog/head', catalog ? { headers: { 'If-None-Match': `"${catalog.catalog_revision}"` } } : undefined);
    if (response.status !== 304) {
      const head = parseHead(await response.json());
      const text = await this.text(head.url);
      await verifyText(text, head, this.hash);
      const next = parseCatalog(JSON.parse(text));
      requireValid(next.catalog_revision === head.catalog_revision, 'Ревизия каталога не совпадает.');
      await this.repository.saveCatalog(next);
      catalog = next;
    }
    requireValid(catalog, 'Локальный каталог отсутствует.');
    const errors: string[] = [];
    for (const product of catalog.products) {
      if (!product.trial_enabled || product.availability !== 'available') continue;
      try {
        await this.prepareProduct(catalog, product);
      } catch (error) {
        errors.push(`${product.title.ru}: ${error instanceof Error ? error.message : 'Ошибка загрузки.'}`);
      }
    }
    return errors;
  }

  private async prepareProduct(catalog: Catalog, product: Product): Promise<void> {
    const current = await this.repository.activeManifest(product.id);
    if (current?.revision_id === product.revision_id) return;
    const manifest = parseManifest(JSON.parse(await this.text(`products/${product.id}/manifest?scope=trial&catalog_revision=${catalog.catalog_revision}`)));
    requireValid(manifest.product_id === product.id && manifest.revision_id === product.revision_id
      && manifest.revision_number === product.revision_number && manifest.scope === 'trial');
    this.checkComposition(product, manifest);
    const documents: Source[] = [];
    for (const descriptor of manifest.documents) {
      const cached = await this.repository.blob(descriptor.sha256);
      let text = cached?.text;
      if (text !== undefined) {
        try { await verifyText(text, descriptor, this.hash); }
        catch { text = undefined; } // Re-fetch a corrupt local cache entry.
      }
      if (text === undefined) {
        const response = await this.request('content/downloads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artifact_ids: [descriptor.artifact_id] }) });
        const downloads = parseDownloads(await response.json());
        const download = downloads[0];
        requireValid(downloads.length === 1 && download?.artifact_id === descriptor.artifact_id);
        requireValid(download.sha256 === descriptor.sha256 && download.byte_size === descriptor.byte_size);
        text = await this.text(download.url);
        await verifyText(text, descriptor, this.hash);
      }
      const source = parseSource(JSON.parse(text));
      requireValid(source.product_id === product.id && source.section_id === descriptor.section_id);
      requireValid(source.scope === ({ book: 'chapter', season: 'episode', movie: 'movie' }[product.kind]));
      requireValid(source.lessons.map((lesson) => lesson.id).join() === descriptor.lesson_ids.join());
      await this.repository.saveBlob(descriptor.sha256, descriptor.byte_size, text);
      documents.push(source);
    }
    await this.repository.activate(manifest, documents);
  }

  private checkComposition(product: Product, manifest: Manifest): void {
    // Stage 1.2's trial is exactly the first section, or three movie lessons.
    requireValid(manifest.documents.length === 1);
    const descriptor = manifest.documents[0];
    requireValid(descriptor);
    if (product.kind === 'movie') {
      requireValid(descriptor.section_id === null && manifest.counts.lessons === 3);
    } else {
      requireValid(descriptor.section_id === product.sections[0]?.id);
    }
  }
}
