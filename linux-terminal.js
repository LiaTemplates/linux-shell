/* LiaScript template linux-shell – browser layer: sessions that live once per course,
   xterm.js terminals that attach to them on every page, and the macro API (window.LiaLinux).
   Needs linux-kernel.js and, for terminals, @xterm/xterm (window.Terminal) plus the fit addon. */
(function (global) {
  "use strict";
  if (global.LiaLinux) return;

  const kernel = () => global.LiaLinuxKernel;
  const STORAGE_PREFIX = "LiaLinux:";
  const LOG_LIMIT = 60000;
  const sessions = new Map();
  const editors = {};   // name → (session, options) => Promise<{path, text} | null>  (linux-editor.js)

  const hash = text => { let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(36); };
  const courseKey = () => { try { return global.location.href.replace(/#.*$/, ""); } catch { return "course"; } };
  const storage = () => { try { return global.localStorage; } catch { return null; } };

  // LANG values for the language codes of the packs; any other code becomes "<code>.UTF-8"
  const LANG_VALUES = { en: "en_US.UTF-8", de: "de_DE.UTF-8", fr: "fr_FR.UTF-8", es: "es_ES.UTF-8", it: "it_IT.UTF-8", nl: "nl_NL.UTF-8", pt: "pt_BR.UTF-8", pl: "pl_PL.UTF-8", tr: "tr_TR.UTF-8", uk: "uk_UA.UTF-8" };

  class Session {
    constructor(name, language) {
      this.name = name;
      this.terminals = new Set();
      this.log = "";
      this.busy = false;
      this.pendingRead = null;
      this.line = "";
      this.cursor = 0;
      this.historyIndex = -1;
      this.historyDraft = "";
      this.setups = [];
      this.setupKeys = new Set();
      this.persistent = true;
      this.queue = Promise.resolve();
      this.daemons = [];
      const saved = this.load();
      if (saved) {
        this.sys = kernel().restoreSystem(saved.state);
        this.setups = saved.setups || [];
        this.setupKeys = new Set(this.setups.map(hash));
        this.daemons = saved.daemons || [];
        this.log = saved.log || "";
        if (this.log && !this.log.endsWith("\n")) this.write("\n");
        this.write(this.text("restored") + "\n");
        // background processes of the setups come back, like services after a reboot
        for (const d of this.daemons) this.runAsRoot(`${d.user === "root" ? "" : `sudo -u ${d.user} `}${d.command} &`, false);
      } else {
        this.sys = kernel().createSystem();
        this.fresh = true;
        if (language) this.setLanguage(language);
        this.write(this.text("welcome") + "\n");
      }
      this.io = {
        color: true,
        write: text => this.write(text),
        clear: () => { this.log = ""; for (const t of this.terminals) t.term.clear(); },
        readLine: ({ prompt = "", echo = true } = {}) => new Promise(resolve => {
          this.write(prompt);
          this.pendingRead = { resolve, echo, buffer: "" };
        }),
        // a full-screen editor (nano) registered by linux-editor.js; it takes the keys while it is open
        editor: options => {
          const open = editors.nano;
          if (!open || !this.terminals.size) return Promise.resolve(null);
          return open(this, options);
        },
        // the browser side of xdg-open, upload and download (linux-programs.js calls them through io)
        show: image => this.showImage(image),
        upload: target => this.uploadFiles(target),
        download: files => this.downloadFiles(files)
      };
      this.watchers = new Set();
      this.showPrompt();
    }

    // ---- files between the browser and the simulated file system

    // Writes dropped or chosen browser files into `dir` as the shell's user; returns one line per file.
    async placeFiles(files, dir) {
      const sys = this.sys, proc = sys.shell;
      const lines = [];
      for (const file of files) {
        const name = file.name.replace(/[\/\\]/g, "_");
        if (file.size > UPLOAD_LIMIT) { lines.push(`${name}: too large (${human(file.size)}, limit ${human(UPLOAD_LIMIT)})`); continue; }
        let bytes;
        try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (error) { lines.push(`${name}: ${error.message}`); continue; }
        const text = decodeText(bytes);
        const path = (dir || proc.cwd).replace(/\/$/, "") + "/" + name;
        try {
          sys.writeFile(proc, path, text ?? bytesToString(bytes), { binary: text === null });
          lines.push(`${name} (${human(file.size)}) -> ${path}`);
        } catch (error) { lines.push(`${name}: ${error.message}`); }
      }
      this.save();
      this.notify();
      return lines;
    }

    // Files dropped on a terminal of this session: placed into the current directory, reported at the prompt.
    async dropFiles(files) {
      const lines = await this.placeFiles(files, null);
      const text = lines.map(l => `(upload) ${l}`).join("\n") + "\n";
      if (this.busy || this.pendingRead) { this.write("\n" + text); return; }
      this.write("\n" + text);
      this.showPrompt();
    }

    // `upload [dir]`: the browser's file dialog; resolves to the report lines (empty when cancelled)
    uploadFiles(dir) {
      if (!global.document || !this.terminals.size) return Promise.resolve(null);
      return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file"; input.multiple = true; input.style.display = "none";
        let settled = false;
        const finish = async files => { if (settled) return; settled = true; input.remove(); resolve(files && files.length ? await this.placeFiles([...files], dir) : []); };
        input.addEventListener("change", () => finish(input.files));
        input.addEventListener("cancel", () => finish(null));
        // browsers without the cancel event: a focus that comes back without a change means cancelled
        global.addEventListener("focus", () => setTimeout(() => finish(input.files), 400), { once: true });
        document.body.appendChild(input);
        input.click();
      });
    }

    // `download file …`: one browser download per file ({ name, data, binary })
    downloadFiles(files) {
      if (!global.document) return Promise.resolve(false);
      for (const file of files) {
        const bytes = file.binary ? stringToBytes(file.data) : new TextEncoder().encode(file.data);
        const url = URL.createObjectURL(new Blob([bytes], { type: file.binary ? mimeOf(file.name) : "text/plain;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url; a.download = file.name; a.style.display = "none";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      return Promise.resolve(true);
    }

    // `xdg-open bild.png`: an image viewer below every terminal of this session
    showImage(image) {
      if (!global.document || !this.terminals.size) return Promise.resolve(false);
      const src = dataUrl(image);
      for (const t of this.terminals) {
        let viewer = t.element.nextElementSibling;
        if (!viewer || !viewer.classList.contains("lia-linux-viewer")) {
          viewer = document.createElement("figure");
          viewer.className = "lia-linux-viewer";
          viewer.innerHTML = '<img alt=""><figcaption><span class="lia-linux-viewer-name"></span> <button type="button" class="lia-linux-button lia-linux-viewer-close">✕</button></figcaption>';
          viewer.querySelector(".lia-linux-viewer-close").setAttribute("aria-label", this.ui("close"));
          viewer.querySelector(".lia-linux-viewer-close").onclick = () => viewer.remove();
          t.element.insertAdjacentElement("afterend", viewer);
        }
        const img = viewer.querySelector("img");
        img.src = src; img.alt = image.name;
        viewer.querySelector(".lia-linux-viewer-name").textContent = image.name;
      }
      return Promise.resolve(true);
    }

    // @Linux.image: the file as a data URL (null when missing or unreadable), and a watcher for changes
    fileData(path) {
      try {
        const { inode } = this.sys.stat(this.sys.shell, path);
        if (inode.type !== "file") return null;
        const data = inode.generate ? inode.generate() : inode.data;
        return { name: path.split("/").pop(), src: dataUrl({ name: path, data, binary: Boolean(inode.binary) }), size: data.length, mtime: inode.mtime };
      } catch { return null; }
    }
    watchFile(path, callback) {
      const watcher = { path, callback, last: null };
      this.watchers.add(watcher);
      this.notify();
      return () => this.watchers.delete(watcher);
    }
    notify() {
      for (const w of [...this.watchers]) {
        const data = this.fileData(w.path);
        const stamp = data ? `${data.size}:${data.mtime}` : "missing";
        if (stamp === w.last) continue;
        w.last = stamp;
        try { w.callback(data); } catch { /* a broken watcher does not stop the shell */ }
      }
    }

    storageKey() { return `${STORAGE_PREFIX}${courseKey()}:${this.name}`; }

    // Texts of the terminal itself (welcome, restored, reset) in the language of the session's shell.
    text(key) {
      const K = kernel();
      const code = K.langOf(this.sys.shell.env.LANG);
      return (K.languages[code] && K.languages[code].terminal[key]) || K.languages.en.terminal[key] || "";
    }

    // Labels of the course macros (buttons, feedback) in the language of the session's shell.
    ui(key) {
      const K = kernel();
      const code = K.langOf(this.sys.shell.env.LANG);
      return (K.languages[code] && K.languages[code].ui[key]) || K.languages.en.ui[key] || "";
    }

    // Sets LANG of the login shell, e.g. "de" → de_DE.UTF-8; a code without a pack still sets LANG (messages stay English).
    setLanguage(code) {
      const clean = String(code || "").trim().toLowerCase();
      if (!clean) return;
      const value = LANG_VALUES[clean] || `${clean}.UTF-8`;
      for (const p of [this.sys.loginShell, this.sys.shell]) p.env.LANG = value;
      this.language = clean;
    }

    load() {
      const store = storage();
      if (!store) return null;
      try {
        const raw = store.getItem(this.storageKey());
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data && data.state ? data : null;
      } catch { return null; }
    }

    save() {
      const store = storage();
      if (!store || !this.persistent) return;
      try {
        store.setItem(this.storageKey(), JSON.stringify({ version: 1, state: this.sys.serialize(), setups: this.setups, daemons: this.daemons, log: this.log.slice(-LOG_LIMIT / 2) }));
      } catch { /* quota or private mode: the session simply does not survive a reload */ }
    }

    forget() {
      const store = storage();
      try { store && store.removeItem(this.storageKey()); } catch { /* ignore */ }
    }

    // ---- output

    write(text) {
      this.log += text;
      if (this.log.length > LOG_LIMIT) this.log = this.log.slice(this.log.indexOf("\n", this.log.length - LOG_LIMIT) + 1);
      const data = text.replace(/\r?\n/g, "\r\n");
      for (const t of this.terminals) t.term.write(data);
    }

    showPrompt() {
      this.promptText = this.sys.prompt();
      this.write(this.promptText);
      this.line = ""; this.cursor = 0; this.historyIndex = -1;
      for (const t of this.terminals) { t.drawnLength = this.promptText.length; t.drawnCursor = 0; }
      if (this.typeahead) { const pending = this.typeahead; this.typeahead = ""; setTimeout(() => this.handleData(pending), 0); }
    }

    redrawLine() {
      // Redraw prompt + line in every terminal; a line longer than the terminal is wide wraps,
      // so the cursor first goes back to the row where the prompt starts.
      for (const t of this.terminals) {
        const cols = Math.max(2, t.term.cols || 80);
        // row of a text position; a cursor at the very end of a full row stays on that row (pending wrap)
        const rowOf = (pos, atEnd) => Math.floor((atEnd && pos > 0 && pos % cols === 0 ? pos - 1 : pos) / cols);
        const drawn = t.drawnLength ?? this.promptText.length;
        const current = this.promptText.length + (t.drawnCursor ?? 0);
        const currentRow = rowOf(current, current === drawn);
        let seq = "\r";
        if (currentRow > 0) seq += `\x1b[${currentRow}A`;
        const total = this.promptText.length + this.line.length;
        seq += "\x1b[J" + this.promptText + this.line;
        const target = this.promptText.length + this.cursor;
        const endRow = rowOf(total, true), targetRow = rowOf(target, target === total);
        if (endRow > targetRow) seq += `\x1b[${endRow - targetRow}A`;
        if (target !== total) seq += `\x1b[${(target % cols) + 1}G`;
        t.term.write(seq);
        t.drawnLength = total;
        t.drawnCursor = this.cursor;
      }
    }

    // ---- terminals

    attach(view) {
      this.terminals.add(view);
      view.term.write(this.log.replace(/\r?\n/g, "\r\n"));
    }
    detach(view) { this.terminals.delete(view); }

    // ---- input from a terminal

    handleData(data) {
      if (this.keyHandler) { for (const key of splitKeys(data)) this.keyHandler(key); return; }
      if (this.pendingRead) return this.handleReadLine(data);
      if (this.busy) {
        if (data === "\x03") this.sys.interrupt();
        else if (data === "\x1a") this.sys.suspend();
        // typed ahead while a command runs: handed to the next prompt, like a real terminal
        else if (!data.startsWith("\x1b")) this.typeahead = (this.typeahead || "") + data;
        return;
      }
      for (const key of splitKeys(data)) {
        // a pasted chunk goes through character by character; a newline in it submits the line
        if (key.length > 1 && !key.startsWith("\x1b")) { for (const c of key.replace(/\r\n?/g, "\n")) this.handleData(c === "\n" ? "\r" : c); continue; }
        this.handleKey(key);
      }
    }

    handleReadLine(data) {
      const read = this.pendingRead;
      // a pasted chunk is handled character by character, so a newline in it ends the line
      const keys = splitKeys(data).flatMap(key => key.length > 1 && !key.startsWith("\x1b") ? [...key.replace(/\r\n?/g, "\n")].map(c => c === "\n" ? "\r" : c) : [key]);
      for (const key of keys) {
        if (!this.pendingRead) { this.handleData(key); continue; }
        if (key === "\r" || key === "\n") {
          this.pendingRead = null;
          this.write("\n");
          read.resolve(read.buffer);
          return;
        }
        if (key === "\x7f" || key === "\b") { if (read.buffer) { read.buffer = read.buffer.slice(0, -1); if (read.echo) this.write("\b \b"); } continue; }
        if (key === "\x03") { this.pendingRead = null; this.write("^C\n"); read.resolve(""); this.sys.interrupt(); return; }
        if (key.length === 1 && key >= " ") { read.buffer += key; if (read.echo) this.write(key); }
      }
    }

    handleKey(key) {
      const history = this.sys.history;
      switch (key) {
        case "\r": case "\n":
          // the terminals already show the typed line; the log needs it for replay on another page
          this.log += this.line;
          this.write("\n");
          this.submit(this.line);
          return;
        case "\x7f": case "\b":
          if (this.cursor > 0) { this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor); this.cursor--; this.redrawLine(); }
          return;
        case "\x1b[3~": // Delete
          if (this.cursor < this.line.length) { this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1); this.redrawLine(); }
          return;
        case "\x1b[D": if (this.cursor > 0) { this.cursor--; this.redrawLine(); } return;
        case "\x1b[C": if (this.cursor < this.line.length) { this.cursor++; this.redrawLine(); } return;
        case "\x1b[H": case "\x01": this.cursor = 0; this.redrawLine(); return;
        case "\x1b[F": case "\x05": this.cursor = this.line.length; this.redrawLine(); return;
        case "\x1b[A":
          if (!history.length) return;
          if (this.historyIndex === -1) { this.historyDraft = this.line; this.historyIndex = history.length; }
          if (this.historyIndex > 0) { this.historyIndex--; this.line = history[this.historyIndex]; this.cursor = this.line.length; this.redrawLine(); }
          return;
        case "\x1b[B":
          if (this.historyIndex === -1) return;
          this.historyIndex++;
          if (this.historyIndex >= history.length) { this.historyIndex = -1; this.line = this.historyDraft; }
          else this.line = history[this.historyIndex];
          this.cursor = this.line.length; this.redrawLine();
          return;
        case "\x15": this.line = this.line.slice(this.cursor); this.cursor = 0; this.redrawLine(); return; // Ctrl+U
        case "\x0b": this.line = this.line.slice(0, this.cursor); this.redrawLine(); return; // Ctrl+K
        case "\x17": { // Ctrl+W
          const before = this.line.slice(0, this.cursor).replace(/\S+\s*$/, "");
          this.line = before + this.line.slice(this.cursor); this.cursor = before.length; this.redrawLine(); return;
        }
        case "\x0c": this.io.clear(); this.write(this.promptText + this.line); return; // Ctrl+L
        case "\x03": this.write("^C\n"); this.showPrompt(); return;
        case "\x04": if (!this.line) { this.write("\n"); this.submit("exit"); } return;
        case "\t": this.complete(); return;
        default:
          if (key.length === 1 && key >= " ") {
            this.line = this.line.slice(0, this.cursor) + key + this.line.slice(this.cursor);
            this.cursor++;
            this.redrawLine();
          }
      }
    }

    complete() {
      const before = this.line.slice(0, this.cursor);
      const m = /(\S*)$/.exec(before);
      const word = m[1];
      const isCommand = !before.slice(0, before.length - word.length).trim();
      let candidates = [];
      if (isCommand && !word.includes("/")) {
        candidates = [...kernel().commands, ...kernel().builtins].filter(n => n.startsWith(word) && /^[a-z]/.test(n));
      } else {
        const slash = word.lastIndexOf("/");
        const dir = slash >= 0 ? word.slice(0, slash + 1) : "";
        const partial = word.slice(slash + 1);
        let names = [];
        try { names = this.sys.readdir(this.sys.shell, dir || "."); } catch { names = []; }
        candidates = names.filter(n => n.startsWith(partial) && (partial.startsWith(".") || !n.startsWith(".")))
          .map(n => { let full = dir + n; try { if (this.sys.stat(this.sys.shell, (dir || "") + n).inode.type === "dir") full += "/"; } catch { /* keep */ } return full; });
      }
      if (!candidates.length) return;
      if (candidates.length === 1) {
        const insert = candidates[0] + (candidates[0].endsWith("/") ? "" : " ");
        this.line = before.slice(0, before.length - word.length) + insert + this.line.slice(this.cursor);
        this.cursor = before.length - word.length + insert.length;
        this.redrawLine();
        return;
      }
      let common = candidates[0];
      for (const c of candidates) while (!c.startsWith(common)) common = common.slice(0, -1);
      if (common.length > word.length) {
        this.line = before.slice(0, before.length - word.length) + common + this.line.slice(this.cursor);
        this.cursor = before.length - word.length + common.length;
        this.redrawLine();
      } else {
        this.write("\n" + candidates.map(c => c.replace(/^.*\/(?=.)/, "")).join("  ") + "\n" + this.promptText + this.line);
        if (this.line.length - this.cursor) for (const t of this.terminals) t.term.write(`\x1b[${this.line.length - this.cursor}D`);
      }
    }

    // ---- running commands

    submit(line) {
      if (this.busy) return Promise.resolve(null);
      this.busy = true;
      this.fresh = false;
      const done = this.sys.run(line, this.io).then(status => {
        this.busy = false;
        this.pendingRead = null;
        this.save();
        this.showPrompt();
        this.notify();
        return status;
      });
      this.queue = done.catch(() => {});
      return done;
    }

    // Typed by a macro, not by the learner: echo each line at the prompt, then run it.
    async runLines(text) {
      const lines = text.split("\n").map(l => l.replace(/\r$/, "")).filter(l => l.trim() && !l.trim().startsWith("#"));
      let output = "";
      for (const line of lines) {
        while (this.busy || this.pendingRead) await new Promise(r => setTimeout(r, 50));
        this.line = ""; this.cursor = 0;
        this.write(line + "\n");
        const start = this.log.length;
        await this.submit(line);
        output += this.log.slice(start, this.log.length - this.promptText.length);
      }
      return output;
    }

    // Runs a shell test (e.g. "test -x script.sh") silently; true when its status is 0.
    async check(condition) {
      const result = await kernel().runCollect(this.sys, condition);
      this.sys.history.pop();
      return { ok: result.status === 0, output: (result.stdout + result.stderr).trim(), status: result.status };
    }

    // Setup commands run once per session, as root, without echo in the terminal.
    async setup(text) {
      const key = hash(text);
      this.lastSetup = text;
      if (this.setupKeys.has(key)) return { ran: false, errors: "" };
      const errors = await this.runAsRoot(text);
      this.lastSetupErrors = errors;
      // a setup with errors is not recorded: the author fixes it and the next render runs it again
      if (!errors) { this.setups.push(text); this.setupKeys.add(key); }
      this.save();
      this.notify();
      if (!this.busy && !this.pendingRead) { this.write("\n"); this.showPrompt(); }
      return { ran: true, errors };
    }

    async runAsRoot(text, remember = true) {
      const sys = this.sys;
      let errors = "";
      const root = sys.spawn(sys.init, { cmd: "bash", args: ["bash", "setup"], user: "root", cwd: "/" });
      await sys.runSource(root, text, { write: () => {}, error: t => { errors += t; }, color: false, clear: () => {}, readLine: () => Promise.resolve(""), out: () => {}, err: t => { errors += t + "\n"; } });
      for (const job of root.jobs) {
        const p = sys.procs.get(job.pid);
        if (!p) continue;
        p.parentProc = sys.init; p.ppid = 1; sys.init.children.push(p);
        // "sudo -u anna sleep 3600 &" runs as anna: remember the inner command with its user
        if (remember && p.exitCode === null) {
          const m = /^sudo\s+-u\s+(\S+)\s+(.*)$/.exec(job.command);
          this.daemons.push(m ? { user: m[1], command: m[2] } : { user: "root", command: job.command });
        }
      }
      root.jobs = [];
      sys.exit(root, 0); sys.reap(root);
      return errors;
    }

    writeFile(path, content) {
      try {
        const normalized = content.endsWith("\n") ? content : content + "\n";
        this.sys.writeFile(this.sys.shell, path, normalized);
        this.save();
        this.notify();
        return { ok: true, message: `${path} ${this.ui("written")} (${normalized.length} ${this.ui("bytes")}, ${this.ui("owner")} ${this.sys.shell.user})` };
      } catch (error) {
        return { ok: false, message: `${path}: ${error.message}` };
      }
    }

    async reset() {
      this.forget();
      for (const p of [...this.sys.procs.values()]) if (p.wake) p.wake("exit");
      this.sys = kernel().createSystem();
      this.setupKeys = new Set();
      this.daemons = [];
      const setups = this.setups; this.setups = [];
      this.busy = false; this.pendingRead = null;
      if (this.language) this.setLanguage(this.language);
      this.io.clear();
      this.write(this.text("reset") + "\n");
      for (const text of setups) await this.setup(text);
      if (!setups.length) this.showPrompt();
      this.notify();
    }
  }

  // ---- bytes, text and images between the browser and the simulated file system

  const UPLOAD_LIMIT = 2 * 1024 * 1024;
  const human = n => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  // a byte string keeps one char per byte, so the kernel can store any file as a string
  const bytesToString = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return s; };
  const stringToBytes = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
  // text when it is valid UTF-8 without NUL bytes; otherwise null (binary)
  const decodeText = bytes => {
    const head = bytes.subarray(0, 8192);
    for (let i = 0; i < head.length; i++) if (head[i] === 0) return null;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  };
  const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", txt: "text/plain", csv: "text/csv", json: "application/json", html: "text/html", md: "text/markdown" };
  const mimeOf = name => MIME[String(name).split(".").pop().toLowerCase()] || "application/octet-stream";
  const dataUrl = ({ name, data, binary }) => {
    const bytes = binary ? stringToBytes(data) : new TextEncoder().encode(data);
    return `data:${mimeOf(name)};base64,${btoa(bytesToString(bytes))}`;
  };

  // Splits an input chunk into keys: escape sequences stay together.
  function splitKeys(data) {
    const keys = [];
    // a paste (several printable characters at once, possibly with newlines) arrives as one key
    if (data.length > 1 && !data.includes("\x1b") && /^[^\x00-\x08\x0b-\x1f\x7f]*$/.test(data.replace(/\r|\n|\t/g, ""))) return [data];
    let i = 0;
    while (i < data.length) {
      if (data[i] === "\x1b") {
        const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(data.slice(i));
        if (m) { keys.push(m[0]); i += m[0].length; continue; }
      }
      keys.push(data[i]); i++;
    }
    return keys;
  }

  // ---- terminal views (one per macro call, attached to a session)

  class TerminalView {
    constructor(element, session, rows) {
      const TerminalClass = typeof global.Terminal === "function" ? global.Terminal : global.Terminal?.Terminal;
      if (!TerminalClass) throw new Error("xterm.js ist nicht geladen (window.Terminal fehlt).");
      this.element = element;
      this.session = session;
      const dark = global.matchMedia?.("(prefers-color-scheme: dark)")?.matches || document.documentElement.classList.contains("lia-dark") || document.body.classList.contains("dark");
      this.term = new TerminalClass({
        rows: Number(rows) > 0 ? Number(rows) : 16,
        cursorBlink: true,
        convertEol: false,
        scrollback: 2000,
        fontSize: 14,
        fontFamily: "ui-monospace, 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
        theme: dark ? { background: "#1e1e1e", foreground: "#e6e6e6", cursor: "#e6e6e6" } : { background: "#2b2b2b", foreground: "#f0f0f0", cursor: "#f0f0f0" }
      });
      this.term.open(element);
      const FitAddonClass = global.FitAddon?.FitAddon;
      if (FitAddonClass) {
        try { this.fit = new FitAddonClass(); this.term.loadAddon(this.fit); } catch { this.fit = null; }
      }
      // The page may still be laying out the slide: fit now, again shortly after, and whenever the box resizes.
      const refit = () => {
        if (!this.fit) return;
        try { if (element.getBoundingClientRect().width > 50) this.fit.fit(); } catch { /* ignore */ }
      };
      refit();
      setTimeout(refit, 100); setTimeout(refit, 500); setTimeout(refit, 1500);
      if (global.ResizeObserver) { this.resizeObserver = new ResizeObserver(refit); this.resizeObserver.observe(element); }
      this.term.onData(data => session.handleData(data));
      // keep the keyboard inside the terminal: LiaScript ignores arrow keys while a textarea has the focus
      this.term.attachCustomKeyEventHandler(event => { event.stopPropagation(); return true; });
      // files dropped on the terminal land in the current directory of the session
      element.addEventListener("dragover", event => { if (event.dataTransfer && [...event.dataTransfer.types].includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; element.classList.add("lia-linux-dropping"); } });
      element.addEventListener("dragleave", () => element.classList.remove("lia-linux-dropping"));
      element.addEventListener("drop", event => {
        element.classList.remove("lia-linux-dropping");
        const files = event.dataTransfer ? [...event.dataTransfer.files] : [];
        if (!files.length) return;
        event.preventDefault(); event.stopPropagation();
        session.dropFiles(files);
      });
      session.attach(this);
      this.observer = new MutationObserver(() => { if (!document.body.contains(element)) this.dispose(); });
      this.observer.observe(document.body, { childList: true, subtree: true });
      this.resize = refit;
      global.addEventListener("resize", this.resize);
      element.dataset.liaLinuxMounted = "true";
    }
    dispose() {
      this.session.detach(this);
      this.observer.disconnect();
      if (this.resizeObserver) this.resizeObserver.disconnect();
      global.removeEventListener("resize", this.resize);
      try { this.term.dispose(); } catch { /* ignore */ }
    }
  }

  const views = new Map();

  function session(name = "default", language = "") {
    name = String(name || "default").trim() || "default";
    if (!sessions.has(name)) sessions.set(name, new Session(name, language));
    else if (language && sessions.get(name).fresh && !sessions.get(name).language) sessions.get(name).setLanguage(language);
    return sessions.get(name);
  }

  function mount(elementId, sessionName, rows, language) {
    const element = document.getElementById(elementId);
    if (!element) throw new Error(`Element ${elementId} not found`);
    if (views.has(element) && document.body.contains(element) && element.dataset.liaLinuxMounted) return views.get(element);
    const s = session(sessionName, language);
    element.setAttribute("aria-label", s.ui("terminal"));
    const view = new TerminalView(element, s, rows);
    views.set(element, view);
    return view;
  }

  // Waits until the kernel and xterm.js are loaded (header scripts run in order, but LiaScript may render first).
  function ready(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function tick() {
        if (global.LiaLinuxKernel && (typeof global.Terminal === "function" || global.Terminal?.Terminal)) return resolve(global.LiaLinux);
        if (Date.now() - started > timeoutMs) return reject(new Error("The terminal library (xterm.js) or the kernel was not loaded."));
        setTimeout(tick, 50);
      })();
    });
  }

  const unfence = value => {
    let text = String(value ?? "");
    while (/^\s*```/.test(text) && /```\s*$/.test(text)) text = text.replace(/^\s*```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
    return text;
  };

  // A macro parameter that was not given may arrive empty or as the literal placeholder (@1).
  const arg = value => { const text = unfence(String(value ?? "")).trim(); return /^@'?\d+$/.test(text) ? "" : text; };

  // In the fence line of a code block the block is the macro's last parameter. With one optional
  // parameter before it (the session), `first` is the session and `second` the block – otherwise the
  // block is `first`. `edited` is the editor's text when LiaScript substituted @input, else the placeholder.
  function blockArgs(first, second, edited) {
    const hasSecond = arg(second) !== "";
    const session = hasSecond ? arg(first) : "";
    let content = hasSecond ? String(second) : String(first);
    if (edited !== undefined && !/^@'?input$/.test(String(edited).trim())) content = String(edited);
    // a macro mentioned in running text arrives without a block: nothing to run
    if (arg(content) === "") content = "";
    return [session, unfence(content)];
  }

  global.LiaLinux = Object.freeze({
    session, mount, ready, unfence, arg, blockArgs, sessions,
    registerEditor: (name, open) => { editors[name] = open; },
    setup: (name, text) => session(name).setup(unfence(text)),
    run: (name, text) => session(name).runLines(unfence(text)),
    check: (name, condition) => session(name).check(condition),
    writeFile: (name, path, content) => session(name).writeFile(path, unfence(content)),
    reset: name => session(name).reset(),
    image: (name, path) => session(name).fileData(path),
    watch: (name, path, callback) => session(name).watchFile(path, callback),
    ui: (name, key) => session(name).ui(key),
    bytesToString, stringToBytes, decodeText, mimeOf, dataUrl,
    hash
  });
  if (global.document) global.document.dispatchEvent(new CustomEvent("lia-linux-ready"));
})(globalThis);
