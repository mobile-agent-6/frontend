import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { useColorScheme } from "react-native";

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />

        <Stack.Screen name="schedule/create" options={{ title: "일정 추가" }} />

        <Stack.Screen name="schedule/[id]" options={{ title: "일정 수정" }} />

        <Stack.Screen name="settings" options={{ title: "설정" }} />
      </Stack>
    </ThemeProvider>
  );
}
