import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

export type ScheduleListViewState = "loading" | "success" | "empty" | "error";

type ScheduleListStateProps = {
  state: Exclude<ScheduleListViewState, "success">;
  onRetry?: () => void;
  emptyText?: string;
  errorTitle?: string;
};

export function ScheduleListState({
  state,
  onRetry,
  emptyText = "등록된 일정이 없어요.",
  errorTitle = "일정을 불러오지 못했어요.",
}: ScheduleListStateProps) {
  const theme = useTheme();

  if (state === "loading") {
    return (
      <View style={styles.container}>
        <ActivityIndicator
          accessibilityLabel="일정을 불러오는 중"
          color={theme.primary}
        />
      </View>
    );
  }

  if (state === "empty") {
    return (
      <View style={styles.container}>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={styles.emptyText}
        >
          {emptyText}
        </ThemedText>
      </View>
    );
  }

  return (
    <View
      accessibilityRole="alert"
      style={[styles.container, styles.errorContainer]}
    >
      <ThemedText style={styles.errorTitle}>
        {errorTitle}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        잠시 후 다시 시도해 주세요.
      </ThemedText>
      {onRetry && (
        <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={Spacing.two} style={styles.retryButton}>
          <ThemedText themeColor="primary">다시 시도</ThemedText>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.two,
  },
  errorContainer: {
    gap: Spacing.one,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: "600",
  },
  retryButton: {
    marginTop: 8,
  },
  emptyText: {
    fontSize: 15,
    fontWeight: "500",
  },
});
