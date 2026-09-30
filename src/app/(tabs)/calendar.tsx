import { StyleSheet } from "react-native";

import { Header } from "@/components/navigation/header";
import { ScreenPlaceholder } from "@/components/ui/screen-placeholder";
import { ThemedView } from "@/components/ui/themed-view";

export default function CalendarScreen() {
  return (
    <ThemedView style={styles.screen}>
      <Header title="캘린더" />
      <ScreenPlaceholder title="캘린더" />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
});
