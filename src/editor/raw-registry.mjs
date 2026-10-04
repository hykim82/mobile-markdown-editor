// 커서 진입 원문 복원(PRD §5.1⑤ · §5.2③ · §8, HYK-304-cursor-raw-restore-1)
// 에서 "지금 원문으로 펼쳐져 있는 최상위 노드"의 키를 에디터마다 기억하는
// 자리다. serialize.mjs 가 이 키를 보고 그 노드만 원문 그대로 직렬화해야
// 저장 원문(§7 본문)이 커서 왕복 중에도 바뀌지 않는다. 키는 노드가 살아
// 있는 동안 안정적이라 이 집합만으로 충분하다. 순환 import 를 피하려고
// 이 파일은 lexical 에도 serialize 에도 의존하지 않는다.
const registries = new WeakMap();

export function rawKeysOf(editor) {
  let keys = registries.get(editor);
  if (!keys) {
    keys = new Set();
    registries.set(editor, keys);
  }
  return keys;
}

// ⭐혼합 목록 연결 키(HYK-304-mixed-list-fix-1): 불릿과 체크박스가 섞인
// 목록은 종류가 바뀔 때마다 목록 노드를 새로 만든다. 그런데 같은 블록
// "안"에서 이어진 두 목록은 저장 원문에서 줄바꿈 하나("\n")로 이어지고,
// 블록 사이("\n\n")로 떨어진 두 목록과 노드 모양이 똑같다 -- 그래서 "이
// 목록은 앞 목록에 줄바꿈 하나로 이어진다"는 사실을 노드 키로 따로 기억해
// 둔다. 키가 없으면 빈 줄("\n\n")이다(기존 동작 그대로).
const softJoins = new WeakMap();

export function softJoinKeysOf(editor) {
  let keys = softJoins.get(editor);
  if (!keys) {
    keys = new Set();
    softJoins.set(editor, keys);
  }
  return keys;
}
