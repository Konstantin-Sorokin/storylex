import type { Lesson, Segment } from '../domain/content.ts';
import { emptyMinimumSizes, fontCandidates, lineHeight, type LessonLayout, type MinimumSizes, type TextBox } from './lesson-layout.ts';

export const exerciseLabels = {
  word_to_translation: 'СЛОВО И ЗНАЧЕНИЕ · Выберите перевод',
  context_ru_to_en: 'РУССКИЙ → АНГЛИЙСКИЙ · Выберите предложение',
  context_en_to_ru: 'АНГЛИЙСКИЙ → РУССКИЙ · Выберите верный смысл',
};
export type SampleRole = keyof MinimumSizes | 'exampleEn' | 'exampleRu';
export type TextSample = { id: string; text: string; font: number; width: number; role?: SampleRole; itemId?: string; parts?: Segment[] };
export const sampleKey = (sample: TextSample, scale: number) => JSON.stringify([sample.id, sample.text, sample.font, sample.width, scale, sample.parts]);

export function minimumSamples(lesson: Lesson, layout: LessonLayout): TextSample[] {
  const samples: TextSample[] = [
    { id: 'metadata-repeat', text: 'Короткое повторение · 5 слов', font: 13, width: layout.cardWidth, role: 'metadata' },
    { id: 'metadata-lesson', text: `Урок ${lesson.position} · 5 слов`, font: 13, width: layout.cardWidth, role: 'metadata' },
    { id: 'pair-status', text: 'Эти слова не составляют пару. Попробуйте ещё раз.', font: 15, width: layout.cardWidth, role: 'pairStatus' },
  ];
  for (const [id, text] of Object.entries(exerciseLabels)) samples.push({ id, text, font: 12, width: layout.cardWidth, role: 'heading' });
  for (const item of lesson.items) {
    for (const lang of ['en', 'ru'] as const) {
      samples.push({ id: `example:${item.id}:${lang}`, text: item.example[lang].map((part) => part.text).join(''),
        parts: item.example[lang], font: 16, width: layout.cardWidth, itemId: item.id, role: lang === 'en' ? 'exampleEn' : 'exampleRu' });
      samples.push({ id: `pair:${item.id}:${lang}`, text: item[lang], font: 16, width: layout.pairTextWidth, role: 'pair' });
    }
    for (const type of ['word_to_translation', 'context_ru_to_en', 'context_en_to_ru'] as const) {
      const question = item.exercises[type];
      samples.push({ id: `prompt:${question.id}`, text: question.prompt, font: fontCandidates([question.prompt]).at(-1) ?? 16,
        width: layout.cardWidth, role: type === 'word_to_translation' ? 'wordPrompt' : 'prompt' });
      const minimum = fontCandidates(question.options.map((option) => option.text)).at(-1) ?? 16;
      for (const option of question.options) samples.push({ id: `answer:${option.id}`, text: option.text, font: minimum, width: layout.optionTextWidth, role: 'answer' });
    }
  }
  // Pairs share the same question region as individual exercises.
  samples.push({ id: 'pair-heading', text: 'СОБЕРИТЕ СООТВЕТСТВИЯ · Выберите слово и перевод', font: 12, width: layout.cardWidth, role: 'heading' });
  samples.push({ id: 'pair-instruction', text: 'Найди 5 пар', font: 21, width: layout.cardWidth, role: 'prompt' });
  return samples;
}

export function minimumSizes(samples: readonly TextSample[], boxes: ReadonlyMap<string, TextBox>, scale: number): MinimumSizes | null {
  const result = emptyMinimumSizes();
  const examples = new Map<string, number>();
  for (const sample of samples) {
    const box = boxes.get(sampleKey(sample, scale));
    if (!box) return null;
    if (sample.role === 'exampleEn' || sample.role === 'exampleRu') {
      const id = sample.itemId ?? sample.id;
      examples.set(id, (examples.get(id) ?? 0) + box.height);
    } else if (sample.role) result[sample.role] = Math.max(result[sample.role], box.height);
  }
  result.example = Math.max(0, ...examples.values()) + 4;
  return result;
}

export const sampleLineHeight = (sample: TextSample) => sample.role === 'metadata' || sample.role === 'heading' ? 18 : lineHeight(sample.font);
