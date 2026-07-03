# LOOP

이 저장소의 loop 검증 대상과 규칙. (harness-init loop profile, 2026-07-03 설치)

## 검증 명령
```
bash -lc "./scripts/verify.sh"
```
- `scripts/check-cases.mjs` 안전검사 → `node --test` 순으로 실행하고, 하나라도 실패하면 종료 코드가 0이 아니다.

## 현재 loop 작업: 마크다운 파서
- 대상: `src/markdown-parser.mjs` — 마크다운 한 줄/조각을 타입 구조로 파싱하는 순수 함수.
- 테스트: `test/markdown-parser.test.mjs` — Task Contract의 구조화 케이스와 일치.
- 지원 요소: 제목(#, ##, ###) · 목록(-) · 체크박스(- [ ], - [x]) · 굵게(**) · 취소선(~~) · 문단.
- 오탐 방지: 공백 없는 `#제목`은 제목이 아니라 문단이다.

## PASS 조건
- check-cases 안전검사 통과 (동결 케이스 입력 존재)
- node --test 전부 통과

## Test freeze
- RED 확인 후 동결. 동결 후 보호: 완료조건, `scripts/verify.sh`, `scripts/check-cases.mjs`, 동결된 테스트 케이스.
- Verifier는 코드·테스트·verify.sh를 수정하지 않는다. 실제 명령과 실제 종료 코드만 기록한다.
