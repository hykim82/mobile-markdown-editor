// HYK-447 1R (HYK-431 6R / HYK-436 계승) -- 신뢰 경계에서 입력을 "평범한
// 자료"로 고정하는 단일 지점(coder-task.md §2-1).
//
// ---- 왜 이 파일이 다시 바뀌었는가 (6R 경계가 두 곳 뚫렸다) ----
//
// 6R의 경계는 "입력을 한 번 읽어 깊게 얼린 사본으로 복사"했다. 검토 7R이
// 그 경계 **자체**를 두 곳 뚫었다:
//
//   ⓐ 평범한 자료가 아닌 값이 **거부되지 않고 접혔다**. `new Date(...)`·
//      `new Map()`·`new Set([...])`은 own enumerable 키가 없으므로 6R의
//      순회에서 `{}`가 됐고, teardown 정책이 그 빈 껍데기를 "정책이 비어
//      있다"로 읽어 `allowSink:true`(파괴 허가)까지 갔다. 안전장치를 끄려고
//      만든 값이 **빈 껍데기로 접히면 안전장치 자체가 사라진다**.
//   ⓑ 굳히는 **도중**에 입력이 자기 형제를 바꿨다. 6R은 "필드마다 정확히
//      한 번"은 지켰지만, 그 한 번이 **입력이 심어 둔 코드(getter)를 실행**
//      했다. seat의 `paneKey` getter가 읽히는 순간 `policy.protectedSeats`를
//      비웠고, 아직 읽지 않은 그 형제를 뒤이어 읽은 순회는 빈 목록을 봤다 --
//      판정이 "회수해도 된다"로 뒤집혔다. 필드별 1회는 **입력 전체에 대한
//      원자적 관찰이 아니다**.
//
// ---- 이 파일이 지금 요구하는 성질 (⒜⒝⒞) ----
//
// 뿌리는 하나다: 6R은 "무엇이든 받아서 자료로 **만들려고**" 했다. 자료가
// 아닌 것을 자료로 만들려면 그 값의 코드(getter·트랩)를 실행해야 하고,
// 실행하는 순간 관찰은 더 이상 한 시점이 아니다. 그래서 이 라운드는
// 방향을 뒤집는다 -- **경계는 아무것도 만들지 않는다. 이미 평범한 자료인
// 것만 받고, 아니면 거부한다.**
//
//   ⒜ **접힘 금지 -> 명시 거부(fail-closed)**: 아래 `plainKind`가 "평범한
//      자료인가"를 **판별**한다(허용 목록을 늘리는 방식이 아니다). 판별
//      기준은 값의 이름이 아니라 그 값이 **불활성 자료인가**이다:
//        - 원시값(string/number/boolean/null/undefined), 또는
//        - 프로토타입이 정확히 `Array.prototype`인 배열, 또는
//        - 프로토타입이 정확히 `Object.prototype`이거나 `null`인 객체.
//      `Date`·`Map`·`Set`·정규식·클래스 인스턴스·Array 서브클래스·함수·
//      심볼·BigInt·Proxy는 전부 이 판별에 **떨어진다**. 그리고 own 속성 중
//      하나라도 **접근자(getter/setter)** 이면 그 값은 "읽으면 코드가 도는
//      물건"이므로 역시 거부한다. `{}`로 접거나 부분 사본을 만들지 않는다.
//      ★HYK-447 2R: 이 판별은 값의 **종류**만이 아니라 속성의 **가시성**에도
//      미친다. `Object.keys`는 열거 가능한 own 문자열 키만 돌기 때문에
//      **비열거 own 속성과 심볼 키는 순회에 들어오지도 못하고 사라졌다** --
//      검토 1R 이 그 구멍으로 teardown 의 보호 목록(`protectedTargets`)과
//      내구 증거 요구(`requireDurableEvidence`)를 **숨겨서** `allowSink:true`
//      를 얻어냈다. 「사라진 필드」는 「없는 필드」와 구별되지 않으므로,
//      안전장치를 숨기는 것만으로 파괴가 허가된다. 그래서 이제 순회는
//      `Reflect.ownKeys`로 **own 속성을 하나도 빠뜨리지 않고** 보고, 자료로
//      옮길 수 없는 것(비열거·심볼 키·배열의 비원소 own 키)은 **버리지 않고
//      거부한다**. ⛔이것은 "필드 이름 몇 개를 특별히 챙기는" 허용 목록이
//      아니다 -- 이름을 전혀 보지 않고 «속성이 자료로 옮겨지는가»만 본다.
//   ⒝ **원자적 관찰**: ⒜의 판별을 통과한 값의 그래프에는 **실행될 수 있는
//      것이 하나도 없다**. 순회가 하는 일은 `Object.keys` ·
//      `Object.getOwnPropertyDescriptor` · 순정 배열의 `length` 읽기뿐이고,
//      이들은 입력이 심은 코드를 부르지 않는다(Proxy는 그 전에 거부됐고,
//      접근자는 값을 꺼내지 않고 서술자로만 확인한다). 즉 **순회 도중에는
//      입력의 어떤 코드도 돌 수 없으므로, 입력이 자기 형제를 바꿔치기할
//      틈이 원리적으로 없다** -- 관찰은 필드별 1회가 아니라 입력 **전체에
//      대해 한 시점**이다. 이것이 7R P1-ⓑ를 닫는 구조적 근거다.
//      ★ 6R처럼 "getter를 한 번만 부른다"로는 이 성질을 얻을 수 없다.
//      한 번이라도 부르면 그 한 번 안에서 형제가 바뀌기 때문이다. 코드를
//      **아예 부르지 않는 것**만이 원자성을 준다.
//   ⒞ **통과 후 불변**: 산출물의 노드는 전부 `Object.freeze`된 순정 배열/
//      객체이고 잎은 전부 원시값이다. 프로토타입은 이 파일이 만든 리터럴의
//      것이지 입력의 것이 아니며, 키는 `Object.defineProperty`로 심어
//      `__proto__`가 setter를 타고 산출물의 프로토타입을 바꾸는 길도 막는다.
//      원본을 나중에 어떻게 바꿔도 산출물은 따라가지 않는다(복사이므로).
//
// ---- 왜 "거부"가 곧 안전이 아닌가 (호출자 계약) ----
//
// 이 파일은 판정을 대신하지 않는다. `{ok:false}`를 받은 호출자가 그것을
// **fail-closed로 접어야** 안전이 완성된다. 세 소비자가 그렇게 한다:
// grant는 `DELEGATION_INVALID`, seat는 `SEAT_RECLAIM_SCHEMA_INVALID`,
// teardown은 `TEARDOWN_SCHEMA_INVALID`(`allowSink:false`), 사후 판정은
// `FAILED_SPLIT`(성공으로 세지 않는다), anomaly 축만 그 축의 의도적
// 비대칭에 따라 ANOMALY(신호 쪽)로 접는다.
//
// ⚠️ 정직 한계(등급: 확실): 이 경계는 "값의 **표현형**이 평범한 자료인가"만
// 판별한다. 처음부터 평범한 자료로 들어온 거짓말(예: 실제와 다른 짧은 진짜
// 배열, `{"0":"x","length":0}`처럼 배열을 흉내 낸 순정 객체)은 이미 "그
// 자료 자체"이므로 이 경계가 구별할 수 없다 -- 그건 소비자의 스키마가
// "그 자리에 와야 할 자료의 모양"으로 거부할 몫이다(teardown의
// `isValidPolicyShape`가 정확히 그 자리다).

import { types } from "node:util";

export const PLAIN_SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 12,
  maxNodes: 8192,
});

const KIND_ARRAY = "array";
const KIND_OBJECT = "object";

function fail(reason) {
  return { ok: false, reason, value: undefined };
}

function errText(err) {
  try {
    if (err && typeof err === "object" && typeof err.message === "string") {
      return err.message;
    }
    return String(err);
  } catch {
    return "unknown error (message accessor threw)";
  }
}

// 원시값 -- 그 자체가 이미 "흔들 수 없는" 자료다(문자열 위장 객체는
// typeof가 "object"라 여기 들어오지 못한다).
function isPlainPrimitive(v) {
  const t = typeof v;
  return (
    v === null ||
    t === "string" ||
    t === "number" ||
    t === "boolean" ||
    t === "undefined"
  );
}

// ★⒜의 판별기. "이 값이 평범한 자료인가"를 프로토타입 동일성으로 정한다.
// 이름표(instanceof·Symbol.toStringTag·constructor.name)를 보지 않는 것은
// 의도적이다 -- 그런 조회는 입력이 심어 둔 코드를 돌릴 수 있고(⒝ 위반),
// 이름은 위조할 수 있지만 "프로토타입이 정확히 Object.prototype인가"는
// 위조할 수 없다. 통과하지 못하는 값은 부류를 늘려 가며 막는 것이 아니라
// **애초에 이 판별을 통과한 적이 없다**(Date/Map/Set/RegExp/Error/클래스
// 인스턴스/Array 서브클래스/null 아닌 임의 프로토타입 전부 여기서 떨어진다).
function plainKind(v) {
  const proto = Object.getPrototypeOf(v);
  if (Array.isArray(v)) return proto === Array.prototype ? KIND_ARRAY : null;
  return proto === Object.prototype || proto === null ? KIND_OBJECT : null;
}

// 값을 **꺼내지 않고** own 속성 하나를 판별한다(HYK-447 2R 에서 «가시성»까지
// 본다). 세 가지를 거부하고, 어느 것도 값을 꺼내지 않는다:
//
//   - **심볼 키**: 산출물은 문자열 키만 있는 평범한 자료다. 심볼 키를 그냥
//     지나치면 그 값은 «없던 것»이 된다 -- 아래 non-enumerable 과 같은
//     «조용한 소멸»이므로 같은 문으로 거부한다.
//   - **비열거 own 속성**: ★검토 1R P1 이 정확히 이 자리다. `Object.keys`는
//     비열거 own 속성을 돌지 않으므로 6R/1R 의 순회에서 그 속성은 **사라졌고**,
//     teardown 은 «보호 목록이 없다»로 읽어 `allowSink:true` 를 냈다.
//     숨겨진 필드가 «없는 필드»가 되면 안전장치를 숨기는 것만으로 파괴가
//     허가된다 -- 그래서 사라뜨리지 않고 **입력 전체를 거부**한다.
//   - **접근자**: 꺼내는 순간 입력의 코드가 돌기 때문이다(1R P1-ⓑ).
//
// ⚠️순서가 의미를 갖는다: 비열거 검사가 접근자 검사보다 **먼저**다. 비열거
// getter 는 «호출되지 않는» 대신 사라져서 같은 fail-open 을 만들었으므로
// (검토 1R 원문), 그 입력의 사유는 «숨겨졌다»가 맞다.
function inspectOwn(v, key, where) {
  if (typeof key === "symbol") {
    return {
      problem:
        `${where} has a symbol-keyed own property (${String(key)}) -- ` +
        "a symbol key cannot be carried into plain data, so the input is " +
        "refused instead of silently dropping it",
    };
  }
  const desc = Object.getOwnPropertyDescriptor(v, key);
  if (desc === undefined) return { absent: true };
  if (!desc.enumerable) {
    return {
      problem:
        `${where} has a non-enumerable own property ('${key}') -- ` +
        "it would silently disappear from the snapshot, and a hidden field " +
        "must never become an absent field, so the input is refused",
    };
  }
  if (!("value" in desc)) {
    return {
      problem:
        `${where} has an accessor property ('${key}') -- ` +
        "reading it would run the input's own code during the snapshot, so " +
        "it is refused instead of read",
    };
  }
  return { value: desc.value };
}

// 순정 배열의 own 키는 «원소 인덱스 + length» 뿐이어야 한다. 그 밖의 own
// 키(예: `arr.hidden = …`, 심볼 키)는 순회에 들어오지 않아 **사라지므로**
// 같은 이유로 거부한다.
function isIndexKey(key) {
  const n = Number(key);
  return Number.isSafeInteger(n) && n >= 0 && String(n) === key;
}

function auditArrayKeys(v) {
  for (const key of Reflect.ownKeys(v)) {
    // `length`는 언어가 정의한 own data property다(비열거) -- 순정 배열에서
    // 이것은 «숨겨진 필드»가 아니라 배열의 형태 그 자체이고, 아래에서 실제로
    // 읽어 쓴다. plainKind가 이미 Proxy·Array 서브클래스를 걸렀으므로 여기
    // 도달한 `length`는 위조될 수 없다.
    if (key === "length") continue;
    if (typeof key !== "string" || !isIndexKey(key)) {
      return (
        `array carries an own property that is not an element (${String(key)}) -- ` +
        "it would silently disappear from the snapshot, so the input is refused"
      );
    }
    const slot = inspectOwn(v, key, `array index ${key}`);
    if (slot.problem) return slot.problem;
  }
  return null;
}

function snapshotArray(v, ctx, depth) {
  // 순정 배열의 length는 own data property이며 언어 불변식이다 -- 읽어도
  // 입력의 코드가 돌지 않는다(Proxy는 이미 거부됐고 Array 서브클래스도
  // plainKind에서 떨어졌다).
  const len = v.length;
  if (!Number.isSafeInteger(len) || len < 0) {
    return fail(`array length is not a safe non-negative integer (${len})`);
  }
  const keyProblem = auditArrayKeys(v);
  if (keyProblem) return fail(keyProblem);
  const out = [];
  for (let i = 0; i < len; i++) {
    const slot = inspectOwn(v, String(i), `array index ${i}`);
    if (slot.problem) return fail(slot.problem);
    // 구멍(hole)은 undefined로 채운다 -- 6R의 `v[i]`와 같은 값이다.
    const child = snapshotNode(slot.value, ctx, depth + 1);
    if (!child.ok) return child;
    out.push(child.value);
  }
  return { ok: true, value: Object.freeze(out), reason: null };
}

function snapshotObject(v, ctx, depth) {
  const out = {};
  // ★HYK-447 2R: `Object.keys`가 아니라 `Reflect.ownKeys` -- own 속성을
  // **하나도 빠뜨리지 않고** 본다. 빠뜨린 것은 «없는 것»이 되고, 그 소멸이
  // 곧 안전장치의 소멸이었다(검토 1R P1).
  for (const key of Reflect.ownKeys(v)) {
    const slot = inspectOwn(v, key, "input object");
    if (slot.problem) return fail(slot.problem);
    if (slot.absent) continue;
    const child = snapshotNode(slot.value, ctx, depth + 1);
    if (!child.ok) return child;
    // 대입(`out[key] = ...`)이 아니라 defineProperty로 심는다 -- `__proto__`
    // 같은 키가 setter를 타고 산출물의 프로토타입을 바꾸는 길을 아예
    // 막는다(⒞).
    Object.defineProperty(out, key, {
      value: child.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return { ok: true, value: Object.freeze(out), reason: null };
}

function snapshotNode(v, ctx, depth) {
  if (ctx.remaining <= 0) {
    return fail(`input exceeds the ${ctx.maxNodes}-node snapshot budget`);
  }
  ctx.remaining -= 1;
  if (isPlainPrimitive(v)) return { ok: true, value: v, reason: null };
  if (typeof v !== "object") {
    return fail(`a value of type '${typeof v}' is not plain data`);
  }
  if (types.isProxy(v)) {
    return fail(
      "input contains a Proxy -- a Proxy can show different values to " +
        "different readers, so it is refused before it can be fixed as data",
    );
  }
  const kind = plainKind(v);
  if (kind === null) {
    // 이름을 캐묻지 않는다(그 조회 자체가 입력의 코드를 돌릴 수 있다).
    return fail(
      Array.isArray(v)
        ? "input contains an array whose prototype is not Array.prototype " +
            "(an Array subclass is not plain data)"
        : "input contains an object whose prototype is neither " +
            "Object.prototype nor null (Date/Map/Set/RegExp/class instances " +
            "are not plain data) -- it is refused, not folded into {}",
    );
  }
  if (depth >= ctx.maxDepth) {
    return fail(`input nests deeper than the ${ctx.maxDepth}-level limit`);
  }
  return kind === KIND_ARRAY
    ? snapshotArray(v, ctx, depth)
    : snapshotObject(v, ctx, depth);
}

// snapshotPlainData(value, limits) -> { ok, value, reason }
//
// 성공하면 `value`는 원본과 완전히 분리된, 깊게 얼린 평범한 자료다.
// 실패하면 `ok:false`와 사람이 읽을 수 있는 `reason`이다 -- 호출자는
// **반드시 fail-closed로 접어야 한다**(이 파일은 판정을 대신하지 않는다).
// 어떤 인자에도 throw하지 않는다(이 저장소 순수 코어 관례). ⒝ 덕분에 순회
// 도중 입력의 코드가 돌 자리는 없지만, 마지막 안전판으로 try/catch는
// 남긴다(예: 예산·언어 수준의 예기치 못한 예외를 실패 사유로 바꾼다).
export function snapshotPlainData(value, limits) {
  const l = limits !== null && typeof limits === "object" ? limits : {};
  const maxDepth = Number.isSafeInteger(l.maxDepth)
    ? l.maxDepth
    : PLAIN_SNAPSHOT_LIMITS.maxDepth;
  const maxNodes = Number.isSafeInteger(l.maxNodes)
    ? l.maxNodes
    : PLAIN_SNAPSHOT_LIMITS.maxNodes;
  const ctx = { remaining: maxNodes, maxNodes, maxDepth };
  try {
    return snapshotNode(value, ctx, 0);
  } catch (err) {
    return fail(`reading the input threw (${errText(err)})`);
  }
}
