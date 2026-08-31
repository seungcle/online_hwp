/**
 * 아주 얇은 로그인.
 *
 * 대단한 인증이 아니다. 남이 우리 OpenAI 키로 프롬프트를 마구 던지는 것을
 * 막는 최소한의 문턱이다. 실제로 막는 곳은 Worker이고(`backend/index.ts`),
 * 여기는 아이디·비밀번호를 들고 있다가 요청에 붙여 주는 역할만 한다.
 *
 * 그래서 이 파일에는 비밀번호가 들어 있지 않다. 맞는지 아닌지는 서버가 안다.
 * 브라우저가 화면을 열어 주더라도, 서버가 거절하면 AI는 돌지 않는다.
 *
 * 보관은 `sessionStorage`다. 탭을 닫으면 지워진다 — 공용 PC에서 남의 계정이
 * 그대로 남아 있는 것보다 매번 다시 넣는 편이 낫다.
 */

const KEY = 'rhwp:auth'

/** 저장된 자격증명(Basic 인코딩된 값). 없으면 아직 로그인 전이다. */
export function storedCredential(): string | undefined {
  try {
    return sessionStorage.getItem(KEY) ?? undefined
  } catch {
    // 사생활 보호 모드 등에서 접근이 막힐 수 있다. 그때는 로그인 전으로 본다.
    return undefined
  }
}

export function saveCredential(id: string, password: string): string {
  const encoded = encode(id, password)
  try {
    sessionStorage.setItem(KEY, encoded)
  } catch {
    // 저장하지 못해도 이번 세션 동안은 메모리로 쓴다.
  }
  memory = encoded
  return encoded
}

export function clearCredential(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // 비워지지 않아도 아래 memory 를 지우면 이번 요청부터는 붙지 않는다.
  }
  memory = undefined
}

let memory: string | undefined

/** 요청에 붙일 헤더. 로그인 전이면 빈 객체. */
export function authHeaders(): Record<string, string> {
  const credential = memory ?? storedCredential()
  return credential ? { authorization: `Basic ${credential}` } : {}
}

export function isLoggedIn(): boolean {
  return (memory ?? storedCredential()) !== undefined
}

/** UTF-8 아이디·비밀번호도 깨지지 않게 인코딩한다. */
function encode(id: string, password: string): string {
  const bytes = new TextEncoder().encode(`${id}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
