import type { AssistantRecoveryReference } from "@/types/assistant-recovery";

export type AssistantVisibleResult = { messageId: string; reference: AssistantRecoveryReference; executionToken: string; contentToken: string };
export type AssistantDisplayedResult = AssistantVisibleResult & { isCurrent: () => boolean };
export type AssistantVisibleRect = { x: number; y: number; width: number; height: number };

export function isAssistantResultFullyVisible(text: AssistantVisibleRect, viewport: AssistantVisibleRect, window: { width: number; height: number }) {
  if (![...Object.values(text), ...Object.values(viewport), window.width, window.height].every(Number.isFinite) ||
    text.width <= 0 || text.height <= 0 || viewport.width <= 0 || viewport.height <= 0 || window.width <= 0 || window.height <= 0) return false;
  return text.x >= Math.max(0, viewport.x) && text.y >= Math.max(0, viewport.y) &&
    text.x + text.width <= Math.min(window.width, viewport.x + viewport.width) &&
    text.y + text.height <= Math.min(window.height, viewport.y + viewport.height);
}

// 레이아웃 신호와 두 번의 실제 위치 확인이 모두 필요하다. render·snapshot은 노출 증거가 아니다.
export function createAssistantResultVisibility({ measure, isActive, onDisplayed, onPending, dwellMs = 1_000 }: {
  measure: (result: AssistantVisibleResult) => Promise<boolean>;
  isActive: () => boolean;
  onDisplayed: (result: AssistantDisplayedResult) => Promise<boolean>;
  onPending?: (result: AssistantVisibleResult, pending: boolean) => void;
  dwellMs?: number;
}) {
  type Entry = { result: AssistantVisibleResult; laidOut: boolean; confirmed: boolean; pending: boolean; waiting?: boolean; timer?: ReturnType<typeof setTimeout> };
  const entries = new Map<string, Entry>();
  let epoch = 0;
  const keyOf = (result: AssistantVisibleResult) => JSON.stringify([result.reference.serverId, result.reference.requestId.toLowerCase()]);
  const same = (a: AssistantVisibleResult, b: AssistantVisibleResult) => a.messageId === b.messageId && a.executionToken === b.executionToken;
  // UI observation only. It is never display evidence or permission to delete metadata.
  function waiting(entry: Entry, value: boolean) {
    if (entry.waiting === value) return;
    entry.waiting = value;
    try { onPending?.(entry.result, value); } catch {}
  }
  function invalidate(clearWaiting = true) {
    epoch++;
    for (const entry of entries.values()) { if (entry.timer !== undefined) clearTimeout(entry.timer); entry.timer = undefined; if (clearWaiting) waiting(entry, false); }
  }
  function update(results: readonly AssistantVisibleResult[]) {
    const next = new Map(results.map(result => [keyOf(result), result]));
    for (const [key, entry] of entries) if (!next.has(key)) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      waiting(entry, false);
      entries.delete(key);
    }
    for (const [key, result] of next) {
      const previous = entries.get(key);
      if (previous && same(previous.result, result)) continue;
      if (previous?.timer !== undefined) clearTimeout(previous.timer);
      if (previous) waiting(previous, false);
      // HTTP 추적 ID만 달라진 동일 표시 결과는 기존 텍스트 레이아웃을 재사용하되 위치·대기 시간은 다시 확인한다.
      const unchanged = previous?.result.messageId === result.messageId && previous.result.contentToken === result.contentToken;
      entries.set(key, { result, laidOut: Boolean(unchanged && previous?.laidOut), confirmed: Boolean(unchanged && previous?.confirmed), pending: false });
    }
  }
  async function sample(entry: Entry, version: number, afterDwell: boolean) {
    const current = () => epoch === version && isActive() && entries.get(keyOf(entry.result)) === entry;
    if (!current() || !entry.laidOut || entry.confirmed || entry.pending) return;
    let visible = false;
    try { visible = await measure(entry.result); } catch { /* 측정 실패는 보존한다. */ }
    if (!current()) return;
    if (!visible) { waiting(entry, false); return; }
    waiting(entry, true);
    if (!afterDwell) {
      entry.timer = setTimeout(() => { entry.timer = undefined; void sample(entry, version, true); }, dwellMs);
      return;
    }
    entry.pending = true;
    try { if (await onDisplayed({ ...entry.result, isCurrent: current })) entry.confirmed = true; }
    catch { /* 정리 실패는 재전송이나 성공 처리의 근거가 아니다. */ }
    finally { entry.pending = false; waiting(entry, false); }
  }
  function refresh() {
    const active = isActive();
    invalidate(!active);
    if (active) for (const entry of entries.values()) void sample(entry, epoch, false);
  }
  function laidOut(result: AssistantVisibleResult) {
    const entry = entries.get(keyOf(result));
    if (!entry || !same(entry.result, result)) return;
    entry.laidOut = true;
    refresh();
  }
  return { update, laidOut, refresh, invalidate };
}
