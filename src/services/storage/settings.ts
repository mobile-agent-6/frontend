import AsyncStorage from "@react-native-async-storage/async-storage";

const SAVED_PI_IP_KEY = "settings.savedPiIp";

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
