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
