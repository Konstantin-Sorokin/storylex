export type Localized = { ru: string; en: string };
export type Counts = { sections: number; lessons: number; items: number };
export type Section = { id: string; kind: 'chapter' | 'episode'; position: number; title: Localized };
export type Product = {
  id: string;
  kind: 'book' | 'season' | 'movie';
  title: Localized;
  description: Localized;
  year: number;
  author: { id: string; name_ru: string; name_en: string } | null;
  trial_enabled: boolean;
  availability: 'available' | 'blocked';
  revision_id: string;
  revision_number: number;
  counts: Counts;
  sections: Section[];
};
export type Catalog = {
  schema_version: 1;
  catalog_revision: string;
  products: Product[];
  book_series: object[];
  shows: object[];
};
export type FileDescriptor = { sha256: string; byte_size: number };
export type Head = FileDescriptor & { schema_version: 1; catalog_revision: string; url: string };
export type DocumentDescriptor = FileDescriptor & { artifact_id: string; section_id: string | null; lesson_ids: string[] };
export type Manifest = {
  schema_version: 1;
  lesson_engine_version: 1;
  product_id: string;
  revision_id: string;
  revision_number: number;
  scope: 'trial' | 'full';
  counts: Counts;
  documents: DocumentDescriptor[];
};
export type Question = { id: string; prompt: string; options: { id: string; text: string }[]; correct_option_id: string };
export type Segment = { text: string; target: boolean };
export type LearningItem = {
  id: string;
  sense_key: string;
  kind: 'word' | 'phrasal_verb' | 'expression' | 'grammar';
  en: string;
  ru: string;
  example: { en: Segment[]; ru: Segment[] };
  exercises: { word_to_translation: Question; context_ru_to_en: Question; context_en_to_ru: Question };
};
export type Lesson = { id: string; position: number; items: LearningItem[]; pairs: { id: string } };
export type Source = {
  schema_version: 1;
  product_id: string;
  scope: 'chapter' | 'episode' | 'movie';
  section_id: string | null;
  title: Localized;
  lessons: Lesson[];
};
export type Download = FileDescriptor & { artifact_id: string; url: string; expires_at: string | null };
