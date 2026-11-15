import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider,
  useNavigationContainerRef,
  usePathname,
  useRouter,
} from "expo-router";
import { useEffect, useRef } from "react";
import { Platform, useColorScheme } from "react-native";

import { assistantLifecycle } from "@/services/api/assistant-lifecycle";
import { initializeSavedConnection } from "@/services/connection-initialization";

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const navigationRef = useNavigationContainerRef();
  const pathname = usePathname();
  const router = useRouter();
  const hasHandledInitialRoute = useRef(false);

  useEffect(() => { void initializeSavedConnection(); }, []);

  useEffect(() => assistantLifecycle.attach(), []);

  useEffect(() => {
    const handleInitialRoute = () => {
      if (!navigationRef.isReady() || hasHandledInitialRoute.current) return;

      // 최초 진입에서만 일정 비서로 이동하고, 이후 `/` 목록 진입은 유지한다.
      hasHandledInitialRoute.current = true;
      if (pathname === "/") {
        router.replace("/(tabs)/assistant");
      }
    };

    const unsubscribe = navigationRef.addListener("state", handleInitialRoute);
    handleInitialRoute();
    return unsubscribe;
  }, [navigationRef, pathname, router]);

  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />

        {/* SDK 58 iOS의 기본 투명 헤더 대신 기존 폼의 헤더 아래 배치를 유지한다. */}
        <Stack.Screen
          name="schedule/create"
          options={{
            title: "일정 추가",
            headerTransparent: false,
            animation: Platform.OS === "ios" ? "simple_push" : undefined,
          }}
        />

        <Stack.Screen
          name="schedule/[id]"
          options={{
            title: "일정 수정",
            headerTransparent: false,
            animation: Platform.OS === "ios" ? "simple_push" : undefined,
          }}
        />

        <Stack.Screen
          name="settings"
          options={{
            title: "설정",
            headerTransparent: false,
            animation: Platform.OS === "ios" ? "simple_push" : undefined,
          }}
        />
      </Stack>
    </ThemeProvider>
  );
}
