import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type MessageInputProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onStartVoice?: () => void;
  onStopVoice?: () => void;
  isRecording?: boolean;
  voiceDisabled?: boolean;
  onFocus?: () => void;
  disabled?: boolean;
};

export function MessageInput({
  value,
  onChangeText,
  onSend,
  onStartVoice,
  onStopVoice,
  isRecording = false,
  voiceDisabled = true,
  onFocus,
  disabled = false,
}: MessageInputProps) {
  const theme = useTheme();
  const canSend = value.trim().length > 0;
  const textDisabled = disabled || isRecording;
  const sendDisabled = textDisabled || !canSend;
  const buttonDisabled = isRecording
    ? voiceDisabled || !onStopVoice
    : canSend ? sendDisabled : disabled || voiceDisabled || !onStartVoice;
  const onPress = buttonDisabled ? undefined : isRecording ? onStopVoice : canSend ? onSend : onStartVoice;

  return (
    <ThemedView
      style={[styles.container, { borderTopColor: theme.backgroundElement }]}
    >
      <View style={styles.inputContainer}>
        <TextInput
          onFocus={onFocus}
          accessibilityLabel="일정 비서 메시지"
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={sendDisabled ? undefined : onSend}
          editable={!textDisabled}
          accessibilityState={{ disabled: textDisabled }}
          returnKeyType="send"
          submitBehavior="submit"
          style={[
            styles.input,
            { backgroundColor: theme.backgroundElement, color: theme.text },
          ]}
        />
        {value.length === 0 && (
          <View
            pointerEvents="none"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.placeholderContainer}
          >
            <Text
              numberOfLines={1}
              style={[styles.placeholder, { color: theme.textSecondary }]}
            >
              {isRecording ? "음성을 듣고 있어요..." : "메시지를 입력하세요"}
            </Text>
          </View>
        )}
      </View>
      <Pressable
        accessibilityLabel={isRecording ? "녹음 정지" : canSend ? "메시지 전송" : "음성 입력 시작"}
        accessibilityHint={!isRecording && !canSend && voiceDisabled ? "음성 입력은 아직 준비 중입니다." : undefined}
        accessibilityRole="button"
        accessibilityState={{ disabled: buttonDisabled }}
        disabled={buttonDisabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: theme.primary },
          buttonDisabled && styles.disabled,
          pressed && !buttonDisabled && styles.pressed,
        ]}
      >
        <SymbolView
          name={
            isRecording
              ? { ios: "stop.fill", android: "stop", web: "stop" }
              : canSend
              ? { ios: "arrow.up", android: "arrow_upward", web: "arrow_upward" }
              : { ios: "mic", android: "mic", web: "mic" }
          }
          fallback={
            <ThemedText themeColor="primaryForeground">
              {isRecording ? "■" : canSend ? "↑" : "음성"}
            </ThemedText>
          }
          size={24}
          tintColor={theme.primaryForeground}
        />
      </Pressable>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.three,
  },
  inputContainer: {
    flex: 1,
    minWidth: 0,
  },
  placeholderContainer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    justifyContent: "center",
    paddingHorizontal: Spacing.three,
  },
  placeholder: {
    fontSize: 16,
    includeFontPadding: false,
  },
  input: {
    height: 52,
    borderRadius: 26,
    paddingHorizontal: Spacing.three,
    paddingVertical: 0,
    fontSize: 16,
    textAlignVertical: "center",
    includeFontPadding: false,
  },
  button: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 26,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.7,
  },
});
