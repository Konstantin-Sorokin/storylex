import { Stack } from 'expo-router';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ContentProvider } from '../src/data/runtime.tsx';
import { useColors } from '../src/ui/common.tsx';

export default function RootLayout() {
  const colors = useColors();
  return <SafeAreaProvider><SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: colors.background }}>
    <ContentProvider><Stack screenOptions={{ headerStyle: { backgroundColor: colors.card }, headerTintColor: colors.text, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="products/[productId]" options={{ title: 'Произведение' }} />
      <Stack.Screen name="chapters/[productId]/[sectionId]" options={{ title: 'Уроки' }} />
    </Stack></ContentProvider>
  </SafeAreaView></SafeAreaProvider>;
}
