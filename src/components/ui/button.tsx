import { Pressable, StyleSheet } from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { useTheme } from "@/hooks/use-theme";

type ButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

export function Button({ label, onPress, disabled = false }: ButtonProps) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: theme.primary },
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <ThemedText style={[styles.text, { color: theme.primaryForeground }]}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.7,
  },
  text: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "700",
  },
});
