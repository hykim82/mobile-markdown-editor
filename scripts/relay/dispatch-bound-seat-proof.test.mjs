import { test } from "node:test";
import assert from "node:assert/strict";

import {
  judgeDispatchBoundSeatProof,
  SEAT_PROOF,
  SEAT_PROOF_REASON,
} from "./dispatch-bound-seat-proof.mjs";

// HYK-299-casefold-1 -- 좌석 증명 판정 코어의 경로 동등성(대소문자) 반례
// 시험. §1의 실배달 과탐(정상 배달이 WORKTREE_MISMATCH로 거부됨)이
// 재발하지 않는지, 그리고 §2-3의 "윈도우 모양에 한정" 경계가 실제로
// 탐지력을 지키는지를 코어 판정 함수 수준에서 직접 확인한다.

const DISPATCH_SHOW_BASE = Object.freeze({
  taskId: "task_c223b713ccc5",
  dispatchId: "ctx_678e18468b3a",
  assigneePaneKey: "tab-1:leaf-1",
});

const TERMINAL_SHOW_BASE = Object.freeze({
  ok: true,
  handle: "term_abc",
  paneKeyFromShow: "tab-1:leaf-1",
});

function ds(overrides = {}) {
  return { ok: true, ...DISPATCH_SHOW_BASE, ...overrides };
}

function ts(overrides = {}) {
  return { ...TERMINAL_SHOW_BASE, ...overrides };
}

function expected(overrides = {}) {
  return {
    harnessTaskId: "HYK-299-casefold-1",
    runtimeTaskId: DISPATCH_SHOW_BASE.taskId,
    dispatchId: DISPATCH_SHOW_BASE.dispatchId,
    worktreeId:
      "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
    worktreePath:
      "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
    ...overrides,
  };
}

// 1. 소문자 경로 -> PROVEN (관제실 Norm()이 실제로 넘기는 값 모양).
test("1: lowercased windows-drive worktreePath from Norm() -- PROVEN", () => {
  const result = judgeDispatchBoundSeatProof({
    dispatchShow: ds(),
    terminalShow: ts({
      worktreeId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
      worktreePath:
        "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
    }),
    expected: expected({
      worktreeId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::c:/users/administrator/orca/workspaces/harnessengineering/hyk306-review",
      worktreePath:
        "c:/users/administrator/orca/workspaces/harnessengineering/hyk306-review",
    }),
  });
  assert.equal(result.verdict, SEAT_PROOF.PROVEN);
  assert.equal(result.reasonCode, SEAT_PROOF_REASON.PROVEN);
});

// 2. 대소문자 보존 경로 -> PROVEN (회귀 0).
test("2: case-preserved windows-drive path, exact match -- PROVEN (regression)", () => {
  const result = judgeDispatchBoundSeatProof({
    dispatchShow: ds(),
    terminalShow: ts({
      worktreeId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
      worktreePath:
        "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
    }),
    expected: expected(),
  });
  assert.equal(result.verdict, SEAT_PROOF.PROVEN);
});

// 3. 진짜 다른 워크트리 -> 여전히 WORKTREE_MISMATCH (탐지력 유지 증거).
test("3: genuinely different worktree (hyk306-review vs hyk306-label) -- still WORKTREE_MISMATCH", () => {
  const result = judgeDispatchBoundSeatProof({
    dispatchShow: ds(),
    terminalShow: ts({
      worktreeId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-label",
      worktreePath:
        "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-label",
    }),
    expected: expected(),
  });
  assert.equal(result.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(result.reasonCode, SEAT_PROOF_REASON.WORKTREE_MISMATCH);
});

// 4. POSIX 모양에서 대소문자만 다른 두 경로 -> 여전히 WORKTREE_MISMATCH
// (§2-3 근거: 무조건 대소문자 무시로 바꾸면 리눅스에서 탐지력이 깎인다).
test("4: POSIX-shaped paths differing only in case (/srv/Foo vs /srv/foo) -- still WORKTREE_MISMATCH", () => {
  const result = judgeDispatchBoundSeatProof({
    dispatchShow: ds(),
    terminalShow: ts({
      worktreeId: "repo-id-1::/srv/Foo",
      worktreePath: "/srv/Foo",
    }),
    expected: expected({
      worktreeId: "repo-id-1::/srv/foo",
      worktreePath: "/srv/foo",
    }),
  });
  assert.equal(result.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(result.reasonCode, SEAT_PROOF_REASON.WORKTREE_MISMATCH);
});

// 5. 백슬래시 표기 -> PROVEN.
test("5: backslash notation vs forward-slash notation -- PROVEN", () => {
  const result = judgeDispatchBoundSeatProof({
    dispatchShow: ds(),
    terminalShow: ts({
      worktreeId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
      worktreePath:
        "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
    }),
    expected: expected({
      worktreePath:
        "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk306-review",
    }),
  });
  assert.equal(result.verdict, SEAT_PROOF.PROVEN);
});

// 6. 끝 슬래시 차이 -> PROVEN.
test("6: trailing slash difference -- PROVEN", () => {
  const result = judgeDispatchBoundSeatProof({
    dispatchShow: ds(),
    terminalShow: ts({
      worktreeId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
      worktreePath:
        "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
    }),
    expected: expected({
      worktreePath:
        "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review/",
    }),
  });
  assert.equal(result.verdict, SEAT_PROOF.PROVEN);
});

// 7a. worktreeId 통째로 소문자화 -> PROVEN.
test("7a: whole worktreeId lowercased (repoId GUID + path) -- PROVEN", () => {
  const result = judgeDispatchBoundSeatProof({
    dispatchShow: ds(),
    terminalShow: ts({
      worktreeId:
        "E841EC57-D1B5-4BE0-A44B-2023793E7D33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
      worktreePath:
        "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
    }),
    expected: expected({
      worktreeId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::c:/users/administrator/orca/workspaces/harnessengineering/hyk306-review",
    }),
  });
  assert.equal(result.verdict, SEAT_PROOF.PROVEN);
});

// 7b. worktreeId 안의 경로 부분이 진짜 다르면 -> WORKTREE_MISMATCH.
test("7b: worktreeId's path segment genuinely differs -- WORKTREE_MISMATCH", () => {
  const result = judgeDispatchBoundSeatProof({
    dispatchShow: ds(),
    terminalShow: ts({
      worktreeId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
      worktreePath:
        "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
    }),
    expected: expected({
      worktreeId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/some-other-worktree",
    }),
  });
  assert.equal(result.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(result.reasonCode, SEAT_PROOF_REASON.WORKTREE_MISMATCH);
});
