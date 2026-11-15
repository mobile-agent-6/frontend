import AsyncStorage from "@react-native-async-storage/async-storage";
import { getServerTargetSource } from "@/services/api/config";
import { createHttpTransport } from "@/services/api/transport";
import { createSettingsConnection } from "@/services/settings-connection";
import { createVerifiedSettingsStorage } from "@/services/storage/verified-settings";

const selected = process.env.EXPO_PUBLIC_CONNECTION_PROFILE;
const mockData = process.env.EXPO_PUBLIC_SCHEDULE_DATA_MODE === "mock";
const local = getServerTargetSource() !== "pi" || mockData;
function blockedProfile() {
  const transport = { kind: "mock" as const, fetchImpl: (() => Promise.reject(new Error("development-profile-disabled"))) as typeof fetch };
  return createSettingsConnection({ transport, storage: createVerifiedSettingsStorage("mock:disabled"), business: () => false });
}
function build() {
  if (selected || local) {
    if (typeof __DEV__ === "undefined" || !__DEV__ || process.env.NODE_ENV === "production") {
      return blockedProfile();
    }
    // Production bundle exclusion is checked by export inspection in stage 4, not inferred from __DEV__ alone.
    // Keep fixture initialization behind the explicit development boundary.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const profileModule = require("@/development/connection-profile") as typeof import("@/development/connection-profile");
    const name = selected ?? "local";
    if (!(profileModule.connectionProfiles as readonly string[]).includes(name)) return blockedProfile();
    const { transport, clock } = profileModule.createConnectionProfile(name as import("@/development/connection-profile").ConnectionProfile);
    const adapter = name === "save-error" ? { ...AsyncStorage, setItem: async () => { throw new Error("fixture-write-failure"); } } : AsyncStorage;
    return createSettingsConnection({ transport, clock, storage: createVerifiedSettingsStorage(`mock:${name}`, adapter),
      business: () => !mockData && getServerTargetSource() === "pi" });
  }
  return createSettingsConnection({ transport: createHttpTransport(), storage: createVerifiedSettingsStorage("pi") });
}
export const settingsConnection = build();
