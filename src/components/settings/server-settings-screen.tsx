import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { SettingsIpCard } from "@/components/settings/settings-ip-card";
import { SettingsConnectionBadge } from "@/components/settings/settings-connection-status";
import { SettingsSaveFooter, type SettingsSaveFeedback } from "@/components/settings/settings-save-footer";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { serverConnection, type ServerHealthResult } from "@/services/api/server-connection";
import type { SavedServer } from "@/services/storage/settings";

const notices = {
  address: "서버 주소 형식을 확인해 주세요. Pi는 IP만, 개발 서버는 HTTP(S) origin을 입력해 주세요.",
  http: "서버가 연결 확인을 거절했어요. 서버 준비 상태를 확인해 주세요.",
  response: "서버의 연결 확인 응답 형식이 올바르지 않아요.",
  clock: "서버와 휴대폰 시각 차이가 60초를 초과해요. 서버 관리자에게 확인해 주세요. 자동 시간 변경은 실행하지 않았어요.",
  timeout: "서버 연결 확인 시간이 초과됐어요.", network: "서버에 연결하지 못했어요. 네트워크와 주소를 확인해 주세요.",
  aborted: "연결 확인이 중단됐어요.",
};

export function ServerSettingsScreen() {
  const theme = useTheme(), dark = useColorScheme() === "dark";
  const [kind, setKind] = useState<SavedServer["kind"]>("pi");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"restoring" | "checking" | "saving" | null>("restoring");
  const [proof, setProof] = useState<ServerHealthResult | null>(null);
  const [feedback, setFeedback] = useState<SettingsSaveFeedback | null>(null);
  const [feedbackHeight, setFeedbackHeight] = useState(0);
  const sequence = useRef(0), locked = useRef(false), mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const kindRef = useRef<SavedServer["kind"]>("pi");
  const renderedSequence = sequence.current;

  useEffect(() => {
    mounted.current = true;
    const version = ++sequence.current;
    void serverConnection.initialize().then(() => serverConnection.read()).then(saved => {
      if (!mounted.current || version !== sequence.current) return;
      if (saved) { kindRef.current = saved.kind; setKind(saved.kind); setInput(saved.kind === "pi" ? new URL(saved.baseUrl).hostname : saved.baseUrl); }
    }).catch(() => {
      if (mounted.current && version === sequence.current) setFeedback({ status: "error", message: "저장 설정을 복원하지 못했어요. 주소를 다시 확인해 주세요. 기존 복구 기록은 유지돼요." });
    }).finally(() => { if (mounted.current && version === sequence.current) setBusy(null); });
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  const edit = (value: string, nextKind = kindRef.current) => {
    if (!mounted.current || locked.current || busy === "restoring") return;
    // 연속 native 입력은 재렌더 전에도 모두 반영한다. 전송·저장만 렌더 시퀀스로 제한한다.
    sequence.current++; controller.current?.abort(); kindRef.current = nextKind;
    setProof(null); setFeedback(null); setInput(value); setKind(nextKind);
  };
  const check = async () => {
    if (!mounted.current || locked.current || busy !== null || !input.trim() || renderedSequence !== sequence.current) return;
    locked.current = true; setBusy("checking"); setProof(null); setFeedback(null);
    const version = ++sequence.current, abort = new AbortController(); controller.current = abort;
    try {
      const result = await serverConnection.check(input, kind, abort.signal);
      if (!mounted.current || version !== sequence.current) return;
      setProof(result);
      if (!result.ok) setFeedback({ status: "error", message: notices[result.reason] });
    } catch {
      if (mounted.current && version === sequence.current) setFeedback({ status: "error", message: notices.network });
    } finally { locked.current = false; if (mounted.current && version === sequence.current) setBusy(null); }
  };
  const save = async () => {
    if (!mounted.current || locked.current || busy !== null || !proof?.ok || renderedSequence !== sequence.current) return;
    locked.current = true; setBusy("saving"); setFeedback(null);
    const version = ++sequence.current;
    try {
      await serverConnection.save(proof);
      if (mounted.current && version === sequence.current) setFeedback({ status: "success", message: "연결 설정을 저장했어요." });
    } catch {
      if (mounted.current && version === sequence.current) setFeedback({ status: "error", message: "설정을 저장하지 못했어요. 기존 서버와 복구 기록을 유지해요." });
    } finally { locked.current = false; if (mounted.current && version === sequence.current) setBusy(null); }
  };

  const fieldBackground = dark ? theme.backgroundElement : theme.background;
  return <ThemedView style={[styles.screen, { backgroundColor: dark ? theme.background : "#FCF9F7" }]}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Spacing.five + feedbackHeight }]}
        keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}>
        <View style={styles.types}>{(["pi", "development"] as const).map(value => <Pressable key={value}
          accessibilityRole="button" accessibilityState={{ selected: kind === value, disabled: busy !== null }} disabled={busy !== null}
          onPress={() => edit("", value)} style={[styles.type, { backgroundColor: kind === value ? theme.backgroundElement : fieldBackground }]}>
          <ThemedText>{value === "pi" ? "Orange Pi" : "개발 서버"}</ThemedText>
        </Pressable>)}</View>
        <SettingsIpCard inputIp={input} hasIpInput={Boolean(input.trim())} hasCurrentResult={Boolean(proof?.ok)}
          isTimeMismatch={false} isProcessing={busy !== null} isChecking={busy === "checking"} canCheckConnection={busy === null && Boolean(input.trim())}
          fieldBackground={fieldBackground} onIpChange={edit} onCheckConnection={() => { void check(); }}
          label={kind === "pi" ? "서버 주소 (Pi IP)" : "개발 서버 Base URL"} urlInput={kind === "development"}
          placeholder={kind === "pi" ? "Pi IP" : "HTTP(S) origin"}
          description={kind === "pi" ? "Orange Pi 핫스팟의 IP를 입력하세요. 포트 8000을 사용해요." : "BE가 제공한 개발 서버 origin을 입력하세요. Orange Pi 연결 확인과는 별개예요."}
          connectionBadge={proof?.ok ? <SettingsConnectionBadge isTimeMismatch={false} /> : null}
          connectionFeedback={<ThemedText type="small" themeColor="textSecondary">{busy === "restoring" ? "저장된 서버 설정을 불러오고 있어요."
            : proof?.ok ? "실제 서버의 연결과 시각을 확인했어요. 저장하면 일정과 비서가 같은 서버를 사용해요."
              : "주소를 입력하고 연결을 확인한 뒤 저장해 주세요. 연결 실패 시 Mock으로 전환하지 않아요."}</ThemedText>} />
      </ScrollView>
      <SettingsSaveFooter fieldBackground={fieldBackground} disabled={!proof?.ok || busy !== null} isSaving={busy === "saving"}
        feedback={feedback} onSavePress={() => { void save(); }} onFeedbackHeightChange={setFeedbackHeight} />
    </KeyboardAvoidingView>
  </ThemedView>;
}

const styles = StyleSheet.create({ screen: { flex: 1 }, content: { padding: Spacing.four, gap: Spacing.four },
  types: { flexDirection: "row", gap: Spacing.two }, type: { padding: Spacing.three, borderRadius: 12 } });
