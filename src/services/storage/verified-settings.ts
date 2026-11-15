import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseCanonicalIpv4 } from "@/services/api/config";

export type SettingsProvenance = "pi" | `mock:${string}`;
export type VerifiedSettings = Readonly<{ version: 1; ip: string; provenance: SettingsProvenance; verified: true }>;
const queues = new WeakMap<object, Promise<void>>();
export function parseVerifiedSettings(value: unknown, provenance: SettingsProvenance): VerifiedSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4 && record.version === 1 && record.verified === true &&
    record.provenance === provenance && typeof record.ip === "string" && parseCanonicalIpv4(record.ip) === record.ip
    ? Object.freeze({ version: 1, verified: true, ip: record.ip as string, provenance }) : null;
}
export function createVerifiedSettingsStorage(provenance: SettingsProvenance, adapter = AsyncStorage) {
  const key = `settings.verifiedConnection.${provenance}.v1`, journal = `${key}.pending`;
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = (queues.get(adapter) ?? Promise.resolve()).then(fn);
    queues.set(adapter, task.then(() => undefined, () => undefined)); return task;
  }
  return {
    read: () => serial(async () => {
      if (await adapter.getItem(journal)) throw new Error("settings-unconfirmed-write");
      const raw = await adapter.getItem(key); if (raw === null) return null;
      const parsed = parseVerifiedSettings(JSON.parse(raw), provenance);
      if (!parsed) throw new Error("invalid-settings"); return parsed;
    }),
    save: (ip: string, isCurrent: () => boolean, activate: () => void) => serial(async () => {
      const value = parseVerifiedSettings({ version: 1, ip, provenance, verified: true }, provenance);
      if (!value || !isCurrent()) throw new Error("settings-invalidated");
      const previous = await adapter.getItem(key);
      if (!isCurrent()) throw new Error("settings-invalidated");
      await adapter.setItem(journal, "pending");
      try {
        if (!isCurrent()) throw new Error("settings-invalidated");
        await adapter.setItem(key, JSON.stringify(value));
        if (!isCurrent()) throw new Error("settings-invalidated");
        // Linearization point: durable value exists and authority is still current. No await before publication.
        activate();
      } catch (error) {
        try {
          if (previous === null) await adapter.removeItem(key); else await adapter.setItem(key, previous);
          await adapter.removeItem(journal);
        } catch { /* Persistent journal blocks automatic restoration of an uncertain write. */ }
        throw error;
      }
      // A cleanup failure keeps a conservative restore barrier, never an unvalidated fallback.
      try { await adapter.removeItem(journal); } catch {}
      return value;
    }),
  };
}
