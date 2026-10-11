import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type SettingsSaveFooterProps = {
  fieldBackground: string;
  disabled: boolean;
  onSavePress: () => void;
};

export function SettingsSaveFooter({
  fieldBackground,
  disabled,
  onSavePress,
}: SettingsSaveFooterProps) {
  const theme = useTheme();
  return (
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
      <Button
        label="저장"
        disabled={disabled}
        onPress={onSavePress}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  footer: {
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
});
