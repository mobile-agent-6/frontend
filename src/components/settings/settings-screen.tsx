import { useCallback, useEffect, useState } from "react";
import { AppState, KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { useStore } from "zustand";
import { SettingsConnectionBadge, SettingsConnectionFeedback, SettingsConnectionStatus } from "@/components/settings/settings-connection-status";
import { SettingsIpCard } from "@/components/settings/settings-ip-card";
import { SettingsSaveFooter } from "@/components/settings/settings-save-footer";
import { ConfirmationModal } from "@/components/ui/confirmation-modal";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { settingsConnection as connection } from "@/services/settings-runtime";

export function SettingsScreen() {
  const theme = useTheme(), colorScheme = useColorScheme();
  const state = useStore(connection.store);
  const [feedbackHeight, setFeedbackHeight] = useState(0);
  const [hiddenSave, setHiddenSave] = useState<typeof state | null>(null);
  useEffect(() => {
    if (state.phase !== "saved") return;
    const timer = setTimeout(() => setHiddenSave(state), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  useFocusEffect(useCallback(() => {
    const endEditing = connection.beginEditing();
    const listener = AppState.addEventListener("change", status => { if (status !== "active") connection.cancel(); });
    return () => { listener.remove(); endEditing(); };
  }, []));
  const busy = ["restoring", "checking", "syncing", "rechecking", "saving"].includes(state.phase);
  const canSync = !busy && !state.modal && !!state.timing?.within;
  const needsConsent = !["ready", "saved"].includes(state.phase);
  const token = state.consentToken;
  const fieldBackground = colorScheme === "dark" ? theme.backgroundElement : theme.background;
  const feedback = state.phase === "saved" && hiddenSave !== state ? { status: "success" as const, message: "설정이 저장되었습니다." } : null;
  const processing = state.phase === "restoring" ? "저장된 연결을 확인하고 있습니다."
    : state.phase === "syncing" ? "Pi 시간을 맞추고 있습니다."
      : state.phase === "rechecking" ? "연결과 시간을 다시 확인하고 있습니다." : null;
  return <ThemedView style={[styles.screen, { backgroundColor: colorScheme === "dark" ? theme.background : "#FCF9F7" }]}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.keyboardAvoidingView}>
      <ScrollView contentContainerStyle={[styles.content, feedback && { paddingBottom: Spacing.five + feedbackHeight + Spacing.two }]}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <SettingsIpCard inputIp={state.input} hasIpInput={!!state.input.trim()} hasCurrentResult={!!state.timing}
          isTimeMismatch={needsConsent} isProcessing={state.phase === "saving"} isChecking={state.phase === "checking"}
          canCheckConnection={!!state.input.trim() && !busy && !state.modal} fieldBackground={fieldBackground}
          onIpChange={connection.input} onCheckConnection={() => { void connection.check(); }}
          connectionBadge={state.timing && <SettingsConnectionBadge isTimeMismatch={needsConsent} />}
          connectionFeedback={<SettingsConnectionFeedback isChecking={state.phase === "checking"} processingMessage={processing} error={state.error} />} />
        {state.timing && <SettingsConnectionStatus piTime={state.timing.piTime} phoneTime={state.timing.phoneTime} differenceMs={state.timing.differenceMs}
          isTimeMismatch={needsConsent} fieldBackground={fieldBackground} canSync={canSync}
          syncAdjusted={needsConsent ? null : state.adjusted} onSyncPress={connection.openConsent} />}
      </ScrollView>
      <SettingsSaveFooter fieldBackground={fieldBackground} disabled={state.phase !== "ready" || state.modal}
        isSaving={state.phase === "saving"} feedback={feedback} onFeedbackHeightChange={setFeedbackHeight} onSavePress={() => { void connection.save(); }} />
    </KeyboardAvoidingView>
    <ConfirmationModal visible={state.modal} message="Pi 시간을 휴대폰 시간으로 맞출까요?" cancelLabel="취소" confirmLabel="시간 맞추기"
      onCancel={() => connection.dismissConsent(token)} onConfirm={() => { void connection.confirmConsent(token); }} />
  </ThemedView>;
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
