# 한 손 마크다운 에디터

이동 중 한 손으로 마크다운을 빠르고 안 깨지게 입력해 노션에 그대로 복사하는 모바일 로컬 에디터.

**스펙(/spec)이 진실의 원천이다. 스펙과 충돌하는 판단은 하지 않는다.**

## 스택
(⚠ 빌드 착수 전 사용자 확정: iOS / Android / PWA / 크로스플랫폼 — 햅틱·클립보드·IME commit·백그라운드 감지·로컬 DB 구현이 스택마다 다름)

## 명칭 규칙
- `/spec/GLOSSARY.md`에 적힌 명칭만 사용한다. 동의어·재작명·재번역 금지. 한 개념 = 한 이름.

## 빌드 루프 (★필수)
1. 화면 하나 구현한다.
2. 실행하고 스크린샷을 찍는다. (스크린샷 불가 환경이면 사용자에게 스크린샷을 요청한다.)
3. `/spec/mockups`와 대조한다.
4. 어긋난 것을 목록으로 적는다.
5. 수정한다. → 다시 1번부터 반복.
- **완료 판정**: `/spec/PRD.md`의 수용 기준을 실제 실행으로 검증했을 때만 완료다. 체크박스만 채우는 것은 완료가 아니다.

## 스펙 드리프트 금지 (★필수)
- 구현 중 스펙이 틀렸다고 판단돼도 임의로 고치지 않는다. 어긋남을 사용자에게 보고하고, 승인을 받은 뒤에만 변경한다.

## 빌드 전 확정 게이트
- 자음더블 매핑 최종 확정 (GLOSSARY 참조 — 임시 확정 상태)
- "자음더블"의 실제 동작 방식 확정: 자판에서 자음 연타 시 자동 치환인가, 단축키바 칩 탭인가
- 스택 확정 (위)

## 톤
차분·미니멀·또박또박·한 손·거슬림 없는.

<!-- Claude Code 사용 시: CLAUDE.md 에서 "@AGENTS.md" 한 줄로 이 파일을 import 한다. -->

## 하네스 운영 (harness-init, 2026-07-03 적용)

이 프로젝트는 위의 자체 규칙(스펙=진실의 원천, 빌드 루프, 완료 판정, 확정 게이트)을
그대로 유지한다. 하네스는 아래 운영 층만 추가하며, 위 규칙을 재정의하지 않는다.

- 작업 전 Task Contract 작성: 각 작업은 loop / non-loop / none 중 하나로 분류.
- 역할: Orchestrator / Coder / Verifier(loop 전용) / Reviewer / Human.
- 기록: Linear = 코드 작업 로그. AI는 In Review까지, Done은 Human(한용).
- 완료 판정·스펙 드리프트·빌드 루프는 위의 기존 규칙을 그대로 따른다(중복 정의 안 함).
- loop profile(LOOP.md·verify.sh 등)은 명시 승인 시에만 설치.

# Harness Operating Rules

Harness is opt-in for this repository.

## Project

Linear-Project: PROJECT_NAME

## Task Contract

Before durable work starts, create or reference a Task Contract.

Each task chooses exactly one profile:

- `loop`: one command can judge PASS/FAIL
- `non-loop`: review checklist and evidence are required
- `none`: clarification or administration with no durable artifact

## Loop Boundary

Loop profile is not installed automatically.

If `LOOP.md` or `scripts/verify.sh` is absent, treat the repository as:

```text
loop profile not applied
```

Install loop only after explicit approval.

## Records

Linear is the primary work log. If Linear is unavailable, report the outage and
use repository fallback records only if work continues.

AI-managed work stops at In Review. Done is a human action.
