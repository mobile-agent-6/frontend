import { SymbolView } from "expo-symbols";
import { Link } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type HeaderProps = {
  title: string;
};

export function Header({ title }: HeaderProps) {
  const theme = useTheme();

  return (
    <SafeAreaView
      edges={["top"]}
      style={[
        styles.safeArea,
        {
          backgroundColor: theme.background,
          borderBottomColor: theme.backgroundElement,
        },
      ]}
    >
      <View style={styles.content}>
        <ThemedText type="subtitle" numberOfLines={1} style={styles.title}>
          {title}
        </ThemedText>

        <Link href="/settings" asChild>
          <Pressable
            accessibilityLabel="설정 열기"
            accessibilityRole="button"
            hitSlop={Spacing.two}
            style={({ pressed }) => [
              styles.settingsButton,
              pressed && styles.settingsButtonPressed,
            ]}
          >
            <SymbolView
              name={{ ios: "gearshape", android: "settings", web: "settings" }}
              fallback={
                <ThemedText style={styles.settingsFallback}>⚙</ThemedText>
              }
              size={28}
              tintColor={theme.textSecondary}
            />
          </Pressable>
        </Link>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  content: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.four,
  },
  title: {
    flex: 1,
  },
  settingsButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
  },
  settingsButtonPressed: {
    opacity: 0.5,
  },
  settingsFallback: {
    fontSize: 28,
    lineHeight: 32,
  },
});
