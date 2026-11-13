import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { useStore } from "zustand";
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
import { useScheduleStore } from "@/stores/scheduleStore";
import { isMockScheduleMode, isScheduleRequestAllowed, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { SCHEDULE_CREATION_READ_ONLY_MESSAGE, useScheduleCreation } from "@/hooks/use-schedule-creation";
import type { Schedule, ScheduleCategory } from "@/types/schedule";
import {
  createDatePickerValue,
  createTimePickerValue,
  formatLocalDate,
  formatLocalTime,
} from "@/utils/schedule-date-time";

export function ScheduleCreateForm() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const router = useRouter();
  const serverMode = useStore(scheduleDataModeStore, (state) => state.mode === "server");
  const creation = useScheduleCreation();
  const readOnly = serverMode && !isScheduleRequestAllowed("POST", "/schedules");
  const addSchedule = useScheduleStore((state) => state.addSchedule);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [category, setCategory] = useState<ScheduleCategory | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const saveLockedRef = useRef(false);
  const [saveLocked, setSaveLocked] = useState(false);
  const [activePicker, setActivePicker] = useState<"date" | "time" | null>(
    null,
  );
  const [pickerValue, setPickerValue] = useState(() => new Date());

  const canSave =
    title.trim().length > 0 &&
    date !== null &&
    time !== null &&
    category !== null;
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

  const handleSave = async () => {
    if (!isMockScheduleMode()) {
      if (readOnly) { setFormError(SCHEDULE_CREATION_READ_ONLY_MESSAGE); return; }
      if (date === null || time === null || category === null) { setFormError("필수 항목을 모두 입력해 주세요."); return; }
      const generation = scheduleDataModeStore.getState().generation;
      setFormError(null);
      if (await creation.save({ title, date, time, category }) &&
        generation === scheduleDataModeStore.getState().generation && !isMockScheduleMode()) {
        try { router.back(); } catch { setFormError("일정은 저장되었습니다. 뒤로가기로 이전 화면으로 돌아가 주세요."); }
      }
      return;
    }
    const generation = scheduleDataModeStore.getState().generation;
    if (saveLockedRef.current) {
      return;
    }

    const trimmedTitle = title.trim();

    if (!trimmedTitle || date === null || time === null || category === null) {
      setFormError("필수 항목을 모두 입력해 주세요.");
      return;
    }

    saveLockedRef.current = true;
    setSaveLocked(true);
    setFormError(null);

    try {
      const newSchedule: Schedule = {
        id: Crypto.randomUUID(),
        title: trimmedTitle,
        date,
        time,
        category,
        completed: false,
      };

      if (!isMockScheduleMode(generation)) return;
      addSchedule(newSchedule);
    } catch {
      setFormError("일정을 저장하지 못했습니다. 다시 시도해 주세요.");
      saveLockedRef.current = false;
      setSaveLocked(false);
      return;
    }

    // 화면 이동에 오류가 나더라도 이 화면을 벗어날 때까지 저장 잠금을 유지한다.
    // 이미 저장한 일정을 저장 실패로 간주해 다시 등록하지 않도록 한다.
    try {
      if (isMockScheduleMode(generation)) router.back();
    } catch {
      setFormError("일정은 저장되었습니다. 뒤로가기로 이전 화면으로 돌아가 주세요.");
    }
  };

  const handleGetRetry = async () => {
    const generation = scheduleDataModeStore.getState().generation;
    if (await creation.retryGet() && generation === scheduleDataModeStore.getState().generation && !isMockScheduleMode()) {
      try { router.back(); } catch { setFormError("일정은 저장되었습니다. 뒤로가기로 이전 화면으로 돌아가 주세요."); }
    }
  };

  return (
    <ThemedView style={[styles.screen, { backgroundColor: screenBackground }]}>
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

          <View style={styles.categorySection}>
            <ScheduleCategorySelector
              category={category}
              onSelectCategory={setCategory}
            />

            {formError || (serverMode && (creation.error || readOnly)) ? (
              <ScheduleErrorNotice
                testID="schedule-create-feedback"
                title="일정 등록 정보를 확인해 주세요."
                description={readOnly ? SCHEDULE_CREATION_READ_ONLY_MESSAGE : serverMode ? creation.error ?? formError : formError}
                actions={serverMode && creation.needsCheck ? [{
                  key: "list", label: "목록 다시 불러오기", onPress: handleGetRetry, disabled: creation.busy,
                }] : []}
              />
            ) : null}
          </View>
        </ScrollView>

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
            onPress={handleSave}
            disabled={readOnly || !canSave || saveLocked || (serverMode && (creation.busy || creation.created))}
          />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
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
  categorySection: { gap: Spacing.four },
  footer: {
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
  },
});
