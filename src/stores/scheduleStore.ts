import { create } from "zustand";

import type { Schedule } from "@/types/schedule";

export type ScheduleStore = {
  schedules: Schedule[];
  addSchedule: (schedule: Schedule) => void;
  updateSchedule: (id: string, updates: Partial<Schedule>) => void;
  deleteSchedule: (id: string) => void;
  toggleCompleted: (id: string) => void;
};

export const useScheduleStore = create<ScheduleStore>((set) => ({
  schedules: [],

  addSchedule: (schedule) =>
    set((state) => ({
      schedules: [...state.schedules, schedule],
    })),

  updateSchedule: (id, updates) =>
    set((state) => ({
      schedules: state.schedules.map((schedule) =>
        schedule.id === id ? { ...schedule, ...updates } : schedule,
      ),
    })),

  deleteSchedule: (id) =>
    set((state) => ({
      schedules: state.schedules.filter((schedule) => schedule.id !== id),
    })),

  toggleCompleted: (id) =>
    set((state) => ({
      schedules: state.schedules.map((schedule) =>
        schedule.id === id
          ? { ...schedule, completed: !schedule.completed }
          : schedule,
      ),
    })),
}));
