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
import { SettingsSaveFooter } from "@/components/settings/settings-save-footer";
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
import { readSavedPiIp } from "@/services/storage/settings";

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

// 저장 동작은 후속 단계에서 연결한다. 비활성 Button의 필수 prop용이다.
const handleDisabledAction = () => {};

// 저장 실행 기능을 연결할 때 제거할 임시 제한이다. canSave 판정과 분리한다.
const isSaveImplemented = false;

export function SettingsScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const [inputIp, setInputIp] = useState("");
  const [savedIp, setSavedIp] = useState<string | null>(null);
  const [restoreStatus, setRestoreStatus] =
    useState<"loading" | "ready" | "failed">("loading");
  const [verification, setVerification] =
    useState<Verification>(initialVerification);
  const [saveStatus] = useState<"idle" | "saving">("idle");

  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
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

  const handleIpChange = (value: string) => {
    const previousValue = currentInputRef.current;
    currentInputRef.current = value;
    setInputIp(value);
    if (value !== previousValue) {
      requestSequence.current += 1;
      activeRequest.current = null;
      setVerification(initialVerification);
      syncModalIp.current = null;
      setIsSyncModalOpen(false);
    }
  };

  const handleCheckConnection = async () => {
    if (!canCheckConnection || activeRequest.current !== null) return;

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
      activeRequest.current !== null ||
      syncModalIp.current !== null
    ) return;
    syncModalIp.current = currentInputRef.current.trim();
    setIsSyncModalOpen(true);
  };

  const handleCancelSync = () => {
    syncModalIp.current = null;
    setIsSyncModalOpen(false);
  };

  const handleConfirmSync = async () => {
    const ip = syncModalIp.current;
    if (
      !ip ||
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
          ...initialVerification,
          status: "failed",
          ip,
          syncAdjusted: adjusted,
          error: "시간 맞추기 또는 재검증에 실패했습니다. 다시 연결 확인을 해주세요.",
        });
      }
    } finally {
      if (activeRequest.current === requestId) activeRequest.current = null;
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
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
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
                    ? "저장된 Pi IP를 불러오지 못했습니다. 주소를 직접 입력해 연결을 확인하세요."
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
          disabled={!isSaveImplemented || !canSave}
          onSavePress={handleDisabledAction}
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
