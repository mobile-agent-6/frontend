import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { ThemedText } from "@/components/ui/themed-text";
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

function formatMockTime(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
          <View style={styles.addressSection}>
            <View style={styles.labelRow}>
              <ThemedText style={styles.label}>서버 주소 (Pi IP)</ThemedText>
              {hasCurrentResult && (
                <View
                  accessibilityLiveRegion="polite"
                  style={[
                    styles.badge,
                    { backgroundColor: isTimeMismatch ? "#FEF3C7" : "#D1FAE5" },
                  ]}
                >
                  <View
                    style={[
                      styles.badgeDot,
                      { backgroundColor: isTimeMismatch ? "#F59E0B" : "#10B981" },
                    ]}
                  />
                  <ThemedText
                    style={[
                      styles.badgeText,
                      { color: isTimeMismatch ? "#B45309" : "#047857" },
                    ]}
                  >
                    {isTimeMismatch ? "시간 동기화 필요" : "연결됨"}
                  </ThemedText>
                </View>
              )}
            </View>

            <View
              style={[
                styles.addressField,
                { backgroundColor: fieldBackground },
              ]}
            >
              <View
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <SymbolView
                  name={{ ios: "server.rack", android: "dns", web: "dns" }}
                  size={24}
                  tintColor={theme.primary}
                  fallback={
                    <ThemedText style={{ color: theme.primary }}>▤</ThemedText>
                  }
                />
              </View>
              <TextInput
                accessibilityLabel="서버 주소 (Pi IP)"
                accessibilityHint={
                  hasCurrentResult
                    ? isTimeMismatch
                      ? "시간 동기화가 필요한 주소입니다."
                      : "연결 확인을 완료한 주소입니다."
                    : hasIpInput
                      ? "아직 연결을 확인하지 않은 주소입니다."
                      : "Pi IP를 입력하세요."
                }
                editable={!isProcessing}
                accessibilityState={{ disabled: isProcessing }}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                keyboardType={
                  Platform.OS === "ios" ? "numbers-and-punctuation" : "decimal-pad"
                }
                onChangeText={handleIpChange}
                spellCheck={false}
                placeholder="192.168.0.1"
                placeholderTextColor={theme.textSecondary}
                style={[styles.textInput, { color: theme.text }]}
                value={inputIp}
              />
            </View>

            {!hasCurrentResult && (
              <Button
                label={
                  verification.status === "checking"
                    ? "연결 확인 중…"
                    : "연결 확인"
                }
                disabled={!canCheckConnection}
                onPress={handleCheckConnection}
              />
            )}
            {verification.status === "checking" && (
              <ThemedText
                type="small"
                themeColor="textSecondary"
                accessibilityLiveRegion="polite"
              >
                Pi 연결을 확인하고 있습니다.
              </ThemedText>
            )}
            {verification.status === "failed" && (
              <ThemedText
                type="small"
                themeColor="destructive"
                accessibilityRole="alert"
              >
                {verification.error}
              </ThemedText>
            )}

            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.description}
            >
              Orange Pi 핫스팟에 연결한 뒤 Pi IP를 입력하세요
            </ThemedText>
          </View>

          {hasCurrentResult &&
            verification.piTime !== null &&
            verification.phoneTime !== null && (
            <View style={styles.timeSection}>
              <View style={styles.timeHeading}>
                <SymbolView
                  name={{ ios: "clock", android: "schedule", web: "schedule" }}
                  size={20}
                  tintColor={theme.primary}
                />
                <ThemedText style={styles.label}>Pi 시각 확인</ThemedText>
              </View>
              <View
                style={[styles.timeCard, { backgroundColor: fieldBackground }]}
              >
                <View
                  style={[
                    styles.timeRow,
                    {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: theme.backgroundElement,
                    },
                  ]}
                >
                  <ThemedText type="small" themeColor="textSecondary">
                    Pi 시간
                  </ThemedText>
                  <ThemedText style={styles.timeValue}>
                    {formatMockTime(verification.piTime)}
                  </ThemedText>
                </View>
                <View style={styles.timeRow}>
                  <ThemedText type="small" themeColor="textSecondary">
                    휴대폰 시간
                  </ThemedText>
                  <ThemedText style={styles.timeValue}>
                    {formatMockTime(verification.phoneTime)}
                  </ThemedText>
                </View>
              </View>
              {isTimeMismatch && (
                <View
                  style={[styles.syncNotice, { backgroundColor: theme.primaryMuted }]}
                >
                  <ThemedText type="small" style={{ color: theme.primary }}>
                    Pi와 휴대폰 시간이 일치하지 않습니다.
                  </ThemedText>
                  <Button
                    label="Pi 시간 맞추기"
                    disabled
                    onPress={handleDisabledAction}
                  />
                </View>
              )}
            </View>
          )}
        </ScrollView>

        <SafeAreaView
          edges={["bottom"]}
          style={[
            styles.footer,
            {
              backgroundColor: fieldBackground,
              borderTopColor: theme.backgroundElement,
            },
          ]}
        >
          <Button
            label="저장"
            disabled={!isSaveImplemented || !canSave}
            onPress={handleDisabledAction}
          />
        </SafeAreaView>
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
  addressSection: {
    gap: Spacing.two,
  },
  labelRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.two,
    marginBottom: Spacing.one,
  },
  label: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "700",
    flexShrink: 1,
  },
  addressField: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.three,
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  textInput: {
    flex: 1,
    minWidth: 0,
    height: 24,
    paddingVertical: 0,
    fontSize: 16,
    // iOS 단일 행 placeholder는 네이티브 폰트의 줄 높이를 사용한다.
    lineHeight: Platform.OS === "android" ? 24 : undefined,
    fontWeight: "500",
    includeFontPadding: false,
    textAlignVertical: "center",
  },
  description: {
    marginTop: Spacing.one,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.one,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: Spacing.one,
    flexShrink: 1,
  },
  badgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "500",
    flexShrink: 1,
  },
  timeSection: {
    marginTop: Spacing.five,
    gap: Spacing.three,
  },
  timeHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
  },
  timeCard: {
    borderRadius: 16,
    overflow: "hidden",
  },
  timeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: 14,
  },
  timeValue: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  syncNotice: {
    borderRadius: 16,
    padding: Spacing.three,
    gap: Spacing.three,
  },
  footer: {
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
});
