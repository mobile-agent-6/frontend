import { captureScheduleOwner, createScheduleRoute, discardScheduleRoute } from "@/utils/schedule-ownership";
import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { useStore } from "zustand";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
import { useScheduleEditNavigation } from "@/hooks/use-schedule-edit-navigation";
import { useScheduleCompletion, useServerScheduleData } from "@/hooks/use-server-schedule-data";
import { isMockScheduleMode, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { getMainScheduleRange } from "@/utils/schedule-query";

export default function ScheduleListScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const router = useRouter();
  const owner = captureScheduleOwner();
  const insets = useSafeAreaInsets();
  const openSchedule = useScheduleEditNavigation();
  const [selectedCategory, setSelectedCategory] =
    useState<ScheduleCategoryFilter>("전체");
  const serverMode = useStore(scheduleDataModeStore, (state) => state.mode === "server");
  const mock = useScheduleData(!serverMode);
  const server = useServerScheduleData(getMainScheduleRange(new Date()), serverMode);
  const completion = useScheduleCompletion(server.serverId, serverMode);
  const schedules = serverMode ? server.schedules : mock.schedules;
  const readError = serverMode ? Boolean(server.error) : mock.readError;
  const hasSuccessfulRead = serverMode ? server.hasSuccessfulRead : mock.hasSuccessfulRead;
  const retryRead = serverMode ? server.retryRead : mock.retryRead;
  const { toggleCompleted, canOpenSchedule } = mock;
  const retryCompletion = serverMode ? completion.retryCompletion : mock.retryCompletion;
  const completionError = serverMode ? completion.completionError : mock.completionError;
  const needsRefresh = serverMode && server.hasSuccessfulRead && server.stale && !server.isFetching &&
    !server.error && !server.refreshPending && !completionError;
  const loading = serverMode && server.initialLoading;
  const canShowEmpty = serverMode ? server.success : !readError || hasSuccessfulRead;
  const hasFeedback = Boolean(readError || needsRefresh || completionError);
  const initialReadError = readError && !hasSuccessfulRead && schedules.length === 0;
  const feedback = <>
    {readError && !(serverMode && server.completionRefreshFailed) && <ScheduleListState state="error" onRetry={retryRead}
      variant={initialReadError ? "centered" : "card"}
      compactRetryButton={initialReadError}
      errorTitle={hasSuccessfulRead ? "최신 정보를 불러오지 못했어요. 이전 정보를 표시하고 있어요." : undefined} />}
    {needsRefresh && <ScheduleListState state="notice" errorTitle="일정 정보를 다시 확인해 주세요." onRetry={retryRead} retryLabel="일정 다시 불러오기" />}
    {completionError && <ScheduleListState state={serverMode ? completion.completionNoticeState : "error"}
      errorTitle={serverMode ? completion.completionError ?? undefined : "완료 상태를 변경하지 못했어요."}
      onRetry={retryCompletion} retryLabel={serverMode ? "완료 상태 확인하기" : undefined} />}
  </>;

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
  const centeredContent = visibleSchedules.length === 0 && (!hasFeedback || !hasSuccessfulRead);
  // 탭은 별도 레이아웃이다. 오류 카드 끝까지 FAB 위로 올려 볼 수 있는 스크롤 공간을 둔다.
  const feedbackBottomPadding = Math.max(
    centeredContent ? BottomTabInset + 120 : 96,
    Spacing.four + 58 + Spacing.three + insets.bottom,
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
          centeredContent && styles.emptyListContent,
          hasFeedback && { paddingBottom: feedbackBottomPadding },
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
          (hasFeedback || loading) ? (
            <View testID={hasFeedback ? "schedule-list-feedback" : undefined}
              style={[hasFeedback && styles.noticeStack, visibleSchedules.length > 0 && styles.errorHeader]}>
              {loading && <ScheduleListState state="loading" />}
              {feedback}
            </View>
          ) : undefined
        }
        ListHeaderComponentStyle={hasFeedback ? styles.noticeHeader : undefined}
        renderItem={({ item }) => (
          <ScheduleCard
            schedule={item}
            completionDisabled={serverMode && completion.completionDisabled(item.id)}
            onToggleCompleted={() => serverMode ? completion.toggleCompleted(item.id) : isMockScheduleMode() && toggleCompleted(item)}
            onPress={() => (serverMode || canOpenSchedule()) && openSchedule(item.id)}
          />
        )}
      />

      <Pressable
        accessibilityLabel="새 일정 추가"
        accessibilityRole="button"
        onPress={() => {
          const route = createScheduleRoute(null, owner);
          try { if (route) router.push(route); }
          catch (error) { discardScheduleRoute(route?.params.connectionKey); throw error; }
        }}
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
  noticeStack: { gap: Spacing.two },
  errorHeader: { marginBottom: Spacing.four },
  noticeHeader: { alignSelf: "stretch" },
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
