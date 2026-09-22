// 메모 스키마의 id 필드(GLOSSARY: "id -- UUID, 필수, 자동 생성").
// crypto.randomUUID() 는 Node 19+/모든 대상 브라우저에 내장돼 있어 의존성
// 추가 없이 coder-task.md §0-1 "의존 0" 결정을 지킨다.
export function generateMemoId() {
  return crypto.randomUUID();
}
