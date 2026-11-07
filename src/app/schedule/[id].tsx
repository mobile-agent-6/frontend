import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet } from "react-native";
import { useStore } from "zustand";

import { ScheduleEditForm } from "@/components/schedule-edit/schedule-edit-form";
import { ConfirmationModal } from "@/components/ui/confirmation-modal";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useScheduleStore } from "@/stores/scheduleStore";
import { isMockScheduleMode, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
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
  const schedules = useScheduleStore((state) => state.schedules);
  const deleteSchedule = useScheduleStore((state) => state.deleteSchedule);
  const updateSchedule = useScheduleStore((state) => state.updateSchedule);
  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);
  const deleteModalVisibleRef = useRef(false);
  const deleteModalDismissingRef = useRef(false);
  const [isDeleteModalDismissing, setIsDeleteModalDismissing] = useState(false);
  const pendingDeleteNavigationRef = useRef(false);
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

  // 삭제 성공 직후에도 화면 이동 전까지 form을 유지해 not-found 깜빡임을 막는다.
  const displayedSchedule = schedule ?? (!serverMode && actionLocked ? actionSchedule : null);

  const openDeleteModal = () => {
    if (!mountedRef.current || !isMockScheduleMode(generation)) return;
    if (actionLockedRef.current || deleteModalDismissingRef.current || !schedule) return;
    deleteModalVisibleRef.current = true;
    setIsDeleteModalVisible(true);
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
    navigateBack("delete");
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

  const handleSave = (updates: Partial<Schedule>) => {
    if (!mountedRef.current || !isMockScheduleMode(generation)) return;
    if (!schedule || deleteModalVisibleRef.current || Object.keys(updates).length === 0) return;
    runMutation("update", () => updateSchedule(schedule.id, updates));
  };

  const handleDelete = () => {
    if (!mountedRef.current || !isMockScheduleMode(generation)) return;
    if (!schedule || !deleteModalVisibleRef.current) return;
    runMutation("delete", () => deleteSchedule(schedule.id));
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () =>
            displayedSchedule ? (
              <Pressable
                accessibilityLabel="일정 삭제"
                accessibilityRole="button"
                disabled={serverMode || actionLocked || isDeleteModalDismissing}
                accessibilityState={{ disabled: serverMode || actionLocked || isDeleteModalDismissing }}
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

      {serverMode && (detail.initialLoading || detail.isFetching) && <ScheduleListState state="loading" />}
      {serverMode && detail.error && (
        <ScheduleListState state="error" onRetry={detail.retryRead}
          errorTitle={detail.notFound ? "일정을 찾을 수 없어요." : detail.hasSuccessfulRead
            ? "최신 정보를 불러오지 못했어요. 이전 정보를 표시하고 있어요." : "일정을 불러오지 못했어요."} />
      )}
      {displayedSchedule ? (
        <ScheduleEditForm
          key={displayedSchedule.id}
          schedule={displayedSchedule}
          onSave={handleSave}
          actionLocked={serverMode || actionLocked || isDeleteModalVisible || isDeleteModalDismissing}
          actionError={serverMode ? "수정·삭제의 실제 서버 연동은 아직 준비 중입니다." : actionError}
        />
      ) : !serverMode ? (
        <ThemedView style={styles.notFound}>
          <ThemedText>일정을 찾을 수 없어요.</ThemedText>
        </ThemedView>
      ) : null}

      <ConfirmationModal
        visible={!serverMode && isDeleteModalVisible && Boolean(schedule)}
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
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing.four,
  },
});
