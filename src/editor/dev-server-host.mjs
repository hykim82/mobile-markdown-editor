// coder-task.md §0-2-⑷: 개발 서버 기본 바인드는 127.0.0.1 -- `--host` 를
// 줄 때만 외부(같은 와이파이의 휴대폰 등)에 연다. 한용 실기기 확인처럼
// 의도적으로 열 때만 여는 문이어야지, 기본값이 열려 있으면 안 된다.
export function resolveBindHost(argv = process.argv.slice(2)) {
  return argv.includes("--host") ? "0.0.0.0" : "127.0.0.1";
}
