import AsyncStorage from "@react-native-async-storage/async-storage";

import type {
  AssistantRecoveryCleanupEvidence,
  AssistantRecoveryCleanupResult,
  AssistantRecoveryMetadata,
  AssistantRecoveryReference,
  AssistantRecoveryResponse,
} from "@/types/assistant-recovery";
import { isAssistantUuidV4 } from "@/utils/assistant-validation";
import {
  applyAssistantRecoveryResponse,
  canRemoveAssistantRecovery,
  isAssistantRecoveryServerId,
  isAssistantRecoveryTimestamp,
  mergeAssistantRecoveryMetadata,
  parseAssistantRecoveryMetadata,
  prepareAssistantRecoveryCleanupEvidence,
} from "@/utils/assistant-recovery";

const RECOVERY_KEY = "assistant.requestRecovery.v1";
export type AssistantRecoveryStorageAdapter = Pick<typeof AsyncStorage, "getItem" | "setItem">;
export class AssistantRecoveryStorageError extends Error {
  constructor(public readonly code: "read" | "write" | "invalid-data" | "invalid-input" | "not-found" | "conflict") {
    // 하위 storage 예외·URL·요청 본문은 오류 메시지에 포함하지 않는다.
    super(`Assistant 요청 복구 저장소 오류: ${code}`);
    this.name = "AssistantRecoveryStorageError";
  }
}

// 같은 adapter의 factory끼리 공유하며 단일 JS runtime의 read-modify-write를 직렬화한다.
const queues = new WeakMap<AssistantRecoveryStorageAdapter, Promise<void>>();

function reference(input: AssistantRecoveryReference): AssistantRecoveryReference {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    !Object.hasOwn(input, "serverId") || !Object.hasOwn(input, "requestId") ||
    Object.keys(input).some((key) => key !== "serverId" && key !== "requestId") ||
    !isAssistantRecoveryServerId(input.serverId) || !isAssistantUuidV4(input.requestId)) {
    throw new AssistantRecoveryStorageError("invalid-input");
  }
  return { serverId: input.serverId, requestId: input.requestId.toLowerCase() };
}

function matches(entry: AssistantRecoveryReference, ref: AssistantRecoveryReference) {
  return entry.serverId === ref.serverId && entry.requestId === ref.requestId;
}

export function createAssistantRecoveryStorage(storage: AssistantRecoveryStorageAdapter = AsyncStorage) {
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (queues.get(storage) ?? Promise.resolve()).then(operation);
    queues.set(storage, pending.then(() => undefined, () => undefined));
    return pending;
  }

  async function readEntries(): Promise<AssistantRecoveryMetadata[]> {
    let serialized: string | null;
    try { serialized = await storage.getItem(RECOVERY_KEY); }
    catch { throw new AssistantRecoveryStorageError("read"); }
    if (serialized === null) return [];
    try {
      const value: unknown = JSON.parse(serialized);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
      const envelope = value as Record<string, unknown>;
      if (envelope.version !== 1 || !Object.hasOwn(envelope, "version") || !Object.hasOwn(envelope, "entries") ||
        Object.keys(envelope).some((key) => key !== "version" && key !== "entries") || !Array.isArray(envelope.entries)) throw new Error();
      const entries: AssistantRecoveryMetadata[] = [];
      for (const item of envelope.entries) {
        const entry = parseAssistantRecoveryMetadata(item);
        if (!entry || entries.some((previous) => matches(previous, entry))) throw new Error();
        entries.push(entry);
      }
      return entries;
    } catch {
      // 잘못된 기록을 빈 목록으로 바꾸거나 덮어쓰기·자동 삭제하지 않는다.
      throw new AssistantRecoveryStorageError("invalid-data");
    }
  }

  async function writeEntries(entries: AssistantRecoveryMetadata[]) {
    try { await storage.setItem(RECOVERY_KEY, JSON.stringify({ version: 1, entries })); }
    catch { throw new AssistantRecoveryStorageError("write"); }
  }

  /** 이 Promise가 성공한 뒤에만 호출자가 허용된 POST를 실행한다. 여기서는 전송하지 않는다. */
  function saveBeforePost(input: AssistantRecoveryReference, attemptedAt: number): Promise<AssistantRecoveryMetadata> {
    // 큐 대기 중 호출자가 변경한 값이 섞이지 않도록 입력을 복사한다.
    const snapshot = { ...input };
    return enqueue(async () => {
      const ref = reference(snapshot);
      if (!isAssistantRecoveryTimestamp(attemptedAt)) throw new AssistantRecoveryStorageError("invalid-input");
      const entries = await readEntries();
      const index = entries.findIndex((entry) => matches(entry, ref));
      const saved: AssistantRecoveryMetadata = index < 0
        ? { ...ref, firstPostAttemptAt: attemptedAt, lastPostAttemptAt: attemptedAt, acceptConfirmed: false }
        : { ...entries[index], lastPostAttemptAt: attemptedAt };
      if (index < 0) entries.push(saved); else entries[index] = saved;
      await writeEntries(entries);
      return { ...saved };
    });
  }

  function readAll() { return enqueue(readEntries); }
  function readForServer(serverId: string) {
    return enqueue(async () => {
      if (!isAssistantRecoveryServerId(serverId)) throw new AssistantRecoveryStorageError("invalid-input");
      return (await readEntries()).filter((entry) => entry.serverId === serverId);
    });
  }
  function read(input: AssistantRecoveryReference) {
    const snapshot = { ...input };
    return enqueue(async () => {
      const ref = reference(snapshot);
      return (await readEntries()).find((entry) => matches(entry, ref)) ?? null;
    });
  }

  function recordResponse(input: AssistantRecoveryReference, response: AssistantRecoveryResponse): Promise<AssistantRecoveryMetadata> {
    const snapshot = { ...input };
    // DTO 전문을 큐·영속 영역에 보관하지 않고 메타데이터만 먼저 도출한다.
    const seed: AssistantRecoveryMetadata = { ...snapshot, firstPostAttemptAt: 0, lastPostAttemptAt: 0, acceptConfirmed: false };
    const observed = applyAssistantRecoveryResponse(seed, response);
    return enqueue(async () => {
      const ref = reference(snapshot);
      if (!observed) throw new AssistantRecoveryStorageError("invalid-input");
      const entries = await readEntries();
      const index = entries.findIndex((entry) => matches(entry, ref));
      if (index < 0) throw new AssistantRecoveryStorageError("not-found");
      // 최신 저장 상태로 늦은 응답·conversation 충돌을 재판정한다.
      const saved = mergeAssistantRecoveryMetadata(entries[index], observed);
      if (!saved) throw new AssistantRecoveryStorageError("conflict");
      entries[index] = saved;
      await writeEntries(entries);
      return { ...saved };
    });
  }

  function cleanup(input: AssistantRecoveryReference, currentServerId: string, evidence: AssistantRecoveryCleanupEvidence,
    options?: { isCurrent?: () => boolean }): Promise<AssistantRecoveryCleanupResult> {
    const snapshot = { ...input };
    const facts = prepareAssistantRecoveryCleanupEvidence(evidence);
    const isCurrent = options?.isCurrent ?? (() => true);
    return enqueue(async () => {
      if (!isCurrent()) return "retained";
      const ref = reference(snapshot);
      const entries = await readEntries();
      const entry = entries.find((item) => matches(item, ref));
      if (!entry) return "not-found";
      if (!facts) return "retained";
      const replacement = facts.type === "next-input-accepted"
        ? entries.find((item) => item.serverId === ref.serverId && item.requestId === facts.requestId) : undefined;
      if (!canRemoveAssistantRecovery(entry, currentServerId, facts, replacement)) return "retained";
      // 큐와 storage 조회 대기 중 화면·서버가 바뀌면 삭제 쓰기를 시작하지 않는다.
      if (!isCurrent()) return "retained";
      await writeEntries(entries.filter((item) => !matches(item, ref)));
      return "removed";
    });
  }

  /** 로컬 정보만 수동 정리한다. 서버 취소·uncertain 해소·재실행 허용이 아니다. */
  function removeManually(input: AssistantRecoveryReference, confirmation: { confirmed: true },
    options?: { isCurrent?: () => boolean }): Promise<AssistantRecoveryCleanupResult> {
    const snapshot = { ...input };
    const confirmed = confirmation?.confirmed === true;
    const isCurrent = options?.isCurrent ?? (() => true);
    return enqueue(async () => {
      if (!isCurrent()) return "retained";
      const ref = reference(snapshot);
      if (!confirmed) throw new AssistantRecoveryStorageError("invalid-input");
      const entries = await readEntries();
      if (!entries.some((entry) => matches(entry, ref))) return "not-found";
      if (!isCurrent()) return "retained";
      await writeEntries(entries.filter((entry) => !matches(entry, ref)));
      return "removed";
    });
  }

  return { saveBeforePost, readAll, readForServer, read, recordResponse, cleanup, removeManually };
}

// 생성만으로 storage를 읽거나 복구 GET을 시작하지 않는다.
export const assistantRecoveryStorage = createAssistantRecoveryStorage();
