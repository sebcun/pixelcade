const KEYWORDS = new Set([
  "set",
  "to",
  "on",
  "game",
  "start",
  "spawn",
  "sprite",
  "as",
  "at",
  "move",
  "by",
  "hide",
  "show",
  "wait",
  "seconds",
  "repeat",
  "times",
  "award",
  "small",
  "medium",
  "large",
  "xp",
]);

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function isAlpha(ch) {
  return /[A-Za-z_]/.test(ch);
}

function isAlphaNum(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

function makeToken(type, value, line, column) {
  return { type, value, line, column };
}

function readNumber(text, start) {
  let i = start;
  while (i < text.length && isDigit(text[i])) i += 1;
  if (text[i] === ".") {
    i += 1;
    while (i < text.length && isDigit(text[i])) i += 1;
  }
  return { value: text.slice(start, i), end: i };
}

function readIdentifier(text, start) {
  let i = start;
  while (i < text.length && isAlphaNum(text[i])) i += 1;
  return { value: text.slice(start, i), end: i };
}

function readString(text, start) {
  let i = start + 1;
  let out = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === '"' || next === "\\") {
        out += next;
        i += 2;
        continue;
      }
    }
    if (ch === '"') {
      return { value: out, end: i + 1 };
    }
    out += ch;
    i += 1;
  }
  throw new Error("Unterminated string literal");
}

export function tokenize(source) {
  const src = String(source ?? "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const tokens = [];
  const indentStack = [0];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const raw = lines[lineIdx];
    const lineNumber = lineIdx + 1;
    const match = raw.match(/^([ \t]*)/);
    const leading = match ? match[1] : "";
    const indentWidth = leading.replace(/\t/g, "    ").length;
    const content = raw.slice(leading.length);
    const trimmed = content.trim();

    if (trimmed === "" || trimmed.startsWith("--")) {
      tokens.push(makeToken("NEWLINE", "\n", lineNumber, raw.length + 1));
      continue;
    }

    const prevIndent = indentStack[indentStack.length - 1];
    if (indentWidth > prevIndent) {
      indentStack.push(indentWidth);
      tokens.push(makeToken("INDENT", indentWidth, lineNumber, 1));
    } else if (indentWidth < prevIndent) {
      while (indentWidth < indentStack[indentStack.length - 1]) {
        indentStack.pop();
        tokens.push(makeToken("DEDENT", indentWidth, lineNumber, 1));
      }
      if (indentWidth !== indentStack[indentStack.length - 1]) {
        throw new Error(`Invalid indentation at line ${lineNumber}`);
      }
    }

    let i = leading.length;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === " " || ch === "\t") {
        i += 1;
        continue;
      }
      if (ch === "-" && raw[i + 1] === "-") {
        break;
      }
      if (ch === '"') {
        const { value, end } = readString(raw, i);
        tokens.push(makeToken("STRING", value, lineNumber, i + 1));
        i = end;
        continue;
      }
      if (isDigit(ch)) {
        const { value, end } = readNumber(raw, i);
        tokens.push(makeToken("NUMBER", value, lineNumber, i + 1));
        i = end;
        continue;
      }
      if (isAlpha(ch)) {
        const { value, end } = readIdentifier(raw, i);
        const lower = value.toLowerCase();
        tokens.push(
          makeToken(KEYWORDS.has(lower) ? "KEYWORD" : "IDENTIFIER", value, lineNumber, i + 1),
        );
        i = end;
        continue;
      }
      if (",:+-*/()".includes(ch)) {
        tokens.push(makeToken("OPERATOR", ch, lineNumber, i + 1));
        i += 1;
        continue;
      }
      throw new Error(`Unexpected character "${ch}" at line ${lineNumber}, column ${i + 1}`);
    }
    tokens.push(makeToken("NEWLINE", "\n", lineNumber, raw.length + 1));
  }

  while (indentStack.length > 1) {
    indentStack.pop();
    tokens.push(makeToken("DEDENT", 0, lines.length, 1));
  }
  tokens.push(makeToken("EOF", "", lines.length + 1, 1));
  return tokens;
}
