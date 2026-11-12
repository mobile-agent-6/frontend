import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseDevelopmentServerConfig } from "@/services/api/config";

const SAVED_PI_IP_KEY = "settings.savedPiIp";
const SAVED_SERVER_KEY = "settings.verifiedServer.v1";
export type SavedServer = Readonly<{ kind: "pi" | "development"; baseUrl: string }>;

export async function readSavedServer(): Promise<SavedServer | null> {
  const raw = await AsyncStorage.getItem(SAVED_SERVER_KEY);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    const parsed = parseDevelopmentServerConfig(value?.baseUrl);
    if ((value?.kind !== "pi" && value?.kind !== "development") || parsed.status !== "ready" ||
      value.baseUrl !== parsed.config.baseUrl ||
      (value.kind === "pi" && !isPiOrigin(value.baseUrl))) throw new Error();
    return Object.freeze({ kind: value.kind, baseUrl: value.baseUrl });
  } catch { throw new Error("저장된 서버 설정을 읽을 수 없습니다."); }
}

export function isPiOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.port === "8000" &&
      /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) && url.hostname.split(".").every(part => Number(part) <= 255);
  } catch { return false; }
}

// 호출자는 실제 health 검증을 마친 증거를 연결 서비스에서 확인한다. 과거 Mock IP는 자동 승격하지 않는다.
export async function writeSavedServer(value: SavedServer) {
  const parsed = parseDevelopmentServerConfig(value.baseUrl);
  if (parsed.status !== "ready" || !["pi", "development"].includes(value.kind) ||
    (value.kind === "pi" && !isPiOrigin(value.baseUrl))) throw new Error("서버 주소 형식이 올바르지 않습니다.");
  await AsyncStorage.setItem(SAVED_SERVER_KEY, JSON.stringify({ kind: value.kind, baseUrl: parsed.config.baseUrl }));
}

export async function readSavedPiIp(): Promise<string | null> {
  const storedIp = await AsyncStorage.getItem(SAVED_PI_IP_KEY);
  return storedIp?.trim() || null;
}

// 호출자는 현재 IP의 연결·시간 검증을 완료한 뒤에만 이 함수를 사용한다.
// 저장 버튼 연결은 Step 7에서 수행하며 입력 변경 시 자동 호출하지 않는다.
export async function writeSavedPiIp(verifiedIp: string): Promise<void> {
  const normalizedIp = verifiedIp.trim();
  if (!normalizedIp) {
    throw new Error("저장할 Pi IP가 없습니다.");
  }
  await AsyncStorage.setItem(SAVED_PI_IP_KEY, normalizedIp);
}
