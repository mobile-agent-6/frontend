import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { useStore } from "zustand";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import {
  CategoryFilter,
  type ScheduleCategoryFilter,
} from "@/components/schedule-list/category-filter";
import { Header } from "@/components/navigation/header";
import { ScheduleCard } from "@/components/schedule-list/schedule-card";
import { ScheduleListState } from "@/components/schedule-list/schedule-list-state";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { BottomTabInset, Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { useScheduleData } from "@/hooks/use-schedule-data";
import { useServerScheduleData } from "@/hooks/use-server-schedule-data";
import { isMockScheduleMode, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { getMainScheduleRange } from "@/utils/schedule-query";

export default function ScheduleListScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const router = useRouter();
  const [selectedCategory, setSelectedCategory] =
    useState<ScheduleCategoryFilter>("전체");
  const serverMode = useStore(scheduleDataModeStore, (state) => state.mode === "server");
  const mock = useScheduleData(!serverMode);
  const server = useServerScheduleData(getMainScheduleRange(new Date()), serverMode);
  const schedules = serverMode ? server.schedules : mock.schedules;
  const needsRefresh = serverMode && server.hasSuccessfulRead && server.stale && !server.isFetching && !server.error;
  const readError = serverMode ? Boolean(server.error) || needsRefresh : mock.readError;
  const hasSuccessfulRead = serverMode ? server.hasSuccessfulRead : mock.hasSuccessfulRead;
  const retryRead = serverMode ? server.retryRead : mock.retryRead;
  const { retryCompletion, toggleCompleted, canOpenSchedule } = mock;
  const completionError = serverMode ? null : mock.completionError;
  const loading = serverMode && (server.initialLoading || server.isFetching);
  const canShowEmpty = serverMode ? server.success : !readError || hasSuccessfulRead;

  const visibleSchedules = useMemo(
    () => {
      const filteredSchedules =
        selectedCategory === "전체"
          ? [...schedules]
          : schedules.filter(
              (schedule) => schedule.category === selectedCategory,
            );

      return serverMode ? filteredSchedules : filteredSchedules.sort(
        (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
      );
    },
    [schedules, selectedCategory, serverMode],
  );

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
        data={visibleSchedules}
        style={styles.list}
        keyExtractor={(schedule) => schedule.id}
        contentContainerStyle={[
          styles.listContent,
          visibleSchedules.length === 0 && styles.emptyListContent,
        ]}
        ItemSeparatorComponent={ScheduleSeparator}
        ListEmptyComponent={
          !canShowEmpty ? undefined : (
            <ScheduleListState
              state="empty"
              emptyText={selectedCategory === "전체" ? undefined : `${selectedCategory} 일정이 없어요.`}
            />
          )
        }
        ListHeaderComponent={
          readError || completionError || loading ? (
            <View style={((readError && hasSuccessfulRead) || completionError) && visibleSchedules.length > 0
              ? styles.errorHeader
              : undefined}>
              {loading && <ScheduleListState state="loading" />}
              {readError && (
                <ScheduleListState
                  state="error"
                  errorTitle={needsRefresh ? "일정 정보를 다시 확인해 주세요." : hasSuccessfulRead
                    ? "최신 정보를 불러오지 못했어요. 이전 정보를 표시하고 있어요."
                    : undefined}
                  onRetry={retryRead}
                />
              )}
              {completionError && (
                <ScheduleListState
                  state="error"
                  errorTitle="완료 상태를 변경하지 못했어요."
                  onRetry={retryCompletion}
                />
              )}
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <ScheduleCard
            schedule={item}
            completionDisabled={serverMode}
            onToggleCompleted={() => isMockScheduleMode() && toggleCompleted(item)}
            onPress={() => (serverMode || canOpenSchedule()) &&
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
  errorHeader: {
    marginBottom: 24,
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
