import { Ajv2020 } from 'ajv/dist/2020.js';
import sourceSchema from '../../../contracts/content/v1/source.schema.json' with { type: 'json' };
import manifestSchema from '../../../contracts/content/v1/manifest.schema.json' with { type: 'json' };
import catalogSchema from '../../../contracts/content/v1/catalog.schema.json' with { type: 'json' };
import type { Catalog, Head, Manifest, Source, Download } from './content.ts';

const ajv = new Ajv2020({ strict: false });
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sourceValidator = ajv.compile<Source>(sourceSchema);
const manifestValidator = ajv.compile<Manifest>(manifestSchema);
const catalogValidator = ajv.compile<Catalog>(catalogSchema);
const descriptorProperties = {
  sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  byte_size: { type: 'integer', minimum: 1, maximum: 10 * 1024 * 1024 },
  url: { type: 'string', minLength: 1 },
};
const headValidator = ajv.compile<Head>({
  type: 'object', required: ['schema_version', 'catalog_revision', ...Object.keys(descriptorProperties)],
  properties: { ...descriptorProperties, schema_version: { const: 1 }, catalog_revision: { type: 'string', format: 'uuid' } },
});
const downloadsValidator = ajv.compile<{ downloads: Download[] }>({
  type: 'object', required: ['downloads'], properties: { downloads: {
    type: 'array', items: {
      type: 'object', required: ['artifact_id', 'expires_at', ...Object.keys(descriptorProperties)],
      properties: { ...descriptorProperties, artifact_id: { type: 'string', format: 'uuid' }, expires_at: { type: ['string', 'null'] } },
    },
  } },
});

export function requireValid(condition: unknown, message = 'Некорректный учебный пакет.'): asserts condition {
  if (!condition) throw new Error(message);
}

export function parseHead(value: unknown): Head {
  requireValid(headValidator(value), 'Неподдерживаемый формат каталога. Обновите приложение.');
  return value;
}

export function parseDownloads(value: unknown): Download[] {
  requireValid(downloadsValidator(value), 'Некорректный список загрузок.');
  requireValid(new Set(value.downloads.map((row) => row.artifact_id)).size === value.downloads.length);
  return value.downloads;
}

export function parseCatalog(value: unknown): Catalog {
  requireValid(catalogValidator(value), 'Неподдерживаемый формат каталога. Обновите приложение.');
  const ids = new Set<string>();
  for (const product of value.products) {
    requireValid(!ids.has(product.id));
    ids.add(product.id);
    requireValid(new Set(product.sections.map((section) => section.id)).size === product.sections.length);
    product.sections.forEach((section, index) => {
      requireValid(section.position === index + 1);
      requireValid(section.kind === (product.kind === 'book' ? 'chapter' : 'episode'));
    });
    requireValid(product.kind !== 'movie' || product.sections.length === 0);
    requireValid(product.kind !== 'book' || product.author !== null);
  }
  return value;
}

export function parseManifest(value: unknown): Manifest {
  requireValid(manifestValidator(value), 'Неподдерживаемая версия учебного пакета. Обновите приложение.');
  const lessons = value.documents.flatMap((row) => row.lesson_ids);
  requireValid(new Set(lessons).size === lessons.length);
  requireValid(new Set(value.documents.map((row) => row.artifact_id)).size === value.documents.length);
  requireValid(new Set(value.documents.map((row) => row.section_id)).size === value.documents.length);
  requireValid(value.counts.lessons === lessons.length && value.counts.items === lessons.length * 5);
  requireValid(value.counts.sections === value.documents.filter((row) => row.section_id !== null).length);
  return value;
}

const normalize = (text: string) => text.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');

export function parseSource(value: unknown): Source {
  requireValid(sourceValidator(value), 'Некорректный формат главы. Обновите приложение.');
  requireValid((value.scope === 'movie') === (value.section_id === null));
  const ids = new Set<string>();
  const senses = new Set<string>();
  const addId = (id: string) => { requireValid(!ids.has(id)); ids.add(id); };
  value.lessons.forEach((lesson, index) => {
    requireValid(lesson.position === index + 1);
    addId(lesson.id);
    addId(lesson.pairs.id);
    for (const lang of ['en', 'ru'] as const) {
      requireValid(new Set(lesson.items.map((item) => normalize(item[lang]))).size === 5);
    }
    for (const item of lesson.items) {
      addId(item.id);
      const sense = normalize(item.sense_key);
      requireValid(sense && !senses.has(sense));
      senses.add(sense);
      requireValid(item.example.en.some((part) => part.target) && item.example.ru.some((part) => part.target));
      for (const question of Object.values(item.exercises)) {
        addId(question.id);
        question.options.forEach((option) => addId(option.id));
        requireValid(new Set(question.options.map((option) => normalize(option.text))).size === 4);
        requireValid(question.options.some((option) => option.id === question.correct_option_id));
      }
      const word = item.exercises.word_to_translation;
      requireValid(word.prompt === item.en && word.options.find((option) => option.id === word.correct_option_id)?.text === item.ru);
    }
  });
  return value;
}
