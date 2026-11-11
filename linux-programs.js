/* LiaScript template linux-shell – programming languages as installable packages: python3 (Pyodide) with pip,
   nodejs (the JavaScript of the browser itself) and gcc (JSCPP); plus the file transfer between browser and
   simulated file system (upload, download, drag and drop) and the image viewer (xdg-open). This file holds the
   packages, the commands, the JavaScript engine and the input replay; linux-runtimes.js adds the browser-only
   loaders of Pyodide and JSCPP. Works in Node for the model tests (check.mjs replaces the loaders with stubs). */
(function (global) {
  "use strict";

  const NODE_VERSION = "v22.0.0";
  const BIN_MARK = "#!LIACBIN\n";
  const ENV_INTERPRETERS = { python3: "python3", python: "python3", node: "nodejs", nodejs: "nodejs" };

  function start(kernel, system) {
    const { parseArgs, q, joinPath, human } = kernel.helpers;

    // ---------------------------------------------------------------- runtimes: loaded on install, never before

    // name → engine; the loaders (browser: linux-dev-runtimes.js, tests: stubs) create the engines on demand
    const engines = {};
    const loaders = {};
    const loads = [];   // which runtimes were loaded, in order – the model test of acceptance point 4 reads it

    async function runtime(name, io) {
      if (engines[name]) return engines[name];
      const loader = loaders[name];
      if (!loader) { io.err(`${name}: runtime loader not available (linux-runtimes.js not loaded)`); return null; }
      const started = Date.now();
      try {
        io.out(`  Loading the ${RUNTIME_LABEL[name]} runtime ...`);
        engines[name] = await loader(line => io.out(`  ${line}`));
        loads.push(name);
        io.out(`  ${RUNTIME_LABEL[name]} runtime ready (${((Date.now() - started) / 1000).toFixed(1)} s).`);
        return engines[name];
      } catch (error) {
        io.err(`${name}: the runtime could not be loaded: ${error.message}`);
        return null;
      }
    }
    const RUNTIME_LABEL = { python3: "Python", gcc: "C", nodejs: "JavaScript" };

    // ---------------------------------------------------------------- stdin with replay

    // Programs of the synchronous engines (Python, C) cannot wait for the keyboard. When such a program asks for a
    // line nobody typed yet, the attempt is abandoned, one line is read from the terminal and the program starts
    // again with all lines so far; output that was already shown is not printed twice. A pipe (echo 5 | python3 x.py)
    // is read directly and ends with EOF.
    function makeStdin(io, answers) {
      const piped = io.stdin !== undefined;
      const lines = piped ? io.stdin.split("\n") : answers;
      if (piped && lines.length && lines[lines.length - 1] === "") lines.pop();
      const stdin = {
        index: 0, asked: false, piped, eof: false,
        // next line with its newline, null at EOF; throws when the learner has to type first
        next() {
          if (stdin.index < lines.length) return lines[stdin.index++] + "\n";
          if (piped) { stdin.eof = true; return null; }
          stdin.asked = true;
          throw new Error("linux-dev: input needed");
        },
        // everything that is left, for an engine that reads its whole input at once (the C interpreter)
        rest() {
          const text = lines.slice(stdin.index).map(l => l + "\n").join("");
          stdin.index = lines.length;
          return text;
        }
      };
      return stdin;
    }

    async function replay(io, attempt) {
      const answers = [];
      let shown = 0;
      for (let round = 0; round < 1000; round++) {
        let buffer = "";
        const stdin = makeStdin(io, answers);
        const write = text => {
          buffer += text;
          if (buffer.length > shown) { io.write(buffer.slice(shown)); shown = buffer.length; }
        };
        let status;
        try { status = await attempt(stdin, write); }
        catch (error) { if (!stdin.asked) throw error; }
        if (!stdin.asked) return status;
        const line = await io.readLine({ prompt: "", echo: true });
        answers.push(line ?? "");
      }
      io.err("linux-dev: too many inputs");
      return 1;
    }

    // ---------------------------------------------------------------- JavaScript: the browser runs it

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const PARAMS = ["require", "module", "exports", "__filename", "__dirname", "console", "process", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "global", "window", "document"];

    // line number of the first body line inside a Function built from source (V8: 3, other engines may differ)
    const LINE_OFFSET = (() => {
      try { new Function("throw new Error('probe')")(); } catch (error) { const m = /<anonymous>:(\d+):\d+/.exec(error.stack || ""); if (m) return Number(m[1]) - 1; }
      return 2;
    })();

    class ProcessExit extends Error { constructor(code) { super(`process.exit(${code})`); this.code = code; } }

    function inspect(value, depth = 0, seen = new Set()) {
      if (value === null) return "null";
      if (value === undefined) return "undefined";
      if (typeof value === "string") return depth ? `'${value.replace(/'/g, "\\'")}'` : value;
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value) + (typeof value === "bigint" ? "n" : "");
      if (typeof value === "symbol") return value.toString();
      if (typeof value === "function") return `[Function: ${value.name || "(anonymous)"}]`;
      if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
      if (value instanceof Date) return value.toISOString();
      if (value instanceof RegExp) return String(value);
      if (seen.has(value)) return "[Circular *1]";
      if (depth > 2) return Array.isArray(value) ? "[Array]" : "[Object]";
      seen.add(value);
      if (Array.isArray(value)) return value.length ? `[ ${value.map(v => inspect(v, depth + 1, seen)).join(", ")} ]` : "[]";
      if (value instanceof Map) return `Map(${value.size}) {${[...value].map(([k, v]) => ` ${inspect(k, depth + 1, seen)} => ${inspect(v, depth + 1, seen)}`).join(",")} }`;
      if (value instanceof Set) return `Set(${value.size}) {${[...value].map(v => ` ${inspect(v, depth + 1, seen)}`).join(",")} }`;
      const keys = Object.keys(value);
      if (!keys.length) return "{}";
      const body = keys.map(k => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${inspect(value[k], depth + 1, seen)}`).join(", ");
      return `{ ${body} }`;
    }

    // console.log formatting like util.format: %s %d %i %f %j %o %O %%
    function format(args) {
      if (!args.length) return "";
      let [first, ...rest] = args;
      if (typeof first === "string" && /%[sdifjoO%]/.test(first)) {
        first = first.replace(/%([sdifjoO%])/g, (m, kind) => {
          if (kind === "%") return "%";
          if (!rest.length) return m;
          const v = rest.shift();
          if (kind === "s") return typeof v === "string" ? v : inspect(v, 1);
          if (kind === "d" || kind === "i") return String(kind === "i" ? Math.trunc(Number(v)) : Number(v));
          if (kind === "f") return String(parseFloat(v));
          if (kind === "j") { try { return JSON.stringify(v); } catch { return "[Circular]"; } }
          return inspect(v, 1);
        });
      }
      return [first, ...rest].map(v => inspect(v, 0)).join(" ");
    }

    const NODE_ERRORS = { ENOENT: "no such file or directory", EACCES: "permission denied", EISDIR: "illegal operation on a directory", ENOTDIR: "not a directory", EEXIST: "file already exists", ENOTEMPTY: "directory not empty", EPERM: "operation not permitted" };
    function nodeError(error, syscall, path) {
      const code = error.code && NODE_ERRORS[error.code] ? error.code : "EIO";
      const e = new Error(`${code}: ${NODE_ERRORS[code] || error.message}, ${syscall} '${path}'`);
      e.code = code; e.syscall = syscall; e.path = String(path); e.errno = -1;
      return e;
    }

    function makeSandbox(sys, proc, io, { filename, argv }) {
      const dirname = filename.includes("/") ? filename.replace(/\/[^/]*$/, "") || "/" : proc.cwd;
      let pending = 0;          // timers and keyboard reads the program still waits for
      let exitWanted = null;    // set by process.exit or an uncaught error in a callback
      let finish = null;
      const settle = () => { if (finish && (pending === 0 || exitWanted !== null)) finish(); };
      const timers = new Set();

      const guard = fn => (...a) => {
        if (exitWanted !== null) return undefined;
        try { return fn(...a); }
        catch (error) { exitWanted = error instanceof ProcessExit ? error.code : reportUncaught(error); settle(); return undefined; }
      };

      const fsCall = (syscall, path, fn) => { try { return fn(); } catch (error) { throw nodeError(error, syscall, path); } };
      const fs = {
        readFileSync: (p, options) => fsCall("open", p, () => sys.readFile(proc, String(p))),
        writeFileSync: (p, data) => { fsCall("open", p, () => sys.writeFile(proc, String(p), String(data))); },
        appendFileSync: (p, data) => { fsCall("open", p, () => sys.writeFile(proc, String(p), String(data), { append: true })); },
        existsSync: p => { try { sys.stat(proc, String(p)); return true; } catch { return false; } },
        readdirSync: p => fsCall("scandir", p, () => sys.readdir(proc, String(p))),
        mkdirSync: (p, options) => { fsCall("mkdir", p, () => sys.mkdir(proc, String(p), { parents: Boolean(options && options.recursive) })); },
        unlinkSync: p => { fsCall("unlink", p, () => sys.unlink(proc, String(p))); },
        rmdirSync: p => { fsCall("rmdir", p, () => sys.rmdir(proc, String(p))); },
        rmSync: (p, options) => { fsCall("rm", p, () => { const { inode } = sys.stat(proc, String(p)); if (inode.type === "dir" && options && options.recursive) sys.removeTree(proc, String(p)); else if (inode.type === "dir") throw new kernel.SysError("EISDIR", p); else sys.unlink(proc, String(p)); }); },
        renameSync: (from, to) => { fsCall("rename", from, () => sys.rename(proc, String(from), String(to))); },
        copyFileSync: (from, to) => { fsCall("copyfile", from, () => sys.copy(proc, String(from), String(to))); },
        statSync: p => fsCall("stat", p, () => { const { inode } = sys.stat(proc, String(p)); return { size: inode.type === "file" ? (inode.generate ? inode.generate() : inode.data).length : 4096, mode: inode.mode, mtime: new Date(inode.mtime), uid: inode.uid, gid: inode.gid, isFile: () => inode.type === "file", isDirectory: () => inode.type === "dir", isSymbolicLink: () => inode.type === "link" }; })
      };
      const later = (fn, callback) => { pending++; queueMicrotask(() => { pending--; let result, failure = null; try { result = fn(); } catch (error) { failure = error; } guard(callback)(failure, result); settle(); }); };
      fs.readFile = (p, options, cb) => later(() => fs.readFileSync(p), typeof options === "function" ? options : cb);
      fs.writeFile = (p, data, options, cb) => later(() => fs.writeFileSync(p, data), typeof options === "function" ? options : cb);
      fs.appendFile = (p, data, options, cb) => later(() => fs.appendFileSync(p, data), typeof options === "function" ? options : cb);
      fs.readdir = (p, options, cb) => later(() => fs.readdirSync(p), typeof options === "function" ? options : cb);
      fs.mkdir = (p, options, cb) => later(() => fs.mkdirSync(p, typeof options === "object" ? options : undefined), typeof options === "function" ? options : cb);
      fs.unlink = (p, cb) => later(() => fs.unlinkSync(p), cb);
      fs.stat = (p, cb) => later(() => fs.statSync(p), cb);
      fs.promises = {
        readFile: async p => fs.readFileSync(p), writeFile: async (p, d) => fs.writeFileSync(p, d), appendFile: async (p, d) => fs.appendFileSync(p, d),
        readdir: async p => fs.readdirSync(p), mkdir: async (p, o) => fs.mkdirSync(p, o), unlink: async p => fs.unlinkSync(p), stat: async p => fs.statSync(p), rm: async (p, o) => fs.rmSync(p, o)
      };

      const path = {
        sep: "/", delimiter: ":",
        join: (...parts) => { const joined = parts.filter(Boolean).join("/"); return joined.startsWith("/") ? "/" + joined.split("/").filter(x => x && x !== ".").join("/") : joined.split("/").filter(x => x && x !== ".").join("/") || "."; },
        resolve: (...parts) => sys.normalize(proc, parts.filter(Boolean).join("/")),
        basename: (p, ext) => { let base = String(p).replace(/\/+$/, "").split("/").pop(); if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length); return base; },
        dirname: p => { const s = String(p).replace(/\/+$/, ""); return s.includes("/") ? (s.replace(/\/[^/]*$/, "") || "/") : "."; },
        extname: p => { const m = /(\.[^./]*)$/.exec(String(p).split("/").pop()); return m ? m[1] : ""; },
        isAbsolute: p => String(p).startsWith("/"),
        normalize: p => sys.normalize({ cwd: "/" }, String(p)).replace(/^\/(?!$)/, String(p).startsWith("/") ? "/" : "")
      };
      const os = {
        EOL: "\n", platform: () => "linux", type: () => "Linux", arch: () => "x64", release: () => "6.1.0-lialinux", hostname: () => sys.hostname,
        homedir: () => proc.env.HOME, tmpdir: () => "/tmp", uptime: () => Math.floor(sys.uptimeSeconds()), cpus: () => [{ model: "LiaLinux Simulated CPU", speed: 2000 }],
        totalmem: () => 2048 * 1024 * 1024, freemem: () => 1900 * 1024 * 1024,
        userInfo: () => ({ username: proc.user, uid: proc.uid, gid: proc.gid, homedir: proc.env.HOME, shell: proc.env.SHELL })
      };

      // keyboard, or the lines of a pipe (null at its end)
      const pipedLines = io.stdin !== undefined ? io.stdin.split("\n") : null;
      if (pipedLines && pipedLines.length && pipedLines[pipedLines.length - 1] === "") pipedLines.pop();
      const readLine = prompt => {
        if (prompt) io.write(String(prompt));
        if (pipedLines) return Promise.resolve(pipedLines.length ? pipedLines.shift() : null);
        pending++;
        return io.readLine({ prompt: "", echo: true }).then(line => { pending--; return line ?? ""; });
      };
      function makeInterface(promises) {
        const handlers = { line: [], close: [] };
        let reading = false;
        const rl = {
          closed: false,
          question(prompt, options, cb) {
            const callback = typeof options === "function" ? options : cb;
            const answer = readLine(prompt).then(line => { if (line === null) { rl.close(); return new Promise(() => {}); } return line; });
            if (promises) return answer;
            answer.then(line => { if (!rl.closed) guard(callback)(line); settle(); });
          },
          close() { if (rl.closed) return; rl.closed = true; for (const h of handlers.close) guard(h)(); settle(); },
          on(event, handler) { if (handlers[event]) handlers[event].push(handler); if (event === "line") startReading(); return rl; },
          once(event, handler) { return rl.on(event, handler); },
          setPrompt(p) { rl.promptText = String(p); },
          prompt() { startReading(rl.promptText); },
          promptText: "> "
        };
        rl.question = rl.question.bind(rl);
        async function startReading(prompt = "") {
          if (reading) return;
          reading = true;
          while (!rl.closed && exitWanted === null) {
            const line = await readLine(prompt);
            if (rl.closed || exitWanted !== null) break;
            if (line === null) { rl.close(); break; }
            for (const h of handlers.line) guard(h)(line);
          }
          reading = false;
          settle();
        }
        return rl;
      }
      const readline = { createInterface: () => makeInterface(false), promises: { createInterface: () => makeInterface(true) } };

      const process = {
        argv: ["/usr/bin/node", ...argv], argv0: "node", execPath: "/usr/bin/node", env: { ...proc.env }, platform: "linux", arch: "x64", pid: proc.pid, ppid: proc.ppid,
        version: NODE_VERSION, versions: { node: NODE_VERSION.slice(1), v8: "12.4.254.21-node.33" }, title: "node", exitCode: undefined,
        cwd: () => proc.cwd,
        chdir: p => { const { inode } = fsCall("chdir", p, () => sys.stat(proc, String(p))); if (inode.type !== "dir") throw nodeError(new kernel.SysError("ENOTDIR", p), "chdir", p); proc.cwd = sys.normalize(proc, String(p)); },
        exit: code => { throw new ProcessExit(code ?? process.exitCode ?? 0); },
        stdout: { write: t => { io.write(String(t)); return true; }, isTTY: io.stdin === undefined && !io.piped, columns: 80, rows: 24 },
        stderr: { write: t => { io.error(String(t)); return true; }, isTTY: io.stdin === undefined },
        stdin: { isTTY: io.stdin === undefined, on: () => process.stdin, setEncoding: () => process.stdin, resume: () => process.stdin, pause: () => process.stdin },
        on: () => process, once: () => process, off: () => process, emit: () => false,
        nextTick: (fn, ...a) => { pending++; queueMicrotask(() => { pending--; guard(fn)(...a); settle(); }); },
        hrtime: Object.assign(() => { const ms = sys.clock.now(); return [Math.floor(ms / 1000), (ms % 1000) * 1e6]; }, { bigint: () => BigInt(Math.floor(sys.clock.now() * 1e6)) }),
        uptime: () => sys.uptimeSeconds(), memoryUsage: () => ({ rss: 30 * 1024 * 1024, heapTotal: 8 * 1024 * 1024, heapUsed: 5 * 1024 * 1024, external: 1024 * 1024 }),
        kill: () => true
      };

      const consoleObject = {
        log: (...a) => io.write(format(a) + "\n"), info: (...a) => io.write(format(a) + "\n"), debug: (...a) => io.write(format(a) + "\n"),
        error: (...a) => io.error(format(a) + "\n"), warn: (...a) => io.error(format(a) + "\n"), trace: (...a) => io.error("Trace: " + format(a) + "\n"),
        dir: (v) => io.write(inspect(v, 1) + "\n"), table: (v) => io.write(inspect(v, 1) + "\n"),
        assert: (cond, ...a) => { if (!cond) io.error("Assertion failed" + (a.length ? ": " + format(a) : "") + "\n"); },
        time: () => {}, timeEnd: () => {}, group: () => {}, groupEnd: () => {}, count: () => {}
      };

      const setTimeoutS = (fn, ms, ...a) => { pending++; const id = global.setTimeout(() => { timers.delete(id); pending--; guard(fn)(...a); settle(); }, ms); timers.add(id); return id; };
      const clearTimeoutS = id => { if (timers.has(id)) { global.clearTimeout(id); timers.delete(id); pending--; settle(); } };
      const intervals = new Set();
      const setIntervalS = (fn, ms, ...a) => { pending++; const id = global.setInterval(() => guard(fn)(...a), ms); intervals.add(id); return id; };
      const clearIntervalS = id => { if (intervals.has(id)) { global.clearInterval(id); intervals.delete(id); pending--; settle(); } };
      const setImmediateS = (fn, ...a) => setTimeoutS(fn, 0, ...a);

      const modules = new Map();
      const builtins = { fs, "fs/promises": fs.promises, path, os, readline, "readline/promises": readline.promises, process, util: { format: (...a) => format(a), inspect: v => inspect(v, 1), promisify: fn => (...a) => new Promise((ok, no) => fn(...a, (e, r) => e ? no(e) : ok(r))) }, events: null, assert: null };
      function require(name) {
        const clean = String(name).replace(/^node:/, "");
        if (clean in builtins && builtins[clean]) return builtins[clean];
        if (clean === "events") return builtins.events = makeEvents();
        if (clean === "assert") return builtins.assert = makeAssert();
        if (clean.startsWith(".") || clean.startsWith("/")) return loadModule(clean);
        const e = new Error(`Cannot find module '${name}'\nRequire stack:\n- ${filename}`); e.code = "MODULE_NOT_FOUND"; throw e;
      }
      function loadModule(spec) {
        const base = sys.normalize({ cwd: dirname }, spec);
        const candidates = [base, base + ".js", base + ".json", base + "/index.js"];
        let found = null, text = null;
        for (const c of candidates) { try { const { inode } = sys.stat(proc, c); if (inode.type === "file") { text = sys.readFile(proc, c); found = c; break; } } catch { /* next */ } }
        if (found === null) { const e = new Error(`Cannot find module '${spec}'\nRequire stack:\n- ${filename}`); e.code = "MODULE_NOT_FOUND"; throw e; }
        if (modules.has(found)) return modules.get(found).exports;
        const module = { exports: {}, filename: found, loaded: false };
        modules.set(found, module);
        if (found.endsWith(".json")) { module.exports = JSON.parse(text); return module.exports; }
        const inner = makeSandbox(sys, proc, io, { filename: found, argv });
        const fn = new Function(...PARAMS, text.replace(/^#![^\n]*/, ""));
        fn.call(module.exports, inner.values(module).require, module, module.exports, found, found.replace(/\/[^/]*$/, "") || "/", consoleObject, process, setTimeoutS, clearTimeoutS, setIntervalS, clearIntervalS, setImmediateS, sandboxGlobal, undefined, undefined);
        module.loaded = true;
        return module.exports;
      }
      function makeEvents() {
        class EventEmitter { constructor() { this._h = {}; } on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; } once(e, f) { const w = (...a) => { this.off(e, w); f(...a); }; return this.on(e, w); } off(e, f) { this._h[e] = (this._h[e] || []).filter(x => x !== f); return this; } emit(e, ...a) { const hs = this._h[e] || []; for (const h of hs) h(...a); return hs.length > 0; } }
        EventEmitter.EventEmitter = EventEmitter;
        return EventEmitter;
      }
      function makeAssert() {
        const fail = (msg) => { const e = new Error(msg); e.name = "AssertionError"; e.code = "ERR_ASSERTION"; throw e; };
        const assert = (c, m) => { if (!c) fail(m || "The expression evaluated to a falsy value"); };
        assert.ok = assert; assert.equal = (a, b, m) => { if (a != b) fail(m || `${inspect(a, 1)} == ${inspect(b, 1)}`); }; assert.strictEqual = (a, b, m) => { if (a !== b) fail(m || `Expected values to be strictly equal:\n\n${inspect(a, 1)} !== ${inspect(b, 1)}\n`); };
        assert.deepStrictEqual = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(m || `Expected values to be strictly deep-equal:\n${inspect(a, 1)}\n\nshould equal\n\n${inspect(b, 1)}`); };
        assert.throws = (fn, m) => { try { fn(); } catch { return; } fail(m || "Missing expected exception."); };
        return assert;
      }

      const sandboxGlobal = { console: consoleObject, process, setTimeout: setTimeoutS, clearTimeout: clearTimeoutS, setInterval: setIntervalS, clearInterval: clearIntervalS, setImmediate: setImmediateS, require, Buffer: undefined };
      sandboxGlobal.global = sandboxGlobal;

      function sourceLine(n) { try { return sys.readFile(proc, filename).split("\n")[n - 1] ?? ""; } catch { return ""; } }
      function reportUncaught(error) {
        if (error instanceof ProcessExit) return error.code;
        const stack = String(error && error.stack || "");
        const m = /<anonymous>:(\d+):(\d+)/.exec(stack);
        const line = m ? Number(m[1]) - LINE_OFFSET : null;
        const col = m ? Number(m[2]) : 0;
        let text = "";
        if (line && line > 0) text += `${filename}:${line}\n${sourceLine(line)}\n${" ".repeat(Math.max(0, col - 1))}^\n\n`;
        else text += `${filename}\n\n`;
        const head = error instanceof Error ? `${error.name}: ${error.message}` : `Uncaught ${inspect(error, 1)}`;
        text += head + (line ? `\n    at ${filename}:${line}:${col}` : "") + `\n\nNode.js ${NODE_VERSION}\n`;
        io.error(text);
        return 1;
      }

      const values = module => ({ require, module, exports: module.exports });
      return {
        values,
        async execute(code, { expression = false } = {}) {
          const module = { exports: {}, filename, loaded: false };
          let fn;
          try { fn = new AsyncFunction(...PARAMS, expression ? `return eval(${JSON.stringify(code)})` : code); }
          catch (error) { io.error(`${filename}\n\n${error.name}: ${error.message}\n\nNode.js ${NODE_VERSION}\n`); return 1; }
          let status = 0;
          const done = new Promise(resolve => { finish = resolve; });
          try {
            const result = await fn.call(module.exports, require, module, module.exports, filename, dirname, consoleObject, process, setTimeoutS, clearTimeoutS, setIntervalS, clearIntervalS, setImmediateS, sandboxGlobal, undefined, undefined);
            if (expression && result !== undefined) io.write(inspect(await result, 1) + "\n");
          } catch (error) { exitWanted = error instanceof ProcessExit ? error.code : reportUncaught(error); }
          settle();
          if (exitWanted === null && pending > 0) await done;
          for (const id of timers) global.clearTimeout(id);
          for (const id of intervals) global.clearInterval(id);
          status = exitWanted !== null ? exitWanted : (process.exitCode ?? 0);
          return Number(status) & 0xff;
        }
      };
    }

    const nodeEngine = {
      version: NODE_VERSION,
      async runFile(sys, proc, { path, source, argv, io }) {
        const filename = sys.normalize(proc, path);
        return makeSandbox(sys, proc, io, { filename, argv: [filename, ...argv.slice(1)] }).execute(source.replace(/^#![^\n]*/, ""));
      },
      async runCode(sys, proc, { code, argv, io, print = false }) {
        return makeSandbox(sys, proc, io, { filename: "[eval]", argv: ["[eval]", ...argv] }).execute(code, { expression: print });
      },
      async repl(sys, proc, io) {
        io.out(`Welcome to Node.js ${NODE_VERSION}.`);
        io.out('Type ".help" for more information.');
        const scope = {};
        for (;;) {
          io.write("> ");
          const line = await io.readLine({ prompt: "", echo: true });
          if (line === null || line === undefined) break;
          const text = line.trim();
          if (!text) continue;
          if (text === ".exit") break;
          if (text === ".help") { io.out(".exit     Exit the REPL\n.help     Print this help message\n\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL"); continue; }
          // declarations live in the scope object so they survive the next line
          const code = text.replace(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, "scope.$1 =");
          const sandbox = makeSandbox(sys, proc, io, { filename: "REPL", argv: [] });
          const wrapped = `with (scope) { return eval(${JSON.stringify(code)}) }`;
          try {
            const fn = new Function("scope", ...PARAMS, wrapped);
            const module = { exports: {} };
            const result = await fn(scope, sandbox.values(module).require, module, module.exports, "REPL", proc.cwd, { log: (...a) => io.write(format(a) + "\n"), error: (...a) => io.error(format(a) + "\n"), warn: (...a) => io.error(format(a) + "\n"), info: (...a) => io.write(format(a) + "\n") }, { argv: ["node"], env: { ...proc.env }, exit: () => { throw new ProcessExit(0); } }, global.setTimeout, global.clearTimeout, global.setInterval, global.clearInterval, fn => global.setTimeout(fn, 0), scope, undefined, undefined);
            io.out(inspect(result, 1));
          } catch (error) {
            if (error instanceof ProcessExit) break;
            io.err(`Uncaught ${error && error.name ? error.name + ": " + error.message : String(error)}`);
          }
        }
        return 0;
      }
    };
    engines.nodejs = nodeEngine;

    // ---------------------------------------------------------------- the commands

    async function python3(proc, args, io) {
      if (args[0] === "-V" || args[0] === "--version") { const e = await runtime("python3", io); if (!e) return 1; io.out(`Python ${e.version}`); return 0; }
      if (args[0] === "-h" || args[0] === "--help") { io.out("usage: python3 [option] ... [-c cmd | file | -] [arg] ...\nOptions:\n-c cmd : program passed in as string\n-V     : print the Python version number and exit\nfile   : program read from script file\n-      : interactive mode"); return 0; }
      if (args[0] && args[0].startsWith("-") && args[0] !== "-c" && args[0] !== "-" && !(args[0] === "-m" && args[1] === "pip")) { io.err(`Unknown option: ${args[0]}\nusage: python3 [option] ... [-c cmd | file | -] [arg] ...\nTry \`python -h' for more information.`); return 2; }
      const engine = await runtime("python3", io);
      if (!engine) return 1;
      if (args[0] === "-m" && args[1] === "pip") return pip.call(this, proc, args.slice(2), io);
      if (args[0] === "-c") {
        if (args[1] === undefined) { io.err("Argument expected for the -c option\nusage: python3 [option] ... [-c cmd | file | -] [arg] ..."); return 2; }
        return engine.runCode(this, proc, { code: args[1], argv: ["-c", ...args.slice(2)], io });
      }
      if (!args.length || args[0] === "-") return engine.repl(this, proc, io);
      const path = args[0];
      let source;
      try { source = this.readFile(proc, path); }
      catch (error) {
        if (error.code === "EISDIR") io.err(`python3: can't open file ${q(this.normalize(proc, path))}: [Errno 21] Is a directory`);
        else if (error.code === "EACCES") io.err(`python3: can't open file ${q(this.normalize(proc, path))}: [Errno 13] Permission denied`);
        else io.err(`python3: can't open file ${q(this.normalize(proc, path))}: [Errno 2] No such file or directory`);
        return 2;
      }
      proc.cmd = "python3"; proc.args = ["python3", ...args];
      return engine.runFile(this, proc, { path, source, argv: [path, ...args.slice(1)], io });
    }

    async function node(proc, args, io) {
      if (args[0] === "-v" || args[0] === "--version") { io.out(NODE_VERSION); return 0; }
      if (args[0] === "-h" || args[0] === "--help") { io.out("Usage: node [options] [ script.js ] [arguments]\n       node -e \"script\"\n       node -p \"expression\"\n\nOptions:\n  -e, --eval script    evaluate script\n  -p, --print script   evaluate script and print result\n  -v, --version        print Node.js version"); return 0; }
      if (args[0] === "-e" || args[0] === "--eval" || args[0] === "-p" || args[0] === "--print") {
        if (args[1] === undefined) { io.err(`node: ${args[0]} requires an argument`); return 9; }
        return nodeEngine.runCode(this, proc, { code: args[1], argv: args.slice(2), io, print: args[0] === "-p" || args[0] === "--print" });
      }
      if (args[0] && args[0].startsWith("-")) { io.err(`node: bad option: ${args[0]}`); return 9; }
      if (!args.length) return nodeEngine.repl(this, proc, io);
      const path = args[0];
      let source;
      try { source = this.readFile(proc, path); }
      catch (error) {
        const abs = this.normalize(proc, path);
        if (error.code === "EACCES") io.err(`node:internal/modules/cjs/loader\n\nError: EACCES: permission denied, open '${abs}'\n\nNode.js ${NODE_VERSION}`);
        else io.err(`node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module '${abs}'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n    at node:internal/main/run_main_module:28:49 {\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js ${NODE_VERSION}`);
        return 1;
      }
      proc.cmd = "node"; proc.args = ["node", ...args];
      return nodeEngine.runFile(this, proc, { path, source, argv: [path, ...args.slice(1)], io });
    }

    const C_HEADERS = { "stdio.h": "cstdio", "stdlib.h": "cstdlib", "string.h": "cstring", "math.h": "cmath", "ctype.h": "cctype", "time.h": "ctime" };
    function translateC(source) {
      // JSCPP speaks C++: the C headers get their C++ names, headers it does not know are dropped, f(void) becomes f()
      return source.replace(/^[ \t]*#include[ \t]*<([^>]+)>[ \t]*$/gm, (line, header) => {
        if (C_HEADERS[header]) return `#include <${C_HEADERS[header]}>`;
        if (["cstdio", "cstdlib", "cstring", "cmath", "cctype", "ctime", "iostream"].includes(header)) return line;
        return "";
      }).replace(/\(\s*void\s*\)/g, "()").replace(/\bstruct\s+(\w+)\b(?!\s*\{)/g, (m, name) => structNames(source).has(name) ? name : m)
        // two quirks of the interpreter: puts adds no newline, and a space between a comma and %s is swallowed
        .replace(/\bputs\s*\(/g, 'printf("%s\\n", ').replace(/, %/g, ",\\x20%");
    }
    // C says "struct P p", C++ (and JSCPP) "P p" – for the structs the file defines
    function structNames(source) {
      const names = new Set();
      for (const m of source.matchAll(/\bstruct\s+(\w+)\s*\{/g)) names.add(m[1]);
      return names;
    }

    async function gcc(proc, args, io) {
      let output = null;
      const inputs = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-o") { output = args[++i]; if (output === undefined) { io.err("gcc: error: missing filename after '-o'"); return 1; } }
        else if (a === "-c" || a === "-S" || a === "-E") { io.err(`gcc: error: option '${a}' is not supported by the simulation (it compiles one file into a program)`); return 1; }
        else if (a.startsWith("-")) { /* -Wall -Wextra -O2 -std=c11 -g -lm -pedantic: accepted and ignored */ }
        else inputs.push(a);
      }
      if (!inputs.length) { io.err("gcc: fatal error: no input files\ncompilation terminated."); return 1; }
      if (inputs.length > 1) { io.err("gcc: error: the simulation compiles one source file at a time"); return 1; }
      const src = inputs[0];
      let source;
      try { source = this.readFile(proc, src); }
      catch (error) {
        io.err(`gcc: error: ${src}: ${error.code === "EACCES" ? "Permission denied" : "No such file or directory"}\ngcc: fatal error: no input files\ncompilation terminated.`);
        return 1;
      }
      if (!/\.(c|cc|cpp|cxx|C)$/.test(src)) { io.err(`gcc: error: ${src}: file not recognized: file format not recognized\ncollect2: error: ld returned 1 exit status`); return 1; }
      const engine = await runtime("gcc", io);
      if (!engine) return 1;
      try { engine.compile(translateC(source), src); }
      catch (error) {
        const where = error.line ? `${src}:${error.line}:${error.column || 1}: error: ` : `${src}: error: `;
        io.err(`${where}${error.message}\ncompilation terminated.`);
        return 1;
      }
      const target = output || "a.out";
      try {
        const existing = this.resolve(proc, target);
        if (existing.inode && existing.inode.type === "dir") { io.err(`/usr/bin/ld: cannot open output file ${target}: Is a directory\ncollect2: error: ld returned 1 exit status`); return 1; }
        const inode = this.writeFile(proc, target, BIN_MARK + JSON.stringify({ name: src, source }), { mode: 0o777 & ~proc.umask });
        inode.mode = (inode.mode | 0o111) & ~proc.umask;
      } catch (error) { io.err(`/usr/bin/ld: cannot open output file ${target}: ${error.message}\ncollect2: error: ld returned 1 exit status`); return 1; }
      return 0;
    }

    // ---------------------------------------------------------------- pip: packages of the Python runtime

    async function pip(proc, args, io) {
      const words = args.filter(a => !a.startsWith("-"));
      const action = words[0];
      const names = words.slice(1).map(n => n.toLowerCase().replace(/[=<>!~].*$/, ""));
      if (!action || action === "help" || args.includes("-h") || args.includes("--help")) {
        io.out("Usage:\n  pip <command> [options]\n\nCommands:\n  install    Install packages (from the package set of the Python runtime; pure Python packages also from PyPI).\n  uninstall  Forget packages (a loaded package stays in memory until the page is reloaded).\n  list       List installed packages.\n  show       Show information about one package.\n  freeze     Output installed packages in requirements format.");
        return action ? 0 : 1;
      }
      if (!this.installed.has("python3")) { io.err("Command 'pip' needs python3: sudo apt install python3"); return 127; }
      const engine = await runtime("python3", io);
      if (!engine) return 1;
      // after a reload the packages of earlier installs come back on demand
      if (engine.ensurePackages && ["list", "show", "freeze"].includes(action)) await engine.ensurePackages(this, io);
      switch (action) {
        case "install": {
          if (!names.length) { io.err("ERROR: You must give at least one requirement to install (see \"pip help install\")"); return 1; }
          let status = 0;
          for (const name of names) {
            if (this.pip.has(name) && engine.hasPackage(name)) { io.out(`Requirement already satisfied: ${name}`); continue; }
            io.out(`Collecting ${name}`);
            try {
              const version = await engine.installPackage(name, line => io.out(`  ${line}`));
              this.pip.add(name);
              io.out(`Successfully installed ${name}-${version}`);
            } catch (error) {
              io.err(`ERROR: Could not find a version that satisfies the requirement ${name} (${error.message})\nERROR: No matching distribution found for ${name}`);
              status = 1;
            }
          }
          return status;
        }
        case "uninstall": {
          if (!names.length) { io.err("ERROR: You must give at least one requirement to uninstall (see \"pip help uninstall\")"); return 1; }
          for (const name of names) {
            if (!this.pip.has(name)) { io.err(`WARNING: Skipping ${name} as it is not installed.`); continue; }
            this.pip.delete(name);
            io.out(`Successfully uninstalled ${name}`);
          }
          return 0;
        }
        case "list": case "freeze": {
          const rows = [...this.pip].sort().map(name => [name, engine.packageVersion(name) || "?"]);
          if (action === "freeze") { for (const [n, v] of rows) io.out(`${n}==${v}`); return 0; }
          io.out("Package".padEnd(18) + "Version"); io.out("-".repeat(17) + " " + "-".repeat(10));
          for (const [n, v] of rows) io.out(`${n.padEnd(18)}${v}`);
          return 0;
        }
        case "show": {
          if (!names.length) { io.err("ERROR: Please provide a package name or names."); return 1; }
          let status = 0;
          for (const name of names) {
            if (!this.pip.has(name)) { io.err(`WARNING: Package(s) not found: ${name}`); status = 1; continue; }
            io.out(`Name: ${name}\nVersion: ${engine.packageVersion(name) || "?"}\nLocation: /usr/lib/python3/site-packages (Pyodide)\nRequires: ${engine.packageRequires(name).join(", ")}`);
          }
          return status;
        }
        default:
          io.err(`ERROR: unknown command "${action}"`);
          return 1;
      }
    }

    // ---------------------------------------------------------------- files between browser and simulation

    async function upload(proc, args, io) {
      const target = args[0] || ".";
      try { const { inode } = this.stat(proc, target); if (inode.type !== "dir") { io.err(`upload: ${target}: Not a directory`); return 1; } }
      catch (error) { io.err(`upload: ${target}: ${error.message}`); return 1; }
      if (!io.upload) { io.err("upload: no browser file dialog here (works in the terminal of the course page)"); return 1; }
      io.out(`Choose files in the browser dialog – they land in ${this.normalize(proc, target)}`);
      const lines = await io.upload(this.normalize(proc, target));
      if (lines === null) { io.err("upload: no browser file dialog here"); return 1; }
      if (!lines.length) { io.out("upload: cancelled, nothing uploaded"); return 1; }
      for (const line of lines) io.out(line);
      return lines.some(l => /: /.test(l) && !/ -> /.test(l)) ? 1 : 0;
    }

    async function download(proc, args, io) {
      if (!args.length) { io.err("usage: download FILE... (sends the files to the browser's download folder)"); return 1; }
      const files = [];
      let status = 0;
      for (const path of args) {
        try {
          const { inode } = this.stat(proc, path);
          if (inode.type === "dir") { io.err(`download: ${path}: Is a directory – pack it first: zip -r ${path.replace(/\/$/, "")}.zip ${path}`); status = 1; continue; }
          const data = this.readFile(proc, path);
          files.push({ name: path.replace(/\/$/, "").split("/").pop(), data, binary: Boolean(inode.binary) });
        } catch (error) { io.err(`download: ${path}: ${error.message}`); status = 1; }
      }
      if (!files.length) return status;
      if (!io.download) { io.err("download: no browser here (works in the terminal of the course page)"); return 1; }
      await io.download(files);
      for (const f of files) io.out(`${f.name}: ${f.data.length} bytes sent to the browser's downloads`);
      return status;
    }

    async function xdgOpen(proc, args, io) {
      if (!args.length) { io.err("xdg-open: file or URL expected"); return 1; }
      let status = 0;
      for (const path of args) {
        try {
          const { inode } = this.stat(proc, path);
          if (inode.type === "dir") { io.err(`xdg-open: ${path}: is a directory (no file manager in the simulation – try ls)`); status = 2; continue; }
          const data = this.readFile(proc, path);
          const name = path.split("/").pop();
          if (!/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name) && !/^(\x89PNG|\xff\xd8\xff|GIF8|RIFF)/.test(data)) { io.err(`xdg-open: ${path}: only images open here (png, jpg, gif, webp, svg)`); status = 2; continue; }
          if (!io.show) { io.notice(`(no display here – ${path} would open in the image viewer of the course page)`); continue; }
          await io.show({ name, data, binary: Boolean(inode.binary) || !name.endsWith(".svg") });
        } catch (error) { io.err(`xdg-open: ${path}: ${error.message}`); status = 2; }
      }
      return status;
    }

    system.registerPackage("python3", { version: "3.14.0-1", description: "interactive high-level object-oriented language (Python 3, Pyodide runtime) with pip", size: 24, commands: ["python3", "python", "pip", "pip3"], install: (sys, io) => runtime("python3", io) });
    system.registerPackage("nodejs", { version: "22.0.0-1", description: "evented I/O for V8 javascript (runs on the JavaScript of the browser)", size: 2040, commands: ["node", "nodejs"] });
    system.registerPackage("gcc", { version: "12.2.0-14", description: "GNU C compiler (JSCPP interpreter runtime)", size: 51, commands: ["gcc", "cc"], install: (sys, io) => runtime("gcc", io) });

    kernel.registerCommands({ python3, python: python3, node, nodejs: node, gcc, cc: gcc, pip, pip3: pip, upload, download, "xdg-open": xdgOpen, display: xdgOpen, eog: xdgOpen });

    // ---------------------------------------------------------------- executable formats: ./programm

    // a program compiled by gcc: the stored source runs in the C engine
    kernel.registerExecFormat({
      test: source => source.startsWith(BIN_MARK),
      run: async (sys, proc, { path, source, args, io }) => {
        let program;
        try { program = JSON.parse(source.slice(BIN_MARK.length)); } catch { io.err(`bash: ${path}: cannot execute binary file: Exec format error`); return 126; }
        const engine = await runtime("gcc", io);
        if (!engine) return 126;
        proc.cmd = path.split("/").pop(); proc.args = [path, ...args];
        return replay(io, (stdin, write) => engine.run(translateC(program.source), { stdin, write, error: text => io.error(text), argv: [path, ...args] }));
      }
    });

    // a script whose first line names python3 or node, directly or through /usr/bin/env
    const shebang = source => {
      const m = /^#!\s*(\S+)(?:[ \t]+(\S+))?/.exec(source);
      if (!m) return null;
      const first = m[1].split("/").pop();
      const name = first === "env" ? m[2] : first;
      return name && ENV_INTERPRETERS[name] ? { name, viaEnv: first === "env", path: m[1] } : null;
    };
    kernel.registerExecFormat({
      test: source => shebang(source) !== null,
      run: async (sys, proc, { path, args, source, io }) => {
        const interpreter = shebang(source);
        if (!sys.installed.has(ENV_INTERPRETERS[interpreter.name])) {
          if (interpreter.viaEnv) io.err(`/usr/bin/env: '${interpreter.name}': No such file or directory`);
          else io.err(`bash: ${path}: ${interpreter.path}: bad interpreter: No such file or directory`);
          return interpreter.viaEnv ? 127 : 126;
        }
        return sys.execute(proc.parentProc || sys.shell, [interpreter.name, path, ...args], io, { asProcess: proc });
      }
    });

    // ---------------------------------------------------------------- manual pages

    const MAN_EN = {
      python3: { name: "an interpreted, interactive, object-oriented programming language", synopsis: "python3 [-c command | -m pip … | script | -] [arguments]", description: "python3 script.py runs a program; print() writes to the terminal, input() reads a line from it.\n-c 'code' runs the code given on the command line; without arguments python3 opens the interactive prompt >>> (exit() leaves it).\nThe package has to be installed first: sudo apt install python3 – it loads the Python runtime into the browser once. Further packages: pip install numpy matplotlib." },
      pip: { name: "install Python packages", synopsis: "pip install PACKAGE… | list | show PACKAGE | uninstall PACKAGE | freeze", description: "Loads packages from the package set of the Python runtime (built for the browser: numpy, matplotlib, pandas, scipy, sympy, …) and pure Python packages from PyPI – only when you ask, with progress in the terminal. Installed packages stay known after a reload and come back with the first import.\nDiagrams: plt.savefig(\"plot.png\") writes the picture into the file system, xdg-open plot.png shows it; plt.show() does both." },
      upload: { name: "bring files from your computer into the simulation", synopsis: "upload [DIRECTORY]", description: "Opens the file dialog of the browser; the chosen files land in DIRECTORY (default: the current one) and belong to you. Files can also be dropped on the terminal. Limit: 2 MB per file." },
      download: { name: "send files to your computer", synopsis: "download FILE…", description: "The browser downloads each file unchanged; reading needs the r permission. A directory is packed first: zip -r name.zip directory, then download name.zip." },
      "xdg-open": { name: "open a file with the matching program", synopsis: "xdg-open FILE", description: "In the simulation this shows an image (png, jpg, gif, webp, svg) in a viewer below the terminal – e.g. a diagram saved by matplotlib. display and eog do the same." },
      node: { name: "server-side JavaScript runtime", synopsis: "node [script.js | -e code | -p expression] [arguments]", description: "node app.js runs a JavaScript file; console.log() writes to the terminal, require('fs') reads and writes files, require('readline') asks for input.\n-e runs code, -p prints the result of an expression, without arguments node opens the prompt > (.exit leaves it).\nInstall with sudo apt install nodejs. Runs on the JavaScript of the browser: an endless loop freezes the page." },
      gcc: { name: "GNU project C compiler", synopsis: "gcc [-Wall] [-o output] source.c", description: "Compiles one C file into a program (a.out without -o) and sets the x permission. Start it with ./output.\nErrors are reported with file name and line number. Supported: stdio.h (printf, scanf, puts, getchar), stdlib.h, string.h, math.h, ctype.h, functions, arrays, pointers, char strings, switch, loops. Not supported: struct, typedef, malloc, goto, several source files, linking libraries, files.\nInstall with sudo apt install gcc." }
    };
    const MAN_DE = {
      python3: { name: "interpretierte, interaktive, objektorientierte Programmiersprache", synopsis: "python3 [-c befehl | -m pip … | skript | -] [argumente]", description: "python3 skript.py führt ein Programm aus; print() schreibt ins Terminal, input() liest eine Zeile daraus.\n-c 'code' führt den Code der Kommandozeile aus; ohne Argumente öffnet python3 die Eingabeaufforderung >>> (exit() verlässt sie).\nDas Paket muss installiert sein: sudo apt install python3 – das lädt die Python-Laufzeit einmal in den Browser. Weitere Pakete: pip install numpy matplotlib." },
      pip: { name: "Python-Pakete installieren", synopsis: "pip install PAKET… | list | show PAKET | uninstall PAKET | freeze", description: "Lädt Pakete aus dem Vorrat der Python-Laufzeit (für den Browser gebaut: numpy, matplotlib, pandas, scipy, sympy, …) und reine Python-Pakete von PyPI – erst auf Anforderung, mit Fortschritt im Terminal. Installierte Pakete bleiben nach einem Neuladen bekannt und kommen beim ersten import zurück.\nDiagramme: plt.savefig(\"plot.png\") schreibt das Bild ins Dateisystem, xdg-open plot.png zeigt es; plt.show() macht beides." },
      upload: { name: "Dateien vom eigenen Rechner in die Simulation holen", synopsis: "upload [VERZEICHNIS]", description: "Öffnet den Dateidialog des Browsers; die gewählten Dateien landen in VERZEICHNIS (ohne Angabe: im aktuellen) und gehören dir. Dateien lassen sich auch auf das Terminal ziehen. Grenze: 2 MB je Datei." },
      download: { name: "Dateien auf den eigenen Rechner schicken", synopsis: "download DATEI…", description: "Der Browser lädt jede Datei unverändert herunter; Lesen braucht das Recht r. Ein Verzeichnis vorher packen: zip -r name.zip verzeichnis, dann download name.zip." },
      "xdg-open": { name: "eine Datei mit dem passenden Programm öffnen", synopsis: "xdg-open DATEI", description: "In der Simulation zeigt das ein Bild (png, jpg, gif, webp, svg) in einer Vorschau unter dem Terminal – etwa ein von matplotlib gespeichertes Diagramm. display und eog tun dasselbe." },
      node: { name: "JavaScript-Laufzeit für die Kommandozeile", synopsis: "node [skript.js | -e code | -p ausdruck] [argumente]", description: "node app.js führt eine JavaScript-Datei aus; console.log() schreibt ins Terminal, require('fs') liest und schreibt Dateien, require('readline') fragt nach Eingaben.\n-e führt Code aus, -p gibt das Ergebnis eines Ausdrucks aus, ohne Argumente öffnet node die Eingabeaufforderung > (.exit verlässt sie).\nInstallation: sudo apt install nodejs. Läuft auf dem JavaScript des Browsers: eine Endlosschleife friert die Seite ein." },
      gcc: { name: "C-Compiler des GNU-Projekts", synopsis: "gcc [-Wall] [-o ausgabe] quelle.c", description: "Übersetzt eine C-Datei in ein Programm (a.out ohne -o) und setzt das Recht x. Start mit ./ausgabe.\nFehler werden mit Dateiname und Zeilennummer gemeldet. Unterstützt: stdio.h (printf, scanf, puts, getchar), stdlib.h, string.h, math.h, ctype.h, Funktionen, Felder, Zeiger, char-Zeichenketten, switch, Schleifen. Nicht unterstützt: struct, typedef, malloc, goto, mehrere Quelldateien, Bibliotheken linken, Dateien.\nInstallation: sudo apt install gcc." }
    };
    try {
      Object.assign(kernel.MAN, MAN_EN, { python: MAN_EN.python3, nodejs: MAN_EN.node, cc: MAN_EN.gcc, pip3: MAN_EN.pip, display: MAN_EN["xdg-open"], eog: MAN_EN["xdg-open"] });
      if (kernel.languages.de) Object.assign(kernel.languages.de.man, MAN_DE, { python: MAN_DE.python3, nodejs: MAN_DE.node, cc: MAN_DE.gcc, pip3: MAN_DE.pip, display: MAN_DE["xdg-open"], eog: MAN_DE["xdg-open"] });
    } catch { /* a frozen table only loses the manual pages */ }

    global.LiaLinuxPrograms = Object.freeze({ loaders, engines, loads, replay, makeStdin, inspect, format, translateC, BIN_MARK, NODE_VERSION, runtime });
    if (global.document) global.document.dispatchEvent(new CustomEvent("lia-linux-programs-ready"));
  }

  // a second run (the preview reloads the course in place) keeps the loaded runtimes
  if (global.LiaLinuxPrograms) return;
  // the header scripts may load in any order: wait for the kernel and the package index
  (function wait(tries) {
    if (global.LiaLinuxKernel && global.LiaLinuxSystem) return start(global.LiaLinuxKernel, global.LiaLinuxSystem);
    if (tries < 400) setTimeout(() => wait(tries + 1), 50);
    else console.error("linux-programs: linux-kernel.js and linux-system.js were not loaded");
  })(0);
})(globalThis);
