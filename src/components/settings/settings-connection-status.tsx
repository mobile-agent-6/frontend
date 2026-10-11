import { SymbolView } from "expo-symbols";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type SettingsConnectionBadgeProps = {
  isTimeMismatch: boolean;
};

export function SettingsConnectionBadge({
  isTimeMismatch,
}: SettingsConnectionBadgeProps) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.badge,
        { backgroundColor: isTimeMismatch ? "#FEF3C7" : "#D1FAE5" },
      ]}
    >
      <View
        style={[
          styles.badgeDot,
          { backgroundColor: isTimeMismatch ? "#F59E0B" : "#10B981" },
        ]}
      />
      <ThemedText
        style={[
          styles.badgeText,
          { color: isTimeMismatch ? "#B45309" : "#047857" },
        ]}
      >
        {isTimeMismatch ? "시간 동기화 필요" : "연결됨"}
      </ThemedText>
    </View>
  );
}

type SettingsConnectionFeedbackProps = {
  isChecking: boolean;
  processingMessage: string | null;
  error: string | null;
};

export function SettingsConnectionFeedback({
  isChecking,
  processingMessage,
  error,
}: SettingsConnectionFeedbackProps) {
  return (
    <>
      {(isChecking || processingMessage !== null) && (
        <ThemedText
          type="small"
          themeColor="textSecondary"
          accessibilityLiveRegion="polite"
        >
          {processingMessage ?? "Pi 연결을 확인하고 있습니다."}
        </ThemedText>
      )}
      {error !== null && (
        <ThemedText
          type="small"
          themeColor="destructive"
          accessibilityRole="alert"
        >
          {error}
        </ThemedText>
      )}
    </>
  );
}

type SettingsConnectionStatusProps = {
  piTime: number;
  phoneTime: number;
  isTimeMismatch: boolean;
  fieldBackground: string;
  canSync: boolean;
  syncAdjusted: boolean | null;
  onSyncPress: () => void;
};

function formatMockTime(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}


export function SettingsConnectionStatus({
  piTime,
  phoneTime,
  isTimeMismatch,
  fieldBackground,
  canSync,
  syncAdjusted,
  onSyncPress,
}: SettingsConnectionStatusProps) {
  const theme = useTheme();
  return (
    <View style={styles.timeSection}>
      <View style={styles.timeHeading}>
        <SymbolView
          name={{ ios: "clock", android: "schedule", web: "schedule" }}
          size={20}
          tintColor={theme.primary}
        />
        <ThemedText style={styles.label}>Pi 시각 확인</ThemedText>
      </View>
      <View
        style={[styles.timeCard, { backgroundColor: fieldBackground }]}
      >
        <View
          style={[
            styles.timeRow,
            {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.backgroundElement,
            },
          ]}
        >
          <ThemedText type="small" themeColor="textSecondary">
            Pi 시간
          </ThemedText>
          <ThemedText style={styles.timeValue}>
            {formatMockTime(piTime)}
          </ThemedText>
        </View>
        <View style={styles.timeRow}>
          <ThemedText type="small" themeColor="textSecondary">
            휴대폰 시간
          </ThemedText>
          <ThemedText style={styles.timeValue}>
            {formatMockTime(phoneTime)}
          </ThemedText>
        </View>
      </View>
      {isTimeMismatch && (
        <View
          style={[styles.syncNotice, { backgroundColor: theme.primaryMuted }]}
        >
          <ThemedText type="small" style={{ color: theme.primary }}>
            Pi와 휴대폰 시간이 일치하지 않습니다.
          </ThemedText>
          <Button
            label="Pi 시간 맞추기"
            disabled={!canSync}
            onPress={onSyncPress}
          />
        </View>
      )}
      {!isTimeMismatch && syncAdjusted !== null && (
        <View style={[styles.syncSuccess, { backgroundColor: "#ECFDF5" }]}>
          <SymbolView
            name={{ ios: "checkmark", android: "check", web: "check" }}
            size={16}
            tintColor="#047857"
          />
          <ThemedText type="small" style={styles.syncSuccessText}>
            {syncAdjusted
              ? "Pi 시간이 동기화되었습니다."
              : "시각 변경 없이 시간 검증을 통과했습니다."}
          </ThemedText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.one,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: Spacing.one,
    flexShrink: 1,
  },
  badgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "500",
    flexShrink: 1,
  },
  label: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "700",
    flexShrink: 1,
  },
  timeSection: {
    marginTop: Spacing.five,
    gap: Spacing.three,
  },
  timeHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
  },
  timeCard: {
    borderRadius: 16,
    overflow: "hidden",
  },
  timeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: 14,
  },
  timeValue: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  syncSuccess: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingVertical: 14,
  },
  syncSuccessText: {
    color: "#047857",
    flexShrink: 1,
  },
  syncNotice: {
    borderRadius: 16,
    padding: Spacing.three,
    gap: Spacing.three,
  },
});
