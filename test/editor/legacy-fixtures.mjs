// HYK-304-fixture-module-1(coder-task.md §1 P2-2 수리): 이 8개 표본은
// review.md §1-2 표를 그대로 옮긴 것이고(legacy-body-compat.test.mjs 가
// 먼저 가져왔다), 두 시험 파일(legacy-body-compat.test.mjs ·
// memo-navigation.test.mjs)이 "같은 표본으로 두 입구를 잰다"를 위해
// 공유한다. ⛔이 파일은 *.test.mjs 가 아니다 -- 그래야 러너가 시험으로
// 집지 않는다(이전 라운드는 memo-navigation.test.mjs 가
// legacy-body-compat.test.mjs 를 "시험 파일을 import"해 가져왔는데, 그
// import 가 side effect 로 그 파일의 11개 test() 등록을 다시 돌려
// memo-navigation.test.mjs 단독 실행이 6→19칸으로 부풀었다 -- 값은
// 한 글자도 바꾸지 않고 이 모듈로만 옮긴다).
export const LEGACY_FIXTURES = {
  B1: "C:\\Users\\han\\memo.md",
  B2: "끝에 백슬래시\\",
  B3: "a\\\\b",
  B4: "a\\\\\\b",
  B5: "- 항목1\\\n- 항목2",
  B6: "- [x] 할일1\\\n- [ ] 할일2",
  B7: "수식 \\alpha 와 \\beta",
  B8: "a\\\\\\\\b",
};
