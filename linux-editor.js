/* LiaScript template linux-shell – nano, a full-screen editor inside the xterm.js terminal.
   Loaded after linux-terminal.js. The kernel's nano command hands the file over through io.editor;
   this file draws the editor, reads the keys and returns the text when the learner saves. */
(function (global) {
  "use strict";
  // the header scripts may load in any order: wait for the terminal layer instead of giving up
  let tries = 0;
  (function wait() { if (global.LiaLinux) start(); else if (++tries < 400) setTimeout(wait, 50); })();
  function start() {
  const L = global.LiaLinux;

  const VERSION = "GNU nano 7.2";
  const SHORTCUTS = [
    ["^G", "Help"], ["^O", "Write Out"], ["^W", "Where Is"], ["^K", "Cut"], ["^T", "Execute"], ["^C", "Location"],
    ["^X", "Exit"], ["^R", "Read File"], ["^\\", "Replace"], ["^U", "Paste"], ["^J", "Justify"], ["^/", "Go To Line"]
  ];
  const HELP = [
    "Main nano help text", "",
    "The nano editor is designed to emulate the functionality and ease-of-use of the UW Pico text editor.",
    "There are four main sections of the editor: the top line shows the program version, the current",
    "filename being edited, and whether or not the file has been modified. Next is the main editor window",
    "showing the file being edited. The status line is the third line from the bottom and shows important",
    "messages. The bottom two lines show the most commonly used shortcuts in the editor.", "",
    "^O  Write the current buffer to disk      ^X  Close the current buffer / exit nano",
    "^K  Cut the current line                  ^U  Paste the cut text",
    "^W  Search forward for a string           ^/  Go to line number",
    "Arrows, Home, End, PageUp, PageDown move the cursor.", "",
    "(In the simulation: a subset of nano – press any key to return.)"
  ];

  class Nano {
    constructor(view, { path, text, isNew, user }, done) {
      this.view = view; this.term = view.term; this.done = done;
      this.path = path; this.isNew = isNew; this.user = user;
      this.lines = text.replace(/\r/g, "").split("\n");
      if (this.lines.length > 1 && this.lines[this.lines.length - 1] === "") this.lines.pop();
      this.row = 0; this.col = 0; this.top = 0;
      this.modified = false; this.cutBuffer = []; this.cutRun = false;
      this.message = isNew ? "New File" : `Read ${this.lines.length} line${this.lines.length === 1 ? "" : "s"}`;
      this.prompt = null;
      this.helpOpen = false;
      this.search = "";
      this.term.write("\x1b[?1049h\x1b[H\x1b[2J");  // alternate screen
      this.draw();
    }

    get rows() { return Math.max(8, this.term.rows); }
    get cols() { return Math.max(20, this.term.cols); }
    get textRows() { return this.rows - 5; }

    draw() {
      const cols = this.cols;
      const out = ["\x1b[H"];
      // title bar
      const name = this.path ? this.path : "New Buffer";
      const title = `  ${VERSION}`;
      const mid = name.length + 2 > cols - title.length - 12 ? name : name;
      const modified = this.modified ? "Modified" : "";
      const left = title, center = mid, right = modified + " ";
      const space = Math.max(0, cols - left.length - right.length);
      const centerPos = Math.max(0, Math.floor((space - center.length) / 2));
      out.push("\x1b[7m" + (left + " ".repeat(centerPos) + center).padEnd(cols - right.length).slice(0, cols - right.length) + right + "\x1b[0m\x1b[K");
      // text area
      if (this.row < this.top) this.top = this.row;
      if (this.row >= this.top + this.textRows) this.top = this.row - this.textRows + 1;
      for (let i = 0; i < this.textRows; i++) {
        const line = this.lines[this.top + i];
        out.push("\r\n" + (line === undefined ? "" : line.slice(0, cols - 1)) + "\x1b[K");
      }
      // status line
      const status = this.prompt ? `${this.prompt.label}${this.prompt.value}` : this.message ? `[ ${this.message} ]` : "";
      const statusPos = this.prompt ? 0 : Math.max(0, Math.floor((cols - status.length) / 2));
      out.push("\r\n" + " ".repeat(statusPos) + (status ? "\x1b[7m" + status + "\x1b[0m" : "") + "\x1b[K");
      // shortcut lines
      const width = Math.max(10, Math.floor(cols / 6));
      const cell = ([k, t]) => ("\x1b[7m" + k + "\x1b[0m " + t).padEnd(width + 8).slice(0, width + 8);
      const line1 = this.prompt ? [["^C", "Cancel"]] : SHORTCUTS.filter((_, i) => i % 2 === 0);
      const line2 = this.prompt ? [] : SHORTCUTS.filter((_, i) => i % 2 === 1);
      out.push("\r\n" + line1.map(cell).join("") + "\x1b[K");
      out.push("\r\n" + line2.map(cell).join("") + "\x1b[K");
      // cursor
      if (this.prompt) out.push(`\x1b[${this.rows - 2};${Math.min(cols, this.prompt.label.length + this.prompt.value.length + 1)}H`);
      else out.push(`\x1b[${this.row - this.top + 2};${Math.min(cols, this.col + 1)}H`);
      this.term.write(out.join(""));
    }

    drawHelp() {
      const out = ["\x1b[H\x1b[2J"];
      for (const l of HELP.slice(0, this.rows - 1)) out.push(l.slice(0, this.cols - 1) + "\r\n");
      this.term.write(out.join(""));
    }

    close(result) {
      this.term.write("\x1b[?1049l");  // back to the normal screen
      this.done(result);
    }

    // one key from the terminal (already split into escape sequences)
    key(k) {
      this.cutRun = this.cutRun && k === "\x0b";
      if (this.helpOpen) { this.helpOpen = false; this.term.write("\x1b[H\x1b[2J"); this.draw(); return; }
      if (this.prompt) return this.promptKey(k);
      this.message = "";
      const line = this.lines[this.row];
      switch (k) {
        case "\x18": // ^X
          if (!this.modified) return this.close(null);
          this.prompt = { label: "Save modified buffer? ", value: "", kind: "yesno" };
          break;
        case "\x0f": // ^O
          this.prompt = { label: "File Name to Write: ", value: this.path, kind: "write" };
          break;
        case "\x17": // ^W
          this.prompt = { label: "Search: ", value: "", kind: "search" };
          break;
        case "\x1f": // ^/ (Go To Line)
          this.prompt = { label: "Enter line number, column number: ", value: "", kind: "goto" };
          break;
        case "\x07": // ^G
          this.helpOpen = true; this.drawHelp(); return;
        case "\x0b": // ^K cut line
          if (!this.cutRun) this.cutBuffer = [];
          this.cutBuffer.push(line);
          if (this.lines.length === 1) this.lines[0] = ""; else this.lines.splice(this.row, 1);
          if (this.row >= this.lines.length) this.row = this.lines.length - 1;
          this.col = 0; this.modified = true; this.cutRun = true;
          break;
        case "\x15": // ^U paste
          if (!this.cutBuffer.length) break;
          this.lines.splice(this.row, 0, ...this.cutBuffer);
          this.row += this.cutBuffer.length; this.col = 0; this.modified = true;
          break;
        case "\x03": // ^C location
          this.message = `line ${this.row + 1}/${this.lines.length} (${Math.round((this.row + 1) / this.lines.length * 100)}%), col ${this.col + 1}/${line.length + 1}`;
          break;
        case "\r": case "\n":
          this.lines.splice(this.row + 1, 0, line.slice(this.col));
          this.lines[this.row] = line.slice(0, this.col);
          this.row++; this.col = 0; this.modified = true;
          break;
        case "\x7f": case "\b":
          if (this.col > 0) { this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col); this.col--; this.modified = true; }
          else if (this.row > 0) { const prev = this.lines[this.row - 1]; this.lines.splice(this.row, 1); this.row--; this.col = prev.length; this.lines[this.row] = prev + line; this.modified = true; }
          break;
        case "\x1b[3~": // Delete
          if (this.col < line.length) { this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1); this.modified = true; }
          else if (this.row < this.lines.length - 1) { this.lines[this.row] = line + this.lines[this.row + 1]; this.lines.splice(this.row + 1, 1); this.modified = true; }
          break;
        case "\x1b[A": if (this.row > 0) { this.row--; this.col = Math.min(this.col, this.lines[this.row].length); } break;
        case "\x1b[B": if (this.row < this.lines.length - 1) { this.row++; this.col = Math.min(this.col, this.lines[this.row].length); } break;
        case "\x1b[D": if (this.col > 0) this.col--; else if (this.row > 0) { this.row--; this.col = this.lines[this.row].length; } break;
        case "\x1b[C": if (this.col < line.length) this.col++; else if (this.row < this.lines.length - 1) { this.row++; this.col = 0; } break;
        case "\x1b[H": case "\x01": this.col = 0; break;
        case "\x1b[F": case "\x05": this.col = line.length; break;
        case "\x1b[5~": this.row = Math.max(0, this.row - this.textRows); this.col = Math.min(this.col, this.lines[this.row].length); break; // PageUp
        case "\x1b[6~": this.row = Math.min(this.lines.length - 1, this.row + this.textRows); this.col = Math.min(this.col, this.lines[this.row].length); break; // PageDown
        case "\t":
          this.lines[this.row] = line.slice(0, this.col) + "    " + line.slice(this.col); this.col += 4; this.modified = true; break;
        default:
          if (k.length === 1 && k >= " ") { this.lines[this.row] = line.slice(0, this.col) + k + line.slice(this.col); this.col++; this.modified = true; }
          else if (k.length > 1 && !k.startsWith("\x1b")) { // pasted text
            const parts = k.replace(/\r\n?/g, "\n").split("\n");
            const before = line.slice(0, this.col), after = line.slice(this.col);
            this.lines.splice(this.row, 1, before + parts[0], ...parts.slice(1));
            this.row += parts.length - 1;
            this.col = this.lines[this.row].length;
            this.lines[this.row] += after;
            this.modified = true;
          }
      }
      this.draw();
    }

    promptKey(k) {
      const p = this.prompt;
      if (k === "\x03") { this.prompt = null; this.message = "Cancelled"; this.draw(); return; }
      if (p.kind === "yesno") {
        if (/^[yYjJ]$/.test(k)) { this.prompt = { label: "File Name to Write: ", value: this.path, kind: "write", exitAfter: true }; this.draw(); return; }
        if (/^[nN]$/.test(k)) return this.close(null);
        return;
      }
      if (k === "\r" || k === "\n") {
        const value = p.value;
        this.prompt = null;
        if (p.kind === "write") {
          if (!value) { this.message = "Cancelled"; this.draw(); return; }
          this.path = value;
          this.modified = false;
          const text = this.lines.join("\n") + "\n";
          this.message = `Wrote ${this.lines.length} line${this.lines.length === 1 ? "" : "s"}`;
          if (p.exitAfter) return this.close({ path: value, text });
          this.saved = { path: value, text };
          this.draw();
          return;
        }
        if (p.kind === "search") {
          if (!value) { this.message = "Cancelled"; this.draw(); return; }
          this.search = value;
          const found = this.find(value);
          if (!found) this.message = `"${value}" not found`;
          this.draw();
          return;
        }
        if (p.kind === "goto") {
          const n = parseInt(value, 10);
          if (!n) { this.message = "Invalid line number"; } else { this.row = Math.min(this.lines.length, Math.max(1, n)) - 1; this.col = 0; }
          this.draw();
          return;
        }
      }
      if (k === "\x7f" || k === "\b") { p.value = p.value.slice(0, -1); this.draw(); return; }
      if (k.length === 1 && k >= " ") { p.value += k; this.draw(); }
    }

    find(needle) {
      const total = this.lines.length;
      for (let step = 0; step < total; step++) {
        const r = (this.row + step) % total;
        const from = step === 0 ? this.col + 1 : 0;
        const i = this.lines[r].toLowerCase().indexOf(needle.toLowerCase(), from);
        if (i >= 0) { this.row = r; this.col = i; return true; }
      }
      return false;
    }
  }

  // The session asks for an editor: open nano on the terminal that has the focus (the first attached one),
  // feed it the keys until it closes, and resolve with { path, text } or null.
  L.registerEditor("nano", (session, options) => new Promise(resolve => {
    const view = [...session.terminals][0];
    if (!view) { resolve(null); return; }
    let editor;
    const done = result => {
      session.keyHandler = null;
      // the last ^O before ^X without changes still counts as a save
      resolve(result || (editor && editor.saved) || null);
    };
    editor = new Nano(view, options, done);
    session.keyHandler = key => editor.key(key);
  }));
  }
})(globalThis);
