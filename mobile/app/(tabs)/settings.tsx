import { DevLogin, useContent } from '../../src/data/runtime.tsx';
import { Action, Copy, Heading, Page } from '../../src/ui/common.tsx';

export default function SettingsScreen() {
  const { prepare, busy, errors, learning, sync, syncBusy, syncError, syncStatus, authenticate } = useContent();
  return <Page><Heading>Настройки</Heading>
    <Copy>Подготовка загружает опубликованный каталог и назначенные автором пробные главы. Скачанные главы открываются без интернета.</Copy>
    <Action label={busy ? 'Загрузка материалов…' : 'Обновить материалы'} disabled={busy} onPress={() => { void prepare(); }} />
    {errors.map((error, index) => <Copy key={index}>{error}</Copy>)}
    <Heading>Синхронизация прогресса (dev)</Heading>
    <Copy>Тестовый аккаунт: {learning.userId}</Copy>
    <Copy>Ожидают отправки: {syncStatus?.pending ?? '…'}. Отклонены: {syncStatus?.terminal ?? '…'}.</Copy>
    <Copy>Последняя доставка и pull: {syncStatus?.last_sync ?? 'ещё не выполнены'}</Copy>
    {syncError && <Copy>{syncError}</Copy>}
    {syncStatus?.codes.map((code, index) => <Copy key={index}>Операция сохранена для диагностики: {code}</Copy>)}
    <Action label={syncBusy ? 'Синхронизация…' : 'Синхронизировать'} disabled={syncBusy} onPress={sync} />
    <Copy>Dev-токен хранится только в памяти. После перезапуска введите его для отправки; офлайн-уроки продолжают работать.</Copy>
    <DevLogin authenticate={authenticate} />
  </Page>;
}
