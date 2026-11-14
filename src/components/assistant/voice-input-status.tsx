import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, StyleSheet, View } from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import type { AssistantInputUi } from "@/utils/assistant-voice-ui";

type VoiceInputStatusProps = {
  input: AssistantInputUi;
};

const notices = {
  recording: {
    title: "듣고 있어요", description: "말씀해 주세요.",
    icon: { ios: "mic", android: "mic", web: "mic" }, fallback: "음성",
  },
  stopping: {
    title: "녹음을 마무리하고 있어요", description: "녹음 종료 후 정리 중이에요.",
    icon: { ios: "stop.circle", android: "stop_circle", web: "stop_circle" }, fallback: "■",
  },
  recorded: {
    title: "녹음이 완료됐어요", description: "아직 전송하지 않았어요.",
    icon: { ios: "checkmark.circle", android: "check_circle", web: "check_circle" }, fallback: "✓",
  },
  "permission-error": {
    title: "마이크 권한을 확인해 주세요", description: "권한을 허용한 뒤 다시 시도해 주세요.",
    icon: { ios: "mic.slash", android: "mic_off", web: "mic_off" }, fallback: "!",
  },
  "recording-error": {
    title: "녹음하지 못했어요", description: "다시 시도해 주세요.",
    icon: { ios: "exclamationmark.circle", android: "error_outline", web: "error_outline" }, fallback: "!",
  },
  recognizing: {
    title: "처리 중이에요", description: "음성을 인식하고 있어요.",
    icon: { ios: "waveform", android: "graphic_eq", web: "graphic_eq" }, fallback: "…",
  },
  processing: {
    title: "처리 중이에요", description: "일정 내용을 확인하고 있어요.",
    icon: { ios: "clock", android: "schedule", web: "schedule" }, fallback: "…",
  },
  "stt-error": {
    title: "잘 못 들었어요", description: "다시 말씀해 주세요.",
    icon: { ios: "exclamationmark.circle", android: "error_outline", web: "error_outline" }, fallback: "!",
  },
} as const;

const waveSteps = Array.from({ length: 17 }, (_, index) => index / 16);

// 음량과 무관한 진행 표시. recording에서만 마운트하고 상태 변경 시 해제한다.
function RecordingWaveform() {
  const theme = useTheme();
  const [progress] = useState(() => new Animated.Value(0));
  // 기기 설정을 확인하기 전과 확인 실패 시에도 정적인 파형을 유지한다.
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let active = true;
    let settingChanged = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      settingChanged = true;
      if (active) setReduceMotion(enabled);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active && !settingChanged) setReduceMotion(enabled);
    }, () => { /* 설정 확인 실패 시 애니메이션을 시작하지 않는다. */ });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    progress.setValue(0);
    const animation = Animated.loop(Animated.timing(progress, {
      toValue: 1,
      duration: 1400,
      easing: Easing.linear,
      useNativeDriver: true,
      isInteraction: false,
    }));
    animation.start();
    return () => {
      animation.stop();
      progress.stopAnimation();
      progress.setValue(0);
    };
  }, [progress, reduceMotion]);

  return (
    <View
      testID="voice-input-waveform"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.waveform}
    >
      {[8, 16, 12, 20].map((height, index) => (
        <Animated.View key={index} style={[styles.waveBar, {
          height,
          backgroundColor: theme.primary,
          opacity: 0.45 + index * 0.18,
          // 세로 배율은 기본 중앙 기준으로 적용되어 카드 레이아웃을 바꾸지 않는다.
          transform: reduceMotion ? undefined : [{ scaleY: progress.interpolate({
            inputRange: waveSteps,
            outputRange: waveSteps.map((step) => 0.45 + 0.55 * (1 + Math.cos(2 * Math.PI * (step - index / 4))) / 2),
          }) }],
        }]} />
      ))}
    </View>
  );
}

// 실제 녹음·서버 작업을 시작하거나 대화 메시지를 생성하지 않는다.
export function VoiceInputStatus({ input }: VoiceInputStatusProps) {
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  if (input.source === "text") return null;
  const notice = notices[input.phase];
  const isError = input.phase === "permission-error" || input.phase === "recording-error" || input.phase === "stt-error";
  const loading = input.phase === "recognizing" || input.phase === "processing";
  const iconColor = isError ? theme.destructive : theme.primary;

  return (
    <View testID="voice-input-status" style={styles.container}>
      <View testID="voice-input-card" style={[styles.card, {
        backgroundColor: dark ? theme.backgroundElement : theme.background,
        borderColor: dark ? theme.backgroundSelected : theme.backgroundElement,
      }]}>
        <View
          testID="voice-input-icon"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.icon, { backgroundColor: dark ? theme.backgroundSelected : theme.backgroundElement }]}
        >
          {loading ? <ActivityIndicator size="small" color={theme.primary} /> : (
            <SymbolView
              name={notice.icon}
              size={24}
              tintColor={iconColor}
              fallback={<ThemedText style={{ color: iconColor }}>{notice.fallback}</ThemedText>}
            />
          )}
        </View>
        <View
          style={styles.notice}
          accessible
          accessibilityRole={isError ? "alert" : "text"}
          accessibilityLabel={`${notice.title}. ${notice.description}`}
          accessibilityLiveRegion="polite"
        >
          <ThemedText style={styles.title}>{notice.title}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">{notice.description}</ThemedText>
        </View>
        {input.phase === "recording" && <RecordingWaveform />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexShrink: 0,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two + Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  notice: { flex: 1, minWidth: 0, gap: Spacing.half },
  title: { fontSize: 16, lineHeight: 24, fontWeight: "700" },
  waveform: { flexDirection: "row", alignItems: "center", gap: Spacing.one, width: 28, height: 24, flexShrink: 0 },
  waveBar: { width: 4, borderRadius: 2 },
});
