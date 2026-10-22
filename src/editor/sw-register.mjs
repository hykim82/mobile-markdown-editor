// HYK-304-pwa-installable-1 (coder-task.md §2 요구 4): 서비스 워커 등록
// 1자리. navigator.serviceWorker 가 없으면(지원 없음 환경 -- 구형 브라우저,
// 이 저장소의 jsdom 시험 기본 환경 등) 아무 일도 하지 않는다 -- 부팅·입력을
// 막지 않는다.
//
// 등록 자체는 setTimeout(..., 0)으로 다음 매크로태스크로 미룬다 -- app.mjs
// main() 의 동기 구간(에디터 마운트·리스너 결선, "첫 화면")이 이미 끝난
// 뒤에만 시작되므로 PRD §5b "실행→입력 1초" NFR 을 늦추지 않는다(등록
// 자체가 느려도 그 비용은 이미 입력 가능해진 뒤에 치른다).
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  setTimeout(() => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((error) => {
        // 등록 실패는 앱 동작에 영향 0(§2 요구 4) -- 그러나 조용한 실패는
        // 피한다(디버깅 불가능해지므로) -- 콘솔 1줄만 남긴다.
        console.error("[sw] 등록 실패", error);
      });
  }, 0);
}
