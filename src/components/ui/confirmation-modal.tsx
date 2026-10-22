import { Modal, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type ConfirmationModalProps = {
  visible: boolean;
  message: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  onDismiss?: () => void;
  confirmVariant?: "primary" | "destructive";
};

export function ConfirmationModal({
  visible,
  message,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  onDismiss,
  confirmVariant = "primary",
}: ConfirmationModalProps) {
  const theme = useTheme();

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      onDismiss={onDismiss}
      transparent
      visible={visible}
    >
      <View style={styles.backdrop}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content}>
            <View
              accessibilityViewIsModal
              onAccessibilityEscape={onCancel}
              style={[
                styles.card,
                {
                  backgroundColor: theme.background,
                  borderColor: theme.backgroundSelected,
                },
              ]}
            >
              <ThemedText style={styles.message}>{message}</ThemedText>
              <View style={styles.actions}>
                <View style={styles.action}>
                  <Button
                    label={cancelLabel}
                    onPress={onCancel}
                    variant="secondary"
                  />
                </View>
                <View style={styles.action}>
                  <Button
                    label={confirmLabel}
                    onPress={onConfirm}
                    variant={confirmVariant}
                  />
                </View>
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  safeArea: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing.four,
  },
  card: {
    width: "100%",
    maxWidth: 400,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.four,
    gap: Spacing.four,
  },
  message: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: "700",
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.three,
  },
  action: {
    flexGrow: 1,
    flexBasis: 120,
  },
});
