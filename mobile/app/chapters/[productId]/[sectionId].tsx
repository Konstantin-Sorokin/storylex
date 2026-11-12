import { useCallback } from 'react';
import { useLocalSearchParams } from 'expo-router';
import type { ContentRepository } from '../../../src/data/content-repository.ts';
import { useLocalQuery } from '../../../src/data/runtime.tsx';
import { Card, Copy, Heading, Page } from '../../../src/ui/common.tsx';

export default function ChapterScreen() {
  const params = useLocalSearchParams<{ productId: string; sectionId: string }>();
  const { value: source, error } = useLocalQuery(useCallback((repository: ContentRepository) =>
    repository.document(params.productId, params.sectionId === 'movie' ? null : params.sectionId),
  [params.productId, params.sectionId]), null);
  return <Page>{source ? <>
    <Heading>{source.title.ru}</Heading><Copy>{source.lessons.length} уроков · {source.lessons.length * 5} слов</Copy>
    {source.lessons.map((lesson) => <Card key={lesson.id}><Copy>Урок {lesson.position} · {lesson.items.length} слов</Copy></Card>)}
    <Copy>Прохождение уроков появится в следующем этапе.</Copy>
  </> : <Copy>{error ?? 'Скачанная глава недоступна.'}</Copy>}</Page>;
}
