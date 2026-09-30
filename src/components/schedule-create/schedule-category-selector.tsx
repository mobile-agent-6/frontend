import { Pressable, StyleSheet, View } from "react-native";

import { ThemedText } from "@/components/themed-text";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import {
  SCHEDULE_CATEGORIES,
  type ScheduleCategory,
} from "@/types/schedule";

type ScheduleCategorySelectorProps = {
  category: ScheduleCategory | null;
  onSelectCategory: (category: ScheduleCategory) => void;
};

export function ScheduleCategorySelector({
  category,
  onSelectCategory,
}: ScheduleCategorySelectorProps) {
  const theme = useTheme();
  const colorScheme = useColorScheme();

  return (
    <View style={styles.categoryGroup}>
      <ThemedText style={styles.label}>카테고리</ThemedText>
      <View style={styles.categoryList}>
        {SCHEDULE_CATEGORIES.map((item) => {
          const selected = category === item;

          return (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => onSelectCategory(item)}
              style={({ pressed }) => [
                styles.categoryChip,
                {
                  backgroundColor: selected
                    ? theme.primary
                    : colorScheme === "dark"
                      ? theme.backgroundSelected
                      : "#F3EFED",
                },
                pressed && styles.pressed,
              ]}
            >
              <ThemedText
                type="smallBold"
                style={{
                  color: selected ? theme.primaryForeground : theme.text,
                  fontSize: 15,
                }}
              >
                {item}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  categoryGroup: {
    gap: 12,
  },
  label: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "700",
  },
  categoryList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  categoryChip: {
    minWidth: 72,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  pressed: {
    opacity: 0.7,
  },
});
