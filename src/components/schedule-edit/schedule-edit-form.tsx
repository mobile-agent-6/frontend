import { useScheduleOwner } from "@/hooks/use-schedule-owner";
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
import { ScheduleTimeField } from "@/components/schedule-create/schedule-time-field";
import { ScheduleErrorNotice } from "@/components/schedule-list/schedule-error-notice";
import { Button } from "@/components/ui/button";
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
  onSave: (updates: Partial<Schedule>, original: Schedule) => void;
  actionLocked: boolean;
  actionError: string | null;
  errorTitle?: string;
  readError?: string | null;
  onRetryRead?: () => void;
  onRetryDetailRead?: () => void;
  retryReadLabel?: string;
  retryReadDisabled?: boolean;
};

export function ScheduleEditForm({
  schedule,
  onSave,
  actionLocked,
  actionError,
  errorTitle = "일정 정보를 확인해 주세요.",
  readError,
  onRetryRead,
  onRetryDetailRead,
  retryReadLabel = "일정 정보 다시 불러오기",
  retryReadDisabled,
}: ScheduleEditFormProps) {
  const ownsScreen = useScheduleOwner();
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const [original] = useState(() => ({
    ...schedule,
    title: schedule.title.trim(),
    date: schedule.date,
    time: schedule.time,
    category: schedule.category,
  }));
  const [title, setTitle] = useState(schedule.title);
  const [date, setDate] = useState(schedule.date);
  const [time, setTime] = useState(schedule.time);
  const [category, setCategory] = useState<ScheduleCategory>(schedule.category);
  const [activePicker, setActivePicker] = useState<"date" | "time" | null>(
    null,
  );
  const [pickerValue, setPickerValue] = useState(() => new Date());
  const [formError, setFormError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const isValid =
    trimmedTitle.length > 0 && Boolean(date) && Boolean(time) && Boolean(category);
  const updates: Partial<
    Pick<Schedule, "title" | "date" | "time" | "category">
  > = {};

  if (trimmedTitle !== original.title) updates.title = trimmedTitle;
  if (date !== original.date) updates.date = date;
  if (time !== original.time) updates.time = time;
  if (category !== original.category) updates.category = category;

  const isDirty = Object.keys(updates).length > 0;

  const handleSave = () => {
    if (!ownsScreen() || actionLocked) return;

    if (!isValid) {
      setFormError("필수 항목을 모두 입력해 주세요.");
      return;
    }

    setFormError(null);

    if (!isDirty) return;

    onSave(updates, original);
  };

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
    setFormError(null);

    if (Platform.OS === "android") {
      setActivePicker(null);
    }
  };

  const handleTimeChange = (selectedTime: Date) => {
    setPickerValue(selectedTime);
    setTime(formatLocalTime(selectedTime));
    setFormError(null);

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
                onChangeText={(value) => {
                  setTitle(value);
                  setFormError(null);
                }}
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

            <View style={styles.categorySection}>
              <ScheduleCategorySelector
                category={category}
                onSelectCategory={(value) => {
                  setCategory(value);
                  setFormError(null);
                }}
              />

              {formError || actionError || readError ? (
                <ScheduleErrorNotice
                  testID="schedule-edit-feedback"
                  title={errorTitle}
                  description={[formError, actionError]}
                  secondaryDescription={readError}
                  disabled={retryReadDisabled}
                  actions={[
                    ...(onRetryRead ? [{ key: "read", label: retryReadLabel, onPress: onRetryRead }] : []),
                    ...(onRetryDetailRead ? [{ key: "detail", label: "일정 정보 다시 불러오기", onPress: onRetryDetailRead }] : []),
                  ]}
                />
              ) : null}
            </View>
          </ScrollView>

          <View
            style={[
              styles.footer,
              {
                backgroundColor: screenBackground,
              },
            ]}
          >
            <Button
              label="수정 완료"
              onPress={handleSave}
              disabled={!isDirty || !isValid || actionLocked}
            />
          </View>
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
  categorySection: {
    gap: Spacing.four,
  },
  footer: {
    flexShrink: 0,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.three,
  },
});
