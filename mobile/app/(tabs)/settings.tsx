import { useContent } from '../../src/data/runtime.tsx';
import { Action, Copy, Heading, Page } from '../../src/ui/common.tsx';

export default function SettingsScreen() {
  const { prepare, busy, errors } = useContent();
  return <Page><Heading>Настройки</Heading>
    <Copy>Подготовка загружает опубликованный каталог и назначенные автором пробные главы. Скачанные главы открываются без интернета.</Copy>
    <Action label={busy ? 'Загрузка материалов…' : 'Обновить материалы'} disabled={busy} onPress={() => { void prepare(); }} />
    {errors.map((error, index) => <Copy key={index}>{error}</Copy>)}
  </Page>;
}
