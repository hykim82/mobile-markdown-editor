const HEADING_RE = /^(#{1,6}) (.*)$/;
const CHECKBOX_RE = /^- \[( |x)\] (.*)$/;
const BULLET_RE = /^- (.*)$/;
const BOLD_RE = /^\*\*(.*)\*\*$/;
const STRIKE_RE = /^~~(.*)~~$/;

export function parse(line) {
  const heading = line.match(HEADING_RE);
  if (heading) {
    return { type: "heading", level: heading[1].length, text: heading[2] };
  }

  const checkbox = line.match(CHECKBOX_RE);
  if (checkbox) {
    return { type: "checkbox", checked: checkbox[1] === "x", text: checkbox[2] };
  }

  const bullet = line.match(BULLET_RE);
  if (bullet) {
    return { type: "bullet", text: bullet[1] };
  }

  const spans = [];
  const bold = line.match(BOLD_RE);
  if (bold) {
    spans.push({ type: "bold", text: bold[1] });
  } else {
    const strike = line.match(STRIKE_RE);
    if (strike) {
      spans.push({ type: "strike", text: strike[1] });
    }
  }

  return { type: "paragraph", text: line, spans };
}
