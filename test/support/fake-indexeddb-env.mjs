// node --test 환경에는 브라우저의 indexedDB 전역이 없다 -- fake-indexeddb
// (devDependency, 제품 번들에는 안 들어간다. coder-task.md §0-1 "의존 0"
// 은 제품 코드 얘기다)로 그 전역을 심는다. indexeddb-adapter.mjs 를
// import 하는 어떤 테스트 파일보다도 먼저 import 해야 한다.
import "fake-indexeddb/auto";
