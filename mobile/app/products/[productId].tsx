import { useCallback } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import type { ContentRepository } from '../../src/data/content-repository.ts';
import { useLocalQuery } from '../../src/data/runtime.tsx';
import { Action, Card, Copy, Heading, Page } from '../../src/ui/common.tsx';

export default function ProductScreen() {
  const params = useLocalSearchParams<{ productId: string }>();
  const { value, error } = useLocalQuery(useCallback(async (repository: ContentRepository) => {
    const catalog = await repository.catalog();
    const product = catalog?.products.find((entry) => entry.id === params.productId);
    const manifest = await repository.activeManifest(params.productId);
    return product ? { product, manifest } : null;
  }, [params.productId]), null);
  if (!value) return <Page><Copy>{error ?? 'Загрузка произведения…'}</Copy></Page>;
  const { product, manifest } = value;
  const available = product.trial_enabled && product.availability === 'available';
  function open(sectionId: string) {
    router.push({ pathname: '/chapters/[productId]/[sectionId]', params: { productId: params.productId, sectionId } });
  }
  return <Page><Heading>{product.title.ru}</Heading><Copy>{product.description.ru}</Copy>
    <Copy>{product.counts.sections} глав/эпизодов · {product.counts.lessons} уроков · {product.counts.items} слов</Copy>
    {!available && <Copy>Пробная часть недоступна.</Copy>}
    {available && !manifest && <Copy>Пробная глава ещё не загружена. Повторите подготовку в настройках.</Copy>}
    {product.kind === 'movie' && available && manifest && <Action label="Открыть пробные уроки" onPress={() => open('movie')} />}
    {product.sections.map((section) => {
      const downloaded = available && manifest?.documents.some((document) => document.section_id === section.id);
      return <Card key={section.id}><Copy>{section.position}. {section.title.ru}</Copy>
        {downloaded ? <Action label="Открыть пробную главу" onPress={() => open(section.id)} /> : <Copy>Нет скачанной пробы</Copy>}
      </Card>;
    })}
  </Page>;
}
