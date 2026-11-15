import { getServerTargetSource } from "@/services/api/config";

/** Development and ordinary Mock startup keep their existing path and perform no Pi I/O. */
export function initializeSavedConnection(): Promise<void> {
  if (getServerTargetSource() !== "pi" || process.env.EXPO_PUBLIC_SCHEDULE_DATA_MODE === "mock") return Promise.resolve();
  // Ordinary development/Mock startup must not initialize Pi storage or a profile.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtime = require("@/services/settings-runtime") as typeof import("@/services/settings-runtime");
  return runtime.settingsConnection.restore();
}
