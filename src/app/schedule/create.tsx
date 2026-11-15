import { useEffect } from "react";
import { useLocalSearchParams } from "expo-router";
import { useStore } from "zustand";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { resolveScheduleRoute, retainScheduleRoute } from "@/utils/schedule-ownership";
import { ScheduleListState } from "@/components/schedule-list/schedule-list-state";
import { ScheduleCreateForm } from "@/components/schedule-create/schedule-create-form";

export default function ScheduleCreateScreen() {
  const { connectionKey } = useLocalSearchParams<{ connectionKey?: string | string[] }>();
  useStore(scheduleDataModeStore);
  useEffect(() => retainScheduleRoute(connectionKey), [connectionKey]);
  if (!resolveScheduleRoute(connectionKey, null)) return <ScheduleListState state="error" errorTitle="일정을 찾을 수 없어요." />;
  return <ScheduleCreateForm />;
}
