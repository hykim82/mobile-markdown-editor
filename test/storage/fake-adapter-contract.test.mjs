// coder-task.md §0-2-⑹ 증거물 1/2: 메모리(가짜) 구현이 어댑터 계약을
// 만족한다. indexeddb-adapter.test.mjs 가 «같은» 시험을 IndexedDB
// 구현에 돌려 인터페이스가 실제로 갈아끼워짐을 보인다.
import { runAdapterContractTests } from "../support/adapter-contract.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";

runAdapterContractTests("메모리(가짜) 어댑터", () => createFakeAdapter());
