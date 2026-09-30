import { StyleSheet } from "react-native";

import { Header } from "@/components/header";
import { ScreenPlaceholder } from "@/components/screen-placeholder";
import { ThemedView } from "@/components/themed-view";

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
