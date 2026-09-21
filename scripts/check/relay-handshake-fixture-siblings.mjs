// HYK-430 5R (§2⑵ "한 곳인가 흩어져인가" -- 흩어져 있었다, 이 파일이 그
// 한 곳이다): relay-handshake.mjs를 격리 임시 디렉터리에 형제 파일과
// 함께 복사해 자식 프로세스로 돌리는 시험들(list-relay-handshake-
// isolated-fixtures.mjs가 기계로 셈, HYK-430 4R §2⑵)이 각자 자기 파일
// 안에 "어떤 형제를 복사할지" 목록을 따로 하드코딩해 왔다 -- 그래서
// relay-handshake.mjs가 새 정적 import를 하나 추가할 때마다(1R: 복제,
// 2R: 동적 import, 이번 5R: 정적 import) 그 목록들이 하나씩 조용히
// 낡았다(같은 결함의 세 번째 변신, coder-task.md §1). ★이번 5R은 그
// "흩어짐" 자체를 여기 한 곳으로 모은다 -- relay-handshake.mjs가 정적
// import하는 형제 파일이 바뀌면 이 배열 하나만 고치면 된다.
export const RELAY_HANDSHAKE_STATIC_SIBLINGS = Object.freeze([
  "time-authority.mjs",
  "reject-streak.mjs",
  "envelope-archive.mjs",
  "child-probe-timeout-policy.mjs",
]);

// relay-handshake.mjs 자신을 포함한 전체 파일 집합 -- 대부분의 격리
// 픽스처는 "relay-handshake.mjs 자신 + 이 정적 형제들"을 통째로
// 복사하므로, 이 파생값을 바로 쓰면 "relay-handshake.mjs" 리터럴을 또
// 따로 적을 필요가 없다.
export const RELAY_HANDSHAKE_FIXTURE_FILES = Object.freeze([
  "relay-handshake.mjs",
  ...RELAY_HANDSHAKE_STATIC_SIBLINGS,
]);
