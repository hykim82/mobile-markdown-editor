// HYK-171 사이클4b-2c (coder-task.md §2-C, 재작업1 §1) -- 배정 결속 좌석
// 증명 계약에 쓰는 원시 fixture. §1의 실측 응답 5종(P1·P2·N1·N2·N3)을
// 그대로 담는다.
//
// ★schema lock은 fixture에 대해 단언한다. 따라서 lock의 가치는 fixture의
// 충실도와 같다. 재작업1 이전 버전은 오류 응답 `error` 키집합을
// coder-task.md의 서술("error.code = terminal_handle_stale")에서
// `{code}` 단일 키로 재구성했는데, ORCH가 실 CLI 원문을 다시 대조하니
// 실제로는 `{code, message}` 두 키였다 -- 재구성값으로 lock을 세우면
// **영원히 green이면서 틀린 형태를 고정**한다(4b-2c 재작업1의 실제 사고,
// 원인은 ORCH가 원시 응답을 손에 들고도 태스크 문서에 발췌만 남긴 것).
// 이 파일의 원시 fixture는 이제 ORCH가 실 CLI에서 포획한 원문 그대로다
// (포획 시각·명령은 각 fixture 주석에 기재). 서술에서 재구성한 값만
// `SYNTHETIC`으로 표기한다.
//
// 출처(재작업1 갱신): ORCH가 2026-07-27 08:0x KST `orca terminal show
// --terminal <handle> --json` / `orca orchestration dispatch-show --json`
// 원문을 직접 캡처해 coder-task.md 재작업1 §1에 그대로 붙였다(이전처럼
// 축약 없음, `…` 없음). pm-lane 좌석 관측.
//
// 아래 표시가 없는 필드는 전부 실측(MEASURED)이다. 실측 근거가 없어 이
// 코더가 채운 값은 각 줄에 `SYNTHETIC`이라고 명시했다.

// ---------------------------------------------------------------------------
// P1 -- `orca terminal show --terminal <live> --json` (coder-task.md 재작업1
// §1-2, ORCH 원문 캡처 그대로). result.terminal 정확히 14키(스키마락
// 대상): branch, connected, handle, lastOutputAt, leafId, paneRuntimeId,
// preview, ptyId, rendererGraphEpoch, tabId, title, worktreeId,
// worktreePath, writable. 전 필드 값이 이제 MEASURED다(`preview`만 예외 --
// 아래 참조).
// ---------------------------------------------------------------------------
export function rawTerminalShowP1(terminalOverrides = {}) {
  return {
    id: "5273500b-7306-44da-b552-e7c25fd386a2", // MEASURED
    ok: true,
    result: {
      terminal: {
        branch: "refs/heads/hykim82/pm-lane", // MEASURED
        connected: true, // MEASURED
        handle: "term_0d45da55-b526-4d0b-8af1-7315359ee968", // MEASURED
        lastOutputAt: 1785106979315, // MEASURED (epoch ms, number -- 문자열 아님)
        leafId: "baba3a4b-05b3-42e9-ba76-93ad0ba9e071", // MEASURED
        paneRuntimeId: -1, // MEASURED (★실측값 -1 -- 식별자로 쓰지 말 것)
        // preview는 화면 문자열이라 계약이 아니다(S8) -- 키 존재는
        // MEASURED이나 값 자체는 판정에 영향을 주지 않으므로 SYNTHETIC
        // placeholder를 쓴다(어댑터가 이 필드를 절대 읽지 않는다는 계약은
        // S8 테스트가 별도로 고정한다).
        preview: "SYNTHETIC(placeholder -- value is not a contract, S8)",
        ptyId:
          "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/pm-lane@@cd142cb0", // MEASURED
        rendererGraphEpoch: 0, // MEASURED
        tabId: "234f072a-02a5-41e1-a254-3255f248bfcf", // MEASURED
        title: "관리자: pm-lane", // MEASURED (S8 -- 어댑터가 읽지 않는다)
        worktreeId:
          "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/pm-lane", // MEASURED
        worktreePath:
          "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/pm-lane", // MEASURED
        writable: true, // MEASURED
        ...terminalOverrides,
      },
    },
    _meta: { runtimeId: "2126e301-e70a-4595-b7a6-c3721e3a43b9" }, // MEASURED
  };
}

// ---------------------------------------------------------------------------
// P2 -- `orca orchestration dispatch-show --task <id> --json` (coder-task.md
// 재작업1 §1-3, ORCH 원문 캡처 그대로). result.dispatch 정확히 11키
// (스키마락 대상): id, task_id, assignee_handle, assignee_pane_key, status,
// failure_count, last_failure, dispatched_at, completed_at, created_at,
// last_heartbeat_at. 전 필드 값이 이제 MEASURED다.
//
// ★이 fixture는 P1과 같은 좌석의 같은 배정에서 나온 실측 쌍이다(같은
// 캡처 세션, coder-task.md 재작업1 §1-3 명시) -- assignee_pane_key가 P1의
// `${tabId}:${leafId}`와 문자 완전 일치하는 것은 조작된 positive-join이
// 아니라 실측 쌍 자체의 성질이다.
//
// ★시각 함정(§1): dispatched_at/created_at은 UTC다(로컬 KST보다 9시간
// 이르다 -- 실측 22:51 UTC = 07:51 KST 당일). 이 fixture는 그 값을 원시
// 보존만 한다 -- 어떤 판정 코드도 이 필드를 읽지 않는다
// (dispatch-bound-seat-proof.mjs는 시간 필드를 아예 참조하지 않는다).
//
// status:"completed"는 ORCH가 이 배정을 소비 후 완료 처리한 실측 상태다
// (판정 로직은 이 필드도 읽지 않는다).
// ---------------------------------------------------------------------------
export function rawDispatchShowP2(dispatchOverrides = {}) {
  return {
    id: "63bf962f-731e-4724-a61d-10741678e3a2", // MEASURED
    ok: true,
    result: {
      dispatch: {
        id: "ctx_678e18468b3a", // MEASURED
        task_id: "task_c223b713ccc5", // MEASURED
        assignee_handle: "term_0d45da55-b526-4d0b-8af1-7315359ee968", // MEASURED
        assignee_pane_key:
          "234f072a-02a5-41e1-a254-3255f248bfcf:baba3a4b-05b3-42e9-ba76-93ad0ba9e071", // MEASURED
        status: "completed", // MEASURED
        failure_count: 0, // MEASURED
        last_failure: null, // MEASURED
        dispatched_at: "2026-07-26 22:51:08", // MEASURED (★UTC 함정 -- 실제 전달은 2026-07-27 07:51 KST)
        completed_at: "2026-07-26 23:02:41", // MEASURED (UTC, 같은 함정)
        created_at: "2026-07-26 22:51:08", // MEASURED
        last_heartbeat_at: null, // MEASURED
        ...dispatchOverrides,
      },
    },
    _meta: { runtimeId: "2126e301-e70a-4595-b7a6-c3721e3a43b9" }, // MEASURED
  };
}

// ---------------------------------------------------------------------------
// N1/N2/N3 -- `orca terminal show` 오류 응답 (coder-task.md 재작업1 §1-1,
// ORCH 원문 캡처 그대로: 낡은 handle `term_1e81a5f3-…` / 존재하지 않는
// handle `term_00000000-…` / 형식 오류 문자열 `not-a-handle`). 세 가지
// 다른 입력이 전부 같은 오류 코드 `terminal_handle_stale`을 낸다 -- ★이
// fixture 세 개가 (최상위 `id`를 제외하고) 값이 완전히 같은 것이 핵심
// 계약이다(구별 근거 없음을 실측으로 고정, MEASURED).
//
// ★재작업1 수정: `error` 객체의 정확한 전체 키집합은 이전 버전에서
// coder-task.md의 서술("error.code = terminal_handle_stale")만 보고
// `{code}` 단일 키로 재구성했었다 -- ORCH가 원문을 다시 대조하니 실제로는
// **`{code, message}` 두 키**였다(재구성 lock이 틀린 형태를 고정하고
// 있던 사고, 파일 헤더 참조). `message` 값은 `code`와 같은 문자열이다
// (추가 정보를 담지 않는다는 것 자체가 실측 관측 결과다).
//
// ⚠️ 최상위 `id`는 요청마다 다른 값이다(아래 세 함수가 실측대로 서로
// 다른 id를 쓴다) -- 따라서 `id`의 **값**은 계약이 아니고, 스키마락은
// 키 존재와 typeof string만 확인한다(정확한 값 고정 금지).
// ---------------------------------------------------------------------------
function rawTerminalShowHandleStale(id) {
  return {
    id, // MEASURED (값은 요청마다 다름 -- 계약 아님, 키/타입만 계약)
    ok: false,
    error: {
      code: "terminal_handle_stale", // MEASURED
      message: "terminal_handle_stale", // MEASURED (code와 동일 문자열 -- 추가 정보 없음도 실측 관측)
    },
    _meta: { runtimeId: "2126e301-e70a-4595-b7a6-c3721e3a43b9" }, // MEASURED
  };
}

// N1 -- 낡은(stale) handle: 같은 좌석의 직전 handle
// (term_1e81a5f3-f217-49ec-b2b9-40c951ceaee3).
export function rawTerminalShowN1StaleHandle() {
  return rawTerminalShowHandleStale("92f6cdb3-8e65-4111-bea4-cbb492a9785a");
}

// N2 -- 형식은 맞지만 존재하지 않는 handle
// (term_00000000-0000-4000-8000-000000000000).
export function rawTerminalShowN2NonexistentHandle() {
  return rawTerminalShowHandleStale("6dc6473a-d47e-48a4-a9c5-92582e0a3759");
}

// N3 -- handle 형식조차 아닌 문자열(not-a-handle).
export function rawTerminalShowN3MalformedHandle() {
  return rawTerminalShowHandleStale("1f58ae56-eada-492a-be2b-76a49c2f9bb1");
}

// ---------------------------------------------------------------------------
// N-g 보조 -- `terminal list` 행(§1 "list를 신원 근거로 쓰지 말 것" 실측
// 근거: `pty:<worktreeId>@@<hash>` 폴백 composite, tabId===leafId). 이
// 형태를 `terminalShow` 정규화 자리에 통째로 넣으면 result.terminal 봉투
// 자체가 없어 NO_TERMINAL_ENVELOPE로 거부돼야 한다.
//
// ★재작업2 수정(review-1 P1-2): 이 fixture 전체가 SYNTHETIC이다 -- ORCH가
// `terminal list` 원문을 캡처해 제공한 적이 없다(P1/P2/N1-N3와 달리 실
// CLI 응답을 손에 든 적 없음). 파일 헤더의 "미표기 값은 MEASURED" 선언과
// 어긋나지 않도록 모든 필드에 개별 SYNTHETIC 표기를 단다. 값의 신뢰도가
// 판정에 영향을 주지 않는 이유: 이 fixture는 `result.terminals`(복수)
// 구조 자체로 거부되므로(§2-A NO_TERMINAL_ENVELOPE) 안쪽 필드값이 무엇이든
// 결과가 달라지지 않는다 -- 그래도 값을 지어낸 사실 자체는 표기해야 한다
// (표기 허위 방지, review-1 지적).
// ---------------------------------------------------------------------------
export function rawTerminalListRowDisguisedAsShow() {
  return {
    id: "reqTerminalList", // SYNTHETIC (원문 캡처 없음)
    ok: true, // SYNTHETIC (원문 캡처 없음 -- terminal list 성공 응답이라고 가정)
    result: {
      terminals: [
        {
          handle: "term_0d45da55-b526-4d0b-8af1-7315359ee968", // SYNTHETIC (P1의 실측 handle을 재사용했을 뿐, 이 list 응답 자체는 원문 캡처 없음)
          tabId:
            "pty:e841ec57-…::C:/Users/…/hyk171-cycle4b2b4-review@@5dff66e5", // SYNTHETIC (원문 캡처 없음 -- 폴백 composite 형태만 §1 실측 근거를 따름)
          leafId:
            "pty:e841ec57-…::C:/Users/…/hyk171-cycle4b2b4-review@@5dff66e5", // SYNTHETIC (원문 캡처 없음, 위와 동일 사유)
        },
      ],
    },
    _meta: { runtimeId: "runtimeMain" }, // SYNTHETIC (원문 캡처 없음)
  };
}

// ---------------------------------------------------------------------------
// expected -- 배정 결속 좌석 증명 판정의 호출자 기대값(§2-B5/6). P1/P2
// fixture와 정합하는 기본값을 낸다.
// ---------------------------------------------------------------------------
export function expectedMatchingP1P2(overrides = {}) {
  return {
    // harnessTaskId는 P1/P2 어느 쪽에도 대응 필드가 없다(호출자 echo,
    // dispatch-bound-seat-proof.mjs 주석 참조) -- 이 사이클(원 task_id)을
    // 그대로 쓴다.
    harnessTaskId: "HYK-171-cycle4b2c-2",
    runtimeTaskId: "task_c223b713ccc5", // MEASURED (P2 dispatch.task_id와 일치)
    dispatchId: "ctx_678e18468b3a", // MEASURED (P2 dispatch.id와 일치)
    worktreeId:
      "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/pm-lane", // MEASURED (P1 worktreeId와 일치)
    worktreePath:
      "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/pm-lane", // MEASURED (P1 worktreePath와 일치)
    ...overrides,
  };
}
