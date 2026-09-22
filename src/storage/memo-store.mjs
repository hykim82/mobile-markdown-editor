// PRD §8 정책 6줄 중 생성/자동저장/자동저장 실패/저장공간 부족을 여기
// 하나로 묶는다. 이 파일은 storage-adapter 계약(put/get/list/remove)
// 밖의 어떤 것도 알지 못한다 -- 어댑터를 갈아끼워도 이 파일은 안 바뀐다
// (coder-task.md §0-2-⑹).
//
// 모듈 수준 함수 + 명시적 state/config 객체로 나눈 것은 취향이 아니라
// eslint max-lines-per-function(80) 때문이다 -- createMemoStore 안에
// 클로저로 다 넣으면 그 함수 하나가 90줄을 넘는다.
import { generateMemoId } from "./id.mjs";
import { deriveTitleFromBody } from "./title.mjs";
import { isQuotaExceededError, attemptCacheCleanup } from "./quota.mjs";

const DEFAULT_DEBOUNCE_MS = 1000;

function setStatus(state, config, next) {
  state.status = next;
  config.onStatusChange(next);
}

function clearTimer(state, config) {
  if (state.timer) {
    config.clearTimeoutFn(state.timer);
    state.timer = null;
  }
}

// 정책 "자동저장 실패": 즉시 1회 재시도 -> 그래도 실패하면 memo(메모리)는
// 그대로 두고 상태만 남긴다. "입력마다 재시도"는 이 함수를 매 입력마다
// (scheduleDebouncedFlush 경유로) 새로 부르는 것 자체로 실현된다 -- 실패
// 이력을 다음 호출로 들고 가지 않으므로 매 사이클이 독립된 "최대 2회
// 시도"다.
async function performSave(state, adapter, config) {
  if (!state.memo) return;
  const record = { ...state.memo };
  setStatus(state, config, "saving");
  try {
    await adapter.put(record);
    setStatus(state, config, "ok");
  } catch (firstErr) {
    const quota = isQuotaExceededError(firstErr);
    setStatus(state, config, quota ? "quota-exceeded" : "retrying");
    if (quota) await config.cacheCleanup();
    try {
      await adapter.put(record);
      setStatus(state, config, "ok");
    } catch (secondErr) {
      setStatus(
        state,
        config,
        isQuotaExceededError(secondErr) ? "quota-exceeded" : "failed",
      );
    }
  }
}

function scheduleDebouncedFlush(state, adapter, config) {
  clearTimer(state, config);
  state.timer = config.setTimeoutFn(() => {
    state.timer = null;
    performSave(state, adapter, config);
  }, config.debounceMs);
}

async function createNewMemo(state, adapter, config, body) {
  state.memo = {
    id: config.idFactory(),
    title: deriveTitleFromBody(body),
    body,
    createdAt: config.now(),
    updatedAt: config.now(),
    deletedAt: null,
  };
  clearTimer(state, config);
  await performSave(state, adapter, config); // 생성 순간은 디바운스 없이 즉시 저장
}

async function clearToEmpty(state, adapter, config) {
  const id = state.memo.id;
  state.memo = null;
  clearTimer(state, config);
  setStatus(state, config, "idle");
  try {
    await adapter.remove(id);
  } catch {
    // 빈 메모 정리 실패는 무해하다 -- 다음 입력이 새 메모를 다시 만든다.
  }
}

// 정책 "생성": 첫 글자 입력 순간 생성·저장 -- 빈 메모는 만들지 않는다.
// 이미 있는 메모가 도로 빈 문자열이 되면(전체 삭제) "빈 메모는 저장
// 안 함" 불변을 데이터 계층에서도 지키기 위해 하드 삭제하고 다음
// 입력에서 새로 만든다.
async function handleContentChange(state, adapter, config, body) {
  if (!state.memo) {
    if (body.length === 0) return;
    await createNewMemo(state, adapter, config, body);
    return;
  }
  if (body.length === 0) {
    await clearToEmpty(state, adapter, config);
    return;
  }
  state.memo.body = body;
  state.memo.title = deriveTitleFromBody(body);
  state.memo.updatedAt = config.now();
  scheduleDebouncedFlush(state, adapter, config);
}

// setTimeout/clearTimeout 을 그대로(레퍼런스만) 기본값으로 넘기면 실제
// 브라우저에서 "TypeError: Illegal invocation" 이 난다 -- 네이티브
// setTimeout 은 window 를 this 로 받아야 하는데, config.setTimeoutFn(...)
// 처럼 다른 객체의 메서드로 호출되면 this 가 config 로 바뀐다(Node의
// setTimeout 은 이 제약이 없어 node:test 시험은 이 버그를 못 잡았다 --
// 실기기/실브라우저(claude-in-chrome)로 실제 입력해 보고서야 드러남).
// 화살표 함수로 한 번 감싸면 내부에서 전역 setTimeout 을 "메서드 호출이
// 아니라 그냥 호출"하게 되어 this 문제가 사라진다.
function buildConfig(options) {
  return {
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    now: options.now ?? (() => Date.now()),
    idFactory: options.idFactory ?? generateMemoId,
    onStatusChange: options.onStatusChange ?? (() => {}),
    cacheCleanup: options.cacheCleanup ?? attemptCacheCleanup,
    setTimeoutFn: options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeoutFn: options.clearTimeoutFn ?? ((id) => clearTimeout(id)),
  };
}

export function createMemoStore(adapter, options = {}) {
  const config = buildConfig(options);
  const state = { memo: null, timer: null, status: "idle" };

  return {
    onContentChange: (body) =>
      handleContentChange(state, adapter, config, body),
    // 정책 "자동저장": 뒤로가기·백그라운드 전환 시 즉시 저장(디바운스 무시).
    flushImmediate: () => {
      clearTimer(state, config);
      return performSave(state, adapter, config);
    },
    loadMemo: (record) => {
      state.memo = record ? { ...record } : null;
      setStatus(state, config, "idle");
    },
    getMemoId: () => state.memo?.id ?? null,
    getStatus: () => state.status,
  };
}
