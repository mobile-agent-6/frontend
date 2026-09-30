import { SymbolView } from "expo-symbols";
import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";

type TabsProps = ComponentProps<typeof Tabs>;
type CustomTabBarProps = Parameters<NonNullable<TabsProps["tabBar"]>>[0];

const TAB_LABELS: Record<string, string> = {
  index: "목록",
  assistant: "일정 비서",
  calendar: "캘린더",
};

export function TabBar() {
  const theme = useTheme();

  return (
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.primary,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "일정 목록",
        }}
      />

      <Tabs.Screen
        name="assistant"
        options={{
          title: "일정 비서",
        }}
      />

      <Tabs.Screen
        name="calendar"
        options={{
          title: "캘린더",
        }}
      />
    </Tabs>
  );
}

function CustomTabBar({ state, navigation, insets }: CustomTabBarProps) {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const { width } = useWindowDimensions();
  const navigationBarWidth = Math.max(0, Math.min(width - 32, 430));

  return (
    <View
      style={[
        styles.container,
        {
          paddingBottom: Math.max(insets.bottom - Spacing.two, Spacing.two),
          backgroundColor:
            colorScheme === "dark" ? theme.background : "#FCF9F7",
        },
      ]}
    >
      <View
        accessibilityRole="tablist"
        style={[
          styles.navigationBar,
          {
            width: navigationBarWidth,
            backgroundColor:
              colorScheme === "dark" ? theme.backgroundElement : "#FFFFFF",
            borderColor:
              colorScheme === "dark" ? theme.backgroundSelected : "#E7E2DF",
          },
        ]}
      >
        {state.routes.map((route, index) => {
          const selected = state.index === index;
          const centerTab = route.name === "assistant";
          const label = TAB_LABELS[route.name] ?? route.name;

          const handlePress = () => {
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });

            if (!selected && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params);
            }
          };

          const handleLongPress = () => {
            navigation.emit({
              type: "tabLongPress",
              target: route.key,
            });
          };

          if (centerTab) {
            return (
              <View key={route.key} style={styles.centerSlot}>
                <Pressable
                  accessibilityLabel="일정 비서"
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onLongPress={handleLongPress}
                  onPress={handlePress}
                  style={({ pressed }) => [
                    styles.centerButton,
                    {
                      backgroundColor: theme.primary,
                      borderColor:
                        colorScheme === "dark"
                          ? theme.backgroundElement
                          : "#FFFFFF",
                    },
                    pressed && styles.centerButtonPressed,
                  ]}
                >
                  <TabIcon
                    routeName={route.name}
                    color={theme.primaryForeground}
                    size={35}
                  />
                </Pressable>
              </View>
            );
          }

          const itemColor = selected ? theme.primary : theme.textSecondary;

          return (
            <Pressable
              key={route.key}
              accessibilityLabel={label}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onLongPress={handleLongPress}
              onPress={handlePress}
              style={({ pressed }) => [
                styles.sideTab,
                selected && { backgroundColor: theme.primaryMuted },
                pressed && styles.sideTabPressed,
              ]}
            >
              <TabIcon routeName={route.name} color={itemColor} size={24} />
              <ThemedText
                numberOfLines={1}
                style={[styles.label, { color: itemColor }]}
              >
                {label}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

type TabIconProps = {
  routeName: string;
  color: string;
  size: number;
};

function TabIcon({ routeName, color, size }: TabIconProps) {
  if (routeName === "assistant") {
    return (
      <SymbolView
        name={{
          ios: "bubble",
          android: "bubble",
          web: "bubble",
        }}
        fallback={<ThemedText style={{ color }}>○</ThemedText>}
        size={size}
        tintColor={color}
      />
    );
  }

  if (routeName === "calendar") {
    return (
      <SymbolView
        name={{
          ios: "calendar",
          android: "calendar_today",
          web: "calendar_today",
        }}
        fallback={<ThemedText style={{ color }}>□</ThemedText>}
        size={size}
        tintColor={color}
      />
    );
  }

  return (
    <SymbolView
      name={{ ios: "checklist", android: "checklist", web: "checklist" }}
      fallback={<ThemedText style={{ color }}>✓</ThemedText>}
      size={size}
      tintColor={color}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flexShrink: 0,
    alignItems: "center",
    paddingTop: Spacing.two,
  },
  navigationBar: {
    height: 76,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 38,
    paddingHorizontal: 6,
    paddingVertical: 6,
    ...Platform.select({
      ios: {
        shadowColor: "#000000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 10,
      },
      android: {
        elevation: 3,
      },
      default: {},
    }),
  },
  sideTab: {
    minWidth: 0,
    height: 56,
    flex: 1.1,
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.half,
    marginHorizontal: Spacing.one,
    borderRadius: 28,
    paddingHorizontal: 10,
    paddingVertical: Spacing.half,
  },
  sideTabPressed: {
    opacity: 0.65,
  },
  label: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  centerSlot: {
    minWidth: 0,
    height: 52,
    flex: 0.8,
    alignItems: "center",
    justifyContent: "center",
  },
  centerButton: {
    width: 80,
    height: 80,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 5,
    borderRadius: 40,
    transform: [{ translateY: -19 }],
  },
  centerButtonPressed: {
    opacity: 0.82,
    transform: [{ translateY: -19 }, { scale: 0.96 }],
  },
});
