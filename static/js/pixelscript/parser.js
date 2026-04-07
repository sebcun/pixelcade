import { tokenize } from "./lexer.js";

const SPRITE_PROP_NAMES = new Set(["x", "y", "opacity", "scale", "rotation", "visible"]);

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

  parseCoordPair() {
    const x = this.parseExpression();
    this.expect("OPERATOR", ",");
    const y = this.parseExpression();
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

  parsePrimary() {
    const token = this.peek();
    if (this.is("NUMBER")) {
      this.advance();
      return { type: "NumberLiteral", value: Number(token.value) };
    }
    if (this.is("STRING")) {
      this.advance();
      return { type: "StringLiteral", value: String(token.value) };
    }
    if (this.is("KEYWORD", "true")) {
      this.advance();
      return { type: "BooleanLiteral", value: true };
    }
    if (this.is("KEYWORD", "false")) {
      this.advance();
      return { type: "BooleanLiteral", value: false };
    }
    if (this.is("OPERATOR", "(")) {
      this.advance();
      const inner = this.parseExpression();
      this.expect("OPERATOR", ")");
      return inner;
    }
    if (this.is("IDENTIFIER")) {
      const idToken = this.advance();
      const name = String(idToken.value);
      if (this.is("KEYWORD", "touches")) {
        this.advance();
        if (this.is("KEYWORD", "wall")) {
          this.advance();
          return { type: "TouchExpr", left: name, wall: true, right: null };
        }
        const other = this.expect("IDENTIFIER");
        return {
          type: "TouchExpr",
          left: name,
          wall: false,
          right: String(other.value),
        };
      }
      let node = { type: "Identifier", name };
      while (this.is("OPERATOR", ".")) {
        this.advance();
        const propTok = this.peek();
        if (this.is("IDENTIFIER")) {
          this.advance();
          node = { type: "MemberExpression", object: node, property: String(propTok.value) };
        } else if (
          this.is("KEYWORD", "x") ||
          this.is("KEYWORD", "y") ||
          this.is("KEYWORD", "opacity") ||
          this.is("KEYWORD", "scale") ||
          this.is("KEYWORD", "rotation") ||
          this.is("KEYWORD", "visible")
        ) {
          const kw = this.advance();
          node = { type: "MemberExpression", object: node, property: String(kw.value).toLowerCase() };
        } else {
          throw new Error(`Expected property name after "." at line ${propTok?.line ?? "?"}`);
        }
      }
      return node;
    }
    throw new Error(`Expected value at line ${token?.line ?? "?"}`);
  }

  parseUnary() {
    if (this.is("KEYWORD", "not")) {
      this.advance();
      return { type: "UnaryExpression", operator: "not", argument: this.parseUnary() };
    }
    if (this.is("OPERATOR", "-")) {
      this.advance();
      return { type: "UnaryExpression", operator: "-", argument: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parseMultiplicative() {
    let node = this.parseUnary();
    while (this.is("OPERATOR", "*") || this.is("OPERATOR", "/")) {
      const op = this.advance().value;
      const right = this.parseUnary();
      node = { type: "BinaryExpression", operator: String(op), left: node, right };
    }
    return node;
  }

  parseAdditive() {
    let node = this.parseMultiplicative();
    while (this.is("OPERATOR", "+") || this.is("OPERATOR", "-")) {
      const op = this.advance().value;
      const right = this.parseMultiplicative();
      node = { type: "BinaryExpression", operator: String(op), left: node, right };
    }
    return node;
  }

  parseComparison() {
    let node = this.parseAdditive();
    while (
      this.is("OPERATOR", "==") ||
      this.is("OPERATOR", "!=") ||
      this.is("OPERATOR", "<") ||
      this.is("OPERATOR", ">") ||
      this.is("OPERATOR", "<=") ||
      this.is("OPERATOR", ">=")
    ) {
      const op = this.advance().value;
      const right = this.parseAdditive();
      node = { type: "BinaryExpression", operator: String(op), left: node, right };
    }
    return node;
  }

  parseAnd() {
    let node = this.parseComparison();
    while (this.is("KEYWORD", "and")) {
      this.advance();
      const right = this.parseComparison();
      node = { type: "BinaryExpression", operator: "and", left: node, right };
    }
    return node;
  }

  parseOr() {
    let node = this.parseAnd();
    while (this.is("KEYWORD", "or")) {
      this.advance();
      const right = this.parseAnd();
      node = { type: "BinaryExpression", operator: "or", left: node, right };
    }
    return node;
  }

  parseExpression() {
    return this.parseOr();
  }

  parseIfChain() {
    this.expect("KEYWORD", "if");
    const test = this.parseExpression();
    this.expect("OPERATOR", ":");
    const thenBody = this.parseBlock();
    const elseIfs = [];
    let elseBody = null;
    this.eatNewlines();
    while (true) {
      if (this.is("KEYWORD", "else")) {
        this.advance();
        if (this.is("KEYWORD", "if")) {
          this.advance();
          const cond = this.parseExpression();
          this.expect("OPERATOR", ":");
          elseIfs.push({ test: cond, body: this.parseBlock() });
          this.eatNewlines();
          continue;
        }
        this.expect("OPERATOR", ":");
        elseBody = this.parseBlock();
      }
      break;
    }
    return {
      type: "IfStatement",
      test,
      thenBody,
      elseIfs,
      elseBody,
    };
  }

  parseWhile() {
    this.expect("KEYWORD", "while");
    const cond = this.parseExpression();
    this.expect("OPERATOR", ":");
    return { type: "WhileStatement", cond, body: this.parseBlock() };
  }

  parseLoop() {
    this.expect("KEYWORD", "loop");
    this.expect("OPERATOR", ":");
    return { type: "LoopStatement", body: this.parseBlock() };
  }

  parseSetStatement() {
    this.expect("KEYWORD", "set");
    const first = this.expect("IDENTIFIER");
    const firstName = String(first.value);
    if (this.is("KEYWORD", "to")) {
      this.advance();
      const value = this.parseExpression();
      return { type: "SetStatement", variable: firstName, value };
    }
    let propName = null;
    if (this.is("IDENTIFIER")) {
      propName = String(this.advance().value).toLowerCase();
    } else if (
      this.is("KEYWORD", "x") ||
      this.is("KEYWORD", "y") ||
      this.is("KEYWORD", "opacity") ||
      this.is("KEYWORD", "scale") ||
      this.is("KEYWORD", "rotation") ||
      this.is("KEYWORD", "visible")
    ) {
      propName = String(this.advance().value).toLowerCase();
    }
    if (!propName || !SPRITE_PROP_NAMES.has(propName)) {
      throw new Error(
        `Expected "to" or sprite property (x, y, opacity, scale, rotation, visible) at line ${this.peek()?.line ?? "?"}`,
      );
    }
    this.expect("KEYWORD", "to");
    const value = this.parseExpression();
    return {
      type: "SetSpriteProperty",
      sprite: firstName,
      property: propName,
      value,
    };
  }

  parseOnGameStart() {
    this.expect("KEYWORD", "on");
    this.expect("KEYWORD", "game");
    this.expect("KEYWORD", "start");
    this.expect("OPERATOR", ":");
    return { type: "OnGameStart", body: this.parseBlock() };
  }

  parseOnKey() {
    this.expect("KEYWORD", "on");
    this.expect("KEYWORD", "key");
    const modeTok = this.advance();
    if (modeTok.type !== "KEYWORD") {
      throw new Error(`Expected press, hold, or release at line ${modeTok.line}`);
    }
    const mode = String(modeTok.value).toLowerCase();
    if (mode !== "press" && mode !== "hold" && mode !== "release") {
      throw new Error(`Expected press, hold, or release at line ${modeTok.line}`);
    }
    const keyStr = this.expect("STRING");
    this.expect("OPERATOR", ":");
    return {
      type: "OnKeyStatement",
      mode,
      keyName: String(keyStr.value),
      body: this.parseBlock(),
    };
  }

  parseOnTouch() {
    this.expect("KEYWORD", "on");
    const sprite = this.expect("IDENTIFIER");
    this.expect("KEYWORD", "touches");
    if (this.is("KEYWORD", "wall")) {
      this.advance();
      this.expect("OPERATOR", ":");
      return {
        type: "OnTouchWallStatement",
        sprite: String(sprite.value),
        body: this.parseBlock(),
      };
    }
    const other = this.expect("IDENTIFIER");
    this.expect("OPERATOR", ":");
    return {
      type: "OnTouchSpriteStatement",
      sprite: String(sprite.value),
      other: String(other.value),
      body: this.parseBlock(),
    };
  }

  parseOn() {
    if (this.is("KEYWORD", "on")) {
      const p = this.pos;
      this.advance();
      if (this.is("KEYWORD", "game")) {
        this.pos = p;
        return this.parseOnGameStart();
      }
      if (this.is("KEYWORD", "key")) {
        this.pos = p;
        return this.parseOnKey();
      }
      this.pos = p;
      return this.parseOnTouch();
    }
    return null;
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
    const duration = this.parseExpression();
    this.expect("KEYWORD", "seconds");
    return { type: "WaitStatement", duration };
  }

  parseRepeat() {
    this.expect("KEYWORD", "repeat");
    const count = this.parseExpression();
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

  parseSpin() {
    this.expect("KEYWORD", "spin");
    const sprite = this.expect("IDENTIFIER");
    const modeTok = this.advance();
    if (modeTok.type !== "KEYWORD") {
      throw new Error(`Expected "by" or "to" at line ${modeTok.line}`);
    }
    const mode = String(modeTok.value).toLowerCase();
    if (mode !== "by" && mode !== "to") {
      throw new Error(`Expected "by" or "to" at line ${modeTok.line}`);
    }
    const value = this.parseExpression();
    return { type: "SpinSprite", sprite: String(sprite.value), mode, value };
  }

  parseStop() {
    this.expect("KEYWORD", "stop");
    if (this.is("KEYWORD", "loop")) {
      this.advance();
      return { type: "StopLoopStatement" };
    }
    if (this.is("KEYWORD", "game")) {
      this.advance();
      return { type: "StopGameStatement" };
    }
    throw new Error(`Expected "loop" or "game" after stop at line ${this.peek()?.line ?? "?"}`);
  }

  parseStatement() {
    if (this.is("NEWLINE")) {
      this.advance();
      return null;
    }
    if (this.is("KEYWORD", "if")) return this.parseIfChain();
    if (this.is("KEYWORD", "while")) return this.parseWhile();
    if (this.is("KEYWORD", "loop")) return this.parseLoop();
    if (this.is("KEYWORD", "break")) {
      this.advance();
      return { type: "BreakStatement" };
    }
    if (this.is("KEYWORD", "continue")) {
      this.advance();
      return { type: "ContinueStatement" };
    }
    if (this.is("KEYWORD", "stop")) return this.parseStop();
    if (this.is("KEYWORD", "set")) return this.parseSetStatement();
    const onStmt = this.parseOn();
    if (onStmt) return onStmt;
    if (this.is("KEYWORD", "spawn")) return this.parseSpawn();
    if (this.is("KEYWORD", "move")) return this.parseMove();
    if (this.is("KEYWORD", "hide")) return this.parseHideShow("hide");
    if (this.is("KEYWORD", "show")) return this.parseHideShow("show");
    if (this.is("KEYWORD", "wait")) return this.parseWait();
    if (this.is("KEYWORD", "repeat")) return this.parseRepeat();
    if (this.is("KEYWORD", "award")) return this.parseAward();
    if (this.is("KEYWORD", "spin")) return this.parseSpin();
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

