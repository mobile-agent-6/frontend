import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import {
  CategoryFilter,
  type ScheduleCategoryFilter,
} from "@/components/schedule-list/category-filter";
import { Header } from "@/components/navigation/header";
import { ScheduleCard } from "@/components/schedule-list/schedule-card";
import {
  ScheduleListState,
  type ScheduleListViewState,
} from "@/components/schedule-list/schedule-list-state";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { BottomTabInset, Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { useScheduleStore } from "@/stores/scheduleStore";

export default function ScheduleListScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const router = useRouter();
  const schedules = useScheduleStore((state) => state.schedules);
  const toggleCompleted = useScheduleStore((state) => state.toggleCompleted);
  const [selectedCategory, setSelectedCategory] =
    useState<ScheduleCategoryFilter>("전체");
  const [requestState] =
    useState<Exclude<ScheduleListViewState, "empty">>("success");

  const visibleSchedules = useMemo(
    () =>
      selectedCategory === "전체"
        ? schedules
        : schedules.filter(
            (schedule) => schedule.category === selectedCategory,
          ),
    [schedules, selectedCategory],
  );

  const viewState: ScheduleListViewState =
    requestState === "success" && visibleSchedules.length === 0
      ? "empty"
      : requestState;
  const displayedSchedules = viewState === "success" ? visibleSchedules : [];

  return (
    <ThemedView
      style={[
        styles.screen,
        {
          backgroundColor:
            colorScheme === "dark" ? theme.background : "#FCF9F7",
        },
      ]}
    >
      <Header title="일정 목록" />

      <CategoryFilter
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
      />

      <FlatList
        data={displayedSchedules}
        style={styles.list}
        keyExtractor={(schedule) => schedule.id}
        contentContainerStyle={[
          styles.listContent,
          viewState !== "success" && styles.emptyListContent,
        ]}
        ItemSeparatorComponent={ScheduleSeparator}
        ListEmptyComponent={
          viewState === "success" ? null : (
            <ScheduleListState state={viewState} />
          )
        }
        renderItem={({ item }) => (
          <ScheduleCard
            schedule={item}
            onToggleCompleted={() => toggleCompleted(item.id)}
            onPress={() =>
              router.push({
                pathname: "/schedule/[id]",
                params: { id: item.id },
              })
            }
          />
        )}
      />

      <Pressable
        accessibilityLabel="새 일정 추가"
        accessibilityRole="button"
        onPress={() => router.push("/schedule/create")}
        style={({ pressed }) => [
          styles.addButton,
          { backgroundColor: theme.primary },
          pressed && styles.addButtonPressed,
        ]}
      >
        <SymbolView
          name={{ ios: "plus", android: "add", web: "add" }}
          fallback={<ThemedText style={styles.addFallback}>+</ThemedText>}
          size={30}
          tintColor={theme.primaryForeground}
        />
      </Pressable>
    </ThemedView>
  );
}

function ScheduleSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.one,
    paddingBottom: 96,
  },
  emptyListContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: BottomTabInset + 120,
  },
  separator: {
    height: 12,
  },
  addButton: {
    position: "absolute",
    right: Spacing.four,
    bottom: Spacing.four,
    width: 58,
    height: 58,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 29,
  },
  addButtonPressed: {
    opacity: 0.72,
    transform: [{ scale: 0.96 }],
  },
  addFallback: {
    color: "#FFFFFF",
    fontSize: 34,
    lineHeight: 36,
    fontWeight: "300",
  },
});
