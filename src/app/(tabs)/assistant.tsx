import { StyleSheet } from "react-native";

import { ConversationList } from "@/components/assistant/conversation-list";
import { Header } from "@/components/navigation/header";
import { ThemedView } from "@/components/ui/themed-view";

export default function AssistantScreen() {
  return (
    <ThemedView style={styles.screen}>
      <Header title="일정 비서" />
      <ConversationList messages={[]} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
});
