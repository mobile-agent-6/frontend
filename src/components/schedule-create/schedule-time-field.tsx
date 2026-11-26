import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet } from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type ScheduleTimeFieldProps = {
  backgroundColor: string;
  expanded: boolean;
  onPress: () => void;
  time: string | null;
};

export function ScheduleTimeField({
  backgroundColor,
  expanded,
  onPress,
  time,
}: ScheduleTimeFieldProps) {
  const theme = useTheme();

  return (
    <>
      <ThemedText style={styles.label}>시간</ThemedText>
      <Pressable
        accessibilityLabel={time ? `선택한 시간 ${time}` : "시간 선택"}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onPress}
        style={({ pressed }) => [
          styles.selectionField,
          { backgroundColor },
          pressed && styles.pressed,
        ]}
      >
        <SymbolView
          fallback={
            <ThemedText style={[styles.iconFallback, { color: theme.primary }]}>
              ○
            </ThemedText>
          }
          name={{ ios: "clock", android: "schedule", web: "schedule" }}
          size={24}
          tintColor={theme.primary}
        />
        <ThemedText
          style={[
            styles.selectionText,
            !time && { color: theme.textSecondary },
          ]}
        >
          {time ?? "시간 선택"}
        </ThemedText>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "700",
  },
  selectionField: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
  },
  selectionText: {
    flex: 1,
    fontSize: 16,
    lineHeight: 24,
  },
  pressed: {
    opacity: 0.7,
  },
  iconFallback: {
    fontSize: 20,
    lineHeight: 24,
  },
});
