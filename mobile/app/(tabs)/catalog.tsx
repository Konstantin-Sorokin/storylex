import { useCallback } from 'react';
import { router } from 'expo-router';
import { useContent, useLocalQuery } from '../../src/data/runtime.tsx';
import type { ContentRepository } from '../../src/data/content-repository.ts';
import { Action, Card, Copy, Heading, Page } from '../../src/ui/common.tsx';

export default function CatalogScreen() {
  const { errors } = useContent();
  const { value: catalog, error } = useLocalQuery(useCallback((repository: ContentRepository) => repository.catalog(), []), null);
  return <Page><Heading>Каталог</Heading>
    {error && <Copy>{error}</Copy>}
    {errors.length > 0 && <Copy>Часть материалов не загрузилась. Повторите подготовку в настройках. Уже скачанные главы доступны.</Copy>}
    {catalog?.products.length === 0 && <Copy>Опубликованных произведений пока нет.</Copy>}
    {catalog?.products.filter((product) => product.availability === 'available').map((product) => <Card key={product.id}>
      <Heading>{product.title.ru}</Heading>
      <Copy>{product.year}{product.author ? ` · ${product.author.name_ru}` : ''}</Copy>
      {product.trial_enabled && <Copy>Есть пробный доступ</Copy>}
      <Action label="Открыть произведение" onPress={() => router.push({ pathname: '/products/[productId]', params: { productId: product.id } })} />
    </Card>)}
  </Page>;
}
