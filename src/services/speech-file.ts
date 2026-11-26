import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";

type Claim = { file: File; safe: boolean; cleanup: boolean; deleting: boolean };
const claims = new Map<string, Claim>();
const ownedName = /^assistant-speech-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.wav$/i;
const normalized = (uri: string) => decodeURIComponent(uri).replace(/^file:\/\/\/private\/var\//, "file:///var/").replace(/\/$/, "");
export type SpeechFile = { uri: string; handoff(): void; release(safe: boolean): boolean };
const diagnosticIds = new WeakMap<Claim, number>();
let nextDiagnosticId = 0;
function diagnose(event: string, claim: Claim, detail: Record<string, number | boolean | undefined> = {}) {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    try {
      if (!diagnosticIds.has(claim)) diagnosticIds.set(claim, ++nextDiagnosticId);
      console.info("[assistant-speech-file]", event, { owner: diagnosticIds.get(claim), ...detail });
    } catch { /* Diagnostic failure never changes ownership or cleanup. */ }
  }
}

/** A dedicated cache namespace; no caller-supplied deletion URI or recorder sweep. */
export function createSpeechFileStore() {
  const directory = new Directory(Paths.cache, "AssistantSpeech");
  function remove(key: string, claim: Claim) {
    if (claims.get(key) !== claim || !claim.safe || !claim.cleanup || claim.deleting) return false;
    claim.deleting = true;
    let existedBeforeDelete: boolean | undefined;
    try {
      existedBeforeDelete = claim.file.exists;
      if (existedBeforeDelete) claim.file.delete();
      const existsAfterDelete = claim.file.exists;
      if (existsAfterDelete) { diagnose("file-delete-failed", claim, { existedBeforeDelete, existsAfterDelete }); return false; }
      claims.delete(key);
      diagnose("file-deleted", claim, { existedBeforeDelete, existsAfterDelete });
      return true;
    } catch { diagnose("file-delete-failed", claim, { existedBeforeDelete }); return false; }
    finally { claim.deleting = false; }
  }
  function sweep() {
    // Failed safe deletions survive screen/store recreation. Unsafe player claims stay protected.
    for (const [key, claim] of claims) if (claim.safe && claim.cleanup) remove(key, claim);
    if (!directory.exists) return;
    const parent = normalized(directory.uri);
    for (const entry of directory.list()) {
      if (!(entry instanceof File) || !ownedName.test(entry.name)) continue;
      const key = normalized(entry.uri);
      if (key !== `${parent}/${entry.name}` || claims.has(key)) continue;
      const claim = { file: entry, safe: true, cleanup: true, deleting: false };
      claims.set(key, claim); remove(key, claim);
    }
  }
  async function create(bytes: Uint8Array): Promise<SpeechFile> {
    directory.create({ intermediates: true, idempotent: true });
    const name = `assistant-speech-${randomUUID()}.wav`;
    if (!ownedName.test(name)) throw new Error("speech-file-name");
    const file = new File(directory, name), key = normalized(file.uri);
    if (file.exists || claims.has(key)) throw new Error("speech-file-collision");
    const claim: Claim = { file, safe: false, cleanup: false, deleting: false };
    claims.set(key, claim);
    let writtenSize: number | undefined, sizeMatches: boolean | undefined;
    try {
      file.create(); await file.write(bytes);
      const exists = file.exists, size = exists ? file.size : 0;
      writtenSize = size; sizeMatches = exists && size === bytes.length;
      if (!sizeMatches) throw new Error("speech-file-write");
      claim.safe = true;
      diagnose("file-written", claim, { size, expectedSize: bytes.length, sizeMatches: true });
    } catch (error) { diagnose("file-write-failed", claim, { size: writtenSize, expectedSize: bytes.length, sizeMatches }); claim.safe = true; claim.cleanup = true; remove(key, claim); throw error; }
    return {
      uri: file.uri,
      handoff() {
        if (claims.get(key) !== claim || claim.deleting || claim.cleanup || !claim.safe) throw new Error("speech-file-owner");
        claim.safe = false;
      },
      release(safe) {
        if (claims.get(key) !== claim) return true;
        if (!safe) return false;
        claim.safe = true; claim.cleanup = true;
        return remove(key, claim);
      },
    };
  }
  return { create, sweep };
}
