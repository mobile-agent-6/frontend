import { resolveScheduleRoute, retainScheduleRoute } from "@/utils/schedule-ownership";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// iOS의 우측 항목은 Toolbar만 담당하며 이전 headerRight 항목도 명시적으로 비운다.
const iosHeaderOptions = { headerRight: () => null };

function userMessage(message: string | null | undefined) {
  return message
    ?.replaceAll("GET 조회만 다시 시도해 주세요.", "최신 정보를 다시 불러와 주세요.")
    .replaceAll("GET으로 일정 존재 여부를 확인해 주세요.", "최신 일정 정보를 확인해 주세요.")
    .replaceAll("삭제 성공으로 처리하지 않고 GET으로 확인해 주세요.", "삭제 결과는 아직 확인되지 않았어요. 최신 정보를 확인해 주세요.") ?? null;
}

export default function ScheduleEditScreen() {
  const { id, connectionKey } = useLocalSearchParams<{ id?: string | string[]; connectionKey?: string | string[] }>();
  const scheduleId = typeof id === "string" && id.length > 0 ? id : undefined;
  const mode = useStore(scheduleDataModeStore);
  const serverMode = mode.mode === "server";
  useEffect(() => retainScheduleRoute(connectionKey), [connectionKey]);
  const owner = resolveScheduleRoute(connectionKey, scheduleId ?? null);
  const detail = useServerScheduleDetail(scheduleId, serverMode && Boolean(owner));
  if (!owner) return <><Stack.Screen options={iosHeaderOptions} /><ScheduleListState state="error" errorTitle="일정을 찾을 수 없어요." /></>;
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
  const hasSchedule = Boolean(schedule);

  const openDeleteModal = useCallback(() => {
    if (!mountedRef.current || generation !== scheduleDataModeStore.getState().generation) return;
    if (serverMode ? isMockScheduleMode() || deleteDisabled || !id ||
      !isScheduleRequestAllowed("DELETE", `/schedules/${encodeURIComponent(id)}`) : !isMockScheduleMode(generation)) return;
    if (actionLockedRef.current || deleteModalDismissingRef.current || !hasSchedule) return;
    deleteModalVisibleRef.current = true;
    setIsDeleteModalVisible(true);
  }, [deleteDisabled, generation, hasSchedule, id, serverMode]);

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
    if (!mountedRef.current || generation !== scheduleDataModeStore.getState().generation) return;
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
  const readError = serverMode && (detail.error || detail.notFound || needsRefresh) && !serverDeletion.active
    ? detail.notFound ? "일정을 찾을 수 없어요." : detail.hasSuccessfulRead
      ? needsRefresh ? "일정 정보를 다시 확인해 주세요." : "최신 정보를 불러오지 못했어요. 이전 정보를 표시하고 있어요."
      : "일정을 불러오지 못했어요."
    : null;
  // 미확인 PATCH의 retryServerRead는 같은 단건 GET과 잠금을 보존한다.
  // 성공 PATCH의 retryServerRead는 목록 GET이므로 단건 복구도 별도로 제공한다.
  const additionalDetailRetry = serverMode && serverUpdate.saved && serverUpdate.needsCheck && readError
    ? detail.retryRead : undefined;
  // 기존 Hook의 안내 상태를 사용자용 문구로만 변환한다. 요청·복구·잠금 상태는 그대로 사용한다.
  const updateFeedback = (() => {
    if (!serverMode || serverDeletion.active || !serverUpdate.needsCheck || (!serverUpdate.error && !readError)) return null;
    if (serverUpdate.saved) {
      if (readError) return {
        title: "일정은 수정됐어요",
        description: "일정 목록과 상세 정보를 최신 상태로 불러오지 못했어요.",
        retryLabel: "일정 목록 다시 불러오기",
      };
      return serverUpdate.error === "목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요." ? {
        title: "일정 목록을 불러오지 못했어요",
        description: "수정은 완료됐지만 목록을 갱신하지 못했어요.",
        retryLabel: "일정 목록 다시 불러오기",
      } : {
        title: "일정은 수정됐어요",
        description: "다만 일정 목록에 변경 내용이 표시되지 않을 수 있어요.",
        retryLabel: "일정 목록 새로고침",
      };
    }
    if (serverUpdate.error === "서버 상태를 확인하지 못했어요. 입력과 수정 잠금을 유지하고 GET 조회만 다시 시도해 주세요." ||
      serverUpdate.error === "서버 상태를 조회하지 못했어요. GET 조회만 다시 시도해 주세요." ||
      (!detail.notFound && Boolean(detail.error) && Boolean(readError))) return {
      title: "최신 정보를 불러오지 못했어요",
      description: "수정 여부가 확인되지 않았어요. 연결 상태를 확인하고 다시 조회해 주세요.",
      retryLabel: "수정 결과 다시 확인하기",
    };
    if (detail.notFound) return {
      title: "일정을 확인할 수 없어요",
      description: "현재 서버에서 일정을 찾지 못했어요. 수정 결과도 아직 확인되지 않았어요.",
      retryLabel: "수정 결과 확인하기",
    };
    if (serverUpdate.error === "서버 상태를 다시 조회했어요. 기존 수정의 적용 여부를 확인해 주세요. 자동으로 다시 저장하지 않습니다.") return {
      title: "최신 일정 정보를 불러왔어요",
      description: "변경 사항이 반영됐는지 확인해 주세요.",
      retryLabel: "다시 확인하기",
    };
    return {
      title: "수정 결과를 확인할 수 없어요",
      description: "변경 사항이 저장됐을 수도 있어요. 중복 수정을 막기 위해 먼저 최신 상태를 확인해 주세요.",
      retryLabel: "수정 결과 확인하기",
    };
  })();
  const formActionError = serverMode ? serverDeletion.error ?? serverUpdate.error ?? actionError ??
    (!patchAllowed && !deleteAllowed ? "현재 정책에서는 일정 수정·삭제를 사용할 수 없어요." : null) : actionError;
  const detailFeedback = readError ? {
    title: needsRefresh ? "일정 정보를 다시 확인해 주세요" : "일정 정보를 불러오지 못했어요",
    description: detail.notFound ? "현재 서버에서 일정을 찾지 못했어요."
      : needsRefresh ? "일정 정보를 다시 불러와 최신 상태를 확인해 주세요." : "현재 이전 정보를 표시하고 있어요.",
  } : null;
  const readFeedback = readError ? (
    <ScheduleListState state={needsRefresh ? "notice" : "error"} onRetry={detail.retryRead}
      retryLabel="일정 정보 다시 불러오기"
      errorTitle={readError} />
  ) : null;

  const showDeleteButton = Boolean(displayedSchedule);
  const headerDeleteDisabled = deleteDisabled || actionLocked || isDeleteModalDismissing;
  const destructiveColor = theme.destructive;
  // Header는 일정의 내용이 아니라 표시 여부·비활성화·색상·동작이 바뀔 때만 재등록한다.
  const headerOptions = useMemo(() => ({
    headerRight: () => showDeleteButton ? (
      <Pressable
        accessibilityLabel="일정 삭제"
        accessibilityRole="button"
        disabled={headerDeleteDisabled}
        accessibilityState={{ disabled: headerDeleteDisabled }}
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
          tintColor={destructiveColor}
          fallback={
            <ThemedText type="small" style={{ color: destructiveColor }}>
              삭제
            </ThemedText>
          }
        />
      </Pressable>
    ) : null,
  }), [destructiveColor, headerDeleteDisabled, openDeleteModal, showDeleteButton]);
  const iosDeleteToolbar = useMemo(() => {
    if (Platform.OS !== "ios") return null;
    const button = headerOptions.headerRight();
    return (
      <Stack.Toolbar placement="right">
        {button ? (
          <Stack.Toolbar.View hidesSharedBackground>
            {button}
          </Stack.Toolbar.View>
        ) : null}
      </Stack.Toolbar>
    );
  }, [headerOptions]);

  return (
    <>
      <Stack.Screen options={Platform.OS === "ios" ? iosHeaderOptions : headerOptions} />
      {iosDeleteToolbar}

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
            actionError={updateFeedback?.description ?? userMessage(formActionError)}
            errorTitle={updateFeedback?.title ?? (formActionError ? undefined : detailFeedback?.title)}
            readError={updateFeedback ? null : detailFeedback?.description}
            onRetryRead={serverMode && serverDeletion.needsCheck ? retryDeletionRead
              : serverMode && serverUpdate.needsCheck ? retryServerRead : readError ? detail.retryRead : undefined}
            onRetryDetailRead={additionalDetailRetry}
            retryReadLabel={updateFeedback?.retryLabel ?? (serverDeletion.needsCheck ? "서버 상태 다시 불러오기" : "일정 정보 다시 불러오기")}
            retryReadDisabled={serverUpdate.busy || serverDeletion.busy || detail.isFetching}
          />
        ) : !serverMode ? (
          <ThemedView style={styles.notFound}>
            <ThemedText>일정을 찾을 수 없어요.</ThemedText>
          </ThemedView>
        ) : null}
        {serverMode && !displayedSchedule && serverDeletion.active && (
          <ScheduleListState state={serverDeletion.busy ? "loading" : "error"}
            errorTitle={userMessage(serverDeletion.error) ?? (detail.notFound ? "일정을 찾을 수 없어요." : "일정 삭제 결과를 확인하고 있어요.")}
            onRetry={serverDeletion.busy ? undefined : retryDeletionRead} />
        )}
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
    width: 44,
    height: 44,
    flexGrow: 0,
    flexShrink: 0,
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
