import { SymbolView } from "expo-symbols";
import { StyleSheet, Switch, View } from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type ScheduleNotificationToggleProps = {
  backgroundColor: string;
  notificationEnabled: boolean;
  onValueChange: (value: boolean) => void;
};

export function ScheduleNotificationToggle({
  backgroundColor,
  notificationEnabled,
  onValueChange,
}: ScheduleNotificationToggleProps) {
  const theme = useTheme();

  return (
    <View style={[styles.notificationField, { backgroundColor }]}>
      <View style={styles.notificationLabel}>
        <SymbolView
          fallback={
            <ThemedText style={[styles.iconFallback, { color: theme.primary }]}>
              ◇
            </ThemedText>
          }
          name={{
            ios: "bell",
            android: "notifications",
            web: "notifications",
          }}
          size={24}
          tintColor={theme.primary}
        />
        <ThemedText style={styles.notificationText}>
          10분 전 알림 받기
        </ThemedText>
      </View>
      <View style={styles.switchContainer}>
        <Switch
          accessibilityLabel="10분 전 알림 받기"
          ios_backgroundColor={theme.backgroundSelected}
          onValueChange={onValueChange}
          thumbColor={theme.primaryForeground}
          trackColor={{
            false: theme.backgroundSelected,
            true: theme.primary,
          }}
          value={notificationEnabled}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  notificationField: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.three,
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  notificationLabel: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  notificationText: {
    flexShrink: 1,
    fontSize: 16,
    lineHeight: 24,
  },
  switchContainer: {
    height: 48,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  iconFallback: {
    fontSize: 20,
    lineHeight: 24,
  },
});
