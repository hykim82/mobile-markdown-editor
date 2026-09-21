// coder-task.md §0-2-⑷ "★시험이 «기본이 127.0.0.1 임」을 값으로 재라."
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBindHost } from "../../src/editor/dev-server-host.mjs";

test("인자가 없으면 기본값은 127.0.0.1 이다(외부 노출 안 함)", () => {
  assert.equal(resolveBindHost([]), "127.0.0.1");
});

test("--host 를 주면 0.0.0.0 으로 연다(한용 실기기 확인용, 의도적으로 켜는 문)", () => {
  assert.equal(resolveBindHost(["--host"]), "0.0.0.0");
});

test("--host 가 아닌 다른 인자만 있으면 여전히 127.0.0.1 이다", () => {
  assert.equal(resolveBindHost(["--foo", "bar"]), "127.0.0.1");
});
