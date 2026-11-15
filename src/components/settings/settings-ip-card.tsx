import { SymbolView } from "expo-symbols";
import type { ReactNode } from "react";
import { Platform, StyleSheet, TextInput, View } from "react-native";

import { Button } from "@/components/ui/button";
import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { SETTINGS_CONNECTION_BADGE_HEIGHT } from "@/components/settings/settings-connection-status";

type SettingsIpCardProps = {
  inputIp: string;
  hasIpInput: boolean;
  hasCurrentResult: boolean;
  isTimeMismatch: boolean;
  isProcessing: boolean;
  isChecking: boolean;
  canCheckConnection: boolean;
  fieldBackground: string;
  connectionBadge: ReactNode;
  connectionFeedback: ReactNode;
  onIpChange: (value: string) => void;
  onCheckConnection: () => void;
};

export function SettingsIpCard({
  inputIp,
  hasIpInput,
  hasCurrentResult,
  isTimeMismatch,
  isProcessing,
  isChecking,
  canCheckConnection,
  fieldBackground,
  connectionBadge,
  connectionFeedback,
  onIpChange,
  onCheckConnection,
}: SettingsIpCardProps) {
  const theme = useTheme();
  return (
    <View style={styles.addressSection}>
      <View style={styles.labelRow}>
        <ThemedText style={styles.label}>서버 주소 (Pi IP)</ThemedText>
        {connectionBadge}
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
          onChangeText={onIpChange}
          spellCheck={false}
          placeholder="192.168.0.1"
          placeholderTextColor={theme.textSecondary}
          style={[styles.textInput, { color: theme.text }]}
          value={inputIp}
        />
      </View>

      {(
        <Button
          label={
            isChecking
              ? "연결 확인 중…"
              : "연결 확인"
          }
          disabled={!canCheckConnection}
          onPress={onCheckConnection}
        />
      )}
      <ThemedText
        type="small"
        themeColor="textSecondary"
        style={styles.description}
      >
        Orange Pi와 휴대폰을 통신 가능한 네트워크에 연결한 후 Orange Pi의 IP 주소를 입력해 주세요.
      </ThemedText>
      {connectionFeedback}
    </View>
  );
}

const styles = StyleSheet.create({
  addressSection: {
    gap: Spacing.two,
  },
  labelRow: {
    minHeight: SETTINGS_CONNECTION_BADGE_HEIGHT,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.two,
    marginBottom: Spacing.one,
  },
  label: {
    // Wrapped flex lines use their tallest child; keep the title independent of badge height.
    alignSelf: "flex-start",
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
    minHeight: 24,
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
});
