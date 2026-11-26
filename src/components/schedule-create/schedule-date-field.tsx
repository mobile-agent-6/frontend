import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet } from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type ScheduleDateFieldProps = {
  backgroundColor: string;
  date: string | null;
  expanded: boolean;
  onPress: () => void;
};

export function ScheduleDateField({
  backgroundColor,
  date,
  expanded,
  onPress,
}: ScheduleDateFieldProps) {
  const theme = useTheme();

  return (
    <>
      <ThemedText style={styles.label}>날짜</ThemedText>
      <Pressable
        accessibilityLabel={date ? `선택한 날짜 ${date}` : "날짜 선택"}
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
              □
            </ThemedText>
          }
          name={{
            ios: "calendar",
            android: "calendar_today",
            web: "calendar_today",
          }}
          size={24}
          tintColor={theme.primary}
        />
        <ThemedText
          style={[
            styles.selectionText,
            !date && { color: theme.textSecondary },
          ]}
        >
          {date ?? "연도. 월. 일."}
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
