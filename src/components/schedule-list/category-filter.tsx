import { useRef } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  type LayoutChangeEvent,
} from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import {
  SCHEDULE_CATEGORIES,
  type ScheduleCategory,
} from "@/types/schedule";

export type ScheduleCategoryFilter = "전체" | ScheduleCategory;

type CategoryFilterProps = {
  selectedCategory: ScheduleCategoryFilter;
  onSelectCategory: (category: ScheduleCategoryFilter) => void;
};

const FILTERS: ScheduleCategoryFilter[] = ["전체", ...SCHEDULE_CATEGORIES];
const LIGHT_CHIP_BACKGROUND = "#F3EFED";
const LIGHT_CHIP_TEXT = "#362B25";

export function CategoryFilter({
  selectedCategory,
  onSelectCategory,
}: CategoryFilterProps) {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const scrollViewRef = useRef<ScrollView>(null);
  const chipPositions = useRef(
    new Map<ScheduleCategoryFilter, { x: number; width: number }>(),
  );

  const handleChipLayout = (
    category: ScheduleCategoryFilter,
    event: LayoutChangeEvent,
  ) => {
    const { x, width } = event.nativeEvent.layout;
    chipPositions.current.set(category, { x, width });
  };

  const handleSelect = (category: ScheduleCategoryFilter) => {
    onSelectCategory(category);

    const position = chipPositions.current.get(category);
    if (position) {
      scrollViewRef.current?.scrollTo({
        x: Math.max(0, position.x - Spacing.three),
        animated: true,
      });
    }
  };

  return (
    <ScrollView
      ref={scrollViewRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
      style={styles.scrollView}
    >
      {FILTERS.map((category) => {
        const selected = selectedCategory === category;

        return (
          <Pressable
            key={category}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            hitSlop={Spacing.one}
            onLayout={(event) => handleChipLayout(category, event)}
            onPress={() => handleSelect(category)}
            style={({ pressed }) => [
              styles.chip,
              {
                backgroundColor: selected
                  ? theme.primary
                  : colorScheme === "dark"
                    ? theme.backgroundSelected
                    : LIGHT_CHIP_BACKGROUND,
              },
              pressed && styles.pressed,
            ]}
          >
            <ThemedText
              type="smallBold"
              style={{
                color: selected
                  ? theme.primaryForeground
                  : colorScheme === "dark"
                    ? theme.text
                    : LIGHT_CHIP_TEXT,
                fontSize: 16,
                lineHeight: 16,
              }}
            >
              {category}
            </ThemedText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flexGrow: 0,
    flexShrink: 0,
  },
  content: {
    gap: Spacing.two,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.three,
    paddingVertical: Spacing.three,
  },
  chip: {
    minWidth: 60,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    paddingHorizontal: Spacing.three,
  },
  pressed: {
    opacity: 0.65,
  },
});
