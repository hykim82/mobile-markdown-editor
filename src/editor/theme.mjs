// Lexical 은 굵게(bold)만 의미 태그(<strong>)로 내보내 테마 없이도 브라우저
// 기본 스타일로 보인다 -- 취소선(strikethrough)은 theme.text.strikethrough
// 클래스에 «전적으로» 의존하므로, 테마가 없으면 class="" 인 맨 <span>이 되어
// 화면에 선이 그어지지 않는다(HYK-304-render-layer-1 검토에서 실측된 P1).
// 프로덕션 엔트리(app.mjs)와 테스트 헬퍼(make-editor.mjs)가 같은 테마를
// 써야 "테스트가 통과 = 실제로 렌더된다"가 성립하므로 한 곳에 둔다.
export const EDITOR_THEME = {
  text: {
    bold: "editor-bold",
    strikethrough: "editor-strikethrough",
  },
};
