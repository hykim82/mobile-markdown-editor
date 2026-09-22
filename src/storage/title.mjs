// GLOSSARY "제목 -- 문자열, 기본값은 본문 첫 줄에서 자동 갱신." 마크다운
// 기호를 벗기지 않고 첫 줄 원문을 그대로 쓴다 -- 스펙에 기호 제거 요구가
// 없고, 제목도 결국 §7 본문 원문에서 파생되는 값이라 원문을 훼손하지
// 않는 쪽이 안전하다.
export function deriveTitleFromBody(body) {
  const firstLine = body.split("\n")[0] ?? "";
  return firstLine.trim();
}
