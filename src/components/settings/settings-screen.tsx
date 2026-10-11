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
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { checkMockSettingsConnection } from "@/services/mock/settings";

type Verification = {
  status:
    | "unverified"
    | "checking"
    | "syncing"
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

// 시간 맞추기와 저장 동작은 후속 단계에서 연결한다. 비활성 Button의 필수 prop용이다.
const handleDisabledAction = () => {};

// 저장 실행 기능을 연결할 때 제거할 임시 제한이다. canSave 판정과 분리한다.
const isSaveImplemented = false;

export function SettingsScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const [inputIp, setInputIp] = useState("");
  // 저장값 변경과 저장 실행은 후속 단계에서 연결한다.
  const [savedIp] = useState<string | null>(null);
  const [verification, setVerification] =
    useState<Verification>(initialVerification);
  const [saveStatus] = useState<"idle" | "saving">("idle");

  const currentInputRef = useRef(inputIp);
  const requestSequence = useRef(0);
  const activeRequest = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      requestSequence.current += 1;
      activeRequest.current = null;
    };
  }, []);

  const normalizedIp = inputIp.trim();
  const hasIpInput = normalizedIp.length > 0;
  const isProcessing =
    verification.status === "checking" ||
    verification.status === "syncing" ||
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
      verification.status === "time-sync-required");
  const isTimeMismatch =
    hasCurrentResult && verification.status === "time-sync-required";
  const canCheckConnection = hasIpInput && !isProcessing && !hasCurrentResult;

  const handleIpChange = (value: string) => {
    const previousValue = currentInputRef.current;
    currentInputRef.current = value;
    setInputIp(value);
    if (value !== previousValue) {
      requestSequence.current += 1;
      activeRequest.current = null;
      setVerification(initialVerification);
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
                error={verification.status === "failed" ? verification.error : null}
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
                onSyncPress={handleDisabledAction}
              />
            )}
        </ScrollView>

        <SettingsSaveFooter
          fieldBackground={fieldBackground}
          disabled={!isSaveImplemented || !canSave}
          onSavePress={handleDisabledAction}
        />
      </KeyboardAvoidingView>
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
