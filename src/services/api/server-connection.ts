import { fetch as expoFetch } from "expo/fetch";

import { parseDevelopmentServerConfig, setServerConfiguration } from "@/services/api/config";
import { isPiOrigin, readSavedServer, writeSavedServer, type SavedServer } from "@/services/storage/settings";
import { parseScheduleApiDateTime } from "@/utils/schedule-mapper";

export type ServerHealthResult =
  | Readonly<{ ok: true; server: SavedServer; rttMs: number; differenceSeconds: number }>
  | Readonly<{ ok: false; reason: "address" | "http" | "response" | "clock" | "timeout" | "network" | "aborted"; status?: number }>;

// 실제 HTTP는 사용자 연결 확인에만 수행한다. 앱 시작은 저장 주소 복원만 하며 health/time-sync를 자동 호출하지 않는다.
export function createServerConnection({ fetchImpl = expoFetch, read = readSavedServer, write = writeSavedServer,
  apply = setServerConfiguration, now = Date.now, monotonic = () => performance.now(), timeoutMs = 5_000 }: {
  fetchImpl?: typeof fetch; read?: typeof readSavedServer; write?: typeof writeSavedServer;
  apply?: typeof setServerConfiguration; now?: () => number; monotonic?: () => number; timeoutMs?: number;
} = {}) {
  const proofs = new WeakSet<object>();
  let initialization: Promise<SavedServer | null> | undefined;
  let revision = 0;
  let saves: Promise<unknown> = Promise.resolve();

  function initialize() {
    if (!initialization) {
      const initialRevision = revision;
      initialization = read().then(server => {
        if (revision === initialRevision && server) apply(server.baseUrl);
        return server;
      }).catch(() => { if (revision === initialRevision) apply(null); throw new Error("저장된 서버 설정을 복원하지 못했습니다. 설정에서 다시 확인해 주세요."); });
    }
    return initialization;
  }

  async function check(input: string, kind: SavedServer["kind"], signal?: AbortSignal): Promise<ServerHealthResult> {
    const address = input.trim();
    if (kind === "pi" && (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(address) ||
      address.split(".").some(part => Number(part) > 255))) return { ok: false, reason: "address" };
    const parsed = parseDevelopmentServerConfig(kind === "pi" ? `http://${address}:8000` : address);
    if (parsed.status !== "ready" || (kind === "pi" && !isPiOrigin(parsed.config.baseUrl))) return { ok: false, reason: "address" };
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const stopped = new Promise<never>((_, reject) => { cancel = () => { controller.abort(); reject(new Error()); }; });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const wall = now(), start = monotonic();
      timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
      const response = await Promise.race([fetchImpl(`${parsed.config.baseUrl}/health`, {
        method: "GET", headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal,
      }), stopped]);
      const raw = await Promise.race([response.text(), stopped]);
      const rttMs = monotonic() - start;
      if (signal?.aborted) return { ok: false, reason: "aborted" };
      if (response.status !== 200) return { ok: false, reason: "http", status: response.status };
      try {
        const data = JSON.parse(raw);
        if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
          data.status !== "ok" || data.apiVersion !== "v1" || typeof data.serverTime !== "string" || !data.serverTime.endsWith("Z")) throw new Error();
        const time = parseScheduleApiDateTime(data.serverTime).milliseconds;
        const differenceSeconds = Math.abs(time - (wall + rttMs / 2)) / 1_000;
        if (!Number.isFinite(rttMs) || rttMs < 0 || !Number.isFinite(differenceSeconds)) throw new Error();
        if (differenceSeconds > 60) return { ok: false, reason: "clock" };
        const result = Object.freeze({ ok: true as const, server: Object.freeze({ kind, baseUrl: parsed.config.baseUrl }), rttMs, differenceSeconds });
        proofs.add(result);
        return result;
      } catch { return { ok: false, reason: "response" }; }
    } catch { return { ok: false, reason: signal?.aborted ? "aborted" : timedOut ? "timeout" : "network" }; }
    finally { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }

  function save(result: ServerHealthResult) {
    if (!result.ok || !proofs.has(result)) return Promise.reject(new Error("연결 확인이 필요합니다."));
    // 이전 복원·저장 완료 순서로 최신 서버 설정을 되돌리지 않는다. 실패하면 현재 서버를 유지한다.
    revision++;
    const operation = saves.then(async () => {
      await write(result.server);
      apply(result.server.baseUrl);
    });
    saves = operation.catch(() => undefined);
    return operation;
  }
  return { initialize, check, save, read };
}

export const serverConnection = createServerConnection();
