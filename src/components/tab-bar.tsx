import { Tabs } from "expo-router";

import { useTheme } from "@/hooks/use-theme";

export function TabBar() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.primary,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "일정 목록",
        }}
      />

      <Tabs.Screen
        name="assistant"
        options={{
          title: "일정 비서",
        }}
      />

      <Tabs.Screen
        name="calendar"
        options={{
          title: "캘린더",
        }}
      />
    </Tabs>
  );
}
