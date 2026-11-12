import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useColors } from '../../src/ui/common.tsx';

export default function TabLayout() {
  const colors = useColors();
  const symbols: Record<string, string> = { index: '▤', catalog: '▦', reviews: '↻', settings: '⚙' };
  return <Tabs screenOptions={({ route }) => ({
    headerShown: false,
    tabBarActiveTintColor: colors.accent,
    tabBarInactiveTintColor: colors.muted,
    tabBarStyle: { backgroundColor: colors.card },
    tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 22 }}>{symbols[route.name]}</Text>,
  })}>
    <Tabs.Screen name="index" options={{ title: 'Библиотека' }} />
    <Tabs.Screen name="catalog" options={{ title: 'Каталог' }} />
    <Tabs.Screen name="reviews" options={{ title: 'Повторения' }} />
    <Tabs.Screen name="settings" options={{ title: 'Настройки' }} />
  </Tabs>;
}
