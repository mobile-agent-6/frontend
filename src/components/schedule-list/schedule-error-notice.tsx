import { SymbolView } from "expo-symbols";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";

type RecoveryAction = {
  key: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
};

type ScheduleErrorNoticeProps = {
  title: string;
  description?: string | readonly (string | null | undefined)[] | null;
  secondaryDescription?: string | null;
  actions?: readonly RecoveryAction[];
  loading?: boolean;
  disabled?: boolean;
  tone?: "error" | "notice";
  testID?: string;
  variant?: "card" | "centered";
  compactActions?: boolean;
};

// 표시 문구만 변환한다. 원래 오류 상태와 복구 판단에는 관여하지 않는다.
function userMessage(message: string) {
  return message
    .replaceAll("GET 조회만 다시 시도해 주세요.", "최신 정보를 다시 불러와 주세요.")
    .replaceAll("이전 PATCH의 성공 여부를 뜻하지 않아요.", "이전 완료 변경이 성공했다는 뜻은 아니에요.")
    .replaceAll("PATCH를 다시 보내지 않고", "변경을 다시 요청하지 않고")
    .replaceAll("GET으로", "최신 정보를 불러와")
    .replace(/\bGET\b/g, "정보 조회")
    .replace(/\bPATCH\b/g, "수정 요청")
    .replace(/\bPOST\b/g, "등록 요청")
    .replace(/\bDELETE\b/g, "삭제 요청");
}

export function ScheduleErrorNotice({
  title, description, secondaryDescription, actions = [], loading = false,
  disabled = false, tone = "error", testID = "schedule-error-notice", variant = "card",
  compactActions = false,
}: ScheduleErrorNoticeProps) {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const displayTitle = userMessage(title);
  const descriptions = [...new Set((Array.isArray(description) ? description : [description])
    .filter((text): text is string => Boolean(text)).map(userMessage))]
    .filter((text) => text !== displayTitle);
  const secondary = secondaryDescription ? userMessage(secondaryDescription) : null;
  const busy = loading || actions.some((action) => action.loading);
  const centered = variant === "centered";
  const compactButton = centered && compactActions;

  return (
    <View
      testID={testID}
      accessibilityRole={tone === "error" ? "alert" : undefined}
      accessibilityLiveRegion="polite"
      accessibilityState={{ busy }}
      style={centered ? styles.centered : [styles.card, { backgroundColor: colorScheme === "dark" ? theme.backgroundElement : theme.background }]}
    >
      <View style={[styles.messages, centered && styles.centeredMessages]}>
        <View style={[styles.heading, centered && styles.centeredHeading]}>
          <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {busy ? <ActivityIndicator color={theme.primary} /> : (
              <SymbolView
                name={{ ios: "exclamationmark.circle", android: "error_outline", web: "error_outline" }}
                size={20}
                tintColor={theme.primary}
                fallback={<ThemedText themeColor="primary">!</ThemedText>}
              />
            )}
          </View>
          <ThemedText style={[styles.title, { color: theme.primary }, centered && styles.centeredTitle]}>{displayTitle}</ThemedText>
        </View>
        {descriptions.map((text) => <ThemedText key={text} type="small" style={[styles.description, centered && styles.centeredText]}>{text}</ThemedText>)}
        {secondary && secondary !== displayTitle && !descriptions.includes(secondary) && (
          <ThemedText type="small" themeColor="textSecondary" style={[styles.description, centered && styles.centeredText]}>{secondary}</ThemedText>
        )}
      </View>
      {actions.map((action) => (
        <Button
          key={action.key}
          label={userMessage(action.label)}
          onPress={action.onPress}
          disabled={Boolean(disabled || loading || action.disabled || action.loading)}
          variant="secondary"
          style={centered
            ? [colorScheme === "dark" && styles.darkRecoveryButton, styles.centeredButton, compactButton && styles.compactButton]
            : colorScheme === "dark" ? styles.darkRecoveryButton : undefined}
          textStyle={compactButton ? styles.compactButtonText : undefined}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { width: "100%", alignItems: "center", padding: Spacing.three, gap: Spacing.two + Spacing.one },
  centeredMessages: { width: "100%", alignItems: "center" },
  centeredHeading: { width: "100%", flexDirection: "column", alignItems: "center" },
  centeredTitle: { flex: 0, textAlign: "center" },
  centeredText: { textAlign: "center" },
  centeredButton: { alignSelf: "center", minWidth: Spacing.six * 2, maxWidth: "100%", paddingHorizontal: Spacing.four },
  compactButton: { width: 120, minWidth: 120, minHeight: 44, borderRadius: 12 },
  compactButtonText: { fontSize: 16, fontWeight: "600" },
  darkRecoveryButton: { backgroundColor: "#3A3E44" },
  card: {
    width: "100%",
    borderRadius: 12,
    padding: Spacing.three,
    gap: Spacing.two + Spacing.one,
  },
  messages: { gap: Spacing.two },
  heading: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.two },
  title: { flex: 1, fontSize: 16, lineHeight: 24, fontWeight: "600", textAlign: "left" },
  description: { fontSize: 14, lineHeight: 20, fontWeight: "500", textAlign: "left" },
});
