import { Link } from "expo-router";
import { StyleSheet, View } from "react-native";

import { Header } from "@/components/header";
import { ScreenPlaceholder } from "@/components/screen-placeholder";
import { ThemedView } from "@/components/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

const PLACEHOLDER_SCHEDULE_ID = "00000000-0000-4000-8000-000000000000";

export default function ScheduleListScreen() {
  const theme = useTheme();

  return (
    <ThemedView style={styles.screen}>
      <Header title="일정 목록" />

      <ScreenPlaceholder title="일정 목록">
        <View style={styles.links}>
          <Link
            href="/schedule/create"
            style={[styles.link, { color: theme.primary }]}
          >
            일정 추가
          </Link>

          <Link
            href={{
              pathname: "/schedule/[id]",
              params: { id: PLACEHOLDER_SCHEDULE_ID },
            }}
            style={[styles.link, { color: theme.primary }]}
          >
            일정 수정
          </Link>

          <Link href="/settings" style={[styles.link, { color: theme.primary }]}>
            설정
          </Link>
        </View>
      </ScreenPlaceholder>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  links: {
    alignItems: "center",
    gap: Spacing.two,
  },
  link: {
    fontSize: 16,
    fontWeight: "600",
  },
});
