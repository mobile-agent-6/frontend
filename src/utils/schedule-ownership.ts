import { randomUUID } from "expo-crypto";

import { scheduleHttpClient } from "@/services/api/http";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";

// Runtime-only route capabilities. URL strings cannot grant a new connection's authority.
export function captureScheduleOwner(connection = scheduleDataModeStore.getState()) {
  const { mode, generation } = connection;
  return Object.freeze({ mode, generation, serverId: mode === "server" ? scheduleHttpClient.getServerId() : null });
}
export type ScheduleOwner = ReturnType<typeof captureScheduleOwner>;
export function isScheduleOwnerCurrent(owner: ScheduleOwner) {
  const current = captureScheduleOwner();
  return owner.mode === current.mode && owner.generation === current.generation && owner.serverId === current.serverId;
}
const routes = new Map<string, Readonly<{ owner: ScheduleOwner; id: string | null }>>();
const owners = new Map<string, number>();
export function discardScheduleRoute(key: unknown) {
  if (typeof key === "string" && !owners.get(key)) { routes.delete(key); owners.delete(key); }
}
export function retainScheduleRoute(key: unknown) {
  if (typeof key !== "string" || !routes.has(key)) return () => {};
  owners.set(key, (owners.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners.set(key, Math.max(0, (owners.get(key) ?? 1) - 1));
    // StrictMode can reattach within this commit. A popped route leaves no capability behind.
    void Promise.resolve().then(() => { if (owners.get(key) === 0) { owners.delete(key); routes.delete(key); } });
  };
}
export function createScheduleRoute(id: string | null, owner = captureScheduleOwner()) {
  if (!isScheduleOwnerCurrent(owner)) return null;
  for (const [key, value] of routes) if (!isScheduleOwnerCurrent(value.owner)) { routes.delete(key); owners.delete(key); }
  const connectionKey = randomUUID();
  routes.set(connectionKey, Object.freeze({ owner, id }));
  return id === null ? { pathname: "/schedule/create" as const, params: { connectionKey } }
    : { pathname: "/schedule/[id]" as const, params: { id, connectionKey } };
}
export function resolveScheduleRoute(key: unknown, id: string | null, connection = scheduleDataModeStore.getState()) {
  const route = typeof key === "string" ? routes.get(key) : undefined;
  if (route && !isScheduleOwnerCurrent(route.owner)) { routes.delete(key as string); owners.delete(key as string); }
  return route && route.id === id && route.owner.mode === connection.mode && route.owner.generation === connection.generation &&
    isScheduleOwnerCurrent(route.owner) ? route.owner : null;
}
