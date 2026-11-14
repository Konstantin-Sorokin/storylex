import { Ajv2020 } from 'ajv/dist/2020.js';

export type CompletionState = {
  product_id: string; lesson_id: string; completed: true; trial_revision: string | null;
  client_completed_at: string; accepted_at: string; revision: number;
};
export type CompletionOperation = {
  operation_id: string; sequence: number; type: 'lesson.complete'; occurred_at: string;
  payload: { product_id: string; lesson_id: string; content_revision_id: string };
};
export type Receipt = { operation_id: string } & (
  { status: 'applied' | 'noop'; state: CompletionState; change_revision: number }
  | { status: 'rejected'; code: string }
);
export type ChangePage = {
  changes: { cursor: string; entity: 'lesson_completion'; id: string; state: CompletionState }[];
  next_cursor: string; through_cursor: string; has_more: boolean;
};
const ajv = new Ajv2020({ strict: false });
const id = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const revision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const cursor = { type: 'string', pattern: '^(0|[1-9][0-9]*)$' };
const date = { type: 'string', format: 'date-time' };
ajv.addFormat('date-time', (value: string) => /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
const state = { type: 'object', required: ['product_id', 'lesson_id', 'completed', 'trial_revision', 'client_completed_at', 'accepted_at', 'revision'],
  properties: { product_id: id, lesson_id: id, completed: { const: true }, trial_revision: { anyOf: [id, { type: 'null' }] },
    client_completed_at: date, accepted_at: date, revision } };
const receipts = ajv.compile<{ results: Receipt[]; server_time: string }>({ type: 'object', required: ['results', 'server_time'], properties: {
  server_time: date, results: { type: 'array', maxItems: 100, items: { oneOf: [
    { type: 'object', required: ['operation_id', 'status', 'state', 'change_revision'], properties: {
      operation_id: id, status: { enum: ['applied', 'noop'] }, state, change_revision: revision } },
    { type: 'object', required: ['operation_id', 'status', 'code'], properties: {
      operation_id: id, status: { const: 'rejected' }, code: { type: 'string', minLength: 1 } } },
  ] } },
} });
const page = ajv.compile<ChangePage>({ type: 'object', required: ['changes', 'next_cursor', 'through_cursor', 'has_more'], properties: {
  next_cursor: cursor, through_cursor: cursor, has_more: { type: 'boolean' }, changes: { type: 'array', maxItems: 500, items: {
    type: 'object', required: ['cursor', 'entity', 'id', 'state'], properties: { cursor, entity: { const: 'lesson_completion' }, id, state },
  } },
} });
const session = ajv.compile<{ user_id: string }>({ type: 'object', required: ['user_id'], properties: { user_id: id } });
export function parseSession(value: unknown): string {
  if (!session(value)) throw new Error('Некорректный ответ dev-входа.');
  return value.user_id;
}
export function parseReceipts(value: unknown): Receipt[] {
  if (!receipts(value)) throw new Error('Неподдерживаемый ответ sync. Очередь сохранена.');
  return value.results;
}
export function parsePage(value: unknown): ChangePage {
  if (!page(value)) throw new Error('Неподдерживаемые изменения sync. Курсор сохранён.');
  return value;
}
