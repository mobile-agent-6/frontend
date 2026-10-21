import { SymbolView } from "expo-symbols";
import {
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import type { Schedule } from "@/types/schedule";

type ScheduleCardProps = {
  schedule: Schedule;
  onPress: () => void;
  onToggleCompleted: () => void;
  showDate?: boolean;
};

function formatScheduleDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const localDate = new Date(year, month - 1, day);
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][localDate.getDay()];

  return `${month}월 ${day}일 (${weekday})`;
}

export function ScheduleCard({
  schedule,
  onPress,
  onToggleCompleted,
  showDate = true,
}: ScheduleCardProps) {
  const theme = useTheme();
  const colorScheme = useColorScheme();

  const handleToggle = (event: GestureResponderEvent) => {
    event.stopPropagation();
    onToggleCompleted();
  };

  return (
    <Pressable
      accessibilityLabel={`${schedule.title} 일정 열기`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: theme.background },
        schedule.completed && styles.completedCard,
        pressed && styles.pressed,
      ]}
    >
      <Pressable
        accessibilityLabel={
          schedule.completed
            ? `${schedule.title} 완료 취소`
            : `${schedule.title} 완료`
        }
        accessibilityRole="checkbox"
        accessibilityState={{ checked: schedule.completed }}
        hitSlop={Spacing.two}
        onPress={handleToggle}
        style={[
          styles.toggle,
          {
            backgroundColor: schedule.completed ? "#86D9B5" : "transparent",
            borderColor: schedule.completed
              ? "#86D9B5"
              : colorScheme === "dark"
                ? theme.textSecondary
                : "#D3CFCC",
          },
        ]}
      >
        {schedule.completed ? (
          <SymbolView
            name={{ ios: "checkmark", android: "check", web: "check" }}
            fallback={<ThemedText style={styles.checkFallback}>✓</ThemedText>}
            size={16}
            tintColor="#FFFFFF"
          />
        ) : null}
      </Pressable>

      <View style={styles.details}>
        <View style={styles.titleContainer}>
          <ThemedText
            numberOfLines={1}
            style={[
              styles.title,
              schedule.completed && { color: theme.textSecondary },
            ]}
          >
            {schedule.title}
          </ThemedText>

          {schedule.completed ? (
            <View
              pointerEvents="none"
              style={[
                styles.titleStrike,
                { backgroundColor: theme.textSecondary },
              ]}
            />
          ) : null}
        </View>

        <View style={styles.metadata}>
          <ThemedText
            type="small"
            style={[
              styles.time,
              {
                color: theme.textSecondary,
                opacity: schedule.completed ? 0.65 : 1,
              },
            ]}
          >
            {showDate ? `${formatScheduleDate(schedule.date)}  ` : null}
            {schedule.time}
          </ThemedText>
        </View>
      </View>

      <View
        style={[
          styles.badge,
          {
            backgroundColor:
              colorScheme === "dark" ? theme.backgroundElement : "#F3EFED",
          },
        ]}
      >
        <ThemedText
          type="smallBold"
          style={{
            color: colorScheme === "dark" ? theme.textSecondary : "#796F69",
          }}
        >
          {schedule.category}
        </ThemedText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.three,
    borderRadius: 20,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  completedCard: {
    opacity: 0.58,
  },
  pressed: {
    opacity: 0.7,
  },
  toggle: {
    width: 28,
    height: 28,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderRadius: 14,
  },
  checkFallback: {
    color: "#FFFFFF",
    fontSize: 16,
    lineHeight: 18,
    fontWeight: "700",
  },
  details: {
    minWidth: 0,
    flex: 1,
    gap: Spacing.half,
  },
  titleContainer: {
    maxWidth: "100%",
    alignSelf: "flex-start",
  },
  title: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "700",
  },
  titleStrike: {
    position: "absolute",
    top: "50%",
    left: 0,
    right: 0,
    height: 1,
  },
  metadata: {
    minHeight: 20,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: Spacing.one,
  },
  time: {
    flexShrink: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  badge: {
    flexShrink: 0,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
});
