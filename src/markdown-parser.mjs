// PRD §5.2 트리거 규칙: 헤딩은 "# "/"## "/"### " (레벨 1~3)만 정의한다.
// "#### " 이상은 트리거로 정의되지 않았으므로 문단으로 남는다(레벨 1~3만 매칭).
const HEADING_RE = /^(#{1,3}) (.*)$/u;
const CHECKBOX_RE = /^- \[( |x)\] (.*)$/u;
const BULLET_RE = /^- (.*)$/u;

// 굵게/취소선은 "닫힘"(양쪽 마커)이 있어야 서식이다. `.+?`(1자 이상, 비탐욕)라서
// 빈 서식(`****`)과 닫히지 않은 마커(`**안 닫힘`)는 매치되지 않고 원문 그대로 남는다.
// 비탐욕 + 전역 스캔이라 `**가** 나 **다**` 가 하나로 삼켜지지 않고 두 스팬으로 갈린다.
// `u` 플래그: 이모지·결합문자가 서로게이트 쌍 중간에서 잘리지 않게 한다.
function extractSpans(text) {
  const re = /\*\*(.+?)\*\*|~~(.+?)~~/gu;
  const spans = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[1] !== undefined) {
      spans.push({ type: "bold", text: match[1] });
    } else {
      spans.push({ type: "strike", text: match[2] });
    }
  }
  return spans;
}

export function parse(line) {
  const heading = line.match(HEADING_RE);
  if (heading) {
    const text = heading[2];
    return {
      type: "heading",
      level: heading[1].length,
      text,
      spans: extractSpans(text),
    };
  }

  const checkbox = line.match(CHECKBOX_RE);
  if (checkbox) {
    const text = checkbox[2];
    return {
      type: "checkbox",
      checked: checkbox[1] === "x",
      text,
      spans: extractSpans(text),
    };
  }

  // "- [y] 이상한값"처럼 체크박스 마커가 무효면 위 CHECKBOX_RE 가 실패하고
  // 여기로 떨어진다 -- "- " 자체는 여전히 목록 트리거이므로 불릿으로 처리한다.
  const bullet = line.match(BULLET_RE);
  if (bullet) {
    const text = bullet[1];
    return { type: "bullet", text, spans: extractSpans(text) };
  }

  return { type: "paragraph", text: line, spans: extractSpans(line) };
}

// §5.1 수용기준 ②/§7: 저장·복사의 진실은 항상 마크다운 원문이다. parse() 는
// 프리픽스만 걷어내고 본문(text)의 마크다운 마커는 그대로 두므로, 타입별
// 프리픽스를 되붙이면 입력 라인을 정확히 복원할 수 있다(spans 는 파생
// 메타데이터일 뿐 복원에 필요하지 않다).
export function reconstruct(parsed) {
  switch (parsed.type) {
    case "heading":
      return `${"#".repeat(parsed.level)} ${parsed.text}`;
    case "checkbox":
      return `- [${parsed.checked ? "x" : " "}] ${parsed.text}`;
    case "bullet":
      return `- ${parsed.text}`;
    default:
      return parsed.text;
  }
}
