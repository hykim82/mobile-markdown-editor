// HYK-171 사이클4b-1 (coder-task.md §2-B) -- teardown 3축 판정 순수 코어.
// 부작용 0 · 시각/랜덤/fs/network 0. 입력은 teardown-inventory-adapter.mjs가
// 만든 관측 봉투(inventory)와 정책(policy)뿐이다. 이 파일은 `orca` 문자열도,
// vendor 이름도, pane key/PID도 전혀 모른다(G9 -- 그런 것들은 어댑터에만
// 있다).
//
// judgeTeardown이 내는 판정은 "지금 파괴해도 되는가"(allowSink)뿐이다.
// 파괴 자체(close/rm)는 이 파일이 절대 실행하지 않는다 -- execution은 이
// 단계에서 항상 NOT_ATTEMPTED다(judgePostConditions만 실행 후 사후 관측을
// SUCCEEDED/FAILED_*로 판정한다).

// ---- HYK-431 6R (coder-task.md §2-2): 관측을 한 번으로 줄인다 ----
// 검토 6R은 `Array.isArray(proxy)===true`인 Proxy가 `length`를 0으로
// 보고하게 만들어 policy.protectedTargets를 통째로 숨겼고, 그 결과 보호
// 표적이 TEARDOWN_ELIGIBLE(allowSink:true)이 됐다. 4R의 원형 메서드
// 차용(`Array.prototype.includes.call`)은 "로직이 입력에 조종되지 않게"
// 했을 뿐, 그 로직이 **읽는 값**까지 고정하지는 못한다.
// 6R은 judgeTeardown/judgePostConditions 진입에서 인자를 단 한 번 읽어
// 깊게 얼린 평범한 자료로 고정하고, 스키마 검사도 분류도 evidence도 그
// 고정본만 쓴다 -- 검증기와 소비자가 같은 물건을 본다.

import { snapshotPlainData } from "./plain-snapshot.mjs";

export const TEARDOWN_SCHEMA_VERSION = 1;

export const OBSERVATION = Object.freeze({
  CONSISTENT_PRESENT: "CONSISTENT_PRESENT",
  CONSISTENT_ABSENT: "CONSISTENT_ABSENT",
  SPLIT_STATE: "SPLIT_STATE",
  UNOBSERVABLE: "UNOBSERVABLE",
});

export const ELIGIBILITY = Object.freeze({
  PROTECTED: "PROTECTED",
  ACTIVE_REFERENCE: "ACTIVE_REFERENCE",
  DIRTY_OR_UNMERGED: "DIRTY_OR_UNMERGED",
  EVIDENCE_NOT_DURABLE: "EVIDENCE_NOT_DURABLE",
  ELIGIBLE: "ELIGIBLE",
});

export const EXECUTION = Object.freeze({
  NOT_ATTEMPTED: "NOT_ATTEMPTED",
  SUCCEEDED: "SUCCEEDED",
  FAILED_UNCHANGED: "FAILED_UNCHANGED",
  FAILED_SPLIT: "FAILED_SPLIT",
});

// judgeTeardown/judgePostConditions의 reason 코드 -- evidence.ruleId도 이
// 집합에서만 나온다(mutation #1이 요구하는 "위반 규칙 id" 대조 대상).
export const REASON = Object.freeze({
  SCHEMA_INVALID: "TEARDOWN_SCHEMA_INVALID",
  PROTECTED_TARGET: "TEARDOWN_PROTECTED_TARGET",
  ACTIVE_REFERENCE: "TEARDOWN_ACTIVE_REFERENCE",
  DIRTY_WORKING_TREE: "TEARDOWN_DIRTY_WORKING_TREE",
  UNMERGED_WORKING_TREE: "TEARDOWN_UNMERGED_WORKING_TREE",
  EVIDENCE_NOT_DURABLE: "TEARDOWN_EVIDENCE_NOT_DURABLE",
  // HYK-431 8R: 막을 사유는 못 찾았지만 「파괴해도 된다」를 뒷받침할 근거가
  // 갖춰지지 않았다는 뜻이다(부재 = 판정 불가). EVIDENCE_NOT_DURABLE 과
  // 버킷(eligibility)은 같고 사유만 구별한다 -- 「증거가 약하다」와
  // 「판정할 근거가 아예 없다」는 사람에게 다른 이야기이기 때문이다.
  PREMISE_UNPROVEN: "TEARDOWN_PREMISE_UNPROVEN",
  TARGET_IDENTITY_MISMATCH: "TEARDOWN_TARGET_IDENTITY_MISMATCH",
  DISPATCH_CORRELATION_UNPROVEN: "TEARDOWN_DISPATCH_CORRELATION_UNPROVEN",
  UNOBSERVABLE_LAYER: "TEARDOWN_UNOBSERVABLE_LAYER",
  SPLIT_STATE: "TEARDOWN_SPLIT_STATE",
  CONSISTENT_ABSENT: "TEARDOWN_CONSISTENT_ABSENT",
  ELIGIBLE: "TEARDOWN_ELIGIBLE",
});

const LAYER_VALUES = Object.freeze(["present", "absent", "unobservable"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isLayerValue(v) {
  return LAYER_VALUES.includes(v);
}

// HYK-171 사이클4b-1 재작업(streak 1, REVIEW review-1 P1-2 수리): `target`
// 봉투는 `canonicalPathDigest`만이 아니라 `worktreeId`·`repoId` 두 키도
// **항상 존재**해야 한다(키 부재 자체가 결손). 값은 non-empty string 또는
// 명시적 `null`만 허용한다(정책 결정, 근거: teardown-inventory-adapter.mjs
// 가 관측 실패/부재 시 이 두 필드에 넣는 값이 정확히 `null`이다 -- 그
// `null`은 "모른다"는 정직한 신호로 **허용값**이지, observable:false로
// 격상시킬 사유가 아니다. 하지만 키 자체가 없거나 숫자·객체 등 엉뚱한
// 타입이면 그 봉투는 이 코어의 계약을 지키지 않는 것이므로 스키마
// 위반으로 fail-closed 한다). REVIEW 실측: 이 검사가 없으면 두 필드를
// 완전히 뺀 입력도 `allowSink:true`까지 통과했다.
function isValidNullableIdField(target, key) {
  if (!(key in target)) return false;
  const v = target[key];
  return v === null || isNonEmptyString(v);
}
function isValidTarget(target) {
  return (
    isPlainObject(target) &&
    isNonEmptyString(target.canonicalPathDigest) &&
    isValidNullableIdField(target, "worktreeId") &&
    isValidNullableIdField(target, "repoId")
  );
}
function isValidLayers(layers) {
  return (
    isPlainObject(layers) &&
    isLayerValue(layers.git) &&
    isLayerValue(layers.orca) &&
    isLayerValue(layers.dir)
  );
}
function isValidActiveReferences(refs) {
  return (
    isPlainObject(refs) &&
    Number.isInteger(refs.count) &&
    refs.count >= 0 &&
    Array.isArray(refs.tokens) &&
    typeof refs.observable === "boolean"
  );
}
function isValidWorkingTree(wt) {
  return (
    isPlainObject(wt) &&
    typeof wt.dirty === "boolean" &&
    typeof wt.untracked === "boolean" &&
    typeof wt.unmerged === "boolean" &&
    typeof wt.observable === "boolean"
  );
}

// ---- HYK-447 1R: 정책도 스키마로 fail-closed 한다 ----
// 검토 7R P1-ⓐ의 실제 harm path는 경계 하나가 아니라 **경계 + 여기**였다:
// `new Set([...])`/`new Date(...)`/`{"0":"x","length":0}`을 정책으로 주면
// (경계가 거부하기 전 6R에서는 `{}`로 접혔고) `isProtectedTarget`의
// 비-array fallback `[]`가 그 값을 "보호 목록이 비어 있다"로 읽어
// `allowSink:true`까지 갔다. 경계가 표현형을 거부하게 됐어도 **순정 객체로
// 배열을 흉내 낸 값**(`{"0":"x","length":0}`)은 이미 "그 평범한 자료 자체"
// 라 경계가 구별할 수 없다(plain-snapshot.mjs 정직 한계) -- 그러니 "보호
// 목록을 읽을 수 없다"를 "보호 목록이 비어 있다"로 조용히 바꿔치기하는
// fallback 자체를 없앤다. 읽을 수 없으면 판정하지 않는다(SCHEMA_INVALID,
// allowSink:false). seat-reclaim-core.mjs의 classifyProtection이 이미 같은
// 원칙을 쓴다(그쪽은 PROTECTED로, 여기는 SCHEMA_INVALID로 접는다 -- 두
// 방향 모두 "파괴하지 않는다" 쪽이다).
function isArrayOfNonEmptyStrings(v) {
  return (
    Array.isArray(v) &&
    Array.prototype.every.call(v, (el) => isNonEmptyString(el))
  );
}
function isValidPolicyShape(policy) {
  if (policy === undefined || policy === null) return true; // 정책 미제공은
  // 유효하다 -- 그 경우 dispatchCorrelationProven이 없어 어차피 차단된다.
  if (!isPlainObject(policy)) return false;
  if (
    policy.protectedTargets !== undefined &&
    !isArrayOfNonEmptyStrings(policy.protectedTargets)
  ) {
    return false;
  }
  if (
    policy.requireDurableEvidence !== undefined &&
    typeof policy.requireDurableEvidence !== "boolean"
  ) {
    return false;
  }
  if (
    policy.expectedWorktreeId !== undefined &&
    !isNonEmptyString(policy.expectedWorktreeId)
  ) {
    return false;
  }
  // `dispatchCorrelationProven`은 여기서 형을 따지지 않는다 -- 그 필드는
  // armed strict(`=== true`)라 값이 무엇이든 틀리면 **그 자체로 차단**되고
  // (DISPATCH_CORRELATION_UNPROVEN), 그 구분된 사유가 이 코어의 기존 결정을
  // 설명한다. 위 세 필드는 반대다: 형이 틀리면 안전장치가 **꺼진다**
  // (목록을 못 읽는데 비었다고 보거나, 요구했는데 요구가 사라진다) --
  // 그래서 그 셋만 형을 강제한다.
  return true;
}

// 스키마/필드 결손/타입 오류를 전부 여기서 잡는다(fail-closed 진입점) --
// 이 함수가 false를 내면 judgeTeardown은 나머지 로직을 전혀 평가하지 않고
// 곧장 UNOBSERVABLE + allowSink:false를 반환한다. 각 하위 검사는 위
// isValid*로 분리했다(복잡도 상한 12 준수).
function isValidInventoryShape(inventory) {
  if (!isPlainObject(inventory)) return false;
  if (inventory.schemaVersion !== TEARDOWN_SCHEMA_VERSION) return false;
  if (!isValidTarget(inventory.target)) return false;
  if (!isValidLayers(inventory.layers)) return false;
  if (!isValidActiveReferences(inventory.activeReferences)) return false;
  if (!isValidWorkingTree(inventory.workingTree)) return false;
  if (!isPlainObject(inventory.observationQuality)) return false;
  return true;
}

// 3층(git/orca/dir) + activeReferences/workingTree의 관측 가능 여부를
// 합쳐 관측 축을 판정한다. 소스 하나라도 unobservable/관측불가면 전체가
// UNOBSERVABLE이다(mutation #5: 빈값/absent로 접지 않는다).
function classifyObservation(inventory) {
  const layers = inventory.layers;
  const values = [layers.git, layers.orca, layers.dir];
  if (
    values.some((v) => v === "unobservable") ||
    inventory.activeReferences.observable !== true ||
    inventory.workingTree.observable !== true
  ) {
    return OBSERVATION.UNOBSERVABLE;
  }
  if (values.every((v) => v === "present"))
    return OBSERVATION.CONSISTENT_PRESENT;
  if (values.every((v) => v === "absent")) return OBSERVATION.CONSISTENT_ABSENT;
  return OBSERVATION.SPLIT_STATE;
}

function isProtectedTarget(inventory, policy) {
  // isValidPolicyShape가 이미 "배열이 아니면 판정 자체를 하지 않는다"로
  // 접었으므로, 여기 도달한 값은 문자열 배열이거나 미제공(빈 목록)뿐이다 --
  // 6R까지 있던 "비-array면 빈 목록으로 본다" fallback은 사라졌다.
  const list = policy.protectedTargets ?? [];
  // exact 대조만(부분일치·정규식 금지, coder-task.md §2-B 비타협).
  // HYK-436과 동형: list는 policy.protectedTargets 그 자체(호출자 입력)일
  // 수 있다 -- list 자신의 includes를 부르면 Array 상속 서브클래스가
  // 재정의해 보호를 우회할 수 있으므로 원형의 원본 includes를 빌려 쓴다.
  return Array.prototype.includes.call(
    list,
    inventory.target.canonicalPathDigest,
  );
}

function buildEvidence(inventory, ruleId, extra = {}) {
  return {
    ruleId,
    layers: inventory.layers,
    activeReferenceTokens: inventory.activeReferences.tokens,
    observationQuality: inventory.observationQuality,
    ...extra,
  };
}

// 우선순위 강제(coder-task.md §2-B 비타협): PROTECTED가 다른 모든 자격
// 판정을 이긴다. 각 guard clause는 독립적으로 제거 가능하게 짜여 있다
// (mutation #1/#4/#6이 하나씩 지워 RED를 재현한다).
// mutation #2 (coder-task.md §3): policy.expectedWorktreeId가 주어졌는데
// 관측된 inventory.target.worktreeId와 다르면(경로 문자열은 같아도) 그
// 표적을 신뢰하지 않는다 -- 워크트리가 지워졌다 같은 경로에 다시 만들어진
// 사이 등, "경로는 같지만 실체가 바뀐" 경우를 잡는 결속 검사다. opt-in(
// expectedWorktreeId 미제공 시 건너뜀) -- production 호출자가 이전에
// 관측/기록해둔 id를 넘길 때만 작동한다.
function checkTargetIdentity(inventory, policy) {
  if (!isNonEmptyString(policy.expectedWorktreeId)) return null;
  if (inventory.target.worktreeId === policy.expectedWorktreeId) return null;
  return {
    eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
    reason: REASON.TARGET_IDENTITY_MISMATCH,
    evidence: buildEvidence(inventory, REASON.TARGET_IDENTITY_MISMATCH, {
      expectedWorktreeId: policy.expectedWorktreeId,
      observedWorktreeId: inventory.target.worktreeId,
    }),
  };
}

// HYK-171 사이클4b-1 재작업3(사람 게이트 결정, coder-task.md §2-B): 배정
// (dispatch)이 이 좌석에서 여전히 활성인지는 **현재 읽기 API로 관측할 수
// 없다**(§0 실측: pane key 상관 자체가 증명 불가). 그 사실을 가짜 관측이나
// 상시-UNOBSERVABLE 상수로 숨기지 않고, "증명됐다고 호출자가 명시적으로
// 선언하지 않는 한 차단"하는 전제조건으로 정직하게 표현한다.
//
// **기본값이 없다**(policy.dispatchCorrelationProven 미제공 = 차단) --
// armed strict(`=== true`)와 동형으로 truthy 관용(문자열 "true"/1)도
// 전부 거부한다. 이 사이클의 프로덕션 호출자는 아무도 이 값을 true로
// 주지 않는다 -- paired-good 테스트만 합성 역량 선언으로 명시한다.
// **4b-2가 권위 있는 배정↔좌석 상관 수단을 만들기 전까지 이 전제조건을
// 절대 완화하지 않는다**(주석 자체가 그 다짐이다 -- 이 줄을 지우거나
// 조건을 truthy로 바꾸는 변경은 이 사이클의 판단을 뒤집는 것이다).
function checkDispatchCorrelationProven(inventory, policy) {
  if (policy.dispatchCorrelationProven === true) return null;
  return {
    eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
    reason: REASON.DISPATCH_CORRELATION_UNPROVEN,
    evidence: buildEvidence(inventory, REASON.DISPATCH_CORRELATION_UNPROVEN, {
      note:
        "배정(dispatch)이 이 좌석에서 활성인지는 현재 읽기 API로 증명 " +
        "불가능하다(pane key 상관 없음, coder-task.md §0 실측) -- " +
        "dispatchCorrelationProven이 명시적으로 true가 아니면 차단한다.",
    }),
  };
}

// ---- HYK-431 8R: 「부재」는 「통과」가 아니라 「판정 불가」다 ----
//
// 검토 8R 이 통과시킨 입력: 형태가 유효한 inventory + 깨끗한 작업 트리 +
// `target.worktreeId: null` + `target.repoId: null` + 정책
// `{ dispatchCorrelationProven: true }` -> `allowSink: true`. 즉 안전장치를
// **숨긴** 것도 위조한 것도 아니고 **아예 주지 않은** 것만으로 파괴가
// 허가됐다. 원인은 이 함수가 「주어진 값이 안전한가」만 보기 때문이다 --
// 값이 없으면 그 값을 보는 guard 를 **아예 타지 않으므로** 통과한다.
//
// ★그래서 판정의 성질을 하나 바꾼다: 이 함수의 마지막 `ELIGIBLE` 은
// 「막을 사유를 못 찾았다」가 아니라 「파괴해도 된다는 결론」이다. 적극적인
// 결론은 그것이 기대는 **축마다 근거가 실제로 주어졌을 때만** 낼 수 있다.
// 근거가 없는 축은 「통과」가 아니라 「판정 불가」이고, 판정 불가가 하나라도
// 있으면 결론은 ELIGIBLE 이 아니다(fail-closed).
//
// ⛔이것은 「세 이름을 특별히 챙기는 허용 목록」이 아니다(HYK-447 이 같은
// 함정을 겪었다). 아래 목록의 각 항은 **이 함수가 실제로 기대는 축 그 자체**
// 이며 같은 파일 안의 guard 와 1:1 로 대응한다:
//   - protectedTargets      <-> isProtectedTarget       (보호 대상인가)
//   - expectedWorktreeId    <-> checkTargetIdentity     (그 표적이 맞는가)
//   - requireDurableEvidence<-> 아래 requireDurableEvidence guard (증거를 요구하는가)
// 판정이 기대지 않는 필드는 **이름이 무엇이든 요구하지 않는다** -- 계약에
// 없는 새 이름을 넣어도 판정은 달라지지 않고, 반대로 위 축 중 하나가 비면
// 다른 무엇을 채워 넣어도 통과하지 않는다(coder-task.md §4-4 가 요구한
// 자기 증명).
//
// ⚠️`dispatchCorrelationProven` 은 이 목록에 없다 -- 그 축은 이미
// `checkDispatchCorrelationProven` 이 **부재를 곧 차단**으로 다루고 있어서
// (armed strict) 여기까지 오지 못한다. 즉 그 축은 이 라운드가 세우려는
// 성질을 **이미 갖춘 선례**이고, 이 목록은 나머지 축을 그 선례와 같은
// 성질로 맞추는 것이다.
const ELIGIBILITY_PREMISES = Object.freeze([
  Object.freeze({
    axis: "protectedTargets",
    why: "보호 목록이 주어지지 않으면 이 표적이 보호 대상이 아니라고 판정할 수 없다",
  }),
  Object.freeze({
    axis: "expectedWorktreeId",
    why: "기대 식별자가 주어지지 않으면 관측된 표적이 지우려던 그 표적인지 결속할 수 없다",
  }),
  Object.freeze({
    axis: "requireDurableEvidence",
    why: "내구 증거를 요구하는지 주어지지 않으면 그 축을 판정할 수 없다",
  }),
]);

function isSupplied(v) {
  return v !== undefined && v !== null;
}

// 근거가 갖춰지지 않은 축이 하나라도 있으면 판정 불가(fail-closed)를 낸다.
// 형태(타입) 검사는 isValidPolicyShape가 이미 했으므로 여기서는 「주어졌는가」
// 만 본다 -- 두 검사는 서로 다른 질문이다(형태가 틀렸다 vs 아예 없다).
function checkEligibilityPremises(inventory, policy) {
  const unproven = ELIGIBILITY_PREMISES.filter(
    (premise) => !isSupplied(policy[premise.axis]),
  );
  if (unproven.length === 0) return null;
  return {
    eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
    reason: REASON.PREMISE_UNPROVEN,
    evidence: buildEvidence(inventory, REASON.PREMISE_UNPROVEN, {
      unprovenPremises: unproven.map((premise) => premise.axis),
      why: unproven.map((premise) => premise.why),
    }),
  };
}

// mutation #6 축을 이웃 guard(checkTargetIdentity·checkDispatchCorrelationProven)
// 와 같은 형태로 옮겼다 -- 로직은 그대로이고, classifyEligibility 가 8R 의
// 전제 확인을 한 줄 더 갖게 되면서 복잡도 상한(12)을 지키기 위한 분리다.
function checkDurableEvidence(inventory, policy) {
  if (policy.requireDurableEvidence !== true) return null;
  if (isNonEmptyString(inventory.target.worktreeId)) return null;
  return {
    eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
    reason: REASON.EVIDENCE_NOT_DURABLE,
    evidence: buildEvidence(inventory, REASON.EVIDENCE_NOT_DURABLE, {
      worktreeId: inventory.target.worktreeId,
    }),
  };
}

function classifyEligibility(inventory, policy) {
  if (isProtectedTarget(inventory, policy)) {
    return {
      eligibility: ELIGIBILITY.PROTECTED,
      reason: REASON.PROTECTED_TARGET,
      evidence: buildEvidence(inventory, REASON.PROTECTED_TARGET, {
        protectedTargets: policy.protectedTargets ?? [],
      }),
    };
  }
  const identityMismatch = checkTargetIdentity(inventory, policy);
  if (identityMismatch) return identityMismatch;
  const dispatchCorrelationBlocked = checkDispatchCorrelationProven(
    inventory,
    policy,
  );
  if (dispatchCorrelationBlocked) return dispatchCorrelationBlocked;
  if (
    inventory.activeReferences.observable !== true ||
    inventory.activeReferences.count > 0
  ) {
    return {
      eligibility: ELIGIBILITY.ACTIVE_REFERENCE,
      reason: REASON.ACTIVE_REFERENCE,
      evidence: buildEvidence(inventory, REASON.ACTIVE_REFERENCE, {
        activeReferenceCount: inventory.activeReferences.count,
      }),
    };
  }
  if (inventory.workingTree.observable !== true) {
    return {
      eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
      reason: REASON.EVIDENCE_NOT_DURABLE,
      evidence: buildEvidence(inventory, REASON.EVIDENCE_NOT_DURABLE),
    };
  }
  // unmerged를 dirty보다 먼저 본다 -- 충돌(unmerged) 라인은 항상 dirty도
  // true로 만들기 때문에(git status 표에서 conflict도 "변경 있음"으로
  // 집계된다), 순서를 뒤집으면 unmerged 케이스가 절대 자기 고유 사유
  // (UNMERGED_WORKING_TREE)로 보고되지 못한다(mutation #6b가 이 순서를
  // 고정한다).
  if (inventory.workingTree.unmerged) {
    return {
      eligibility: ELIGIBILITY.DIRTY_OR_UNMERGED,
      reason: REASON.UNMERGED_WORKING_TREE,
      evidence: buildEvidence(inventory, REASON.UNMERGED_WORKING_TREE, {
        workingTree: inventory.workingTree,
      }),
    };
  }
  if (inventory.workingTree.dirty) {
    return {
      eligibility: ELIGIBILITY.DIRTY_OR_UNMERGED,
      reason: REASON.DIRTY_WORKING_TREE,
      evidence: buildEvidence(inventory, REASON.DIRTY_WORKING_TREE, {
        workingTree: inventory.workingTree,
      }),
    };
  }
  // mutation #6 (3번째 독립 사유): policy.requireDurableEvidence===true인
  // 정책 아래서는 orca 자신의 등록 id(worktreeId)가 3층 관측을 corroborate
  // 해야 한다 -- 이는 3층 present/absent 판정(classifyObservation)과는
  // 별개 축이다(observation이 이미 CONSISTENT_PRESENT라도, orca가 그
  // 표적에 자기 id를 못 붙였다면 "path 문자열 일치"만으로 삭제를 허가하지
  // 않는다는 추가 안전판).
  const durableEvidenceBlocked = checkDurableEvidence(inventory, policy);
  if (durableEvidenceBlocked) return durableEvidenceBlocked;
  // ★HYK-431 8R: 여기까지 왔다는 것은 «막을 사유를 찾지 못했다»는 뜻일 뿐,
  // «파괴해도 된다»가 증명된 것이 아니다. 그 둘을 구별한다(아래 주석 참조).
  const unproven = checkEligibilityPremises(inventory, policy);
  if (unproven) return unproven;
  return {
    eligibility: ELIGIBILITY.ELIGIBLE,
    reason: REASON.ELIGIBLE,
    evidence: buildEvidence(inventory, REASON.ELIGIBLE),
  };
}

// judgeTeardown({ inventory, policy }) -- policy: { protectedTargets: string[],
// requireDurableEvidence?: boolean, expectedWorktreeId?: string,
// dispatchCorrelationProven?: boolean }. 순수 판정, 부작용 0.
function schemaInvalidTeardown(evidence) {
  return {
    observation: OBSERVATION.UNOBSERVABLE,
    eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
    execution: EXECUTION.NOT_ATTEMPTED,
    allowSink: false,
    reason: REASON.SCHEMA_INVALID,
    evidence,
  };
}

// 두 스키마 관문을 한 자리에 모은다(inventory 형상 · 정책 형상) -- 둘 다
// fail-closed 방향이 같고(판정하지 않는다), judgeTeardown의 복잡도 상한 12를
// 지키기 위한 분리이기도 하다.
function checkSchemas(inventory, policy) {
  if (!isValidInventoryShape(inventory)) {
    return schemaInvalidTeardown({
      ruleId: REASON.SCHEMA_INVALID,
      inventory: inventory ?? null,
    });
  }
  // HYK-447 1R: 정책을 읽을 수 없으면 판정하지 않는다(isValidPolicyShape
  // 주석 -- "못 읽는다"를 "비어 있다"로 바꿔치기하지 않는다).
  if (!isValidPolicyShape(policy)) {
    return schemaInvalidTeardown({
      ruleId: REASON.SCHEMA_INVALID,
      inventory,
      policyShapeInvalid: true,
    });
  }
  return null;
}

export function judgeTeardown(args = {}) {
  // ★ 신뢰 경계(6R): 인자를 여기서 단 한 번 읽어 고정한다. 고정에
  // 실패하면(Proxy·숨긴 원소·자료 아닌 값) fail-closed -- allowSink:false.
  const fixed = snapshotPlainData(args);
  if (!fixed.ok) {
    return schemaInvalidTeardown({
      ruleId: REASON.SCHEMA_INVALID,
      inventory: null,
      snapshotReason: fixed.reason,
    });
  }
  const { inventory, policy } = isPlainObject(fixed.value) ? fixed.value : {};
  const schemaDenied = checkSchemas(inventory, policy);
  if (schemaDenied) return schemaDenied;
  const p = isPlainObject(policy) ? policy : {};

  const observation = classifyObservation(inventory);
  const {
    eligibility,
    reason: eligibilityReason,
    evidence,
  } = classifyEligibility(inventory, p);

  // observation !== CONSISTENT_PRESENT이면서 eligibility가 ELIGIBLE인
  // 경우(예: 이미 지워진 대상), 보고 사유는 관측 축이 우선한다 -- "이미
  // 없는 표적을 성공으로 세지 않는다"(§2-B CONSISTENT_ABSENT ≠ 성공)와
  // 대칭으로, 여기서도 관측 축이 진짜 차단 사유를 더 정확히 설명한다.
  let reason = eligibilityReason;
  if (
    eligibility === ELIGIBILITY.ELIGIBLE &&
    observation !== OBSERVATION.CONSISTENT_PRESENT
  ) {
    reason =
      observation === OBSERVATION.CONSISTENT_ABSENT
        ? REASON.CONSISTENT_ABSENT
        : observation === OBSERVATION.SPLIT_STATE
          ? REASON.SPLIT_STATE
          : REASON.UNOBSERVABLE_LAYER;
  }

  const allowSink =
    observation === OBSERVATION.CONSISTENT_PRESENT &&
    eligibility === ELIGIBILITY.ELIGIBLE;

  return {
    observation,
    eligibility,
    execution: EXECUTION.NOT_ATTEMPTED,
    allowSink,
    reason,
    evidence,
  };
}

function layersAllAbsent(inv) {
  return (
    isPlainObject(inv) &&
    inv.layers?.git === "absent" &&
    inv.layers?.orca === "absent" &&
    inv.layers?.dir === "absent"
  );
}
function layersAllPresent(inv) {
  return (
    isPlainObject(inv) &&
    inv.layers?.git === "present" &&
    inv.layers?.orca === "present" &&
    inv.layers?.dir === "present"
  );
}

// judgePostConditions({ before, after, cliOk }) -- sink 실행 뒤 사후 3층
// 재관측(after)만으로 성패를 낸다. cliOk(rm 응답의 ok:true)는 절대 단독
// 근거가 아니다(mutation #11: cliOk:true + after가 split이면 FAILED_SPLIT).
// `before`는 이 판정 자체에 쓰이지 않는다(호출자의 로그/증거 보존용으로만
// 함께 넘어온다) -- 성패는 오직 사후 관측(after)만으로 정해진다.
export function judgePostConditions(args = {}) {
  // ★ 신뢰 경계(6R): layersAllAbsent/layersAllPresent가 `after.layers.*`를
  // 각각 한 번씩, 즉 같은 지점을 **두 번** 읽는다 -- 호출마다 다른 값을
  // 주는 입력이면 "absent도 present도 아니다"를 스스로 만들어낼 수 있다.
  // 진입에서 한 번 고정해 그 틈을 없앤다. 고정 실패는 성공으로 세지
  // 않는다(FAILED_SPLIT -- 이 축의 fail-closed 방향).
  const fixed = snapshotPlainData(args);
  if (!fixed.ok) return EXECUTION.FAILED_SPLIT;
  const after = isPlainObject(fixed.value) ? fixed.value.after : undefined;
  if (layersAllAbsent(after)) {
    return EXECUTION.SUCCEEDED;
  }
  if (layersAllPresent(after)) {
    return EXECUTION.FAILED_UNCHANGED;
  }
  return EXECUTION.FAILED_SPLIT;
}
