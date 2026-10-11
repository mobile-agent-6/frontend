import { SymbolView } from "expo-symbols";
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

// Step 1은 정적인 레이아웃만 제공한다. 비활성 Button의 필수 prop용이다.
const handleDisabledAction = () => {};

export function SettingsScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
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
              {/* 초기 미검증 상태에서는 연결 상태 badge를 표시하지 않는다. */}
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
                accessibilityState={{ disabled: true }}
                editable={false}
                caretHidden
                placeholder="192.168.0.1"
                placeholderTextColor={theme.textSecondary}
                style={[styles.textInput, { color: theme.text }]}
                value=""
              />
            </View>

            <Button
              label="연결 확인"
              disabled
              onPress={handleDisabledAction}
            />

            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.description}
            >
              Orange Pi 핫스팟에 연결한 뒤 Pi IP를 입력하세요
            </ThemedText>
          </View>
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
          <Button label="저장" disabled onPress={handleDisabledAction} />
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
  footer: {
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
});
