// 저장 어댑터 -- coder-task.md §0-1(책임자 잠정 결정): IndexedDB 직접,
// 의존성 0. §0-2-⑹ "저장 기술을 어댑터 한 곳에 가둬라": memo-store.mjs
// 등 이 파일 밖의 어떤 코드도 `indexedDB` 전역을 직접 부르지 않는다 --
// 전부 이 파일이 내보내는 네 메서드(put/get/list/remove)를 통해서만
// 접근한다. 2안(SQLite WASM+OPFS)으로 바꿀 때는 이 파일 하나만 같은
// 네 메서드로 다시 쓰면 된다(계약은 test/support/adapter-contract.mjs가
// 기계로 지킨다 -- 이 어댑터와 test/support/fake-adapter.mjs 양쪽에
// 똑같이 돌려서 실제로 갈아끼워짐을 보인다).
const DEFAULT_DB_NAME = "mobile-markdown-editor";
const DB_VERSION = 1;
const STORE_NAME = "memos";

function openDatabase(dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 트랜잭션 하나를 돌려 그 안에서 나온 요청의 결과값으로 resolve 한다.
// §0-2-⑶ 크래시 원자성의 근거: IndexedDB 트랜잭션은 tx.oncomplete 가
// 불릴 때만 실제로 커밋된 것이고, 그 전에는(자동저장 실패·저장공간
// 부족 포함) onerror/onabort 로 떨어져 이전 커밋 상태가 그대로 남는다 --
// 이 함수는 그 경계를 그대로 Promise 성공/실패로 옮길 뿐, 새로 보장을
// 만들어내지 않는다.
function runTransaction(db, mode, run) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_NAME, mode);
    } catch (err) {
      reject(err);
      return;
    }
    const store = tx.objectStore(STORE_NAME);
    let request;
    try {
      request = run(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(
        tx.error ??
          new Error("indexeddb-adapter: transaction aborted with no error"),
      );
  });
}

export function createIndexedDbAdapter({ dbName = DEFAULT_DB_NAME } = {}) {
  let dbPromise = null;
  function connect() {
    if (!dbPromise) dbPromise = openDatabase(dbName);
    return dbPromise;
  }

  return {
    async put(memo) {
      const db = await connect();
      await runTransaction(db, "readwrite", (store) => store.put(memo));
    },
    async get(id) {
      const db = await connect();
      return runTransaction(db, "readonly", (store) => store.get(id));
    },
    async list() {
      const db = await connect();
      return runTransaction(db, "readonly", (store) => store.getAll());
    },
    async remove(id) {
      const db = await connect();
      await runTransaction(db, "readwrite", (store) => store.delete(id));
    },
  };
}
