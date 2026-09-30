import { StyleSheet } from "react-native";

import { Header } from "@/components/navigation/header";
import { ScreenPlaceholder } from "@/components/ui/screen-placeholder";
import { ThemedView } from "@/components/ui/themed-view";

export default function AssistantScreen() {
  return (
    <ThemedView style={styles.screen}>
      <Header title="일정 비서" />
      <ScreenPlaceholder title="일정 비서" />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
});
