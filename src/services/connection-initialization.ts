import { getServerTargetSource } from "@/services/api/config";
import { createStore } from "zustand/vanilla";

// A missing authority is provisional only during this one startup restoration.
export const connectionInitialization = createStore(() => ({
  pending: getServerTargetSource() === "pi" && process.env.EXPO_PUBLIC_SCHEDULE_DATA_MODE !== "mock",
}));
let restoration: Promise<void> | undefined;

/** Development and ordinary Mock startup keep their existing path and perform no Pi I/O. */
export function initializeSavedConnection(): Promise<void> {
  if (getServerTargetSource() !== "pi" || process.env.EXPO_PUBLIC_SCHEDULE_DATA_MODE === "mock") return Promise.resolve();
  restoration ??= (async () => {
    try {
      // Ordinary development/Mock startup must not initialize Pi storage or a profile.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const runtime = require("@/services/settings-runtime") as typeof import("@/services/settings-runtime");
      await runtime.settingsConnection.restore();
    } finally { connectionInitialization.setState({ pending: false }); }
  })();
  return restoration;
}
