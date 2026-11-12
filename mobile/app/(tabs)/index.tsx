import { router } from 'expo-router';
import { Action, Copy, Heading, Page } from '../../src/ui/common.tsx';

export default function LibraryScreen() {
  return <Page><Heading>Моя библиотека</Heading>
    <Copy>Здесь появятся приобретённые и бесплатно добавленные материалы.</Copy>
    <Copy>Пробные главы доступны в каталоге и не добавляются в библиотеку.</Copy>
    <Action label="Открыть каталог" onPress={() => router.navigate('/catalog')} />
  </Page>;
}
