/* LiaScript template linux-shell – the browser loaders of the runtimes: Pyodide for python3 (with pip from its
   package set and micropip) and JSCPP for gcc. Nothing here loads before `apt install python3` / `apt install gcc`
   (or the first use after a reload); pip packages load at `pip install` and come back at the first run after a reload. */
(function (global) {
  "use strict";

  const PYODIDE = { version: "314.0.7", url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.js" };
  const JSCPP = { version: "2.0.9", url: "https://cdn.jsdelivr.net/npm/JSCPP@2.0.9/+esm" };

  function loadScript(url) {
    return new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = url; s.async = true;
      s.onload = () => ok();
      s.onerror = () => no(new Error(`could not load ${url}`));
      document.head.appendChild(s);
    });
  }

  // bytes <-> byte strings (one char per byte), text detection – the same rules as linux-terminal.js
  const bytesToString = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return s; };
  const stringToBytes = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
  const decodeText = bytes => {
    const head = bytes.subarray(0, 8192);
    for (let i = 0; i < head.length; i++) if (head[i] === 0) return null;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  };

  // ---------------------------------------------------------------- Python: Pyodide

  const PY_HELPERS = [
    "import importlib.metadata as _lia_meta",
    "def _lia_version(n):",
    "    try:",
    "        return _lia_meta.version(n)",
    "    except Exception:",
    "        return None",
    "def _lia_requires(n):",
    "    try:",
    "        return [r.split(' ')[0].split(';')[0] for r in (_lia_meta.requires(n) or []) if ';' not in r or 'extra' not in r]",
    "    except Exception:",
    "        return []",
    "_lia_shown = []",
    ""
  ].join("\n");

  function pythonEngine(pyodide, programs) {
    const FS = pyodide.FS;
    const version = pyodide.runPython("import sys; '%d.%d.%d' % sys.version_info[:3]");
    pyodide.runPython(PY_HELPERS);
    const SKIP = ["/proc", "/dev", "/sys"];

    function bindIO(stdin, write, error) {
      const outDec = new TextDecoder(), errDec = new TextDecoder();
      pyodide.setStdout({ write: buf => { write(outDec.decode(buf, { stream: true })); return buf.length; } });
      pyodide.setStderr({ write: buf => { error(errDec.decode(buf, { stream: true })); return buf.length; } });
      pyodide.setStdin({
        stdin: () => {
          let line;
          try { line = stdin.next(); } catch { line = undefined; }
          if (line === undefined) throw new FS.ErrnoError(pyodide.ERRNO_CODES.EIO);
          return line;
        },
        isatty: !stdin.piped
      });
    }

    function rmTree(path) {
      let st; try { st = FS.stat(path); } catch { return; }
      if (FS.isDir(st.mode)) { for (const n of FS.readdir(path)) if (n !== "." && n !== "..") rmTree(path + "/" + n); FS.rmdir(path); }
      else FS.unlink(path);
    }
    function mkdirTree(path) {
      let cur = "";
      for (const p of path.split("/").filter(Boolean)) { cur += "/" + p; try { FS.mkdir(cur); } catch { /* exists */ } }
    }

    // kernel → Pyodide: the working directory with everything the user may read; returns the mirrored paths
    function mirrorIn(sys, proc, dir) {
      const mirrored = new Set();
      FS.chdir("/");   // the working directory of the last run cannot be removed while it is current (EBUSY)
      rmTree(dir); mkdirTree(dir);
      (function walk(path, depth) {
        if (depth > 6 || SKIP.some(s => path === s || path.startsWith(s + "/"))) return;
        let names; try { names = sys.readdir(proc, path); } catch { return; }
        for (const name of names) {
          const full = path.replace(/\/$/, "") + "/" + name;
          let st; try { st = sys.stat(proc, full); } catch { continue; }
          if (st.inode.type === "dir") { try { FS.mkdir(full); } catch { /* exists */ } mirrored.add(full); walk(full, depth + 1); }
          else {
            let data; try { data = sys.readFile(proc, full); } catch { continue; }
            if (typeof data !== "string" || data.length >= 4e6) continue;
            FS.writeFile(full, st.inode.binary ? stringToBytes(data) : data);
            mirrored.add(full);
          }
        }
      })(dir, 0);
      return mirrored;
    }

    // Pyodide → kernel: new and changed files are written back as the user (text or binary), mirrored files the program removed are deleted
    function mirrorOut(sys, proc, dir, io, mirrored) {
      const seen = new Set();
      (function walk(path, depth) {
        if (depth > 6) return;
        let names; try { names = FS.readdir(path); } catch { return; }
        for (const name of names) {
          if (name === "." || name === "..") continue;
          const full = path.replace(/\/$/, "") + "/" + name;
          seen.add(full);
          let st; try { st = FS.stat(full); } catch { continue; }
          if (FS.isDir(st.mode)) {
            try { sys.stat(proc, full); } catch { try { sys.mkdir(proc, full); } catch (error) { io.error(`python3: ${full}: ${error.message}\n`); continue; } }
            walk(full, depth + 1);
          } else {
            let bytes; try { bytes = FS.readFile(full); } catch { continue; }
            const text = decodeText(bytes);
            const data = text ?? bytesToString(bytes);
            let old = null, oldBinary = false;
            try { const r = sys.stat(proc, full); old = sys.readFile(proc, full); oldBinary = Boolean(r.inode.binary); } catch { /* new file */ }
            if (old !== data || oldBinary !== (text === null)) { try { sys.writeFile(proc, full, data, { binary: text === null }); } catch (error) { io.error(`python3: ${full}: ${error.message}\n`); } }
          }
        }
      })(dir, 0);
      for (const path of [...mirrored].sort((a, b) => b.length - a.length)) {
        if (seen.has(path)) continue;
        try { const st = sys.stat(proc, path); if (st.inode.type === "dir") sys.removeTree(proc, path); else sys.unlink(proc, path); } catch { /* keep it */ }
      }
    }

    // ---- packages (pip)

    function packageVersion(name) {
      try { const v = pyodide.runPython(`_lia_version(${JSON.stringify(name)})`); return v === undefined || v === null ? null : String(v); } catch { return null; }
    }
    function packageRequires(name) {
      try { const r = pyodide.runPython(`_lia_requires(${JSON.stringify(name)})`); const list = r && r.toJs ? r.toJs() : r; if (r && r.destroy) r.destroy(); return Array.isArray(list) ? list : []; } catch { return []; }
    }
    function hasPackage(name) {
      return Boolean(pyodide.loadedPackages && pyodide.loadedPackages[name]) || packageVersion(name) !== null;
    }
    async function installPackage(name, say) {
      if (hasPackage(name)) return packageVersion(name) || "?";
      let fromSet = false;
      try {
        say(`Downloading ${name} from the package set of Pyodide ${PYODIDE.version} ...`);
        await pyodide.loadPackage(name);
        fromSet = hasPackage(name);
      } catch { fromSet = false; }
      if (!fromSet) {
        say(`${name} is not in the package set – trying PyPI (pure Python packages only) ...`);
        if (!pyodide.loadedPackages || !pyodide.loadedPackages.micropip) await pyodide.loadPackage("micropip");
        await pyodide.runPythonAsync(`import micropip\nawait micropip.install(${JSON.stringify(name)})`);
        if (!hasPackage(name)) throw new Error("the package did not install");
      }
      return packageVersion(name) || "?";
    }
    // after a reload the runtime is fresh: packages of `pip install` come back before the first run
    async function ensurePackages(sys, io) {
      for (const name of [...sys.pip]) {
        if (hasPackage(name)) continue;
        io.out(`(loading ${name} again after the reload ...)`);
        try { await installPackage(name, () => {}); } catch (error) { io.err(`pip: ${name} could not be loaded: ${error.message}`); }
      }
    }

    function prelude({ argv, seed, cwd, scriptDir, matplotlib }) {
      const lines = [
        "import sys, random",
        `sys.argv = ${JSON.stringify(argv)}`,
        `random.seed(${seed})`,
        `for _m in [k for k, v in list(sys.modules.items()) if getattr(v, "__file__", None) and str(v.__file__).startswith(${JSON.stringify(cwd.replace(/\/$/, "") + "/")})]:`,
        "    del sys.modules[_m]",
        `if ${JSON.stringify(scriptDir)} not in sys.path: sys.path.insert(0, ${JSON.stringify(scriptDir)})`,
        "_lia_shown.clear()"
      ];
      if (matplotlib) lines.push(
        "try:",
        "    import matplotlib, warnings; matplotlib.use('Agg')",
        "    warnings.filterwarnings('ignore', category=matplotlib.MatplotlibDeprecationWarning)",
        "    import matplotlib.pyplot as _plt",
        "    def _lia_show(*a, **k):",
        "        _name = 'figure.png' if not _lia_shown else 'figure%d.png' % (len(_lia_shown) + 1)",
        "        _plt.savefig(_name); _lia_shown.append(_name); _plt.close('all')",
        "    _plt.show = _lia_show",
        "except Exception:",
        "    pass"
      );
      lines.push("");
      return lines.join("\n");
    }

    // the traceback without the frames of pyodide and runpy above the learner's file
    function trimTraceback(text) {
      const lines = text.replace(/\s+$/, "").split("\n");
      if (lines[0] !== "Traceback (most recent call last):") return text.endsWith("\n") ? text : text + "\n";
      const frames = [];
      let i = 1;
      while (i < lines.length && /^  File /.test(lines[i])) { const group = [lines[i++]]; while (i < lines.length && /^    /.test(lines[i])) group.push(lines[i++]); frames.push(group); }
      const rest = lines.slice(i);
      const firstOwn = frames.findIndex(g => !/File "(\/lib\/python|<exec>|<string>)/.test(g[0]) && !/_pyodide|pyodide|runpy/.test(g[0]));
      const kept = firstOwn >= 0 ? frames.slice(firstOwn) : frames.filter(g => !/_pyodide|runpy/.test(g[0]));
      return [lines[0], ...kept.flat(), ...rest].join("\n") + "\n";
    }

    function reportError(error, errorOut) {
      const text = String(error && error.message || error);
      if (error && error.type === "SystemExit") {
        const m = /SystemExit(?::[ \t]*(.*))?[ \t]*$/.exec(text.trim());
        const arg = m && m[1] !== undefined ? m[1].trim() : "";
        if (arg === "" || arg === "None") return 0;
        if (/^-?\d+$/.test(arg)) return Number(arg) & 0xff;
        errorOut(arg + "\n");
        return 1;
      }
      errorOut(trimTraceback(text));
      return 1;
    }

    async function runIn(sys, proc, io, body, argv, script) {
      await ensurePackages(sys, io);
      const cwd = proc.cwd;
      const scriptDir = script ? script.replace(/\/[^/]*$/, "") || "/" : cwd;
      const seed = Math.floor(Math.random() * 1e9);
      const matplotlib = sys.pip.has("matplotlib");
      const status = await programs.replay(io, (stdin, write) => {
        const mirrored = mirrorIn(sys, proc, cwd);
        if (script && !mirrored.has(script)) { mkdirTree(scriptDir); try { FS.writeFile(script, sys.readFile(proc, script)); } catch { /* unreadable: python reports it */ } }
        FS.chdir(cwd);
        bindIO(stdin, write, text => io.error(text));
        let result = 0;
        try { pyodide.runPython(prelude({ argv, seed, cwd, scriptDir, matplotlib }) + body); }
        catch (error) {
          if (stdin.asked) return 1;
          result = reportError(error, text => io.error(text));
        }
        if (!stdin.asked) mirrorOut(sys, proc, cwd, io, mirrored);
        return result;
      });
      // plt.show(): the saved figures open in the viewer below the terminal
      try {
        const shown = pyodide.runPython("list(_lia_shown)");
        const names = shown && shown.toJs ? shown.toJs() : shown;
        if (shown && shown.destroy) shown.destroy();
        for (const name of names || []) {
          try { const { inode } = sys.stat(proc, name); if (io.show) await io.show({ name, data: sys.readFile(proc, name), binary: Boolean(inode.binary) }); else io.notice(`(figure saved as ${name} – xdg-open ${name} shows it on the course page)`); }
          catch { /* not written */ }
        }
      } catch { /* no figures */ }
      return status;
    }

    return {
      version,
      pyodide,
      hasPackage, installPackage, packageVersion, packageRequires, ensurePackages,
      runFile(sys, proc, { path, argv, io }) {
        const script = sys.normalize(proc, path);
        return runIn(sys, proc, io, `import runpy\nrunpy.run_path(${JSON.stringify(script)}, run_name="__main__")\n`, argv, script);
      },
      runCode(sys, proc, { code, argv, io }) {
        return runIn(sys, proc, io, `exec(compile(${JSON.stringify(code)}, "<string>", "exec"), {"__name__": "__main__"})\n`, argv, null);
      },
      async repl(sys, proc, io) {
        await ensurePackages(sys, io);
        io.out(`Python ${version} (Pyodide ${PYODIDE.version}) on linux`);
        io.out('Type "help", "copyright", "credits" or "license" for more information.');
        const mirrored = mirrorIn(sys, proc, proc.cwd);
        FS.chdir(proc.cwd);
        bindIO({ next: () => null, piped: true }, text => io.write(text), text => io.error(text));
        pyodide.runPython(prelude({ argv: [""], seed: 1, cwd: proc.cwd, scriptDir: proc.cwd, matplotlib: sys.pip.has("matplotlib") }));
        const console = pyodide.runPython("import code\ncode.InteractiveConsole()");
        let more = false;
        for (;;) {
          io.write(more ? "... " : ">>> ");
          const line = await io.readLine({ prompt: "", echo: true });
          if (line === null || line === undefined) break;
          if (!more && /^\s*(exit|quit)\(\)\s*$/.test(line)) break;
          try { more = console.push(line); }
          catch (error) { if (error && error.type === "SystemExit") break; io.error(trimTraceback(String(error.message || error))); more = false; }
        }
        console.destroy();
        mirrorOut(sys, proc, proc.cwd, io, mirrored);
        return 0;
      }
    };
  }

  // ---------------------------------------------------------------- C: JSCPP

  function cEngine(JSCPPLib) {
    const silent = { write: () => {}, drain: () => "" };
    // JSCPP reports "line 5 (column 26): <context>\n------^\nExpected … but … found." – gcc style is file:line:column: message
    function compileError(error) {
      const raw = String(error && error.message || error);
      const lines = raw.split("\n").map(l => l.replace(/^ERROR:\s*/, "").trim()).filter(l => l && !/^Parsing Failure:?$/i.test(l));
      const marker = lines.findIndex(l => /^-+\^$/.test(l));
      let message = marker >= 0 ? lines.slice(marker + 1).join(" ") : lines[lines.length - 1] || raw.trim();
      message = message.replace(/^line \d+ \(column \d+\):\s*/, "").replace(/\s+/g, " ");
      if (message.length > 160) message = message.slice(0, 157) + "...";
      // the interpreter's own errors come as "3:10 missing declarator for argument"
      const own = /^(\d+):(\d+)\s+(.*)$/s.exec(message);
      if (own) message = own[3].trim();
      const e = new Error(message);
      const loc = error && error.location && error.location.start;
      if (loc) { e.line = loc.line; e.column = loc.column; }
      else if (own) { e.line = Number(own[1]); e.column = Number(own[2]); }
      else {
        const m = /line (\d+) \(column (\d+)\)/i.exec(raw) || /line (\d+)/i.exec(raw);
        if (m) { e.line = Number(m[1]); e.column = Number(m[2] || 1); }
      }
      return e;
    }
    return {
      version: JSCPP.version,
      compile(source) {
        try { JSCPPLib.run(source, "", { debug: true, stdio: silent }); }
        catch (error) { throw compileError(error); }
      },
      // The interpreter reads its whole input once, when stdio.h is loaded; scanf on an exhausted input fails with
      // "line:col Memory overflow". When that line holds a scanf and the input comes from the keyboard, the program
      // is started again with one more typed line (replay); output that was already shown is not repeated.
      run(source, { stdin, write, error }) {
        try {
          const code = JSCPPLib.run(source, "", {
            stdio: { write: s => write(String(s)), drain: () => stdin.rest() },
            maxTimeout: 10000, unsigned_overflow: "warn"
          });
          return typeof code === "number" ? code & 0xff : 0;
        } catch (e) {
          const message = String(e && e.message || e);
          const at = /^(\d+):\d+\s+Memory overflow/.exec(message);
          const reading = at && /\b(scanf|gets|fgets|getchar)\s*\(/.test(source.split("\n")[Number(at[1]) - 1] || "");
          if (reading && !stdin.piped) { stdin.asked = true; throw e; }
          if (reading) { error("scanf: no more input – the input ended (end of file)\n"); return 1; }
          error((/timeout|time limit/i.test(message) ? "Program stopped after 10 seconds: " : "") + message + "\n");
          return 1;
        }
      }
    };
  }

  // ---------------------------------------------------------------- register the loaders

  function setup(programs) {
    programs.loaders.python3 = async say => {
      say(`Get: ${PYODIDE.url} (Pyodide ${PYODIDE.version}, about 10 MB the first time)`);
      if (!global.loadPyodide) await loadScript(PYODIDE.url);
      const pyodide = await global.loadPyodide({ indexURL: PYODIDE.url.replace(/pyodide\.js$/, "") });
      return pythonEngine(pyodide, programs);
    };
    programs.loaders.gcc = async say => {
      say(`Get: ${JSCPP.url} (JSCPP ${JSCPP.version})`);
      const mod = await import(JSCPP.url);
      const lib = mod.default && typeof mod.default.run === "function" ? mod.default : mod;
      if (typeof lib.run !== "function") throw new Error("JSCPP has no run function");
      return cEngine(lib);
    };
  }

  (function wait(tries) {
    if (global.LiaLinuxPrograms) return setup(global.LiaLinuxPrograms);
    if (tries < 400) setTimeout(() => wait(tries + 1), 50);
  })(0);
})(globalThis);
