import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScheduleCategorySelector } from "@/components/schedule-create/schedule-category-selector";
import { ScheduleDateField } from "@/components/schedule-create/schedule-date-field";
import { ScheduleNotificationToggle } from "@/components/schedule-create/schedule-notification-toggle";
import { ScheduleTimeField } from "@/components/schedule-create/schedule-time-field";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import type { Schedule, ScheduleCategory } from "@/types/schedule";
import {
  createDatePickerValue,
  createTimePickerValue,
  formatLocalDate,
  formatLocalTime,
} from "@/utils/schedule-date-time";

type ScheduleEditFormProps = {
  schedule: Schedule;
};

export function ScheduleEditForm({ schedule }: ScheduleEditFormProps) {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const [title, setTitle] = useState(schedule.title);
  const [date, setDate] = useState(schedule.date);
  const [time, setTime] = useState(schedule.time);
  const [notificationEnabled, setNotificationEnabled] = useState(
    schedule.notificationEnabled,
  );
  const [category, setCategory] = useState<ScheduleCategory>(schedule.category);
  const [activePicker, setActivePicker] = useState<"date" | "time" | null>(
    null,
  );
  const [pickerValue, setPickerValue] = useState(() => new Date());

  const fieldBackground =
    colorScheme === "dark" ? theme.backgroundElement : theme.background;
  const screenBackground =
    colorScheme === "dark" ? theme.background : "#FCF9F7";

  const openDatePicker = () => {
    Keyboard.dismiss();
    setPickerValue(createDatePickerValue(date));
    setActivePicker((current) => (current === "date" ? null : "date"));
  };

  const openTimePicker = () => {
    Keyboard.dismiss();
    setPickerValue(createTimePickerValue(time));
    setActivePicker((current) => (current === "time" ? null : "time"));
  };

  const handleDateChange = (selectedDate: Date) => {
    setPickerValue(selectedDate);
    setDate(formatLocalDate(selectedDate));

    if (Platform.OS === "android") {
      setActivePicker(null);
    }
  };

  const handleTimeChange = (selectedTime: Date) => {
    setPickerValue(selectedTime);
    setTime(formatLocalTime(selectedTime));

    if (Platform.OS === "android") {
      setActivePicker(null);
    }
  };

  return (
    <ThemedView style={[styles.screen, { backgroundColor: screenBackground }]}>
      <SafeAreaView edges={["bottom"]} style={styles.safeArea}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.keyboardAvoidingView}
        >
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.fieldGroup}>
              <ThemedText style={styles.label}>제목</ThemedText>
              <TextInput
                accessibilityLabel="일정 제목"
                onChangeText={setTitle}
                placeholder="일정 제목을 입력하세요"
                placeholderTextColor={theme.textSecondary}
                style={[
                  styles.textInput,
                  {
                    backgroundColor: fieldBackground,
                    color: theme.text,
                  },
                ]}
                value={title}
              />
            </View>

            <View style={styles.fieldGroup}>
              <ScheduleDateField
                backgroundColor={fieldBackground}
                date={date}
                expanded={activePicker === "date"}
                onPress={openDatePicker}
              />
              {activePicker === "date" ? (
                <DateTimePicker
                  accentColor={theme.primary}
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  mode="date"
                  onDismiss={() => setActivePicker(null)}
                  onValueChange={(_, selectedDate) =>
                    handleDateChange(selectedDate)
                  }
                  presentation="dialog"
                  style={Platform.OS === "ios" ? styles.picker : undefined}
                  themeVariant={colorScheme === "dark" ? "dark" : "light"}
                  value={pickerValue}
                />
              ) : null}
            </View>

            <View style={styles.fieldGroup}>
              <ScheduleTimeField
                backgroundColor={fieldBackground}
                expanded={activePicker === "time"}
                onPress={openTimePicker}
                time={time}
              />
              {activePicker === "time" ? (
                <DateTimePicker
                  accentColor={theme.primary}
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  is24Hour
                  mode="time"
                  onDismiss={() => setActivePicker(null)}
                  onValueChange={(_, selectedTime) =>
                    handleTimeChange(selectedTime)
                  }
                  presentation="dialog"
                  style={Platform.OS === "ios" ? styles.picker : undefined}
                  themeVariant={colorScheme === "dark" ? "dark" : "light"}
                  value={pickerValue}
                />
              ) : null}
            </View>

            <ScheduleNotificationToggle
              backgroundColor={fieldBackground}
              notificationEnabled={notificationEnabled}
              onValueChange={setNotificationEnabled}
            />

            <ScheduleCategorySelector
              category={category}
              onSelectCategory={setCategory}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  keyboardAvoidingView: {
    flex: 1,
  },
  content: {
    gap: 28,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.five,
  },
  fieldGroup: {
    gap: Spacing.two,
  },
  label: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "700",
  },
  textInput: {
    minHeight: 56,
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingVertical: 0,
    fontSize: 16,
    fontWeight: "500",
    textAlignVertical: "center",
  },
  picker: {
    minHeight: 180,
  },
});
