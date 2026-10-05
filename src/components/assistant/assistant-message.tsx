import { StyleSheet } from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";

type AssistantMessageProps = {
  text: string;
};

export function AssistantMessage({ text }: AssistantMessageProps) {
  return (
    <ThemedView type="primary" style={styles.bubble}>
      <ThemedText themeColor="primaryForeground">{text}</ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  bubble: {
    alignSelf: "flex-start",
    maxWidth: "85%",
    borderRadius: 20,
    borderBottomLeftRadius: 4,
    padding: Spacing.three,
  },
});
