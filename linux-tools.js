/* LiaScript template linux-shell – further programs: text tools that read pipes (sed, awk, tee, xargs, …),
   diff/cmp, hashes, calendar, user management, fake hardware tables, reboot, and curl/wget over fetch().
   Loaded after linux-kernel.js; registers its commands with LiaLinuxKernel.registerCommands. */
(function (global) {
  "use strict";
  if (global.LiaLinuxTools) return;
  // the header scripts may load in any order: wait for the kernel instead of giving up
  let tries = 0;
  (function wait() { if (global.LiaLinuxKernel) start(); else if (++tries < 400) setTimeout(wait, 50); })();
  function start() {
  const kernel = global.LiaLinuxKernel;
  const { parseArgs, gnuError, q, inputsOf, linesOf, fmtClock, local, pad, MONTHS, breToJs } = kernel.helpers;

  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const encoder = new TextEncoder();
  const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");

  // ---------------------------------------------------------------- md5 (RFC 1321), for md5sum only

  function md5(text) {
    const bytes = encoder.encode(text);
    const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const length = bytes.length;
    const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
    padded.set(bytes); padded[length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor((length * 8) / 2 ** 32), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const rotl = (x, c) => (x << c) | (x >>> (32 - c));
    for (let chunk = 0; chunk < padded.length; chunk += 64) {
      const M = Array.from({ length: 16 }, (_, i) => view.getUint32(chunk + i * 4, true));
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new DataView(new ArrayBuffer(16));
    out.setUint32(0, a0, true); out.setUint32(4, b0, true); out.setUint32(8, c0, true); out.setUint32(12, d0, true);
    return hex(out.buffer);
  }

  async function digest(algorithm, text) {
    if (algorithm === "MD5") return md5(text);
    const subtle = global.crypto && global.crypto.subtle;
    if (!subtle) throw new Error("no crypto available");
    return hex(await subtle.digest(algorithm, encoder.encode(text)));
  }

  function hashCommand(name, algorithm) {
    return async function (proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "c", longs: { check: "c" } }); } catch (error) { gnuError(io, name, error.message); return 1; }
      const inputs = inputsOf(this, proc, io, opts.operands, name);
      if (!inputs) return 0;
      let status = 0;
      for (const input of inputs) {
        if (input.error) { status = 1; continue; }
        if (opts.flags.has("c")) {
          // check lines "<hash>  <file>"
          for (const line of linesOf(input.text)) {
            const m = /^([0-9a-f]+)\s+\*?(.+)$/.exec(line);
            if (!m) continue;
            let text;
            try { text = this.readFile(proc, m[2]); } catch (error) { io.out(`${m[2]}: FAILED open or read`); status = 1; continue; }
            const ok = (await digest(algorithm, text)) === m[1];
            io.out(`${m[2]}: ${ok ? "OK" : "FAILED"}`);
            if (!ok) status = 1;
          }
          continue;
        }
        io.out(`${await digest(algorithm, input.text)}  ${input.name}`);
      }
      return status;
    };
  }

  // ---------------------------------------------------------------- diff (line LCS)

  function lcsScript(a, b) {
    const n = a.length, m = b.length;
    const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ type: "=", a: i, b: j }); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) { ops.push({ type: "-", a: i }); i++; }
      else { ops.push({ type: "+", b: j }); j++; }
    }
    while (i < n) ops.push({ type: "-", a: i++ });
    while (j < m) ops.push({ type: "+", b: j++ });
    return ops;
  }

  function diffNormal(a, b, io) {
    const ops = lcsScript(a, b);
    let changed = false;
    for (let k = 0; k < ops.length;) {
      if (ops[k].type === "=") { k++; continue; }
      let end = k;
      while (end < ops.length && ops[end].type !== "=") end++;
      const removed = ops.slice(k, end).filter(o => o.type === "-"), added = ops.slice(k, end).filter(o => o.type === "+");
      const range = (list, key, fallback) => list.length ? (list.length === 1 ? String(list[0][key] + 1) : `${list[0][key] + 1},${list[list.length - 1][key] + 1}`) : String(fallback);
      // position in the other file when nothing is there: the line before the insertion point
      const aPos = removed.length ? range(removed, "a") : String((ops.slice(0, k).filter(o => o.type !== "+").length));
      const bPos = added.length ? range(added, "b") : String((ops.slice(0, k).filter(o => o.type !== "-").length));
      const kind = removed.length && added.length ? "c" : removed.length ? "d" : "a";
      io.out(`${aPos}${kind}${bPos}`);
      for (const o of removed) io.out(`< ${a[o.a]}`);
      if (kind === "c") io.out("---");
      for (const o of added) io.out(`> ${b[o.b]}`);
      changed = true;
      k = end;
    }
    return changed;
  }

  function diffUnified(a, b, nameA, nameB, io, context = 3) {
    const ops = lcsScript(a, b);
    if (!ops.some(o => o.type !== "=")) return false;
    io.out(`--- ${nameA}`); io.out(`+++ ${nameB}`);
    let k = 0;
    while (k < ops.length) {
      if (ops[k].type === "=") { k++; continue; }
      const start = Math.max(0, k - context);
      let end = k;
      let last = k;
      while (end < ops.length) {
        if (ops[end].type !== "=") last = end;
        if (ops[end].type === "=" && end - last > context * 2) break;
        end++;
      }
      end = Math.min(ops.length, last + context + 1);
      const hunk = ops.slice(start, end);
      const aLines = hunk.filter(o => o.type !== "+"), bLines = hunk.filter(o => o.type !== "-");
      const aStart = aLines.length ? aLines[0].a + 1 : (hunk[0].a ?? 0) + 1, bStart = bLines.length ? bLines[0].b + 1 : (hunk[0].b ?? 0) + 1;
      io.out(`@@ -${aStart},${aLines.length} +${bStart},${bLines.length} @@`);
      for (const o of hunk) io.out(o.type === "=" ? ` ${a[o.a]}` : o.type === "-" ? `-${a[o.a]}` : `+${b[o.b]}`);
      k = end;
    }
    return true;
  }

  // ---------------------------------------------------------------- sed (s, d, p with addresses)

  const SED_ADDRESS = /^(\$|\d+|\/((?:\\\/|[^/])*)\/)(?:,(\$|\d+|\/((?:\\\/|[^/])*)\/))?/;
  // Splits a sed script at ; and newlines – but not inside s/…/…/ (int x; stays a pattern).
  function splitSed(script) {
    const parts = [];
    let current = "", i = 0;
    while (i < script.length) {
      const c = script[i];
      if (c === ";" || c === "\n") { parts.push(current); current = ""; i++; continue; }
      const atCommand = /^\s*$/.test(current.replace(SED_ADDRESS, ""));
      if (atCommand && (c === "s" || c === "y") && script[i + 1] && !/[\s;\n]/.test(script[i + 1])) {
        const sep = script[i + 1];
        let seen = 0;
        current += c + sep; i += 2;
        while (i < script.length && seen < 2) {
          if (script[i] === "\\" && i + 1 < script.length) { current += script[i] + script[i + 1]; i += 2; continue; }
          if (script[i] === sep) seen++;
          current += script[i]; i++;
        }
        continue;
      }
      current += c; i++;
    }
    parts.push(current);
    return parts;
  }

  function parseSed(scripts, extended = false) {
    const commands = [];
    const rx = (source, flags) => new RegExp(extended ? source : breToJs(source), flags);
    for (const script of scripts) for (const raw of splitSed(script)) {
      const text = raw.trim();
      if (!text) continue;
      let rest = text, address = null;
      const addr = SED_ADDRESS.exec(rest);
      if (addr) {
        const one = v => v === "$" ? { last: true } : /^\d+$/.test(v) ? { line: Number(v) } : { re: rx(v.slice(1, -1).replace(/\\\//g, "/"), "") };
        address = { from: one(addr[1]), to: addr[3] !== undefined ? one(addr[3]) : null };
        rest = rest.slice(addr[0].length).trim();
      }
      if (rest[0] === "s") {
        const sep = rest[1];
        const parts = [];
        let current = "", i = 2;
        for (; i < rest.length && parts.length < 2; i++) {
          if (rest[i] === "\\" && rest[i + 1] === sep) { current += sep; i++; continue; }
          if (rest[i] === sep) { parts.push(current); current = ""; continue; }
          current += rest[i];
        }
        if (parts.length < 2) throw new Error(`unterminated \`s' command`);
        const flags = rest.slice(i).replace(sep, "");
        commands.push({ address, kind: "s", re: rx(parts[0], (flags.includes("g") ? "g" : "") + (flags.includes("i") || flags.includes("I") ? "i" : "")), replacement: parts[1].replace(/\\(\d)/g, "$$$1").replace(/&/g, "$$&").replace(/\\&/g, "&"), print: flags.includes("p") });
      } else if (rest === "d") commands.push({ address, kind: "d" });
      else if (rest === "p") commands.push({ address, kind: "p" });
      else if (rest === "q") commands.push({ address, kind: "q" });
      else if (/^[ia]\\?/.test(rest)) commands.push({ address, kind: rest[0], text: rest.replace(/^[ia]\\?\s*/, "") });
      else throw new Error(`unknown command: \`${rest[0]}'`);
    }
    return commands;
  }

  function sedMatches(command, lineNumber, line, total, state) {
    const a = command.address;
    if (!a) return true;
    const hit = part => part.last ? lineNumber === total : part.line !== undefined ? lineNumber === part.line : part.re.test(line);
    if (!a.to) return hit(a.from);
    const key = command;
    if (state.get(key)) { if (hit(a.to) || (a.to.line !== undefined && lineNumber >= a.to.line)) state.set(key, false); return true; }
    if (hit(a.from)) { if (!(hit(a.to) && a.to.line === undefined) && !(a.to.line !== undefined && lineNumber >= a.to.line)) state.set(key, true); return true; }
    return false;
  }

  // ---------------------------------------------------------------- awk (a small interpreter)

  function awkTokens(src) {
    const tokens = [];
    let i = 0;
    const isIdent = c => /[A-Za-z_]/.test(c);
    while (i < src.length) {
      const c = src[i];
      if (c === "\n") { tokens.push({ t: "nl" }); i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === '"') { let s = "", j = i + 1; while (j < src.length && src[j] !== '"') { if (src[j] === "\\" && j + 1 < src.length) { const n = src[++j]; s += n === "n" ? "\n" : n === "t" ? "\t" : n; } else s += src[j]; j++; } tokens.push({ t: "str", v: s }); i = j + 1; continue; }
      if (c === "/" && (!tokens.length || ["op", "nl", "(", ",", "{", ";", "!"].includes(tokens[tokens.length - 1].t) || (tokens[tokens.length - 1].t === "op"))) {
        let s = "", j = i + 1; while (j < src.length && src[j] !== "/") { if (src[j] === "\\" && src[j + 1] === "/") { s += "/"; j += 2; continue; } s += src[j++]; }
        tokens.push({ t: "re", v: s }); i = j + 1; continue;
      }
      if (/[0-9.]/.test(c) && /[0-9]/.test(c === "." ? src[i + 1] || "" : c)) { const m = /^\d*\.?\d+(e[+-]?\d+)?|^\d+/i.exec(src.slice(i)); tokens.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue; }
      if (isIdent(c)) { const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)); tokens.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
      const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
      if (["**="].includes(three)) { tokens.push({ t: "op", v: three }); i += 3; continue; }
      if (["==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "^=", "!~", "**"].includes(two)) { tokens.push({ t: "op", v: two }); i += 2; continue; }
      if ("{}();,[]".includes(c)) { tokens.push({ t: c }); i++; continue; }
      if ("+-*/%^<>=!~$?:".includes(c)) { tokens.push({ t: "op", v: c }); i++; continue; }
      throw new Error(`syntax error at '${c}'`);
    }
    return tokens;
  }

  function awkParse(src) {
    const tokens = awkTokens(src);
    let p = 0;
    const peek = (o = 0) => tokens[p + o] || { t: "eof" };
    const next = () => tokens[p++] || { t: "eof" };
    const skipNl = () => { while (peek().t === "nl" || peek().t === ";") p++; };
    const expect = (t, v) => { const tok = next(); if (tok.t !== t || (v !== undefined && tok.v !== v)) throw new Error(`syntax error near ${tok.v ?? tok.t}`); return tok; };
    const isOp = v => peek().t === "op" && peek().v === v;

    function block() {
      expect("{"); const stmts = [];
      skipNl();
      while (peek().t !== "}") { stmts.push(statement()); skipNl(); }
      expect("}");
      return { type: "block", stmts };
    }
    function statement() {
      const tok = peek();
      if (tok.t === "{") return block();
      if (tok.t === "id" && tok.v === "if") { next(); expect("("); const cond = expression(); expect(")"); skipNl(); const then = statement(); skipNl(); let otherwise = null; if (peek().t === "id" && peek().v === "else") { next(); skipNl(); otherwise = statement(); } return { type: "if", cond, then, otherwise }; }
      if (tok.t === "id" && tok.v === "while") { next(); expect("("); const cond = expression(); expect(")"); skipNl(); return { type: "while", cond, body: statement() }; }
      if (tok.t === "id" && tok.v === "for") {
        next(); expect("(");
        if (peek().t === "id" && peek(1).t === "id" && peek(1).v === "in") { const name = next().v; next(); const arr = expect("id").v; expect(")"); skipNl(); return { type: "forin", name, arr, body: statement() }; }
        const init = peek().t === ";" ? null : expression(); expect(";");
        const cond = peek().t === ";" ? null : expression(); expect(";");
        const step = peek().t === ")" ? null : expression(); expect(")"); skipNl();
        return { type: "for", init, cond, step, body: statement() };
      }
      if (tok.t === "id" && (tok.v === "print" || tok.v === "printf")) {
        next(); const args = [];
        if (peek().t !== "nl" && peek().t !== ";" && peek().t !== "}" && !isOp(">")) { args.push(expression()); while (peek().t === ",") { next(); args.push(expression()); } }
        let redirect = null;
        if (isOp(">")) { next(); redirect = { append: false, target: expression() }; }
        return { type: tok.v, args, redirect };
      }
      if (tok.t === "id" && tok.v === "next") { next(); return { type: "next" }; }
      if (tok.t === "id" && tok.v === "exit") { next(); return { type: "exit" }; }
      if (tok.t === "id" && tok.v === "delete") { next(); const arr = expect("id").v; let key = null; if (peek().t === "[") { next(); key = expression(); expect("]"); } return { type: "delete", arr, key }; }
      return { type: "expr", expr: expression() };
    }
    function expression() { return ternary(); }
    function ternary() { const c = or(); if (isOp("?")) { next(); const a = ternary(); expect("op", ":"); const b = ternary(); return { type: "cond", c, a, b }; } return c; }
    function or() { let left = and(); while (isOp("||")) { next(); skipNl(); left = { type: "or", left, right: and() }; } return left; }
    function and() { let left = inExpr(); while (isOp("&&")) { next(); skipNl(); left = { type: "and", left, right: inExpr() }; } return left; }
    function inExpr() { let left = match(); while (peek().t === "id" && peek().v === "in") { next(); left = { type: "in", key: left, arr: expect("id").v }; } return left; }
    function match() { let left = comparison(); while (isOp("~") || isOp("!~")) { const op = next().v; left = { type: "match", left, right: comparison(), negate: op === "!~" }; } return left; }
    function comparison() { let left = concat(); while (peek().t === "op" && ["<", "<=", ">", ">=", "==", "!="].includes(peek().v) && !(peek().v === ">" && false)) { const op = next().v; left = { type: "cmp", op, left, right: concat() }; } return left; }
    function concat() {
      let left = additive();
      while (["str", "num", "id", "re", "(", "$"].includes(peek().t) || (peek().t === "op" && (peek().v === "$" || peek().v === "!" || peek().v === "-" && false))) {
        if (peek().t === "id" && ["in"].includes(peek().v)) break;
        left = { type: "concat", left, right: additive() };
      }
      return left;
    }
    function additive() { let left = multiplicative(); while (isOp("+") || isOp("-")) { const op = next().v; left = { type: "bin", op, left, right: multiplicative() }; } return left; }
    function multiplicative() { let left = unary(); while (isOp("*") || isOp("/") || isOp("%")) { const op = next().v; left = { type: "bin", op, left, right: unary() }; } return left; }
    function unary() {
      if (isOp("!")) { next(); return { type: "not", e: unary() }; }
      if (isOp("-")) { next(); return { type: "neg", e: unary() }; }
      if (isOp("+")) { next(); return unary(); }
      return power();
    }
    function power() { const base = postfix(); if (isOp("^") || isOp("**")) { next(); return { type: "bin", op: "^", left: base, right: unary() }; } return base; }
    function postfix() {
      const e = primary();
      if (isOp("++") || isOp("--")) { const op = next().v; return { type: "postinc", op, target: e }; }
      if (peek().t === "op" && ["=", "+=", "-=", "*=", "/=", "%=", "^="].includes(peek().v)) { const op = next().v; skipNl(); return { type: "assign", op, target: e, value: ternary() }; }
      return e;
    }
    function primary() {
      const tok = next();
      if (tok.t === "num") return { type: "num", v: tok.v };
      if (tok.t === "str") return { type: "str", v: tok.v };
      if (tok.t === "re") return { type: "re", v: tok.v };
      if (tok.t === "(") { const e = expression(); expect(")"); return { type: "group", e }; }
      if (tok.t === "op" && tok.v === "$") return { type: "field", e: unary() };
      if (tok.t === "op" && (tok.v === "++" || tok.v === "--")) { const target = primary(); return { type: "preinc", op: tok.v, target }; }
      if (tok.t === "id") {
        if (peek().t === "(") { next(); const args = []; if (peek().t !== ")") { args.push(expression()); while (peek().t === ",") { next(); args.push(expression()); } } expect(")"); return { type: "call", name: tok.v, args }; }
        if (peek().t === "[") { next(); const keys = [expression()]; while (peek().t === ",") { next(); keys.push(expression()); } expect("]"); return { type: "index", name: tok.v, keys }; }
        return { type: "var", name: tok.v };
      }
      throw new Error(`syntax error near ${tok.v ?? tok.t}`);
    }
    const rules = [];
    skipNl();
    while (peek().t !== "eof") {
      let pattern = null, action = null;
      if (peek().t === "id" && (peek().v === "BEGIN" || peek().v === "END")) { pattern = next().v; }
      else if (peek().t !== "{") {
        pattern = expression();
        if (peek().t === ",") { next(); pattern = { type: "range", from: pattern, to: expression() }; }
      }
      if (peek().t === "{") action = block();
      rules.push({ pattern, action });
      skipNl();
    }
    return rules;
  }

  function awkRun(rules, inputs, options, io, sys) {
    const vars = { FS: options.FS ?? " ", OFS: " ", ORS: "\n", NR: 0, NF: 0, FNR: 0, FILENAME: "", RSTART: 0, RLENGTH: -1, SUBSEP: "\x1c", ...options.vars };
    const arrays = {};
    let fields = [], record = "", output = "";
    const files = {};
    let stopped = false;
    const num = v => { if (typeof v === "number") return v; const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(String(v)); return m ? Number(m[0]) : 0; };
    const str = v => typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)))) : String(v);
    const truthy = v => typeof v === "number" ? v !== 0 : v !== "";
    const isNumeric = v => typeof v === "number" || (typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(v) && v.trim() !== "");
    const splitRecord = () => {
      const fs = String(vars.FS);
      fields = record === "" ? [] : fs === " " ? record.trim().split(/\s+/) : fs.length === 1 ? record.split(fs) : record.split(new RegExp(fs));
      vars.NF = fields.length;
    };
    const setField = (i, value) => {
      if (i === 0) { record = str(value); splitRecord(); return; }
      while (fields.length < i) fields.push("");
      fields[i - 1] = str(value); vars.NF = fields.length; record = fields.join(str(vars.OFS));
    };
    const getField = i => i === 0 ? record : (fields[i - 1] ?? "");
    const regexOf = v => v instanceof RegExp ? v : new RegExp(str(v));
    const format = (fmt, args) => {
      let i = 0;
      return fmt.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([sdifcxXoeEg%])/g, (m, flags, width, prec, conv) => {
        if (conv === "%") return "%";
        const v = args[i++];
        let s;
        if (conv === "s") s = prec !== undefined ? str(v ?? "").slice(0, Number(prec)) : str(v ?? "");
        else if (conv === "d" || conv === "i") s = String(Math.trunc(num(v)));
        else if (conv === "f") s = num(v).toFixed(prec !== undefined ? Number(prec) : 6);
        else if (conv === "e" || conv === "E") { s = num(v).toExponential(prec !== undefined ? Number(prec) : 6); if (conv === "E") s = s.toUpperCase(); }
        else if (conv === "g") s = String(Number(num(v).toPrecision(prec !== undefined ? Number(prec) || 1 : 6)));
        else if (conv === "x") s = Math.trunc(num(v)).toString(16);
        else if (conv === "X") s = Math.trunc(num(v)).toString(16).toUpperCase();
        else if (conv === "o") s = Math.trunc(num(v)).toString(8);
        else if (conv === "c") s = typeof v === "number" ? String.fromCharCode(v) : str(v).slice(0, 1);
        if (flags.includes("+") && /^[de]/.test(conv + "") && num(v) >= 0) s = "+" + s;
        if (width) s = flags.includes("-") ? s.padEnd(Number(width)) : s.padStart(Number(width), flags.includes("0") && !flags.includes("-") ? "0" : " ");
        return s;
      });
    };
    const write = (text, redirect) => {
      if (!redirect) { output += text; return; }
      const target = str(evaluate(redirect.target));
      files[target] = (files[target] ?? "") + text;
    };
    const lvalueGet = node => {
      if (node.type === "var") return vars[node.name] ?? "";
      if (node.type === "field") return getField(Math.trunc(num(evaluate(node.e))));
      if (node.type === "index") { const key = node.keys.map(k => str(evaluate(k))).join(vars.SUBSEP); const arr = arrays[node.name] || (arrays[node.name] = new Map()); if (!arr.has(key)) arr.set(key, ""); return arr.get(key); }
      throw new Error("assignment to a non-variable");
    };
    const lvalueSet = (node, value) => {
      if (node.type === "var") { vars[node.name] = value; if (node.name === "NF") { fields.length = Math.max(0, Math.trunc(num(value))); record = fields.join(str(vars.OFS)); } return value; }
      if (node.type === "field") { setField(Math.trunc(num(evaluate(node.e))), value); return value; }
      if (node.type === "index") { const key = node.keys.map(k => str(evaluate(k))).join(vars.SUBSEP); (arrays[node.name] || (arrays[node.name] = new Map())).set(key, value); return value; }
      throw new Error("assignment to a non-variable");
    };
    const compare = (op, a, b) => {
      const both = isNumeric(a) && isNumeric(b);
      const x = both ? num(a) : str(a), y = both ? num(b) : str(b);
      switch (op) { case "<": return x < y; case "<=": return x <= y; case ">": return x > y; case ">=": return x >= y; case "==": return x === y; default: return x !== y; }
    };
    const callFunction = (name, args) => {
      const a = args.map(evaluate);
      switch (name) {
        case "length": return name && args.length ? (args[0].type === "var" && arrays[args[0].name] ? arrays[args[0].name].size : str(a[0]).length) : record.length;
        case "substr": { const s = str(a[0]); const start = Math.max(1, Math.round(num(a[1]))); const len = a.length > 2 ? Math.round(num(a[2])) : Infinity; return s.slice(start - 1, len === Infinity ? undefined : start - 1 + Math.max(0, len)); }
        case "index": return str(a[0]).indexOf(str(a[1])) + 1;
        case "toupper": return str(a[0]).toUpperCase();
        case "tolower": return str(a[0]).toLowerCase();
        case "int": return Math.trunc(num(a[0]));
        case "sqrt": return Math.sqrt(num(a[0]));
        case "sprintf": return format(str(a[0]), a.slice(1));
        case "match": { const m = regexOf(a[1]).exec(str(a[0])); vars.RSTART = m ? m.index + 1 : 0; vars.RLENGTH = m ? m[0].length : -1; return vars.RSTART; }
        case "split": { const parts = str(a[0]) === "" ? [] : a.length > 2 ? str(a[0]).split(str(a[2]).length === 1 ? str(a[2]) : new RegExp(str(a[2]))) : str(a[0]).trim().split(/\s+/); const arr = new Map(); parts.forEach((v, i) => arr.set(String(i + 1), v)); arrays[args[1].name] = arr; return parts.length; }
        case "sub": case "gsub": { const re = regexOf(a[0]); const flagged = new RegExp(re.source, name === "gsub" ? "g" : ""); const target = args[2] || { type: "field", e: { type: "num", v: 0 } }; const before = str(lvalueGet(target)); let count = 0; const after = before.replace(flagged, m => { count++; return str(a[1]).replace(/\\&/g, "\0").replace(/&/g, m).replace(/\0/g, "&"); }); if (count) lvalueSet(target, after); return count; }
        case "system": return 0;
        default: throw new Error(`function ${name} not defined`);
      }
    };
    function evaluate(node) {
      switch (node.type) {
        case "num": return node.v;
        case "str": return node.v;
        case "re": return new RegExp(node.v).test(record) ? 1 : 0;
        case "group": return evaluate(node.e);
        case "field": return getField(Math.trunc(num(evaluate(node.e))));
        case "var": return vars[node.name] ?? "";
        case "index": return lvalueGet(node);
        case "call": return callFunction(node.name, node.args);
        case "not": return truthy(evaluate(node.e)) ? 0 : 1;
        case "neg": return -num(evaluate(node.e));
        case "bin": { const a = num(evaluate(node.left)), b = num(evaluate(node.right)); switch (node.op) { case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": if (b === 0) throw new Error("division by zero"); return a / b; case "%": return a % b; case "^": return a ** b; } return 0; }
        case "concat": return str(evaluate(node.left)) + str(evaluate(node.right));
        case "cmp": return compare(node.op, evaluate(node.left), evaluate(node.right)) ? 1 : 0;
        case "match": { const r = node.right.type === "re" ? new RegExp(node.right.v) : regexOf(evaluate(node.right)); const hit = r.test(str(evaluate(node.left))); return (node.negate ? !hit : hit) ? 1 : 0; }
        case "and": return truthy(evaluate(node.left)) && truthy(evaluate(node.right)) ? 1 : 0;
        case "or": return truthy(evaluate(node.left)) || truthy(evaluate(node.right)) ? 1 : 0;
        case "cond": return truthy(evaluate(node.c)) ? evaluate(node.a) : evaluate(node.b);
        case "in": { const key = str(evaluate(node.key)); return arrays[node.arr] && arrays[node.arr].has(key) ? 1 : 0; }
        case "assign": {
          let value = evaluate(node.value);
          if (node.op !== "=") { const current = num(lvalueGet(node.target)); const b = num(value); value = node.op === "+=" ? current + b : node.op === "-=" ? current - b : node.op === "*=" ? current * b : node.op === "/=" ? current / b : node.op === "%=" ? current % b : current ** b; }
          return lvalueSet(node.target, value);
        }
        case "preinc": { const v = num(lvalueGet(node.target)) + (node.op === "++" ? 1 : -1); lvalueSet(node.target, v); return v; }
        case "postinc": { const v = num(lvalueGet(node.target)); lvalueSet(node.target, v + (node.op === "++" ? 1 : -1)); return v; }
        default: throw new Error(`cannot evaluate ${node.type}`);
      }
    }
    const NEXT = Symbol("next"), EXIT = Symbol("exit");
    function run(stmt) {
      switch (stmt.type) {
        case "block": for (const s of stmt.stmts) run(s); return;
        case "expr": evaluate(stmt.expr); return;
        case "print": write((stmt.args.length ? stmt.args.map(a => str(evaluate(a))).join(str(vars.OFS)) : record) + str(vars.ORS), stmt.redirect); return;
        case "printf": { const a = stmt.args.map(evaluate); write(format(str(a[0] ?? ""), a.slice(1)), stmt.redirect); return; }
        case "if": if (truthy(evaluate(stmt.cond))) run(stmt.then); else if (stmt.otherwise) run(stmt.otherwise); return;
        case "while": { let guard = 0; while (truthy(evaluate(stmt.cond))) { run(stmt.body); if (++guard > 1e6) throw new Error("loop too long"); } return; }
        case "for": { let guard = 0; if (stmt.init) evaluate(stmt.init); while (!stmt.cond || truthy(evaluate(stmt.cond))) { run(stmt.body); if (stmt.step) evaluate(stmt.step); if (++guard > 1e6) throw new Error("loop too long"); } return; }
        case "forin": { const arr = arrays[stmt.arr]; if (!arr) return; for (const key of [...arr.keys()]) { vars[stmt.name] = key; run(stmt.body); } return; }
        case "delete": if (stmt.key === null) delete arrays[stmt.arr]; else arrays[stmt.arr] && arrays[stmt.arr].delete(str(evaluate(stmt.key))); return;
        case "next": throw NEXT;
        case "exit": throw EXIT;
      }
    }
    const patternHits = (rule, state) => {
      if (rule.pattern === null) return true;
      if (rule.pattern.type === "range") {
        if (state.get(rule)) { if (truthy(evaluate(rule.pattern.to))) state.set(rule, false); return true; }
        if (truthy(evaluate(rule.pattern.from))) { if (!truthy(evaluate(rule.pattern.to))) state.set(rule, true); return true; }
        return false;
      }
      return truthy(evaluate(rule.pattern));
    };
    const rangeState = new Map();
    try {
      for (const rule of rules) if (rule.pattern === "BEGIN" && rule.action) run(rule.action);
      const mainRules = rules.filter(r => r.pattern !== "BEGIN" && r.pattern !== "END");
      if (mainRules.length || rules.some(r => r.pattern === "END")) {
        for (const input of inputs) {
          vars.FILENAME = input.name; vars.FNR = 0;
          for (const line of linesOf(input.text)) {
            if (stopped) break;
            record = line; splitRecord(); vars.NR = num(vars.NR) + 1; vars.FNR = num(vars.FNR) + 1;
            try {
              for (const rule of mainRules) if (patternHits(rule, rangeState)) { if (rule.action) run(rule.action); else write(record + str(vars.ORS)); }
            } catch (signal) { if (signal === NEXT) continue; throw signal; }
          }
        }
      }
    } catch (signal) { if (signal !== EXIT) throw signal; stopped = true; }
    try { for (const rule of rules) if (rule.pattern === "END" && rule.action) run(rule.action); } catch (signal) { if (signal !== EXIT) throw signal; }
    return { output, files };
  }

  // ---------------------------------------------------------------- expr (POSIX arithmetic and comparisons)

  function evalExpr(args) {
    let p = 0;
    const peek = () => args[p];
    const take = () => args[p++];
    const isInt = v => /^-?\d+$/.test(String(v));
    const toInt = v => { if (!isInt(v)) throw new Error("non-integer argument"); return Number(v); };
    const or = () => { let a = and(); while (peek() === "|") { take(); const b = and(); a = a !== "0" && a !== "" ? a : b; } return a; };
    const and = () => { let a = cmp(); while (peek() === "&") { take(); const b = cmp(); a = a !== "0" && a !== "" && b !== "0" && b !== "" ? a : "0"; } return a; };
    const cmp = () => {
      let a = add();
      while (["=", "!=", "<", "<=", ">", ">="].includes(peek())) {
        const op = take(); const b = add();
        const both = isInt(a) && isInt(b);
        const x = both ? Number(a) : String(a), y = both ? Number(b) : String(b);
        const r = op === "=" ? x === y : op === "!=" ? x !== y : op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
        a = r ? "1" : "0";
      }
      return a;
    };
    const add = () => { let a = mul(); while (peek() === "+" || peek() === "-") { const op = take(); const b = mul(); a = String(op === "+" ? toInt(a) + toInt(b) : toInt(a) - toInt(b)); } return a; };
    const mul = () => { let a = unary(); while (["*", "/", "%"].includes(peek())) { const op = take(); const b = unary(); if (op !== "*" && toInt(b) === 0) throw new Error("division by zero"); a = String(op === "*" ? toInt(a) * toInt(b) : op === "/" ? Math.trunc(toInt(a) / toInt(b)) : toInt(a) % toInt(b)); } return a; };
    const unary = () => {
      const t = take();
      if (t === undefined) throw new Error("syntax error: missing argument");
      if (t === "(") { const v = or(); if (take() !== ")") throw new Error("syntax error: expecting ')'"); return v; }
      if (t === "length") return String(String(take() ?? "").length);
      if (t === "substr") { const s = String(take()), start = toInt(take()), len = toInt(take()); return s.slice(start - 1, start - 1 + len); }
      if (t === "index") { const s = String(take()), chars = String(take()); const i = [...s].findIndex(c => chars.includes(c)); return String(i + 1); }
      if (t === "match") { const s = String(take()), re = new RegExp("^(?:" + String(take()) + ")"); const m = re.exec(s); return m ? (m[1] !== undefined ? m[1] : String(m[0].length)) : "0"; }
      return String(t);
    };
    const value = or();
    if (p < args.length) throw new Error("syntax error: unexpected argument " + q(args[p]));
    return value;
  }

  // ---------------------------------------------------------------- the programs

  const commands = {
    async egrep(proc, args, io, ctx) { return kernel.run("grep", this, proc, ["-E", ...args], io, ctx); },
    async fgrep(proc, args, io, ctx) { return kernel.run("grep", this, proc, ["-F", ...args], io, ctx); },

    async tac(proc, args, io) {
      const inputs = inputsOf(this, proc, io, args, "tac"); if (!inputs) return 0;
      let status = 0;
      for (const input of inputs) { if (input.error) { status = 1; continue; } for (const l of linesOf(input.text).reverse()) io.out(l); }
      return status;
    },
    async rev(proc, args, io) {
      const inputs = inputsOf(this, proc, io, args, "rev"); if (!inputs) return 0;
      let status = 0;
      for (const input of inputs) { if (input.error) { status = 1; continue; } for (const l of linesOf(input.text)) io.out([...l].reverse().join("")); }
      return status;
    },
    async nl(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { values: "bsw" }); } catch (error) { gnuError(io, "nl", error.message); return 1; }
      const inputs = inputsOf(this, proc, io, opts.operands, "nl"); if (!inputs) return 0;
      const all = opts.values.b === "a";
      const width = Number(opts.values.w ?? 6), sep = opts.values.s ?? "\t";
      let n = 1, status = 0;
      for (const input of inputs) {
        if (input.error) { status = 1; continue; }
        for (const l of linesOf(input.text)) io.out(l === "" && !all ? " ".repeat(width) + " ".repeat(sep.length) + l : `${String(n++).padStart(width)}${sep}${l}`);
      }
      return status;
    },
    async fold(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "s", values: "w", longs: { width: "w" } }); } catch (error) { gnuError(io, "fold", error.message); return 1; }
      const width = Number(opts.values.w ?? 80);
      const inputs = inputsOf(this, proc, io, opts.operands, "fold"); if (!inputs) return 0;
      for (const input of inputs) {
        if (input.error) continue;
        for (const l of linesOf(input.text)) {
          let rest = l;
          while (rest.length > width) {
            let cut = width;
            if (opts.flags.has("s")) { const space = rest.lastIndexOf(" ", width); if (space > 0) cut = space + 1; }
            io.out(rest.slice(0, cut)); rest = rest.slice(cut);
          }
          io.out(rest);
        }
      }
      return 0;
    },
    async realpath(proc, args, io) {
      let status = 0;
      for (const path of args.filter(a => !a.startsWith("-"))) {
        try { io.out(this.stat(proc, path).path); }
        catch (error) { gnuError(io, "realpath", `${path}: ${error.message}`); status = 1; }
      }
      return status;
    },
    async expr(proc, args, io) {
      try { const value = evalExpr(args); io.out(value); return value === "0" || value === "" ? 1 : 0; }
      catch (error) { io.err(`expr: ${error.message}`); return 2; }
    },
    async cal(proc, args, io) {
      const today = local(this.clock.now());
      const months = [];
      const nums = args.filter(a => /^\d+$/.test(a)).map(Number);
      if (nums.length === 2) months.push([nums[0] - 1, nums[1]]);
      else if (nums.length === 1) { for (let m = 0; m < 12; m++) months.push([m, nums[0]]); }
      else months.push([today.getUTCMonth(), today.getUTCFullYear()]);
      const long = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      for (const [month, year] of months) {
        const title = `${long[month]} ${year}`;
        const pad20 = Math.floor((20 - title.length) / 2);
        io.out(" ".repeat(pad20) + title);
        io.out("Su Mo Tu We Th Fr Sa");
        const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
        const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        let line = "   ".repeat(first);
        for (let d = 1; d <= days; d++) {
          line += String(d).padStart(2) + " ";
          if ((first + d) % 7 === 0) { io.out(line.replace(/\s+$/, "")); line = ""; }
        }
        if (line.trim()) io.out(line.replace(/\s+$/, ""));
        if (months.length > 1) io.out("");
      }
      return 0;
    },

    sha256sum: hashCommand("sha256sum", "SHA-256"),
    sha1sum: hashCommand("sha1sum", "SHA-1"),
    md5sum: hashCommand("md5sum", "MD5"),

    async who(proc, args, io) {
      const login = this.loginShell;
      io.out(`${login.user.padEnd(8)} pts/0        ${fmtDateShort(this, this.bootTime)} (:0)`);
      return 0;
    },
    async w(proc, args, io) {
      const s = Math.floor(this.uptimeSeconds());
      io.out(` ${fmtClock(this.clock.now())}:00 up ${Math.floor(s / 60)} min,  1 user,  load average: 0.00, 0.01, 0.05`);
      io.out("USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT");
      io.out(`${this.loginShell.user.padEnd(8)} pts/0    :0               ${fmtClock(this.bootTime).padEnd(8)} 0.00s  0.02s  0.00s w`);
      return 0;
    },
    async last(proc, args, io) {
      io.out(`${this.loginShell.user.padEnd(8)} pts/0        :0               ${fmtDateLong(this, this.bootTime)}   still logged in`);
      io.out(`reboot   system boot  6.1.0-lialinux   ${fmtDateLong(this, this.bootTime)}   still running`);
      io.out("");
      io.out(`wtmp begins ${fmtDateLong(this, this.bootTime)}`);
      return 0;
    },
    async userdel(proc, args, io) {
      if (proc.uid !== 0) { io.err("userdel: Permission denied."); io.err("userdel: cannot lock /etc/passwd; try again later."); return 1; }
      let opts;
      try { opts = parseArgs(args, { flags: "rf", longs: { remove: "r", force: "f" } }); } catch (error) { io.err(`userdel: ${error.message}`); return 2; }
      const name = opts.operands[0];
      const user = this.users.get(name);
      if (!user) { io.err(`userdel: user '${name}' does not exist`); return 6; }
      const inUse = [...this.procs.values()].find(p => p.uid === user.uid);
      if (inUse && !opts.flags.has("f")) { io.err(`userdel: user ${name} is currently used by process ${inUse.pid}`); return 8; }
      this.users.delete(name);
      for (const g of this.groups.values()) g.members = g.members.filter(m => m !== name);
      const own = this.groupByGid(user.gid);
      if (own && own.name === name && ![...this.users.values()].some(u => u.gid === user.gid)) this.groups.delete(name);
      if (opts.flags.has("r")) { const parent = this.lookup(user.home.replace(/\/[^/]+$/, "") || "/"); parent && parent.children.delete(user.home.split("/").pop()); }
      return 0;
    },
    async groupdel(proc, args, io) {
      if (proc.uid !== 0) { io.err("groupdel: Permission denied."); return 1; }
      const name = args.filter(a => !a.startsWith("-"))[0];
      if (!name) { io.err("Usage: groupdel [options] GROUP"); return 2; }
      const group = this.groups.get(name);
      if (!group) { io.err(`groupdel: group '${name}' does not exist`); return 6; }
      const primary = [...this.users.values()].find(u => u.gid === group.gid);
      if (primary) { io.err(`groupdel: cannot remove the primary group of user '${primary.name}'`); return 8; }
      this.groups.delete(name);
      return 0;
    },
    async chsh(proc, args, io, { shell }) {
      let opts;
      try { opts = parseArgs(args, { values: "s", longs: { shell: "s" } }); } catch (error) { io.err(`chsh: ${error.message}`); return 1; }
      const name = opts.operands[0] ?? shell.user;
      const user = this.users.get(name);
      if (!user) { io.err(`chsh: user '${name}' does not exist`); return 1; }
      if (shell.uid !== 0 && user.uid !== shell.uid) { io.err(`chsh: You may not change the shell for '${name}'.`); return 1; }
      const target = opts.values.s ?? (await io.readLine({ prompt: `Changing the login shell for ${name}\nEnter the new value, or press ENTER for the default\n\tLogin Shell [${user.shell}]: `, echo: true }));
      if (!target) return 0;
      if (!["/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh"].includes(target)) { io.err(`chsh: ${target} is an invalid shell`); return 1; }
      user.shell = target;
      return 0;
    },
    async htop(proc, args, io, ctx) { return kernel.run("top", this, proc, args, io, ctx); },
    async lsblk(proc, args, io) {
      io.out("NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS");
      io.out("sda      8:0    0   20G  0 disk");
      io.out("├─sda1   8:1    0  512M  0 part /boot/efi");
      io.out("└─sda2   8:2    0 19.5G  0 part /");
      io.out("sr0     11:0    1 1024M  0 rom");
      return 0;
    },
    async mount(proc, args, io) {
      if (!args.length) {
        io.out("/dev/sda2 on / type ext4 (rw,relatime)");
        io.out("/dev/sda1 on /boot/efi type vfat (rw,relatime,fmask=0077,dmask=0077)");
        io.out("tmpfs on /tmp type tmpfs (rw,nosuid,nodev)");
        io.out("proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)");
        return 0;
      }
      if (proc.uid !== 0) { io.err("mount: only root can do that"); return 1; }
      io.err(`mount: ${args[args.length - 1]}: no device or mount point to mount in the simulation.`);
      return 32;
    },
    async umount(proc, args, io) {
      if (proc.uid !== 0) { io.err("umount: only root can do that"); return 1; }
      io.err(`umount: ${args[0] ?? ""}: not mounted.`);
      return 32;
    },
    async fdisk(proc, args, io) {
      if (proc.uid !== 0) { io.err("fdisk: cannot open /dev/sda: Permission denied"); return 1; }
      io.out("Disk /dev/sda: 20 GiB, 21474836480 bytes, 41943040 sectors");
      io.out("Disk model: LiaLinux Virtual Disk");
      io.out("Units: sectors of 1 * 512 = 512 bytes");
      io.out("Disklabel type: gpt");
      io.out("");
      io.out("Device       Start      End  Sectors  Size Type");
      io.out("/dev/sda1     2048  1050623  1048576  512M EFI System");
      io.out("/dev/sda2  1050624 41943006 40892383 19.5G Linux filesystem");
      return 0;
    },
    async shutdown(proc, args, io) { return powerCommand.call(this, proc, args, io, args.includes("-r") ? "reboot" : "power off"); },
    async reboot(proc, args, io) { return powerCommand.call(this, proc, args, io, "reboot"); },
    async poweroff(proc, args, io) { return powerCommand.call(this, proc, args, io, "power off"); },
    async halt(proc, args, io) { return powerCommand.call(this, proc, args, io, "halt"); },

    async nohup(proc, args, io, ctx) {
      if (!args.length) { io.err("nohup: missing operand"); return 125; }
      proc.traps.HUP = "";
      io.err("nohup: ignoring input and appending output to 'nohup.out'");
      let buffer = "";
      const quiet = this.makeIO({ write: t => { buffer += t; }, error: t => { buffer += t; }, lang: io.lang, readLine: () => Promise.resolve("") });
      const status = await this.execute(proc, args, quiet, { asProcess: proc, line: ctx.line });
      try { this.writeFile(proc, "nohup.out", buffer, { append: true }); } catch { /* ignore */ }
      return status;
    },
    async time(proc, args, io, ctx) {
      const start = this.clock.now();
      const status = args.length ? await this.execute(ctx.shell, args, io, { line: ctx.line }) : 0;
      const seconds = (this.clock.now() - start) / 1000;
      io.err(`\nreal\t${Math.floor(seconds / 60)}m${(seconds % 60).toFixed(3)}s\nuser\t0m0.000s\nsys\t0m0.000s`);
      return status;
    },
    async nice(proc, args, io, ctx) {
      const rest = args.filter((a, i) => !(a === "-n" || (args[i - 1] === "-n") || /^-\d+$/.test(a)));
      if (!rest.length) { io.out("0"); return 0; }
      return this.execute(ctx.shell, rest, io, { line: ctx.line });
    },
    async renice(proc, args, io) { const pid = args.filter(a => /^\d+$/.test(a)).pop(); if (!pid || !this.procs.has(Number(pid))) { io.err(`renice: failed to get priority for ${pid ?? "?"} (process ID): No such process`); return 1; } io.out(`${pid} (process ID) old priority 0, new priority ${args.find(a => /^-?\d+$/.test(a) && a !== pid) ?? 0}`); return 0; },
    async apropos(proc, args, io) {
      const pages = kernel.manPages(io.lang());
      const needle = (args[0] ?? "").toLowerCase();
      const hits = Object.entries(pages).filter(([n, p]) => n.includes(needle) || p.name.toLowerCase().includes(needle));
      if (!hits.length) { io.notice(`${args[0] ?? ""}: nothing appropriate.`); return 1; }
      for (const [n, p] of hits) io.out(`${n.padEnd(12)} (1)  - ${p.name}`);
      return 0;
    },
    async reset(proc, args, io) { io.clear(); return 0; },

    async tee(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "ai", longs: { append: "a" } }); } catch (error) { gnuError(io, "tee", error.message); return 1; }
      const text = io.stdin ?? "";
      let status = 0;
      for (const path of opts.operands) {
        try { this.writeFile(proc, path, text, { append: opts.flags.has("a") }); }
        catch (error) { gnuError(io, "tee", `${path}: ${error.message}`); status = 1; }
      }
      io.write(text);
      return status;
    },
    async xargs(proc, args, io, ctx) {
      let n = Infinity, placeholder = null, trace = false;
      let i = 0;
      for (; i < args.length; i++) {
        if (args[i] === "-n") n = Number(args[++i]);
        else if (args[i] === "-I") placeholder = args[++i];
        else if (args[i] === "-t") trace = true;
        else if (args[i] === "-0" || args[i] === "-r") { /* accepted */ }
        else break;
      }
      const command = args.slice(i);
      if (!command.length) command.push("echo");
      const items = placeholder ? linesOf(io.stdin ?? "").filter(Boolean) : (io.stdin ?? "").split(/\s+/).filter(Boolean);
      if (!items.length) return 0;
      const groups = placeholder ? items.map(x => [x]) : n === Infinity ? [items] : Array.from({ length: Math.ceil(items.length / n) }, (_, k) => items.slice(k * n, (k + 1) * n));
      let status = 0;
      const out = this.makeIO({ write: io.write, error: io.error, color: io.color, lang: io.lang, readLine: () => Promise.resolve(""), clear: io.clear });
      for (const group of groups) {
        const words = placeholder ? command.map(w => w.split(placeholder).join(group[0])) : [...command, ...group];
        if (trace) io.err(words.join(" "));
        const code = await this.execute(ctx.shell, words, out, { line: words.join(" ") });
        if (code !== 0) status = 123;
      }
      return status;
    },
    async sed(proc, args, io) {
      let scripts = [], files = [], quiet = false, inPlace = false, extended = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-n" || a === "--quiet" || a === "--silent") quiet = true;
        else if (a === "-e" || a === "--expression") scripts.push(args[++i] ?? "");
        else if (a === "-i" || a === "--in-place") inPlace = true;
        else if (a === "-E" || a === "-r" || a === "--regexp-extended") extended = true;
        else if (a.startsWith("-") && a.length > 1 && !scripts.length && !/^-\d/.test(a)) {
          for (const c of a.slice(1)) { if (c === "n") quiet = true; else if (c === "i") inPlace = true; else if (c === "E" || c === "r") extended = true; else if (c === "e") { scripts.push(args[++i] ?? ""); } else { io.err(`sed: invalid option -- '${c}'`); return 1; } }
        }
        else if (!scripts.length) scripts.push(a);
        else files.push(a);
      }
      if (!scripts.length) { io.err("Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]..."); return 1; }
      let commands;
      try { commands = parseSed(scripts, extended); } catch (error) { io.err(`sed: -e expression #1, char 0: ${error.message}`); return 1; }
      const inputs = inputsOf(this, proc, io, files, "sed"); if (!inputs) return 0;
      let status = 0;
      for (const input of inputs) {
        if (input.error) { status = 2; continue; }
        const lines = linesOf(input.text);
        const out = [];
        const state = new Map();
        let quit = false;
        for (let n = 0; n < lines.length && !quit; n++) {
          let line = lines[n], deleted = false;
          const extra = [];
          for (const c of commands) {
            if (!sedMatches(c, n + 1, line, lines.length, state)) continue;
            if (c.kind === "s") { const before = line; line = line.replace(c.re, c.replacement); if (c.print && line !== before) extra.push(line); }
            else if (c.kind === "d") { deleted = true; break; }
            else if (c.kind === "p") extra.push(line);
            else if (c.kind === "i") out.push(c.text);
            else if (c.kind === "a") extra.push(c.text);
            else if (c.kind === "q") { quit = true; }
          }
          if (!deleted) { if (!quiet) out.push(line); for (const e of extra) out.push(e); }
        }
        const text = out.length ? out.join("\n") + "\n" : "";
        if (inPlace && input.name !== "-") { try { this.writeFile(proc, input.name, text); } catch (error) { io.err(`sed: couldn't edit ${input.name}: ${error.message}`); status = 4; } }
        else io.write(text);
      }
      return status;
    },
    async awk(proc, args, io) {
      let program = null, FS, files = [];
      const vars = {};
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-F") FS = args[++i];
        else if (a.startsWith("-F")) FS = a.slice(2);
        else if (a === "-v") { const spec = args[++i] ?? ""; const eq = spec.indexOf("="); const k = eq < 0 ? spec : spec.slice(0, eq); const v = eq < 0 ? "" : spec.slice(eq + 1); vars[k] = v.replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\\\/g, "\\"); }
        else if (a === "-f") { try { program = this.readFile(proc, args[++i]); } catch (error) { io.err(`awk: ${error.message}`); return 2; } }
        else if (program === null) program = a;
        else files.push(a);
      }
      if (program === null) { io.err("usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]"); return 2; }
      if (FS === "\\t") FS = "\t";
      let rules;
      try { rules = awkParse(program); } catch (error) { io.err(`awk: ${error.message}`); io.err(` source line number 1`); return 2; }
      // a BEGIN-only program needs no input at all
      const needsInput = rules.some(r => r.pattern !== "BEGIN");
      const inputs = needsInput ? inputsOf(this, proc, io, files, "awk") : [];
      if (!inputs) return 2;
      try {
        const result = awkRun(rules, inputs.filter(i => !i.error), { FS, vars }, io, this);
        io.write(result.output);
        for (const [path, text] of Object.entries(result.files)) { try { this.writeFile(proc, path, text); } catch (error) { io.err(`awk: cannot write ${path}: ${error.message}`); } }
        return 0;
      } catch (error) { io.err(`awk: ${error.message}`); return 2; }
    },

    async curl(proc, args, io) {
      let url = null, output = null, silent = false, headOnly = false, remoteName = false, show = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-o" || a === "--output") output = args[++i];
        else if (a === "-O" || a === "--remote-name") remoteName = true;
        else if (a === "-s" || a === "--silent") silent = true;
        else if (a === "-S" || a === "--show-error") show = true;
        else if (a === "-I" || a === "--head") headOnly = true;
        else if (a === "-L" || a === "--location" || a === "-k" || a === "--insecure" || a === "-f") { /* accepted */ }
        else if (a.startsWith("-")) { io.err(`curl: option ${a}: is unknown`); return 2; }
        else url = a;
      }
      if (!url) { io.err("curl: try 'curl --help' for more information"); return 2; }
      if (!/^https?:\/\//.test(url)) url = "http://" + url;
      const result = await fetchText(url, headOnly);
      if (result.error) { if (!silent || show) io.err(`curl: (${result.code}) ${result.error}`); return result.code; }
      if (headOnly) { io.out(`HTTP/1.1 ${result.status} ${result.statusText}`); for (const [k, v] of result.headers) io.out(`${k}: ${v}`); return 0; }
      const target = output ?? (remoteName ? url.split("/").pop().split("?")[0] || "index.html" : null);
      if (target) { try { this.writeFile(proc, target, result.text); } catch (error) { io.err(`curl: (23) Failure writing output to destination: ${error.message}`); return 23; } return 0; }
      io.write(result.text);
      return 0;
    },
    async wget(proc, args, io) {
      let url = null, output = null, quiet = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-O" || a === "--output-document") output = args[++i];
        else if (a.startsWith("--output-document=")) output = a.split("=")[1];
        else if (a === "-q" || a === "--quiet") quiet = true;
        else if (a === "-c" || a === "--no-check-certificate" || a === "-nv") { /* accepted */ }
        else if (a.startsWith("-")) { io.err(`wget: unrecognized option '${a}'`); return 2; }
        else url = a;
      }
      if (!url) { io.err("wget: missing URL"); io.err("Usage: wget [OPTION]... [URL]..."); return 1; }
      if (!/^https?:\/\//.test(url)) url = "http://" + url;
      const name = output ?? (url.replace(/\/+$/, "").split("/").pop().split("?")[0] || "index.html");
      if (!quiet) io.err(`--${new Date(this.clock.now()).toISOString().slice(0, 19).replace("T", " ")}--  ${url}`);
      const result = await fetchText(url, false);
      if (result.error) { if (!quiet) io.err(`wget: ${result.error}`); return 4; }
      if (name === "-") { io.write(result.text); return 0; }
      try { this.writeFile(proc, name, result.text); } catch (error) { io.err(`wget: ${name}: ${error.message}`); return 3; }
      if (!quiet) { io.err(`HTTP request sent, awaiting response... ${result.status} ${result.statusText}`); io.err(`Length: ${result.text.length} [${result.type || "text/plain"}]`); io.err(`Saving to: '${name}'`); io.err(""); io.err(`'${name}' saved [${result.text.length}/${result.text.length}]`); }
      return 0;
    }
  };

  async function fetchText(url, headOnly) {
    if (typeof global.fetch !== "function") return { error: "network access is not available here", code: 7 };
    try {
      const response = await global.fetch(url, { method: headOnly ? "HEAD" : "GET" });
      const text = headOnly ? "" : await response.text();
      return { status: response.status, statusText: response.statusText || "", headers: [...response.headers.entries()], type: response.headers.get("content-type") || "", text };
    } catch (error) {
      const host = url.replace(/^https?:\/\//, "").split("/")[0];
      return { error: `Could not resolve host: ${host} (${error.message}; in a browser the other site must allow access – CORS)`, code: 6 };
    }
  }

  function powerCommand(proc, args, io, action) {
    if (proc.uid !== 0) {
      io.err(`Failed to set wall message, ignoring: Interactive authentication required.`);
      io.err(`Failed to ${action} system via logind: Interactive authentication required.`);
      return 1;
    }
    io.notice(`The system is going down for ${action} NOW!`);
    const sys = this;
    sys.clock.schedule(0, () => sys.rebootSystem());
    return 0;
  }

  function fmtDateShort(sys, ms) { const d = local(ms); return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
  function fmtDateLong(sys, ms) { const d = local(ms); return `${DAYS[d.getUTCDay()].slice(0, 3)} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }

  kernel.registerCommands(commands);
  global.LiaLinuxTools = Object.freeze({ md5, evalExpr, awkParse, awkRun, parseSed, lcsScript, diffNormal, diffUnified });

  // diff and cmp need the kernel's file reading – defined here so the LCS helpers above are in scope
  kernel.registerCommands({
    async diff(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "uqiwBrcN", longs: { unified: "u", brief: "q", "ignore-case": "i" } }); } catch (error) { gnuError(io, "diff", error.message); return 2; }
      if (opts.operands.length !== 2) { gnuError(io, "diff", "missing operand"); return 2; }
      const [nameA, nameB] = opts.operands;
      let a, b;
      try { a = nameA === "-" ? io.stdin ?? "" : this.readFile(proc, nameA); b = nameB === "-" ? io.stdin ?? "" : this.readFile(proc, nameB); }
      catch (error) { gnuError(io, "diff", `${error.path}: ${error.message}`); return 2; }
      const norm = t => opts.flags.has("i") ? t.toLowerCase() : t;
      const la = linesOf(a), lb = linesOf(b);
      const same = la.length === lb.length && la.every((l, i) => norm(l) === norm(lb[i]));
      if (opts.flags.has("q")) { if (!same) io.out(`Files ${nameA} and ${nameB} differ`); return same ? 0 : 1; }
      const changed = opts.flags.has("u") ? diffUnified(la.map(norm), lb.map(norm), nameA, nameB, io) : diffNormal(la.map(norm), lb.map(norm), io);
      return changed ? 1 : 0;
    },
    async cmp(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "sl", longs: { silent: "s", quiet: "s" } }); } catch (error) { gnuError(io, "cmp", error.message); return 2; }
      if (opts.operands.length < 2) { gnuError(io, "cmp", "missing operand"); return 2; }
      const [nameA, nameB] = opts.operands;
      let a, b;
      try { a = nameA === "-" ? io.stdin ?? "" : this.readFile(proc, nameA); b = nameB === "-" ? io.stdin ?? "" : this.readFile(proc, nameB); }
      catch (error) { gnuError(io, "cmp", `${error.path}: ${error.message}`); return 2; }
      const ba = encoder.encode(a), bb = encoder.encode(b);
      const n = Math.min(ba.length, bb.length);
      for (let i = 0; i < n; i++) {
        if (ba[i] !== bb[i]) { if (!opts.flags.has("s")) io.out(`${nameA} ${nameB} differ: byte ${i + 1}, line ${a.slice(0, i).split("\n").length}`); return 1; }
      }
      if (ba.length !== bb.length) { if (!opts.flags.has("s")) io.err(`cmp: EOF on ${ba.length < bb.length ? nameA : nameB} after byte ${n}`); return 1; }
      return 0;
    }
  });
  }
})(globalThis);
