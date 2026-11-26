import { ActivityIndicator, StyleSheet, View } from "react-native";

import { ScheduleErrorNotice } from "@/components/schedule-list/schedule-error-notice";
import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

export type ScheduleListViewState = "loading" | "success" | "empty" | "error" | "notice";

type ScheduleListStateProps = {
  state: Exclude<ScheduleListViewState, "success">;
  onRetry?: () => void;
  emptyText?: string;
  errorTitle?: string;
  retryLabel?: string;
  retryDisabled?: boolean;
  retryLoading?: boolean;
  variant?: "card" | "centered";
  compactRetryButton?: boolean;
};

export function ScheduleListState({
  state,
  onRetry,
  emptyText = "등록된 일정이 없어요.",
  errorTitle = "일정을 불러오지 못했어요.",
  retryLabel = "다시 시도",
  retryDisabled,
  retryLoading,
  variant = "card",
  compactRetryButton = false,
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
    <ScheduleErrorNotice
      title={errorTitle}
      description={state === "notice" ? "최신 정보를 다시 불러와 상태를 확인할 수 있어요." : "잠시 후 다시 시도해 주세요."}
      tone={state}
      variant={variant}
      compactActions={compactRetryButton}
      actions={onRetry ? [{ key: "retry", label: retryLabel, onPress: onRetry, disabled: retryDisabled, loading: retryLoading }] : []}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.two,
  },
  emptyText: {
    fontSize: 15,
    fontWeight: "500",
  },
});
