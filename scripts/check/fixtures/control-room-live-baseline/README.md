# control-room-live-baseline

이 디렉터리의 파일들은 관제실(`D:\문서관리\하네스-관제실\`) 라이브 문서의
**드리프트 전용 현재 기준선 사본**이다.

⚠️ **이것은 「역사 스냅숏」이 아니다.** `scripts/check/fixtures/control-room-worker-dispatch-rule-*-applied.md.txt`
류의 파일들과 혼동하지 마라 — 그것들은 "그때 그 패치가 이걸 만들어 냈다"를
고정하려고 일부러 얼려 둔 파일이고, 라이브 문서가 정당하게 바뀌어도 절대
갱신되지 않는다. 반대로 **이 디렉터리의 파일은 항상 "지금" 라이브 문서와
같아야 하는 파일**이다.

## 규율 (⛔ 위반 시 DRIFT 경보가 상시로 떠서 무시되는 상태가 된다)

**관제실 라이브 파일(예: `worker-dispatch-rule.md`)을 의도적으로 고칠 때마다,
같은 커밋에서 이 디렉터리의 대응 사본도 반드시 갱신해야 한다.**

갱신 절차:

```
cp "D:/문서관리/하네스-관제실/worker-dispatch-rule.md" \
   scripts/check/fixtures/control-room-live-baseline/worker-dispatch-rule.md.txt
```

그리고 `node scripts/check/selfcheck-inventory.mjs` (또는 이 라운드의
selfcheck 정본 실행형태)를 돌려 새 사본이 `ALIVE`로 판정되는지 확인한 뒤
커밋하라.

## 대상 파일

현재는 `worker-dispatch-rule.md` 하나뿐이다. 다른 관제실 문서로 범위를
넓히려면 HYK-336 이후 별도 이슈로 다뤄라.

## 한계

지문(sha256) 대조는 "바뀌었다"만 말한다 — 정당한 수정(예: 새 절 추가)과
악의적 훼손(예: 계약 절 삭제)을 구별하지 못한다. 그래서 이 규율이 필요하다:
사본을 매번 최신으로 유지해야만 DRIFT가 "진짜 이상 신호"로 남는다.
