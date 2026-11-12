import { createHash, randomUUID } from 'node:crypto';
import sourceFixture from '../../contracts/fixtures/source-chapter-v1.json' with { type: 'json' };
import { parseSource } from '../src/domain/validation.ts';
import type { Catalog, Head, Manifest, Source } from '../src/domain/content.ts';
import { utf8Size, type Fetch } from '../src/infrastructure/downloader.ts';

export const hash = async (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const BASE = 'http://storylex.test/api/v1/';
export async function fixture(source = parseSource(structuredClone(sourceFixture)), number = 1) {
  const text = JSON.stringify(source);
  const descriptor = { artifact_id: randomUUID(), section_id: source.section_id,
    lesson_ids: source.lessons.map((lesson) => lesson.id), sha256: await hash(text), byte_size: utf8Size(text) };
  const manifest: Manifest = { schema_version: 1, lesson_engine_version: 1, product_id: source.product_id,
    revision_id: randomUUID(), revision_number: number, scope: 'trial',
    counts: { sections: 1, lessons: source.lessons.length, items: source.lessons.length * 5 }, documents: [descriptor] };
  const catalog: Catalog = { schema_version: 1, catalog_revision: randomUUID(), book_series: [], shows: [], products: [{
    id: source.product_id, kind: 'book', title: source.title, description: { ru: 'Описание', en: 'Description' },
    year: 2026, author: { id: randomUUID(), name_ru: 'Автор', name_en: 'Author' }, trial_enabled: true,
    availability: 'available', revision_id: manifest.revision_id, revision_number: number, counts: manifest.counts,
    sections: [{ id: source.section_id!, kind: 'chapter', position: 1, title: source.title }],
  }] };
  const catalogText = JSON.stringify(catalog);
  const head: Head = { schema_version: 1, catalog_revision: catalog.catalog_revision,
    url: BASE + 'catalog/revisions/' + catalog.catalog_revision, sha256: await hash(catalogText), byte_size: utf8Size(catalogText) };
  return { source, text, descriptor, manifest, catalog, catalogText, head };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function server(f: Fixture) {
  const calls: string[] = [];
  const reply = (text: string) => new Response(text, { headers: { 'Content-Type': 'application/json' } });
  const fetcher: Fetch = async (input, init) => {
    const url = new URL(input.toString());
    calls.push(url.pathname);
    if (url.pathname.endsWith('/catalog/head')) {
      if (new Headers(init?.headers).get('If-None-Match') === `"${f.catalog.catalog_revision}"`) return new Response(null, { status: 304 });
      return reply(JSON.stringify(f.head));
    }
    if (url.toString() === f.head.url) return reply(f.catalogText);
    if (url.pathname.endsWith('/manifest')) {
      if (url.searchParams.get('catalog_revision') !== f.catalog.catalog_revision) throw new Error('Unpinned manifest');
      return reply(JSON.stringify(f.manifest));
    }
    if (url.pathname.endsWith('/content/downloads')) return reply(JSON.stringify({ downloads: [{
      ...f.descriptor, url: BASE + 'content/artifacts/' + f.descriptor.artifact_id, expires_at: null,
    }] }));
    if (url.pathname.endsWith('/content/artifacts/' + f.descriptor.artifact_id)) return reply(f.text);
    throw new Error(`Unexpected request: ${url}`);
  };
  return { calls, fetcher };
}

export function corrected(source: Source): Source {
  const next = structuredClone(source);
  next.title.ru = 'Исправленная глава';
  return next;
}
