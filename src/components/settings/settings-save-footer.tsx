import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

export type SettingsSaveFeedback = {
  status: "success" | "error";
  message: string;
};

type SettingsSaveFooterProps = {
  fieldBackground: string;
  disabled: boolean;
  isSaving: boolean;
  feedback: SettingsSaveFeedback | null;
  onSavePress: () => void;
};

export function SettingsSaveFooter({
  fieldBackground,
  disabled,
  isSaving,
  feedback,
  onSavePress,
}: SettingsSaveFooterProps) {
  const theme = useTheme();
  return (
    <View style={styles.container}>
      {/* SafeArea 패딩과 분리한 기준점: 피드백이 footer 높이를 바꾸지 않는다. */}
      <View pointerEvents="none" style={styles.feedbackAnchor}>
        {feedback && (
          <View
            style={[
              styles.feedback,
              {
                backgroundColor:
                  feedback.status === "success" ? "#EAF7F1" : fieldBackground,
                borderColor:
                  feedback.status === "success" ? "#D1FAE5" : theme.destructive,
              },
            ]}
          >
            <ThemedText
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[
                styles.feedbackText,
                { color: feedback.status === "success" ? "#047857" : theme.destructive },
              ]}
            >
              {feedback.message}
            </ThemedText>
          </View>
        )}
      </View>
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
          label={isSaving ? "저장 중…" : "저장"}
          disabled={disabled}
          onPress={onSavePress}
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexShrink: 0,
  },
  feedbackAnchor: {
    height: 0,
    flexShrink: 0,
    position: "relative",
    zIndex: 1,
  },
  feedback: {
    position: "absolute",
    bottom: Spacing.two,
    left: Spacing.four,
    right: Spacing.four,
    padding: Spacing.three,
    borderWidth: 1,
    borderRadius: 16,
  },
  feedbackText: {
    textAlign: "center",
    fontWeight: "700",
  },
  footer: {
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
});
