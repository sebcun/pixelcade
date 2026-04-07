import { tokenize } from "./lexer.js";

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.pos + offset] || this.tokens[this.tokens.length - 1];
  }

  advance() {
    const token = this.peek();
    this.pos += 1;
    return token;
  }

  is(type, valueLower) {
    const token = this.peek();
    if (!token || token.type !== type) return false;
    if (valueLower == null) return true;
    return String(token.value).toLowerCase() === String(valueLower).toLowerCase();
  }

  expect(type, valueLower) {
    const token = this.peek();
    if (!this.is(type, valueLower)) {
      throw new Error(`Unexpected token "${token?.value ?? "EOF"}" at line ${token?.line ?? "?"}`);
    }
    return this.advance();
  }

  eatNewlines() {
    while (this.is("NEWLINE")) this.advance();
  }

  parseValue() {
    const token = this.peek();
    if (this.is("NUMBER")) {
      this.advance();
      return { type: "NumberLiteral", value: Number(token.value) };
    }
    if (this.is("STRING")) {
      this.advance();
      return { type: "StringLiteral", value: String(token.value) };
    }
    if (this.is("IDENTIFIER")) {
      this.advance();
      return { type: "Identifier", name: String(token.value) };
    }
    throw new Error(`Expected value at line ${token?.line ?? "?"}`);
  }

  parseCoordPair() {
    const x = this.parseValue();
    this.expect("OPERATOR", ",");
    const y = this.parseValue();
    return { x, y };
  }

  parseBlock() {
    this.expect("NEWLINE");
    this.expect("INDENT");
    const body = [];
    this.eatNewlines();
    while (!this.is("DEDENT") && !this.is("EOF")) {
      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
      this.eatNewlines();
    }
    this.expect("DEDENT");
    return body;
  }

  parseSetStatement() {
    this.expect("KEYWORD", "set");
    const variable = this.expect("IDENTIFIER");
    this.expect("KEYWORD", "to");
    const value = this.parseValue();
    return {
      type: "SetStatement",
      variable: String(variable.value),
      value,
    };
  }

  parseOnGameStart() {
    this.expect("KEYWORD", "on");
    this.expect("KEYWORD", "game");
    this.expect("KEYWORD", "start");
    this.expect("OPERATOR", ":");
    return {
      type: "OnGameStart",
      body: this.parseBlock(),
    };
  }

  parseSpawn() {
    this.expect("KEYWORD", "spawn");
    this.expect("KEYWORD", "sprite");
    const spriteName = this.expect("STRING");
    this.expect("KEYWORD", "as");
    const variable = this.expect("IDENTIFIER");
    this.expect("KEYWORD", "at");
    const { x, y } = this.parseCoordPair();
    return {
      type: "SpawnSprite",
      spriteName: String(spriteName.value),
      variable: String(variable.value),
      x,
      y,
    };
  }

  parseMove() {
    this.expect("KEYWORD", "move");
    const sprite = this.expect("IDENTIFIER");
    const modeToken = this.advance();
    if (modeToken.type !== "KEYWORD") {
      throw new Error(`Expected "to" or "by" at line ${modeToken.line}`);
    }
    const mode = String(modeToken.value).toLowerCase();
    if (mode !== "to" && mode !== "by") {
      throw new Error(`Expected "to" or "by" at line ${modeToken.line}`);
    }
    const { x, y } = this.parseCoordPair();
    return {
      type: "MoveSprite",
      sprite: String(sprite.value),
      mode,
      x,
      y,
    };
  }

  parseHideShow(kind) {
    this.expect("KEYWORD", kind);
    const sprite = this.expect("IDENTIFIER");
    return {
      type: kind === "hide" ? "HideSprite" : "ShowSprite",
      sprite: String(sprite.value),
    };
  }

  parseWait() {
    this.expect("KEYWORD", "wait");
    const duration = this.parseValue();
    this.expect("KEYWORD", "seconds");
    return { type: "WaitStatement", duration };
  }

  parseRepeat() {
    this.expect("KEYWORD", "repeat");
    const count = this.parseValue();
    this.expect("KEYWORD", "times");
    this.expect("OPERATOR", ":");
    return { type: "RepeatStatement", count, body: this.parseBlock() };
  }

  parseAward() {
    this.expect("KEYWORD", "award");
    const amount = this.expect("KEYWORD");
    this.expect("KEYWORD", "xp");
    return { type: "AwardXpStatement", amount: String(amount.value).toLowerCase() };
  }

  parseStatement() {
    if (this.is("NEWLINE")) {
      this.advance();
      return null;
    }
    if (this.is("KEYWORD", "set")) return this.parseSetStatement();
    if (this.is("KEYWORD", "on")) return this.parseOnGameStart();
    if (this.is("KEYWORD", "spawn")) return this.parseSpawn();
    if (this.is("KEYWORD", "move")) return this.parseMove();
    if (this.is("KEYWORD", "hide")) return this.parseHideShow("hide");
    if (this.is("KEYWORD", "show")) return this.parseHideShow("show");
    if (this.is("KEYWORD", "wait")) return this.parseWait();
    if (this.is("KEYWORD", "repeat")) return this.parseRepeat();
    if (this.is("KEYWORD", "award")) return this.parseAward();
    const token = this.peek();
    throw new Error(`Unknown command "${token?.value ?? "EOF"}" at line ${token?.line ?? "?"}`);
  }

  parseProgram() {
    const body = [];
    this.eatNewlines();
    while (!this.is("EOF")) {
      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
      this.eatNewlines();
    }
    return { type: "Program", body };
  }
}

export function parse(source) {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return parser.parseProgram();
}
