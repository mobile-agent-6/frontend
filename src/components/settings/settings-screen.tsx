import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
} from "react-native";

import {
  SettingsConnectionBadge,
  SettingsConnectionFeedback,
  SettingsConnectionStatus,
} from "@/components/settings/settings-connection-status";
import { SettingsIpCard } from "@/components/settings/settings-ip-card";
import {
  SettingsSaveFooter,
  type SettingsSaveFeedback,
} from "@/components/settings/settings-save-footer";
import { ConfirmationModal } from "@/components/ui/confirmation-modal";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import {
  checkMockSettingsConnection,
  reverifyMockSettingsConnection,
  syncMockSettingsTime,
} from "@/services/mock/settings";
import { readSavedPiIp, writeSavedPiIp } from "@/services/storage/settings";

type Verification = {
  status:
    | "unverified"
    | "checking"
    | "syncing"
    | "rechecking"
    | "connected"
    | "time-sync-required"
    | "failed";
  ip: string | null;
  timeDifferenceSeconds: number | null;
  syncAdjusted: boolean | null;
  piTime: number | null;
  phoneTime: number | null;
  error: string | null;
};

const initialVerification: Verification = {
  status: "unverified",
  ip: null,
  timeDifferenceSeconds: null,
  syncAdjusted: null,
  piTime: null,
  phoneTime: null,
  error: null,
};

export function SettingsScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const [inputIp, setInputIp] = useState("");
  const [savedIp, setSavedIp] = useState<string | null>(null);
  const [restoreStatus, setRestoreStatus] =
    useState<"loading" | "ready" | "failed">("loading");
  const [verification, setVerification] =
    useState<Verification>(initialVerification);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving">("idle");

  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<SettingsSaveFeedback | null>(null);
  const [feedbackHeight, setFeedbackHeight] = useState(0);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSave = useRef<number | null>(null);
  const syncModalIp = useRef<string | null>(null);

  const currentInputRef = useRef(inputIp);
  const requestSequence = useRef(0);
  const activeRequest = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const initialSequence = requestSequence.current;

    readSavedPiIp()
      .then((ip) => {
        if (cancelled) return;
        setSavedIp(ip);
        // 늦게 전달된 입력 이벤트가 있다면 입력·검증 상태를 덮어쓰지 않는다.
        if (requestSequence.current === initialSequence) {
          currentInputRef.current = ip ?? "";
          setInputIp(ip ?? "");
          setVerification(initialVerification);
        }
        setRestoreStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setRestoreStatus("failed");
      });

    return () => {
      cancelled = true;
      requestSequence.current += 1;
      activeRequest.current = null;
      syncModalIp.current = null;
      activeSave.current = null;
      if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    };
  }, []);

  const normalizedIp = inputIp.trim();
  const hasIpInput = normalizedIp.length > 0;
  const isSyncProcessing =
    verification.status === "syncing" || verification.status === "rechecking";
  const isProcessing =
    restoreStatus === "loading" ||
    verification.status === "checking" ||
    isSyncProcessing ||
    isSyncModalOpen ||
    saveStatus === "saving";
  // connected는 연결 확인과 최종 시간 검증을 통과한 상태다.
  const canSave =
    hasIpInput &&
    verification.ip === normalizedIp &&
    verification.status === "connected" &&
    verification.timeDifferenceSeconds !== null &&
    Math.abs(verification.timeDifferenceSeconds) <= 60 &&
    normalizedIp !== savedIp &&
    !isProcessing;

  const hasCurrentResult =
    verification.ip === normalizedIp &&
    (verification.status === "connected" ||
      verification.status === "time-sync-required" ||
      isSyncProcessing);
  const isTimeMismatch =
    hasCurrentResult &&
    (verification.status === "time-sync-required" || isSyncProcessing);
  const canSync =
    verification.status === "time-sync-required" &&
    verification.ip === normalizedIp &&
    hasIpInput &&
    !isProcessing;
  const canCheckConnection = hasIpInput && !isProcessing && !hasCurrentResult;

  const clearSaveFeedback = () => {
    if (feedbackTimer.current !== null) {
      clearTimeout(feedbackTimer.current);
      feedbackTimer.current = null;
    }
    setSaveFeedback(null);
  };

  const renderedSequence = requestSequence.current;

  const handleIpChange = (value: string) => {
    if (activeSave.current !== null) return;
    const previousValue = currentInputRef.current;
    currentInputRef.current = value;
    setInputIp(value);
    if (value !== previousValue) {
      clearSaveFeedback();
      requestSequence.current += 1;
      activeRequest.current = null;
      setVerification(initialVerification);
      syncModalIp.current = null;
      setIsSyncModalOpen(false);
    }
  };

  const handleCheckConnection = async () => {
    if (
      !canCheckConnection ||
      renderedSequence !== requestSequence.current ||
      activeRequest.current !== null ||
      syncModalIp.current !== null
    ) return;

    const ip = currentInputRef.current.trim();
    if (!ip) return;
    const requestId = ++requestSequence.current;
    activeRequest.current = requestId;
    setVerification({ ...initialVerification, status: "checking", ip });

    const isCurrentRequest = () =>
      activeRequest.current === requestId &&
      requestSequence.current === requestId &&
      currentInputRef.current.trim() === ip;

    try {
      const result = await checkMockSettingsConnection(ip);
      if (!isCurrentRequest() || result.ip !== ip) return;
      if (result.outcome === "failed") {
        setVerification({
          ...initialVerification,
          status: "failed",
          ip,
          error: result.message,
        });
        return;
      }
      setVerification({
        ...initialVerification,
        status:
          Math.abs(result.timeDifferenceSeconds) <= 60
            ? "connected"
            : "time-sync-required",
        ip,
        piTime: result.piTime,
        phoneTime: result.phoneTime,
        timeDifferenceSeconds: result.timeDifferenceSeconds,
      });
    } catch {
      if (isCurrentRequest()) {
        setVerification({
          ...initialVerification,
          status: "failed",
          ip,
          error: "연결 확인에 실패했습니다. 다시 시도하세요.",
        });
      }
    } finally {
      if (activeRequest.current === requestId) activeRequest.current = null;
    }
  };

  const handleOpenSyncModal = () => {
    if (
      !canSync ||
      renderedSequence !== requestSequence.current ||
      verification.ip !== currentInputRef.current.trim() ||
      activeRequest.current !== null ||
      syncModalIp.current !== null
    ) return;
    requestSequence.current += 1;
    syncModalIp.current = currentInputRef.current.trim();
    setIsSyncModalOpen(true);
  };

  const handleCancelSync = () => {
    if (renderedSequence !== requestSequence.current) return;
    requestSequence.current += 1;
    syncModalIp.current = null;
    setIsSyncModalOpen(false);
  };

  const handleConfirmSync = async () => {
    const ip = syncModalIp.current;
    if (
      !ip ||
      renderedSequence !== requestSequence.current ||
      ip !== currentInputRef.current.trim() ||
      verification.status !== "time-sync-required" ||
      verification.ip !== ip ||
      activeRequest.current !== null
    ) return;

    // 동의는 한 번만 소비하고 확인 시점의 최신 휴대폰 시각을 읽는다.
    syncModalIp.current = null;
    setIsSyncModalOpen(false);
    const currentTime = Date.now();
    const requestId = ++requestSequence.current;
    activeRequest.current = requestId;
    const previousVerification = verification;
    setVerification({
      ...verification,
      status: "syncing",
      syncAdjusted: null,
      error: null,
    });

    const isCurrentRequest = () =>
      activeRequest.current === requestId &&
      requestSequence.current === requestId &&
      currentInputRef.current.trim() === ip;
    let adjusted: boolean | null = null;
    try {
      const syncResult = await syncMockSettingsTime(ip, currentTime);
      if (!isCurrentRequest() || syncResult.ip !== ip) return;
      if (syncResult.outcome === "failed") {
        setVerification({
          ...previousVerification,
          syncAdjusted: null,
          error: syncResult.message,
        });
        return;
      }
      adjusted = syncResult.adjusted;
      setVerification({
        ...previousVerification,
        status: "rechecking",
        syncAdjusted: adjusted,
        error: null,
      });
      const result = await reverifyMockSettingsConnection(syncResult);
      if (!isCurrentRequest() || result.ip !== ip) return;
      if (result.outcome === "failed") {
        setVerification({
          ...initialVerification,
          status: "failed",
          ip,
          syncAdjusted: adjusted,
          error: result.message,
        });
        return;
      }
      const isWithinThreshold = Math.abs(result.timeDifferenceSeconds) <= 60;
      setVerification({
        ...initialVerification,
        status: isWithinThreshold ? "connected" : "time-sync-required",
        ip,
        syncAdjusted: adjusted,
        piTime: result.piTime,
        phoneTime: result.phoneTime,
        timeDifferenceSeconds: result.timeDifferenceSeconds,
        error: isWithinThreshold
          ? null
          : "재검증 후에도 시간 차이가 60초를 초과합니다.",
      });
    } catch {
      if (isCurrentRequest()) {
        setVerification({
          ...(adjusted === null ? previousVerification : initialVerification),
          status: adjusted === null ? "time-sync-required" : "failed",
          ip,
          syncAdjusted: adjusted,
          error: adjusted === null
            ? "Pi 시간 맞추기에 실패했습니다. 다시 시도하세요."
            : "재검증에 실패했습니다. 다시 연결 확인을 해주세요.",
        });
      }
    } finally {
      if (activeRequest.current === requestId) activeRequest.current = null;
    }
  };
  // 이전 렌더의 이벤트가 IP 재수정 후 과거 검증을 저장하지 않도록 확인한다.
  const handleSave = async () => {
    const ip = currentInputRef.current.trim();
    if (
      !canSave ||
      ip !== verification.ip ||
      renderedSequence !== requestSequence.current ||
      activeRequest.current !== null ||
      activeSave.current !== null
    ) return;

    const requestId = ++requestSequence.current;
    activeRequest.current = requestId;
    activeSave.current = requestId;
    clearSaveFeedback();
    setSaveStatus("saving");

    const isCurrentRequest = () =>
      activeSave.current === requestId &&
      activeRequest.current === requestId &&
      requestSequence.current === requestId &&
      currentInputRef.current.trim() === ip;

    let isReadingSavedIp = restoreStatus === "failed";
    try {
      // 복원 실패는 저장값 없음과 다르므로, 기존 값을 확인하기 전에는 쓰지 않는다.
      if (isReadingSavedIp) {
        const previousIp = await readSavedPiIp();
        if (!isCurrentRequest()) return;
        setSavedIp(previousIp);
        setRestoreStatus("ready");
        isReadingSavedIp = false;
        if (previousIp === ip) return;
      }
      await writeSavedPiIp(ip);
      if (!isCurrentRequest()) return;
      setSavedIp(ip);
      setSaveFeedback({ status: "success", message: "설정이 저장되었습니다." });
      feedbackTimer.current = setTimeout(() => {
        feedbackTimer.current = null;
        setSaveFeedback(null);
      }, 3000);
    } catch {
      if (isCurrentRequest()) {
        setSaveFeedback({
          status: "error",
          message: isReadingSavedIp
            ? "기존 저장 IP를 확인하지 못해 저장하지 않았습니다. 다시 저장해 주세요."
            : "설정을 저장하지 못했습니다. 다시 저장해 주세요.",
        });
      }
    } finally {
      if (isCurrentRequest()) {
        activeSave.current = null;
        activeRequest.current = null;
        setSaveStatus("idle");
      }
    }
  };

  const screenBackground =
    colorScheme === "dark" ? theme.background : "#FCF9F7";
  const fieldBackground =
    colorScheme === "dark" ? theme.backgroundElement : theme.background;

  return (
    <ThemedView style={[styles.screen, { backgroundColor: screenBackground }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboardAvoidingView}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            saveFeedback !== null && {
              paddingBottom: Spacing.five + feedbackHeight + Spacing.two,
            },
          ]}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <SettingsIpCard
            inputIp={inputIp}
            hasIpInput={hasIpInput}
            hasCurrentResult={hasCurrentResult}
            isTimeMismatch={isTimeMismatch}
            isProcessing={isProcessing}
            isChecking={verification.status === "checking"}
            canCheckConnection={canCheckConnection}
            fieldBackground={fieldBackground}
            onIpChange={handleIpChange}
            onCheckConnection={handleCheckConnection}
            connectionBadge={
              hasCurrentResult && (
                <SettingsConnectionBadge isTimeMismatch={isTimeMismatch} />
              )
            }
            connectionFeedback={
              <SettingsConnectionFeedback
                isChecking={verification.status === "checking"}
                processingMessage={
                  restoreStatus === "loading"
                    ? "저장된 Pi IP를 불러오고 있습니다."
                    : verification.status === "syncing"
                      ? "Pi 시간을 맞추고 있습니다."
                      : verification.status === "rechecking"
                        ? "연결과 시간을 다시 확인하고 있습니다."
                        : null
                }
                error={
                  verification.error ??
                  (restoreStatus === "failed"
                    ? "저장된 Pi IP를 불러오지 못했습니다. 주소를 직접 입력해 연결을 확인하세요. 저장 시 기존 IP를 다시 확인합니다."
                    : null)
                }
              />
            }
          />

          {hasCurrentResult &&
            verification.piTime !== null &&
            verification.phoneTime !== null && (
              <SettingsConnectionStatus
                piTime={verification.piTime}
                phoneTime={verification.phoneTime}
                isTimeMismatch={isTimeMismatch}
                fieldBackground={fieldBackground}
                canSync={canSync}
                syncAdjusted={
                  verification.status === "connected"
                    ? verification.syncAdjusted
                    : null
                }
                onSyncPress={handleOpenSyncModal}
              />
            )}
        </ScrollView>

        <SettingsSaveFooter
          fieldBackground={fieldBackground}
          disabled={!canSave}
          isSaving={saveStatus === "saving"}
          feedback={saveFeedback}
          onFeedbackHeightChange={setFeedbackHeight}
          onSavePress={handleSave}
        />
      </KeyboardAvoidingView>
      <ConfirmationModal
        visible={isSyncModalOpen}
        message="Pi 시간을 휴대폰 시간으로 맞출까요?"
        cancelLabel="취소"
        confirmLabel="시간 맞추기"
        onCancel={handleCancelSync}
        onConfirm={handleConfirmSync}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  keyboardAvoidingView: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.five,
  },
});
