import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from "react-native";
import { useStore } from "zustand";

import { ScheduleEditForm } from "@/components/schedule-edit/schedule-edit-form";
import { ConfirmationModal } from "@/components/ui/confirmation-modal";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useScheduleStore } from "@/stores/scheduleStore";
import { isMockScheduleMode, isScheduleRequestAllowed, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { useScheduleUpdate } from "@/hooks/use-schedule-update";
import { useScheduleDeletion } from "@/hooks/use-schedule-deletion";
import { useServerScheduleDetail } from "@/hooks/use-server-schedule-data";
import { ScheduleListState } from "@/components/schedule-list/schedule-list-state";
import type { Schedule } from "@/types/schedule";

export default function ScheduleEditScreen() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const scheduleId = typeof id === "string" && id.length > 0 ? id : undefined;
  const mode = useStore(scheduleDataModeStore);
  const serverMode = mode.mode === "server";
  const detail = useServerScheduleDetail(scheduleId, serverMode);
  // 대상·서버·모드가 달라지면 폼과 native 모달 상태도 별도 수명으로 시작한다.
  return <ScheduleEditContent key={JSON.stringify([mode.generation, serverMode ? detail.serverId : null, scheduleId])}
    id={scheduleId} serverMode={serverMode} generation={mode.generation} detail={detail} />;
}

function ScheduleEditContent({ id, serverMode, generation, detail }: {
  id: string | undefined;
  serverMode: boolean;
  generation: number;
  detail: ReturnType<typeof useServerScheduleDetail>;
}) {
  const router = useRouter();
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const serverUpdate = useScheduleUpdate(id, detail.serverId);
  const serverDeletion = useScheduleDeletion(id, detail.serverId);
  const patchAllowed = serverMode && Boolean(id) && isScheduleRequestAllowed("PATCH", `/schedules/${encodeURIComponent(id ?? "")}`);
  const deleteAllowed = serverMode && Boolean(id) && isScheduleRequestAllowed("DELETE", `/schedules/${encodeURIComponent(id ?? "")}`);
  const deleteDisabled = serverMode && (!deleteAllowed || detail.isFetching || !detail.hasDetailSuccess || Boolean(detail.error) ||
    serverUpdate.busy || serverUpdate.blocked || serverDeletion.busy || serverDeletion.blocked);
  const schedules = useScheduleStore((state) => state.schedules);
  const deleteSchedule = useScheduleStore((state) => state.deleteSchedule);
  const updateSchedule = useScheduleStore((state) => state.updateSchedule);
  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);
  const deleteModalVisibleRef = useRef(false);
  const deleteModalDismissingRef = useRef(false);
  const [isDeleteModalDismissing, setIsDeleteModalDismissing] = useState(false);
  const pendingDeleteNavigationRef = useRef(false);
  const serverDeleteNavigatedRef = useRef(false);
  const actionLockedRef = useRef(false);
  const [actionLocked, setActionLocked] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSchedule, setActionSchedule] = useState<Schedule | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; pendingDeleteNavigationRef.current = false; };
  }, []);
  const schedule = serverMode ? detail.schedule :
    typeof id === "string" && id.length > 0
      ? schedules.find((item) => item.id === id)
      : undefined;

  // 확정 성공 또는 결과 확인 중에는 원래 폼을 유지해 입력 유실·not-found 깜빡임을 막는다.
  const displayedSchedule = schedule ?? ((serverMode ? serverUpdate.busy || serverUpdate.blocked || serverDeletion.active : actionLocked) ? actionSchedule : null);
  const initialLoading = serverMode && detail.initialLoading && !displayedSchedule && !serverDeletion.active;

  const openDeleteModal = () => {
    if (!mountedRef.current || generation !== scheduleDataModeStore.getState().generation) return;
    if (serverMode ? isMockScheduleMode() || deleteDisabled || !id ||
      !isScheduleRequestAllowed("DELETE", `/schedules/${encodeURIComponent(id)}`) : !isMockScheduleMode(generation)) return;
    if (actionLockedRef.current || deleteModalDismissingRef.current || !schedule) return;
    deleteModalVisibleRef.current = true;
    setIsDeleteModalVisible(true);
  };

  const navigateServerDelete = () => {
    if (!mountedRef.current || isMockScheduleMode() || generation !== scheduleDataModeStore.getState().generation || serverDeleteNavigatedRef.current) return;
    serverDeleteNavigatedRef.current = true;
    try { router.back(); } catch { setActionError("일정은 삭제되었습니다. 뒤로가기로 이전 화면으로 돌아가 주세요."); }
  };
  const finishServerDelete = () => {
    if (!mountedRef.current) return;
    if (deleteModalDismissingRef.current) pendingDeleteNavigationRef.current = true;
    else navigateServerDelete();
  };
  const closeDeleteModal = () => {
    if (actionLockedRef.current || !deleteModalVisibleRef.current) return;
    deleteModalVisibleRef.current = false;
    if (Platform.OS === "ios") {
      deleteModalDismissingRef.current = true;
      setIsDeleteModalDismissing(true);
    }
    setIsDeleteModalVisible(false);
  };

  const navigateBack = (kind: "update" | "delete") => {
    if (!mountedRef.current || !isMockScheduleMode(generation)) return;
    // 데이터 변경 성공 후에는 화면 이동에 실패해도 잠금을 풀거나 재실행하지 않는다.
    try {
      router.back();
    } catch {
      setActionError(
        kind === "update"
          ? "일정은 수정되었습니다. 뒤로가기로 이전 화면으로 돌아가 주세요."
          : "일정은 삭제되었습니다. 뒤로가기로 이전 화면으로 돌아가 주세요.",
      );
    }
  };

  const handleDeleteModalDismiss = () => {
    deleteModalDismissingRef.current = false;
    setIsDeleteModalDismissing(false);
    if (!pendingDeleteNavigationRef.current) return;
    pendingDeleteNavigationRef.current = false;
    if (serverMode) navigateServerDelete(); else navigateBack("delete");
  };

  const runMutation = (kind: "update" | "delete", mutate: () => void) => {
    if (
      !mountedRef.current || !isMockScheduleMode(generation) ||
      actionLockedRef.current ||
      deleteModalDismissingRef.current ||
      !schedule ||
      !useScheduleStore.getState().schedules.some((item) => item.id === schedule.id)
    ) {
      return;
    }

    actionLockedRef.current = true;
    setActionLocked(true);
    setActionSchedule(schedule);
    setActionError(null);
    if (deleteModalVisibleRef.current && Platform.OS === "ios") {
      deleteModalDismissingRef.current = true;
      setIsDeleteModalDismissing(true);
    }
    deleteModalVisibleRef.current = false;
    setIsDeleteModalVisible(false);

    try {
      mutate();
    } catch {
      setActionError(
        kind === "update"
          ? "일정을 수정하지 못했습니다. 다시 시도해 주세요."
          : "일정을 삭제하지 못했습니다. 다시 삭제를 확인해 주세요.",
      );
      actionLockedRef.current = false;
      setActionLocked(false);
      setActionSchedule(null);
      return;
    }

    // iOS 모달이 완전히 닫힌 뒤 화면을 이동해 두 native 전환이 겹치지 않게 한다.
    if (kind === "delete" && deleteModalDismissingRef.current) {
      pendingDeleteNavigationRef.current = true;
      return;
    }
    navigateBack(kind);
  };

  const finishServerUpdate = () => {
    if (!mountedRef.current || isMockScheduleMode() || generation !== scheduleDataModeStore.getState().generation) return;
    try { router.back(); } catch { setActionError("일정은 수정되었습니다. 뒤로가기로 이전 화면으로 돌아가 주세요."); }
  };
  const retryServerRead = async () => { if (await serverUpdate.retryGet()) finishServerUpdate(); };
  const retryDeletionRead = async () => { if (await serverDeletion.retryGet()) finishServerDelete(); };
  const handleSave = async (updates: Partial<Schedule>, original: Schedule) => {
    if (serverMode) {
      if (!mountedRef.current || isMockScheduleMode() || generation !== scheduleDataModeStore.getState().generation ||
        !patchAllowed || detail.isFetching || !detail.hasDetailSuccess || detail.error || deleteModalVisibleRef.current || deleteModalDismissingRef.current) return;
      setActionSchedule(schedule ?? original);
      if (await serverUpdate.save(original, updates)) finishServerUpdate();
      return;
    }
    if (!mountedRef.current || !isMockScheduleMode(generation)) return;
    if (!schedule || deleteModalVisibleRef.current || Object.keys(updates).length === 0) return;
    runMutation("update", () => updateSchedule(schedule.id, updates));
  };

  const handleDelete = async () => {
    if (serverMode) {
      if (!mountedRef.current || isMockScheduleMode() || generation !== scheduleDataModeStore.getState().generation ||
        !id || !schedule || !deleteModalVisibleRef.current || deleteDisabled ||
        !isScheduleRequestAllowed("DELETE", `/schedules/${encodeURIComponent(id)}`)) return;
      setActionSchedule(schedule);
      closeDeleteModal();
      if (await serverDeletion.remove()) finishServerDelete();
      return;
    }
    if (!mountedRef.current || !isMockScheduleMode(generation)) return;
    if (!schedule || !deleteModalVisibleRef.current) return;
    runMutation("delete", () => deleteSchedule(schedule.id));
  };

  const needsRefresh = serverMode && Boolean(displayedSchedule) && detail.stale && !detail.isFetching &&
    !detail.error && !detail.refreshPending;
  const readFeedback = serverMode && (detail.error || detail.notFound || needsRefresh) && !serverDeletion.active ? (
    <ScheduleListState state={needsRefresh ? "notice" : "error"} onRetry={detail.retryRead}
      retryLabel={needsRefresh ? "GET 다시 조회" : undefined}
      errorTitle={detail.notFound ? "일정을 찾을 수 없어요." : detail.hasSuccessfulRead
        ? needsRefresh ? "일정 정보를 다시 확인해 주세요." : "최신 정보를 불러오지 못했어요. 이전 정보를 표시하고 있어요."
        : "일정을 불러오지 못했어요."} />
  ) : null;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () =>
            displayedSchedule ? (
              <Pressable
                accessibilityLabel="일정 삭제"
                accessibilityRole="button"
                disabled={deleteDisabled || actionLocked || isDeleteModalDismissing}
                accessibilityState={{ disabled: deleteDisabled || actionLocked || isDeleteModalDismissing }}
                onPress={openDeleteModal}
                style={({ pressed }) => [
                  styles.deleteButton,
                  pressed && styles.deleteButtonPressed,
                ]}
              >
                <SymbolView
                  name={{
                    ios: "trash",
                    android: "delete_outline",
                    web: "delete_outline",
                  }}
                  size={24}
                  tintColor={theme.destructive}
                  fallback={
                    <ThemedText type="small" style={{ color: theme.destructive }}>
                      삭제
                    </ThemedText>
                  }
                />
              </Pressable>
            ) : null,
        }}
      />

      <View testID="schedule-edit-content" style={[styles.contentArea,
        { backgroundColor: colorScheme === "dark" ? theme.background : "#FCF9F7" }]}>
        {!displayedSchedule && readFeedback}
        {displayedSchedule ? (
          <ScheduleEditForm
            key={displayedSchedule.id}
            schedule={displayedSchedule}
            onSave={handleSave}
            actionLocked={(serverMode && (!patchAllowed || detail.isFetching || !detail.hasDetailSuccess || Boolean(detail.error) ||
              serverUpdate.busy || serverUpdate.blocked || serverDeletion.busy || serverDeletion.blocked)) || actionLocked || isDeleteModalVisible || isDeleteModalDismissing}
            actionError={serverMode ? serverDeletion.error ?? serverUpdate.error ?? actionError ?? (!patchAllowed && !deleteAllowed ? "현재 정책에서는 일정 수정·삭제를 사용할 수 없어요." : null) : actionError}
            onRetryRead={serverMode && serverDeletion.needsCheck ? retryDeletionRead : serverMode && serverUpdate.needsCheck ? retryServerRead : undefined}
            retryReadDisabled={serverUpdate.busy || serverDeletion.busy}
          />
        ) : !serverMode ? (
          <ThemedView style={styles.notFound}>
            <ThemedText>일정을 찾을 수 없어요.</ThemedText>
          </ThemedView>
        ) : null}
        {serverMode && !displayedSchedule && serverDeletion.active && (
          <ScheduleListState state={serverDeletion.busy ? "loading" : "error"}
            errorTitle={serverDeletion.error ?? (detail.notFound ? "일정을 찾을 수 없어요." : "일정 삭제 결과를 확인하고 있어요.")}
            onRetry={serverDeletion.busy ? undefined : retryDeletionRead} />
        )}
        {displayedSchedule && readFeedback}
        {initialLoading && <View testID="schedule-edit-loading-overlay" style={[styles.loadingOverlay,
          { backgroundColor: colorScheme === "dark" ? "rgba(0, 0, 0, 0.18)" : "rgba(252, 249, 247, 0.55)" }]}>
          <ActivityIndicator color={theme.primary} accessibilityLabel="일정을 불러오는 중" />
        </View>}
      </View>

      <ConfirmationModal
        visible={isDeleteModalVisible && Boolean(schedule) && (!serverMode || deleteAllowed)}
        message="삭제할까요?"
        cancelLabel="아니요"
        confirmLabel="예"
        confirmVariant="destructive"
        onCancel={closeDeleteModal}
        onConfirm={handleDelete}
        onDismiss={handleDeleteModalDismiss}
      />
    </>
  );
}

const styles = StyleSheet.create({
  deleteButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteButtonPressed: {
    opacity: 0.7,
  },
  contentArea: { flex: 1 },
  loadingOverlay: {
    position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    alignItems: "center", justifyContent: "center",
  },
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing.four,
  },
});
