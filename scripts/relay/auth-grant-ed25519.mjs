import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

// HYK-163 사이클 1 (G2/G4): Ed25519 서명/검증 -- 봉인 세리모니(sign)와 게이트
// 판정(verify) 경로를 분리한다. 계약: **게이트 경로는 개인키를 절대 읽지
// 않는다** -- verify()는 공개키만 인자로 받고, privateKey 타입은 함수 시그니처
// 어디에도 등장하지 않는다(G3: 개인키가 workspace/게이트 코드 경로로 흘러들
// 가능성을 타입 자체로 차단).
//
// node:crypto의 one-shot sign(null, data, key)/verify(null, data, key, sig)가
// Ed25519(PureEdDSA)에 필요한 정확한 호출 형태다(RSA/ECDSA처럼 알고리즘 문자열을
// 요구하지 않는다 -- 이 repo node v26 런타임에서 실측 확인).

export function generateEd25519KeyPair() {
  // 테스트/봉인 세리모니 전용 편의 함수. 게이트(auth-grant-gate.mjs)는 이 함수를
  // import하지 않는다 -- 실 배포 키 발급 절차가 아니다.
  return generateKeyPairSync("ed25519");
}

export function sign(canonicalBytes, privateKey) {
  if (!Buffer.isBuffer(canonicalBytes)) {
    throw new TypeError("auth-grant-ed25519: canonicalBytes must be a Buffer");
  }
  return cryptoSign(null, canonicalBytes, privateKey);
}

// fail-closed: 서명·데이터·키 형태가 무엇이든 예외를 던지지 않고 false만 반환한다
// (호출부의 판정기가 uncaught throw로 open 되는 경로를 원천 차단, arm-state.mjs I4
// 원칙 재적용).
export function verify(canonicalBytes, signature, publicKey) {
  if (!Buffer.isBuffer(canonicalBytes)) return false;
  if (!Buffer.isBuffer(signature) || signature.length === 0) return false;
  if (publicKey === null || publicKey === undefined) return false;
  try {
    return cryptoVerify(null, canonicalBytes, publicKey, signature) === true;
  } catch {
    return false;
  }
}
