import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, StyleSheet } from "react-native";

import { ScheduleEditForm } from "@/components/schedule-edit/schedule-edit-form";
import { ConfirmationModal } from "@/components/ui/confirmation-modal";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useScheduleStore } from "@/stores/scheduleStore";

export default function ScheduleEditScreen() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const router = useRouter();
  const theme = useTheme();
  const schedules = useScheduleStore((state) => state.schedules);
  const deleteSchedule = useScheduleStore((state) => state.deleteSchedule);
  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);
  const schedule =
    typeof id === "string" && id.length > 0
      ? schedules.find((item) => item.id === id)
      : undefined;

  const closeDeleteModal = () => setIsDeleteModalVisible(false);
  const handleDelete = () => {
    if (!schedule) return;

    deleteSchedule(schedule.id);
    closeDeleteModal();
    router.back();
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () =>
            schedule ? (
              <Pressable
                accessibilityLabel="일정 삭제"
                accessibilityRole="button"
                onPress={() => setIsDeleteModalVisible(true)}
                style={({ pressed }) => [
                  styles.deleteButton,
                  pressed && styles.deleteButtonPressed,
                ]}
              >
                <SymbolView
                  name={{
                    ios: "trash",
                    android: "delete_outline",
                    web: "delete_outline",
                  }}
                  size={24}
                  tintColor={theme.destructive}
                  fallback={
                    <ThemedText type="small" style={{ color: theme.destructive }}>
                      삭제
                    </ThemedText>
                  }
                />
              </Pressable>
            ) : null,
        }}
      />

      {schedule ? (
        <ScheduleEditForm key={schedule.id} schedule={schedule} />
      ) : (
        <ThemedView style={styles.notFound}>
          <ThemedText>일정을 찾을 수 없어요.</ThemedText>
        </ThemedView>
      )}

      <ConfirmationModal
        visible={isDeleteModalVisible && Boolean(schedule)}
        message="삭제할까요?"
        cancelLabel="아니요"
        confirmLabel="예"
        confirmVariant="destructive"
        onCancel={closeDeleteModal}
        onConfirm={handleDelete}
      />
    </>
  );
}

const styles = StyleSheet.create({
  deleteButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteButtonPressed: {
    opacity: 0.7,
  },
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing.four,
  },
});
