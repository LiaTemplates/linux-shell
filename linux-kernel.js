/* LiaScript template linux-shell – simulated Linux kernel and shell.
   Plain JavaScript, no build step. Loads in the browser (window.LiaLinuxKernel)
   and in Node (globalThis.LiaLinuxKernel, see check.mjs). No DOM in this file. */
(function (global) {
  "use strict";
  if (global.LiaLinuxKernel) return;

  // ---------------------------------------------------------------- errors

  const MESSAGES = Object.freeze({
    ENOENT: "No such file or directory",
    EACCES: "Permission denied",
    ENOTDIR: "Not a directory",
    EISDIR: "Is a directory",
    EEXIST: "File exists",
    ENOTEMPTY: "Directory not empty",
    EPERM: "Operation not permitted",
    EINVAL: "Invalid argument",
    ESRCH: "No such process",
    ELOOP: "Too many levels of symbolic links"
  });

  class SysError extends Error {
    constructor(code, path) {
      super(MESSAGES[code] || code);
      this.code = code;
      this.path = path;
    }
  }

  // ---------------------------------------------------------------- languages

  // English is built in; other languages register a pack: { name, messages: [[pattern, replacement], …],
  // man: { command: { name, synopsis, description } }, terminal: { welcome, restored, reset },
  // ui: { terminal, check, met, notMet, reset, missing, bytes, setupRan, setupSkipped, setupErrors, session, noOutput, close, written, owner } }.
  // The language of a shell follows its LANG variable, like on a real system; `ui` holds the labels of
  // the course macros (buttons, feedback) in that language.
  const LANGUAGES = {};

  function registerLanguage(code, pack) {
    LANGUAGES[code] = { name: pack.name || code, messages: pack.messages || [], man: pack.man || {}, terminal: pack.terminal || {}, ui: pack.ui || {} };
  }

  function langOf(value) {
    const m = /^([a-z]{2,3})(?:[_-]|\.|$)/i.exec(String(value || "").trim());
    const code = m ? m[1].toLowerCase() : "en";
    return LANGUAGES[code] ? code : "en";
  }

  function localize(text, code) {
    const pack = LANGUAGES[code];
    if (!pack || code === "en") return text;
    for (const [pattern, replacement] of pack.messages) text = text.replace(pattern, replacement);
    return text;
  }

  const SIGNALS = Object.freeze({
    HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, TERM: 15, CONT: 18, STOP: 19, TSTP: 20
  });
  const SIGNAL_NAMES = Object.fromEntries(Object.entries(SIGNALS).map(([name, num]) => [num, name]));

  // ---------------------------------------------------------------- clock

  function realClock() {
    return {
      now: () => Date.now(),
      // minutes to add to UTC for the local time shown by ls, date and ps
      offset: () => -new Date().getTimezoneOffset(),
      schedule(ms, fn) {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      }
    };
  }

  // A clock for tests: time moves only with advance(ms).
  function fakeClock(start = Date.UTC(2026, 10, 10, 18, 13, 0)) {
    let time = start;
    let timers = [];
    const clock = {
      now: () => time,
      offset: () => 0,
      schedule(ms, fn) {
        // a zero delay fires on its own, like a real timer; everything else waits for advance()
        if (ms <= 0) { const id = setTimeout(fn, 0); return () => clearTimeout(id); }
        const timer = { at: time + ms, fn };
        timers.push(timer);
        return () => { timers = timers.filter(t => t !== timer); };
      },
      async advance(ms) {
        const target = time + ms;
        for (;;) {
          const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
          if (!due) break;
          timers = timers.filter(t => t !== due);
          time = due.at;
          due.fn();
          // let the whole promise chain behind the timer settle before the next one fires
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        time = target;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    };
    return clock;
  }

  // ---------------------------------------------------------------- helpers

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n, w = 2) => String(n).padStart(w, "0");

  // Local time of the system's clock, read with UTC getters (the clock says how far it is from UTC).
  let clockOffset = () => 0;
  const local = ms => new Date(ms + clockOffset() * 60000);

  function fmtDate(ms, now) {
    const d = local(ms);
    const mon = MONTHS[d.getUTCMonth()], day = String(d.getUTCDate()).padStart(2, " ");
    const sameYear = local(now).getUTCFullYear() === d.getUTCFullYear();
    return sameYear ? `${mon} ${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : `${mon} ${day}  ${d.getUTCFullYear()}`;
  }

  function fmtClock(ms) {
    const d = local(ms);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  function modeString(inode) {
    const m = inode.mode;
    const type = inode.type === "dir" ? "d" : inode.type === "link" ? "l" : "-";
    const bits = (shift, special, specialChar) => {
      const r = m & (4 << shift) ? "r" : "-";
      const w = m & (2 << shift) ? "w" : "-";
      let x = m & (1 << shift) ? "x" : "-";
      if (m & special) x = x === "x" ? specialChar.toLowerCase() : specialChar.toUpperCase();
      return r + w + x;
    };
    return type + bits(6, 0o4000, "s") + bits(3, 0o2000, "s") + bits(0, 0o1000, "t");
  }

  function parseArgs(args, spec = {}) {
    // spec: { flags: "la1", values: "n" } – short flags, flags with a value (-n 3 or -n3)
    const flags = new Set(), values = {}, operands = [];
    const takesValue = new Set(spec.values || "");
    const known = new Set((spec.flags || "") + (spec.values || ""));
    const longs = spec.longs || {};
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { operands.push(...args.slice(i + 1)); break; }
      if (a.startsWith("--") && a.length > 2) {
        const [name, value] = a.slice(2).split("=");
        if (!(name in longs)) throw new Error(`unrecognized option '--${name}'`);
        const short = longs[name];
        if (takesValue.has(short)) values[short] = value ?? args[++i];
        else flags.add(short);
        continue;
      }
      if (a.startsWith("-") && a.length > 1 && !/^-\d+$/.test(a)) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (!known.has(c)) throw new Error(`invalid option -- '${c}'`);
          if (takesValue.has(c)) {
            values[c] = j + 1 < a.length ? a.slice(j + 1) : args[++i];
            break;
          }
          flags.add(c);
        }
        continue;
      }
      if (/^-\d+$/.test(a) && spec.numeric) { values[spec.numeric] = a.slice(1); continue; }
      operands.push(a);
    }
    return { flags, values, operands };
  }

  // Basic regular expressions (grep, sed without -E): \( \) \{ \} \+ \? \| are the operators,
  // the bare characters are literal – the opposite of JavaScript. Character classes stay as they are.
  function breToJs(pattern) {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "\\" && i + 1 < pattern.length) {
        const n = pattern[i + 1];
        if ("(){}+?|".includes(n)) { out += n; i++; continue; }
        out += c + n; i++; continue;
      }
      if (c === "[") { const end = pattern.indexOf("]", i + 2); if (end > 0) { out += pattern.slice(i, end + 1); i = end; continue; } }
      if ("(){}+?|".includes(c)) { out += "\\" + c; continue; }
      out += c;
    }
    return out;
  }

  function globToRegExp(pattern) {
    let re = "^";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "\\" && i + 1 < pattern.length) { re += "\\" + pattern[++i]; continue; }
      if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else if (c === "[") {
        const end = pattern.indexOf("]", i + 1);
        if (end < 0) { re += "\\["; continue; }
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        re += "[" + cls.replace(/\\/g, "\\\\") + "]";
        i = end;
      } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    return new RegExp(re + "$");
  }

  // ---------------------------------------------------------------- the system

  class System {
    constructor(options = {}) {
      this.clock = options.clock || realClock();
      clockOffset = this.clock.offset || (() => 0);
      this.hostname = options.hostname || "kurs";
      this.users = new Map();
      this.groups = new Map();
      this.procs = new Map();
      this.nextPid = 1;
      this.history = [];
      this.sudoUntil = 0;
      this.installed = new Set();   // optional packages (apt) that are installed
      this.pip = new Set();         // Python packages installed with pip (linux-programs.js)
      this.aptUpdated = false;
      this.services = new Map();    // name → { enabled, active, pid, log: [] } (linux-system.js)
      this.bootTime = this.clock.now();
      this.listeners = new Set();
      this.rootInode = null;
      this.addGroup("root", 0); this.addGroup("daemon", 1); this.addGroup("sys", 3); this.addGroup("adm", 4);
      this.addGroup("tty", 5); this.addGroup("shadow", 42); this.addGroup("sudo", 27); this.addGroup("users", 100);
      this.addUser("root", { uid: 0, gid: 0, home: "/root", password: "root" });
      this.buildFileSystem();
      // groups with fixed ids first, so a user's own group keeps the id of the user
      for (const group of options.groups || DEFAULT_GROUPS) this.addGroup(group.name, group.gid);
      for (const user of options.users || DEFAULT_USERS) this.addUser(user.name, user);
      for (const group of options.groups || DEFAULT_GROUPS) {
        const g = this.groups.get(group.name);
        for (const member of group.members || []) if (this.users.has(member) && !g.members.includes(member)) g.members.push(member);
      }
      this.init = this.spawn(null, { cmd: "init", args: ["/sbin/init"], user: "root" });
      if (options.seed !== false) this.seedHome();
      const login = this.users.get(options.login || "anna") || this.users.get("root");
      this.loginShell = this.spawn(this.init, { cmd: "bash", args: ["-bash"], user: login.name, cwd: login.home });
      this.loginShell.aliases = { ...DEFAULT_ALIASES };
      this.shell = this.loginShell;
    }

    // shutdown -r / reboot as root: every process ends, a fresh login shell starts; files stay.
    rebootSystem() {
      for (const p of [...this.procs.values()]) { if (p.wake) p.wake("exit"); }
      const login = this.loginShell.user;
      const cwd = this.loginShell.cwd, env = { ...this.loginShell.env }, aliases = { ...(this.loginShell.aliases || {}) };
      this.procs.clear(); this.nextPid = 1;
      this.bootTime = this.clock.now();
      this.sudoUntil = 0;
      this.init = this.spawn(null, { cmd: "init", args: ["/sbin/init"], user: "root" });
      const account = this.users.get(login);
      this.loginShell = this.spawn(this.init, { cmd: "bash", args: ["-bash"], user: account.name, cwd: this.lookup(cwd) ? cwd : account.home, env });
      this.loginShell.aliases = aliases;
      this.shell = this.loginShell;
      this.runBootHooks();
      if (this.onReboot) this.onReboot();
    }

    // ---- users and groups

    addGroup(name, gid) {
      if (this.groups.has(name)) return this.groups.get(name);
      if (gid === undefined) gid = Math.max(999, ...[...this.groups.values()].map(g => g.gid), ...[...this.users.values()].map(u => u.uid)) + 1;
      const group = { name, gid, members: [] };
      this.groups.set(name, group);
      return group;
    }

    addUser(name, spec = {}) {
      if (this.users.has(name)) return this.users.get(name);
      const uid = spec.uid ?? Math.max(999, ...[...this.users.values()].map(u => u.uid), ...[...this.groups.values()].map(g => g.gid)) + 1;
      const group = this.addGroup(spec.group || name, spec.gid ?? (spec.uid === 0 ? 0 : uid));
      const user = { name, uid, gid: group.gid, home: spec.home || `/home/${name}`, shell: "/bin/bash", password: spec.password ?? name, gecos: spec.gecos || "" };
      this.users.set(name, user);
      for (const g of spec.groups || []) {
        const extra = this.addGroup(g);
        if (!extra.members.includes(name)) extra.members.push(name);
      }
      if (this.rootInode && user.uid !== 0) {
        const home = this.ensureDir(user.home, { uid: user.uid, gid: user.gid, mode: 0o755 });
        if (home && !home.children.has(".bashrc")) this.putFile(`${user.home}/.bashrc`, "# ~/.bashrc\nalias ll='ls -l'\n", { uid: user.uid, gid: user.gid, mode: 0o644 });
      }
      return user;
    }

    userByUid(uid) { return [...this.users.values()].find(u => u.uid === uid); }
    groupByGid(gid) { return [...this.groups.values()].find(g => g.gid === gid); }
    groupsOf(user) {
      const gids = [user.gid];
      for (const g of this.groups.values()) if (g.members.includes(user.name) && !gids.includes(g.gid)) gids.push(g.gid);
      return gids;
    }

    passwdFile() {
      return [...this.users.values()].sort((a, b) => a.uid - b.uid)
        .map(u => `${u.name}:x:${u.uid}:${u.gid}:${u.gecos}:${u.home}:${u.shell}`).join("\n") + "\n";
    }
    groupFile() {
      return [...this.groups.values()].sort((a, b) => a.gid - b.gid)
        .map(g => `${g.name}:x:${g.gid}:${g.members.join(",")}`).join("\n") + "\n";
    }
    shadowFile() {
      return [...this.users.values()].sort((a, b) => a.uid - b.uid)
        .map(u => `${u.name}:$6$simuliert$${fakeHash(u.password)}:20000:0:99999:7:::`).join("\n") + "\n";
    }

    // ---- file system (inodes)

    makeInode(type, { mode, uid = 0, gid = 0, data = "", target = "", binary = false } = {}) {
      const now = this.clock.now();
      const inode = { type, mode: mode ?? (type === "dir" ? 0o755 : 0o644), uid, gid, mtime: now, ctime: now };
      if (type === "dir") inode.children = new Map();
      else if (type === "link") inode.target = target;
      else { inode.data = data; if (binary) inode.binary = true; }   // binary: data is a byte string (one char per byte)
      return inode;
    }

    buildFileSystem() {
      const root = this.makeInode("dir", { mode: 0o755 });
      this.rootInode = root;
      const dirs = [["/bin", 0o755], ["/sbin", 0o755], ["/etc", 0o755], ["/home", 0o755], ["/root", 0o700], ["/tmp", 0o1777],
        ["/usr", 0o755], ["/usr/bin", 0o755], ["/usr/share", 0o755], ["/usr/share/doc", 0o755], ["/var", 0o755], ["/var/log", 0o755],
        ["/dev", 0o755], ["/proc", 0o555], ["/opt", 0o755], ["/mnt", 0o755]];
      for (const [path, mode] of dirs) this.ensureDir(path, { mode });
      this.putFile("/etc/hostname", this.hostname + "\n");
      this.putFile("/etc/os-release", 'NAME="LiaLinux"\nVERSION="1 (simuliert)"\nID=lialinux\nPRETTY_NAME="LiaLinux 1 (simuliert)"\n');
      this.putFile("/etc/motd", "Willkommen in der simulierten Linux-Shell.\n");
      this.putFile("/var/log/syslog", `${new Date(this.bootTime).toISOString()} kurs kernel: LiaLinux gestartet (simuliert)\n`, { mode: 0o640, gid: 4 });
      this.putFile("/dev/null", "", { mode: 0o666 }).special = "null";
      this.putFile("/usr/share/doc/README", "Dokumentation der simulierten Umgebung: man <befehl>\n");
      // Generated files: their content comes from the live system state.
      this.putFile("/etc/passwd", "", { mode: 0o644 }).generate = () => this.passwdFile();
      this.putFile("/etc/group", "", { mode: 0o644 }).generate = () => this.groupFile();
      this.putFile("/etc/shadow", "", { mode: 0o640, gid: 42 }).generate = () => this.shadowFile();
      this.lookup("/usr/bin").generate = null;
    }

    installCommands(names) {
      const bin = this.lookup("/bin");
      const usr = this.lookup("/usr/bin");
      for (const name of names) {
        // commands of an optional package appear only once the package is installed
        const pkg = OPTIONAL_COMMANDS[name];
        if (pkg && !this.installed.has(pkg)) continue;
        if (!bin.children.has(name)) bin.children.set(name, this.makeInode("file", { mode: 0o755, data: `#!ELF (simuliert) ${name}\n` }));
        if (!usr.children.has(name)) usr.children.set(name, this.makeInode("link", { mode: 0o777, target: `/bin/${name}` }));
      }
    }

    uninstallCommands(names) {
      for (const name of names) { this.lookup("/bin")?.children.delete(name); this.lookup("/usr/bin")?.children.delete(name); }
    }

    // Lifecycle hooks of the extra modules (services after a reboot, package setup): kernel.onBoot(fn)
    runBootHooks() { for (const fn of BOOT_HOOKS) { try { fn(this); } catch { /* a hook must not stop the boot */ } } }

    seedHome() {
      const anna = this.users.get("anna"), ben = this.users.get("ben");
      if (anna) {
        this.putFile("/home/anna/notes.txt", "Linux commands I know:\nls, cd, pwd, cat\n", { uid: anna.uid, gid: anna.gid });
        this.ensureDir("/home/anna/scripts", { uid: anna.uid, gid: anna.gid, mode: 0o755 });
        this.putFile("/home/anna/scripts/hello.sh", "#!/bin/bash\necho \"Hello, $USER!\"\n", { uid: anna.uid, gid: anna.gid, mode: 0o644 });
        this.ensureDir("/home/anna/project", { uid: anna.uid, gid: anna.gid, mode: 0o755 });
        this.putFile("/home/anna/project/data.csv", "name;points\nanna;12\nben;9\n", { uid: anna.uid, gid: anna.gid });
      }
      if (ben) {
        this.putFile("/home/ben/secret.txt", "Ben's password list (do not read!)\n", { uid: ben.uid, gid: ben.gid, mode: 0o600 });
        this.putFile("/home/ben/public.txt", "Everyone may read this.\n", { uid: ben.uid, gid: ben.gid, mode: 0o644 });
      }
      const project = this.groups.get("project");
      if (project) {
        this.ensureDir("/srv", { mode: 0o755 });
        this.ensureDir("/srv/project", { uid: 0, gid: project.gid, mode: 0o775 });
        this.putFile("/srv/project/minutes.txt", "Meeting 1: tasks assigned.\n", { uid: anna ? anna.uid : 0, gid: project.gid, mode: 0o664 });
      }
    }

    // Raw (permission-free) helpers for building the image.
    lookup(path) {
      let node = this.rootInode;
      for (const part of path.split("/").filter(Boolean)) {
        if (!node || node.type !== "dir") return null;
        node = node.children.get(part) || null;
      }
      return node;
    }
    ensureDir(path, attrs = {}) {
      let node = this.rootInode;
      const parts = path.split("/").filter(Boolean);
      parts.forEach((part, index) => {
        let next = node.children.get(part);
        if (!next) {
          next = this.makeInode("dir", index === parts.length - 1 ? attrs : { mode: 0o755 });
          node.children.set(part, next);
        }
        node = next;
      });
      return node;
    }
    putFile(path, data, attrs = {}) {
      const parts = path.split("/").filter(Boolean);
      const dir = this.ensureDir("/" + parts.slice(0, -1).join("/"));
      const inode = this.makeInode("file", { ...attrs, data });
      dir.children.set(parts[parts.length - 1], inode);
      return inode;
    }

    // ---- permissions

    mayAccess(proc, inode, want) {
      // want: "r" | "w" | "x"
      if (proc.uid === 0) {
        if (want !== "x") return true;
        return inode.type === "dir" || (inode.mode & 0o111) !== 0;
      }
      let shift;
      if (inode.uid === proc.uid) shift = 6;
      else if (proc.groups.includes(inode.gid)) shift = 3;
      else shift = 0;
      const bit = want === "r" ? 4 : want === "w" ? 2 : 1;
      return (inode.mode & (bit << shift)) !== 0;
    }

    check(proc, inode, want, path) {
      if (!this.mayAccess(proc, inode, want)) throw new SysError("EACCES", path);
    }

    normalize(proc, path) {
      if (!path) return proc.cwd;
      const abs = path.startsWith("/") ? path : proc.cwd.replace(/\/$/, "") + "/" + path;
      const out = [];
      for (const part of abs.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
      }
      return "/" + out.join("/");
    }

    // Walk a path with permission checks. Returns { inode, parent, name, path }.
    // inode is null when the last component does not exist (parent then exists).
    resolve(proc, path, { follow = true, depth = 0 } = {}) {
      if (depth > 20) throw new SysError("ELOOP", path);
      const abs = this.normalize(proc, path);
      const parts = abs.split("/").filter(Boolean);
      if (parts[0] === "proc") this.refreshProc(this.rootInode.children.get("proc"));
      let node = this.rootInode, parent = null, name = "";
      let current = "";
      for (let i = 0; i < parts.length; i++) {
        if (node.type !== "dir") throw new SysError("ENOTDIR", path);
        this.check(proc, node, "x", path);
        name = parts[i];
        parent = node;
        current += "/" + name;
        node = node.children.get(name) || null;
        if (!node) {
          if (i < parts.length - 1) throw new SysError("ENOENT", path);
          return { inode: null, parent, name, path: abs };
        }
        if (node.type === "link" && (follow || i < parts.length - 1)) {
          const target = node.target.startsWith("/") ? node.target : current.replace(/\/[^/]*$/, "") + "/" + node.target;
          const rest = parts.slice(i + 1).join("/");
          return this.resolve(proc, rest ? target + "/" + rest : target, { follow, depth: depth + 1 });
        }
      }
      if (parent === null) return { inode: node, parent: null, name: "", path: "/" };
      return { inode: node, parent, name, path: abs };
    }

    stat(proc, path, follow = true) {
      const r = this.resolve(proc, path, { follow });
      if (!r.inode) throw new SysError("ENOENT", path);
      return r;
    }

    readFile(proc, path) {
      const { inode } = this.stat(proc, path);
      if (inode.type === "dir") throw new SysError("EISDIR", path);
      this.check(proc, inode, "r", path);
      return inode.generate ? inode.generate() : inode.data;
    }

    writeFile(proc, path, data, { append = false, mode, binary = false } = {}) {
      const r = this.resolve(proc, path);
      if (r.inode) {
        if (r.inode.type === "dir") throw new SysError("EISDIR", path);
        this.check(proc, r.inode, "w", path);
        if (r.inode.special === "null") return r.inode;
        if (r.inode.generate) r.inode.generate = null;
        r.inode.data = append ? r.inode.data + data : data;
        if (binary || r.inode.binary) r.inode.binary = Boolean(binary || (append && r.inode.binary));
        if (!r.inode.binary) delete r.inode.binary;
        r.inode.mtime = this.clock.now();
        return r.inode;
      }
      this.check(proc, r.parent, "w", path);
      const inode = this.makeInode("file", { mode: mode ?? (0o666 & ~proc.umask), uid: proc.uid, gid: proc.gid, data, binary });
      r.parent.children.set(r.name, inode);
      r.parent.mtime = this.clock.now();
      return inode;
    }

    touch(proc, path) {
      const r = this.resolve(proc, path);
      if (r.inode) {
        // utime needs ownership or write access
        if (r.inode.uid !== proc.uid && proc.uid !== 0) this.check(proc, r.inode, "w", path);
        r.inode.mtime = this.clock.now();
        return r.inode;
      }
      this.check(proc, r.parent, "w", path);
      const inode = this.makeInode("file", { mode: 0o666 & ~proc.umask, uid: proc.uid, gid: proc.gid });
      r.parent.children.set(r.name, inode);
      r.parent.mtime = this.clock.now();
      return inode;
    }

    mkdir(proc, path, { parents = false } = {}) {
      const abs = this.normalize(proc, path);
      if (parents) {
        const parts = abs.split("/").filter(Boolean);
        let partial = "";
        for (const part of parts) {
          partial += "/" + part;
          const r = this.resolve(proc, partial);
          if (r.inode) { if (r.inode.type !== "dir") throw new SysError("EEXIST", path); continue; }
          this.mkdir(proc, partial);
        }
        return;
      }
      const r = this.resolve(proc, path);
      if (r.inode) throw new SysError("EEXIST", path);
      this.check(proc, r.parent, "w", path);
      const inode = this.makeInode("dir", { mode: 0o777 & ~proc.umask, uid: proc.uid, gid: proc.gid });
      r.parent.children.set(r.name, inode);
      r.parent.mtime = this.clock.now();
    }

    readdir(proc, path) {
      const { inode } = this.stat(proc, path);
      if (inode.type !== "dir") throw new SysError("ENOTDIR", path);
      this.check(proc, inode, "r", path);
      return [...inode.children.keys()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    }

    canDelete(proc, parent, inode, path) {
      this.check(proc, parent, "w", path);
      this.check(proc, parent, "x", path);
      if (parent.mode & 0o1000 && proc.uid !== 0 && inode.uid !== proc.uid && parent.uid !== proc.uid) throw new SysError("EPERM", path);
    }

    unlink(proc, path) {
      const r = this.resolve(proc, path, { follow: false });
      if (!r.inode) throw new SysError("ENOENT", path);
      if (r.inode.type === "dir") throw new SysError("EISDIR", path);
      this.canDelete(proc, r.parent, r.inode, path);
      r.parent.children.delete(r.name);
      r.parent.mtime = this.clock.now();
    }

    rmdir(proc, path) {
      const r = this.resolve(proc, path, { follow: false });
      if (!r.inode) throw new SysError("ENOENT", path);
      if (r.inode.type !== "dir") throw new SysError("ENOTDIR", path);
      if (r.inode.children.size) throw new SysError("ENOTEMPTY", path);
      if (r.inode === this.rootInode) throw new SysError("EPERM", path);
      this.canDelete(proc, r.parent, r.inode, path);
      r.parent.children.delete(r.name);
    }

    removeTree(proc, path) {
      const r = this.resolve(proc, path, { follow: false });
      if (!r.inode) throw new SysError("ENOENT", path);
      if (r.inode.type === "dir") {
        this.check(proc, r.inode, "r", path);
        this.check(proc, r.inode, "x", path);
        for (const name of [...r.inode.children.keys()]) this.removeTree(proc, r.path.replace(/\/$/, "") + "/" + name);
        this.rmdir(proc, path);
      } else this.unlink(proc, path);
    }

    clone(inode) {
      const copy = { ...inode, mtime: this.clock.now() };
      if (inode.type === "dir") copy.children = new Map([...inode.children].map(([k, v]) => [k, this.clone(v)]));
      return copy;
    }

    copy(proc, from, to, { recursive = false } = {}) {
      const src = this.stat(proc, from);
      if (src.inode.type === "dir" && !recursive) throw new SysError("EISDIR", from);
      if (src.inode.type !== "dir") this.check(proc, src.inode, "r", from);
      let dest = this.resolve(proc, to);
      let targetPath = to;
      if (dest.inode && dest.inode.type === "dir") {
        targetPath = dest.path.replace(/\/$/, "") + "/" + src.name;
        dest = this.resolve(proc, targetPath);
      }
      if (dest.inode) {
        if (dest.inode.type === "dir") throw new SysError("EISDIR", to);
        this.check(proc, dest.inode, "w", to);
      } else this.check(proc, dest.parent, "w", to);
      const copy = this.clone(src.inode);
      copy.uid = proc.uid; copy.gid = proc.gid;
      copy.mode = src.inode.mode & ~proc.umask & 0o777;
      if (copy.generate) { copy.data = copy.generate(); copy.generate = null; }
      dest.parent.children.set(dest.name, copy);
    }

    // Where cp/mv would put `from` when the target is `to`: into `to` when that is a directory.
    targetPath(proc, from, to) {
      let r = this.resolve(proc, to);
      let display = to;
      if (r.inode && r.inode.type === "dir") {
        const name = from.replace(/\/+$/, "").split("/").pop();
        display = joinPath(to.replace(/\/+$/, ""), name);
        r = this.resolve(proc, display);
      }
      return { inode: r.inode, display };
    }

    rename(proc, from, to) {
      const src = this.resolve(proc, from, { follow: false });
      if (!src.inode) throw new SysError("ENOENT", from);
      let dest = this.resolve(proc, to);
      if (dest.inode && dest.inode.type === "dir") dest = this.resolve(proc, dest.path.replace(/\/$/, "") + "/" + src.name);
      this.canDelete(proc, src.parent, src.inode, from);
      if (dest.inode) {
        if (dest.inode.type === "dir") throw new SysError("EISDIR", to);
        this.canDelete(proc, dest.parent, dest.inode, to);
      } else this.check(proc, dest.parent, "w", to);
      src.parent.children.delete(src.name);
      dest.parent.children.set(dest.name, src.inode);
    }

    symlink(proc, target, linkPath) {
      const r = this.resolve(proc, linkPath, { follow: false });
      if (r.inode) throw new SysError("EEXIST", linkPath);
      this.check(proc, r.parent, "w", linkPath);
      r.parent.children.set(r.name, this.makeInode("link", { mode: 0o777, uid: proc.uid, gid: proc.gid, target }));
    }

    chmod(proc, path, mode) {
      const { inode } = this.stat(proc, path);
      if (proc.uid !== 0 && inode.uid !== proc.uid) throw new SysError("EPERM", path);
      inode.mode = (inode.mode & ~0o7777) | (mode & 0o7777);
      inode.ctime = this.clock.now();
    }

    chown(proc, path, uid, gid) {
      const { inode } = this.stat(proc, path);
      if (proc.uid !== 0) {
        // only root may change the owner; a group change is allowed for own files into own groups
        if (uid !== null && uid !== inode.uid) throw new SysError("EPERM", path);
        if (inode.uid !== proc.uid) throw new SysError("EPERM", path);
        if (gid !== null && !proc.groups.includes(gid)) throw new SysError("EPERM", path);
      }
      if (uid !== null) inode.uid = uid;
      if (gid !== null) inode.gid = gid;
      inode.ctime = this.clock.now();
    }

    refreshProc(dir) {
      dir.children.clear();
      for (const p of this.procs.values()) {
        const d = this.makeInode("dir", { mode: 0o555, uid: p.uid, gid: p.gid });
        d.children.set("status", this.makeInode("file", { mode: 0o444, uid: p.uid, gid: p.gid,
          data: `Name:\t${p.cmd}\nState:\t${p.state} (${STATE_WORDS[p.state]})\nPid:\t${p.pid}\nPPid:\t${p.ppid}\nUid:\t${p.uid}\t${p.uid}\nGid:\t${p.gid}\t${p.gid}\n` }));
        d.children.set("cmdline", this.makeInode("file", { mode: 0o444, uid: p.uid, gid: p.gid, data: [p.cmd, ...p.args.slice(1)].join("\0") + "\0" }));
        dir.children.set(String(p.pid), d);
      }
      dir.children.set("uptime", this.makeInode("file", { mode: 0o444, data: `${((this.clock.now() - this.bootTime) / 1000).toFixed(2)} 0.00\n` }));
      dir.children.set("cpuinfo", this.makeInode("file", { mode: 0o444, data: "processor\t: 0\nmodel name\t: LiaLinux Simulated CPU\n" }));
    }

    // ---- processes

    spawn(parent, { cmd, args = [], user, uid, cwd, env } = {}) {
      const account = user ? this.users.get(user) : this.userByUid(uid ?? parent.uid);
      const pid = this.nextPid++;
      let environment = env ? { ...env } : parent ? { ...parent.env } : this.defaultEnv(account);
      // an explicit account (login shell, su, sudo) gets its own identity variables
      if (user !== undefined && !env) environment = { ...environment, HOME: account.home, USER: account.name, LOGNAME: account.name, SHELL: account.shell };
      const proc = {
        pid, ppid: parent ? parent.pid : 0,
        uid: account.uid, gid: account.gid, user: account.name, groups: this.groupsOf(account),
        cwd: cwd || (parent ? parent.cwd : account.home),
        env: environment,
        umask: parent ? parent.umask : 0o022,
        cmd, args: args.length ? args : [cmd], state: "S", start: this.clock.now(), cpu: 0,
        exitCode: null, lastStatus: 0, lastBg: 0, jobs: [], nextJob: 1,
        traps: {}, wake: null, children: [], interrupted: false, parentProc: parent
      };
      if (parent) parent.children.push(proc);
      this.procs.set(pid, proc);
      return proc;
    }

    defaultEnv(account) {
      return {
        HOME: account.home, USER: account.name, LOGNAME: account.name, SHELL: account.shell,
        PATH: "/usr/local/bin:/usr/bin:/bin", PWD: account.home, LANG: "C.UTF-8", TERM: "xterm-256color", HOSTNAME: this.hostname
      };
    }

    exit(proc, code) {
      if (proc.exitCode !== null) return;
      proc.exitCode = code & 0xff;
      proc.state = "Z";
      if (proc.wake) proc.wake("exit");
      // orphans go to init, which reaps finished ones at once
      for (const child of [...proc.children]) {
        child.parentProc = this.init; child.ppid = 1;
        this.init.children.push(child);
        if (child.exitCode !== null) this.reap(child);
      }
      proc.children = [];
      // init reaps at once; a shell reaps its jobs when it next shows the prompt
      if (proc.parentProc === null || proc.parentProc === this.init || proc.parentProc.exitCode !== null) this.reap(proc);
      if (proc.onExit) { const fn = proc.onExit; proc.onExit = null; fn(proc.exitCode); }
    }

    // Ctrl+C / Ctrl+Z from the terminal: the innermost foreground process of the current shell.
    foregroundLeaf() {
      let proc = this.shell;
      while (proc.fgChild) proc = proc.fgChild;
      return proc === this.shell ? null : proc;
    }
    interrupt() {
      const leaf = this.foregroundLeaf();
      if (leaf) this.signal(this.init, leaf.pid, SIGNALS.INT);
      return Boolean(leaf);
    }
    suspend() {
      const leaf = this.foregroundLeaf();
      if (leaf) this.signal(this.init, leaf.pid, SIGNALS.TSTP);
      return Boolean(leaf);
    }

    reap(proc) {
      this.procs.delete(proc.pid);
      if (proc.parentProc) proc.parentProc.children = proc.parentProc.children.filter(c => c !== proc);
    }

    signal(sender, pid, sig) {
      const proc = this.procs.get(pid);
      if (!proc) throw new SysError("ESRCH", String(pid));
      if (sender.uid !== 0 && sender.uid !== proc.uid) throw new SysError("EPERM", String(pid));
      if (proc.exitCode !== null) return;
      const name = SIGNAL_NAMES[sig];
      if (sig === SIGNALS.KILL) return this.exit(proc, 128 + sig);
      if (sig === SIGNALS.STOP || sig === SIGNALS.TSTP) {
        proc.state = "T";
        if (proc.onStop) { const fn = proc.onStop; proc.onStop = null; fn(); }
        return;
      }
      if (sig === SIGNALS.CONT) {
        if (proc.state !== "T") return;
        proc.state = "S";
        const pending = proc.pendingSignal; proc.pendingSignal = null;
        if (pending) this.signal(sender, pid, pending);
        return;
      }
      // a stopped process receives other signals only once it continues
      if (proc.state === "T") { proc.pendingSignal = sig; return; }
      if (proc.traps[name] !== undefined) {
        const handler = proc.traps[name];
        if (handler === "") return; // ignored
        proc.trapQueue = (proc.trapQueue || []).concat(handler);
        if (proc.wake) proc.wake("trap");
        return;
      }
      this.exit(proc, 128 + sig);
    }

    sleep(proc, ms) {
      if (proc.state === "R") proc.state = "S";
      return new Promise(resolve => {
        const done = reason => { proc.wake = null; if (proc.state === "S") proc.state = "R"; resolve(reason); };
        const cancel = this.clock.schedule(ms, () => done("done"));
        proc.wake = reason => { cancel(); done(reason); };
      });
    }

    uptimeSeconds() { return (this.clock.now() - this.bootTime) / 1000; }

    // ---- shell

    makeIO(base = {}) {
      const write = base.write || (() => {});
      const error = base.error || write;
      const lang = base.lang || (() => "en");
      return {
        color: Boolean(base.color),
        lang,
        stdin: base.stdin,      // text of a pipe or < redirection; undefined at the keyboard
        piped: Boolean(base.piped),
        editor: base.editor,    // the terminal's full-screen editor (nano), undefined elsewhere
        show: base.show,        // the terminal's image viewer (xdg-open), upload dialog and download – browser only
        upload: base.upload,
        download: base.download,
        write,
        error,
        out: text => write(text + "\n"),
        // messages of bash and the tools follow LANG; output of the commands themselves does not
        err: text => error(localize(text, lang()) + "\n"),
        notice: text => write(localize(text, lang()) + "\n"),
        clear: () => base.clear && base.clear(),
        readLine: opts => base.readLine ? base.readLine({ ...opts, prompt: localize(opts?.prompt || "", lang()) }) : Promise.resolve("")
      };
    }

    language() { return langOf(this.shell.env.LANG); }

    // Runs one line typed at the prompt of the current shell. Resolves to the exit status.
    async run(line, base) {
      const io = this.makeIO({ ...base, lang: () => this.language() });
      const shell = this.shell;
      if (line.trim()) this.history.push(line);
      const status = await this.runLine(shell, line, io);
      this.reapJobs(shell, io);
      return status;
    }

    // Executes a line (several commands separated by ; & or newline) in a process context.
    async runLine(proc, line, io, positional = []) {
      let status = proc.lastStatus;
      let lists;
      try {
        lists = parseLine(line);
      } catch (error) {
        io.err(`bash: ${error.message}`);
        proc.lastStatus = 2;
        return 2;
      }
      for (const item of lists) {
        if (proc.exited) break;
        if (item.operator === "&&" && status !== 0) continue;
        if (item.operator === "||" && status === 0) continue;
        const stages = [];
        let bad = false;
        for (const stageWords of item.stages) {
          try { stages.push(this.expand(proc, stageWords, positional)); }
          catch (error) { io.err(`bash: ${error.message}`); bad = true; break; }
        }
        if (bad) { status = 1; proc.lastStatus = 1; continue; }
        let negate = false;
        if (stages[0].words[0] === "!") { negate = true; stages[0].words.shift(); if (!stages[0].words.length && stages.length === 1) { status = 1; proc.lastStatus = 1; continue; } }
        if (stages.length > 1) {
          // a pipeline in the background runs as one job
          status = item.background ? this.startBackground(proc, ["bash", "-c", item.text], io, line) : await this.runPipeline(proc, stages, io, item.text);
        } else {
          const { words, redirects } = stages[0];
          let cmdIO = io;
          if (redirects.length) {
            cmdIO = this.applyRedirects(proc, io, redirects);
            if (!cmdIO) { status = 1; proc.lastStatus = 1; continue; }
          }
          if (!words.length) { cmdIO.flush?.(); continue; }
          if (item.background) {
            status = this.startBackground(proc, words, cmdIO, line);
          } else {
            status = await this.execute(proc, words, cmdIO, { line: item.text });
            cmdIO.flush?.();
          }
        }
        if (negate) status = status === 0 ? 1 : 0;
        proc.lastStatus = status;
      }
      return status;
    }

    // cmd1 | cmd2 | cmd3: each stage runs to its end, its output becomes the standard input of the next.
    // Enough for teaching; a program that never ends (yes) therefore stops after a while inside a pipe.
    async runPipeline(proc, stages, io, text) {
      let input;
      let status = 0;
      // every stage of a pipeline runs in a subshell: variables, cd and umask set there do not survive it
      const saved = { vars: { ...(proc.vars || {}) }, env: { ...proc.env }, cwd: proc.cwd, umask: proc.umask };
      try { status = await this.runStages(proc, stages, io, text); }
      finally { proc.vars = saved.vars; proc.env = saved.env; proc.cwd = saved.cwd; proc.umask = saved.umask; }
      return status;
    }

    async runStages(proc, stages, io, text) {
      let input;
      let status = 0;
      for (let i = 0; i < stages.length; i++) {
        const { words, redirects } = stages[i];
        const last = i === stages.length - 1;
        let buffer = "";
        let stageIO = this.makeIO({
          write: last ? io.write : t => { buffer += t; }, error: io.error, color: last && io.color,
          clear: io.clear, readLine: io.readLine, lang: io.lang, stdin: input ?? "", piped: !last, editor: last ? io.editor : undefined, show: io.show, upload: io.upload, download: io.download
        });
        if (redirects.length) { const r = this.applyRedirects(proc, stageIO, redirects); if (!r) { status = 1; input = ""; continue; } stageIO = r; }
        status = await this.execute(proc, words, stageIO, { line: text });
        stageIO.flush?.();
        input = buffer;
      }
      return status;
    }

    expand(proc, words, positional) {
      const result = [];
      const redirects = [];
      let pendingRedirect = null;
      for (const word of words) {
        if (word.length === 1 && word[0].redirect !== undefined) {
          if (word[0].dup !== undefined) redirects.push({ fd: word[0].redirect, dup: word[0].dup, op: word[0].text });
          else pendingRedirect = { fd: word[0].redirect, op: word[0].text, both: Boolean(word[0].both) };
          continue;
        }
        if (pendingRedirect) {
          const [target] = this.expand(proc, [word], positional).words;
          redirects.push({ ...pendingRedirect, target });
          pendingRedirect = null;
          continue;
        }
        let text = "";
        let glob = false;
        for (const part of word) {
          if (part.quote === "'") { text += escapeGlob(part.text); continue; }
          let value = this.expandVars(proc, part.text, positional);
          if (part.quote === '"') { text += escapeGlob(value); continue; }
          if (/[*?[]/.test(value)) glob = true;
          text += value;
        }
        if (!word.length) continue;
        if (word[0].quote === null && text.startsWith("~")) {
          const m = /^~([a-z_][a-z0-9_-]*)?(?=\/|$)/.exec(text);
          if (m) {
            const home = m[1] ? this.users.get(m[1])?.home : proc.env.HOME;
            if (home) text = home + text.slice(m[0].length);
          }
        }
        if (glob) {
          const matches = this.glob(proc, text);
          if (matches.length) { result.push(...matches); continue; }
        }
        result.push(unescapeGlob(text));
      }
      if (pendingRedirect) throw new Error("syntax error near unexpected token `newline'");
      return { words: result, redirects };
    }

    // Builds the io of a command with > >> 2> 2>&1 &> applied; null when a target cannot be opened.
    applyRedirects(proc, io, redirects) {
      let out = io.write, err = io.error, stdin = io.stdin;
      const flushes = [];
      for (const r of redirects) {
        if (r.op === "<") {
          try { stdin = this.readFile(proc, r.target); }
          catch (error) { io.err(`bash: ${r.target}: ${error.message}`); return null; }
          continue;
        }
        if (r.dup !== undefined) {
          const current = r.dup === 1 ? out : err;
          if (r.fd === 2) err = current; else out = current;
          continue;
        }
        try { this.writeFile(proc, r.target, "", { append: r.op === ">>" }); }
        catch (error) { io.err(`bash: ${r.target}: ${error.message}`); return null; }
        let buffer = "";
        const sink = text => { buffer += text; };
        const target = r.target;
        flushes.push(() => { if (buffer) { try { this.writeFile(proc, target, buffer, { append: true }); } catch { /* vanished meanwhile */ } } });
        if (r.both) { out = sink; err = sink; } else if (r.fd === 2) err = sink; else out = sink;
      }
      const result = this.makeIO({ write: t => out(t), error: t => err(t), color: out === io.write && io.color, clear: io.clear, readLine: io.readLine, lang: io.lang, stdin, piped: io.piped || out !== io.write, editor: io.editor, show: io.show, upload: io.upload, download: io.download });
      result.flush = () => flushes.forEach(f => f());
      return result;
    }

    expandVars(proc, text, positional) {
      return text.replace(/\$(\?|\$|!|#|@|\*|\d|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, key, braced, plain) => {
        if (key === "?") return String(proc.lastStatus);
        if (key === "$") return String(proc.pid);
        if (key === "!") return String(proc.lastBg || "");
        if (key === "#") return String(positional.length);
        if (key === "@" || key === "*") return positional.join(" ");
        if (/^\d$/.test(key)) return key === "0" ? proc.scriptName || "bash" : positional[Number(key) - 1] ?? "";
        const name = braced || plain;
        return proc.env[name] ?? proc.vars?.[name] ?? "";
      });
    }

    glob(proc, pattern) {
      const absolute = pattern.startsWith("/");
      const parts = pattern.split("/");
      let bases = [absolute ? "/" : ""];
      if (absolute) parts.shift();
      for (const part of parts) {
        if (part === "") continue;
        const next = [];
        for (const base of bases) {
          const dirPath = base || ".";
          if (!/[*?[]/.test(part)) {
            const candidate = joinPath(base, unescapeGlob(part));
            try { this.stat(proc, candidate, false); next.push(candidate); } catch { /* skip */ }
            continue;
          }
          let names;
          try { names = this.readdir(proc, dirPath); } catch { continue; }
          const re = globToRegExp(part);
          for (const name of names) {
            if (name.startsWith(".") && !part.startsWith(".")) continue;
            if (re.test(name)) next.push(joinPath(base, name));
          }
        }
        bases = next;
        if (!bases.length) return [];
      }
      return bases.sort();
    }

    startBackground(proc, words, io, line) {
      const child = this.spawn(proc, { cmd: words[0], args: words });
      child.state = "S";
      const job = { id: proc.nextJob++, pid: child.pid, command: words.join(" "), state: "Running", notified: false };
      proc.jobs.push(job);
      proc.lastBg = child.pid;
      // a background job shares the terminal's output but cannot read from it
      const quiet = { ...io, readLine: () => Promise.resolve(""), flush: undefined };
      io.out(`[${job.id}] ${child.pid}`);
      this.execute(child, words, quiet, { asProcess: child, foreground: false }).then(code => {
        if (child.exitCode === null) this.exit(child, code);
        io.flush?.();
      });
      return 0;
    }

    reapJobs(shell, io) {
      for (const job of [...shell.jobs]) {
        const proc = this.procs.get(job.pid);
        if (!proc || proc.exitCode === null) {
          if (proc && proc.state === "T" && job.state !== "Stopped") { job.state = "Stopped"; (io.notice || io.out)(`[${job.id}]+  Stopped                 ${job.command}`); }
          else if (proc && proc.state !== "T") job.state = "Running";
          continue;
        }
        const code = proc.exitCode;
        const word = code === 0 ? "Done" : code > 128 && SIGNAL_NAMES[code - 128] ? (code - 128 === 2 ? "Interrupt" : code - 128 === 9 ? "Killed" : code - 128 === 15 ? "Terminated" : `${SIGNAL_NAMES[code - 128]}`) : `Exit ${code}`;
        if (!job.silent) (io.notice || io.out)(`[${job.id}]${job === shell.jobs[shell.jobs.length - 1] ? "+" : "-"}  ${word.padEnd(23)} ${job.command}`);
        this.reap(proc);
        shell.jobs = shell.jobs.filter(j => j !== job);
      }
    }

    findCommand(proc, name) {
      if (name.includes("/")) return name;
      for (const dir of (proc.env.PATH || "/bin").split(":")) {
        const node = this.lookup(joinPath(dir, name));
        if (node) return joinPath(dir, name);
      }
      return null;
    }

    // Executes one simple command (words already expanded) in proc. Resolves to the exit status.
    async execute(proc, words, io, { asProcess = null, line = "", foreground = true, noAlias = false } = {}) {
      // aliases of the shell: the first word is replaced by the alias text (parsed like a command line)
      const aliasHolder = this.shell;
      if (!noAlias && aliasHolder.aliases && aliasHolder.aliases[words[0]] !== undefined) {
        try {
          const parsed = parseLine(aliasHolder.aliases[words[0]]);
          const first = parsed[0] && parsed[0].words.map(w => w.map(p => p.text).join(""));
          if (first && first.length) words = [...first, ...words.slice(1)];
        } catch { /* a broken alias runs as typed */ }
        return this.execute(proc, words, io, { asProcess, line, foreground, noAlias: true });
      }
      const [name, ...args] = words;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name) && !args.length) {
        const eq = name.indexOf("=");
        proc.vars = proc.vars || {};
        const key = name.slice(0, eq), value = name.slice(eq + 1);
        if (key in proc.env) proc.env[key] = value; else proc.vars[key] = value;
        return 0;
      }
      const builtin = BUILTINS[name];
      if (builtin) {
        try { return await builtin.call(this, proc, args, io, { line }); }
        catch (error) { io.err(`bash: ${name}: ${error.message}`); return 1; }
      }
      const command = COMMANDS[name];
      const optional = OPTIONAL_COMMANDS[name];
      if (command && optional && !this.installed.has(optional)) {
        // Ubuntu's command-not-found hint for a package of the index
        io.err(`Command '${name}' not found, but can be installed with:`);
        io.err(`sudo apt install ${optional}`);
        return 127;
      }
      if (command) {
        const child = asProcess || this.spawn(proc, { cmd: name, args: words });
        child.state = "R";
        const running = Promise.resolve()
          .then(() => command.call(this, child, args, io, { shell: proc, line }))
          .catch(error => { io.err(`${name}: ${error.message}`); return 1; })
          .then(code => {
            // a job that was stopped with Ctrl+Z and continued later ends on its own
            if (child.detached && child.exitCode === null) this.exit(child, code);
            return code;
          });
        // a foreground command can be stopped with Ctrl+Z; a background job just keeps its state
        const owner = asProcess ? asProcess.parentProc : proc;
        const stopped = foreground ? new Promise(resolve => { child.onStop = () => resolve("stopped"); }) : new Promise(() => {});
        if (foreground && owner) owner.fgChild = child;
        const result = await Promise.race([running, stopped]);
        if (foreground && owner && owner.fgChild === child) owner.fgChild = null;
        child.onStop = null;
        if (result === "stopped") {
          child.detached = true;
          const job = { id: proc.nextJob++, pid: child.pid, command: words.join(" "), state: "Stopped", notified: true };
          proc.jobs.push(job);
          (io.notice || io.out)(`\n[${job.id}]+  Stopped                 ${job.command}`);
          return 148;
        }
        let status = result;
        if (child.exitCode !== null) status = child.exitCode;
        else if (!asProcess) { this.exit(child, status); this.reap(child); }
        return status;
      }
      if (name.includes("/")) {
        try {
          const { inode } = this.stat(proc, name);
          if (inode.type === "dir") { io.err(`bash: ${name}: Is a directory`); return 126; }
          if (!this.mayAccess(proc, inode, "x")) { io.err(`bash: ${name}: Permission denied`); return 126; }
          const binary = this.normalize(proc, name).replace(/^\/usr\/bin\//, "/bin/");
          if (binary.startsWith("/bin/") && COMMANDS[binary.slice(5)]) return this.execute(proc, [binary.slice(5), ...args], io, { asProcess, line });
          return this.runScript(proc, name, args, io, { asProcess });
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") { io.err(`bash: ${name}: No such file or directory`); return 127; }
          if (error.code === "EACCES") { io.err(`bash: ${name}: Permission denied`); return 126; }
          throw error;
        }
      }
      io.err(`bash: ${name}: command not found`);
      return 127;
    }

    async runScript(proc, path, args, io, { asProcess = null, needExec = true } = {}) {
      let source;
      try {
        const { inode } = this.stat(proc, path);
        if (needExec && !this.mayAccess(proc, inode, "x")) { io.err(`bash: ${path}: Permission denied`); return 126; }
        source = this.readFile(proc, path);
      } catch (error) {
        if (error.code === "EACCES") { io.err(`bash: ${path}: Permission denied`); return 126; }
        io.err(`bash: ${path}: ${error.message}`); return 127;
      }
      const child = asProcess || this.spawn(proc, { cmd: "bash", args: ["bash", path, ...args] });
      child.state = "R";
      child.scriptName = path;
      // a registered executable format (a shebang of an interpreter package, a compiled program) runs the file itself
      const format = EXEC_FORMATS.find(f => f.test(source, path));
      const status = format ? await format.run(this, child, { path, source, args, io }) : await this.runSource(child, source, io, args);
      if (child.exitCode === null && !asProcess) { this.exit(child, status); this.reap(child); }
      return child.exitCode ?? status;
    }

    async runSource(proc, source, io, positional = []) {
      let status = 0;
      for (const rawLine of source.split("\n")) {
        if (proc.exited || proc.exitCode !== null) break;
        const line = rawLine.replace(/\r$/, "");
        if (!line.trim() || line.trim().startsWith("#")) continue;
        status = await this.runLine(proc, line, io, positional);
      }
      return proc.exited ? proc.exitStatus : status;
    }

    prompt(proc = this.shell) {
      const home = proc.env.HOME;
      let cwd = proc.cwd;
      if (home && (cwd === home || cwd.startsWith(home + "/"))) cwd = "~" + cwd.slice(home.length);
      return `${proc.user}@${this.hostname}:${cwd}${proc.uid === 0 ? "#" : "$"} `;
    }

    // su/sudo helpers
    async authenticate(proc, user, io, promptText) {
      if (proc.uid === 0) return true;
      const typed = await io.readLine({ prompt: promptText, echo: false });
      return typed === user.password;
    }

    // ---- persistence

    serialize() {
      const dump = node => {
        const base = { type: node.type, mode: node.mode, uid: node.uid, gid: node.gid, mtime: node.mtime };
        if (node.type === "dir") base.children = Object.fromEntries([...node.children].map(([k, v]) => [k, dump(v)]));
        else if (node.type === "link") base.target = node.target;
        else { if (node.generate) base.generate = true; else base.data = node.data; if (node.special) base.special = node.special; if (node.binary) base.binary = true; }
        return base;
      };
      return {
        version: 1, hostname: this.hostname, bootTime: this.bootTime,
        users: [...this.users.values()], groups: [...this.groups.values()],
        installed: [...this.installed], aptUpdated: this.aptUpdated, pip: [...this.pip],
        services: [...this.services].map(([name, s]) => [name, { enabled: s.enabled, log: s.log.slice(-50) }]),
        fs: dump(this.rootInode), history: this.history,
        shell: { user: this.shell.user, cwd: this.shell.cwd, env: this.shell.env, umask: this.shell.umask, vars: this.shell.vars || {}, aliases: this.loginShell.aliases || {} }
      };
    }

    static restore(data, options = {}) {
      const sys = new System({ ...options, users: [], groups: [], seed: false, login: data.shell.user, hostname: data.hostname });
      sys.users.clear(); sys.groups.clear();
      for (const g of data.groups) sys.groups.set(g.name, { ...g, members: [...g.members] });
      for (const u of data.users) sys.users.set(u.name, { ...u });
      const load = node => {
        const inode = { type: node.type, mode: node.mode, uid: node.uid, gid: node.gid, mtime: node.mtime, ctime: node.mtime };
        if (node.type === "dir") inode.children = new Map(Object.entries(node.children).map(([k, v]) => [k, load(v)]));
        else if (node.type === "link") inode.target = node.target;
        else { inode.data = node.data ?? ""; if (node.special) inode.special = node.special; if (node.binary) inode.binary = true; }
        return inode;
      };
      sys.rootInode = load(data.fs);
      sys.lookup("/etc/passwd").generate = () => sys.passwdFile();
      sys.lookup("/etc/group").generate = () => sys.groupFile();
      sys.lookup("/etc/shadow").generate = () => sys.shadowFile();
      sys.history = [...data.history];
      sys.procs.clear(); sys.nextPid = 1;
      sys.init = sys.spawn(null, { cmd: "init", args: ["/sbin/init"], user: "root" });
      const account = sys.users.get(data.shell.user);
      sys.loginShell = sys.spawn(sys.init, { cmd: "bash", args: ["-bash"], user: account.name, cwd: data.shell.cwd, env: data.shell.env });
      sys.loginShell.umask = data.shell.umask;
      sys.loginShell.vars = { ...data.shell.vars };
      sys.loginShell.aliases = { ...DEFAULT_ALIASES, ...(data.shell.aliases || {}) };
      sys.shell = sys.loginShell;
      sys.installed = new Set(data.installed || []);
      sys.pip = new Set(data.pip || []);
      sys.aptUpdated = Boolean(data.aptUpdated);
      sys.restoredServices = data.services || null;
      return sys;
    }
  }

  const STATE_WORDS = { R: "running", S: "sleeping", T: "stopped", Z: "zombie" };

  const DEFAULT_USERS = [
    { name: "anna", uid: 1000, password: "anna", groups: ["sudo", "project"], gecos: "Anna Example" },
    { name: "ben", uid: 1001, password: "ben", groups: ["project"], gecos: "Ben Sample" }
  ];
  const DEFAULT_GROUPS = [{ name: "project", gid: 1002, members: ["anna", "ben"] }];
  // the aliases Ubuntu's .bashrc defines
  const DEFAULT_ALIASES = { ll: "ls -alF", la: "ls -A", l: "ls -CF" };

  function fakeHash(text) {
    // a stable, obviously fake hash for /etc/shadow
    let h = 0;
    for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h.toString(36).padStart(8, "0") + "simuliert";
  }

  // What `file` says about well-known binary formats, by their first bytes (data as a byte string).
  function binaryKind(data) {
    if (data.startsWith("\x89PNG")) { const w = data.charCodeAt(19) | (data.charCodeAt(18) << 8), h = data.charCodeAt(23) | (data.charCodeAt(22) << 8); return `PNG image data, ${w} x ${h}, 8-bit/color RGBA, non-interlaced`; }
    if (data.startsWith("\xff\xd8\xff")) return "JPEG image data, JFIF standard 1.01";
    if (data.startsWith("GIF8")) return "GIF image data";
    if (data.startsWith("%PDF-")) return `PDF document, version ${data.slice(5, 8)}`;
    if (data.startsWith("PK\x03\x04")) return "Zip archive data, at least v2.0 to extract";
    if (data.startsWith("\x1f\x8b")) return "gzip compressed data";
    if (data.startsWith("RIFF") && data.slice(8, 12) === "WEBP") return "RIFF (little-endian) data, Web/P image";
    return null;
  }

  function joinPath(base, name) {
    if (!base) return name;
    return base.endsWith("/") ? base + name : base + "/" + name;
  }
  const escapeGlob = text => text.replace(/[*?[\\]/g, "\\$&");
  const unescapeGlob = text => text.replace(/\\([*?[\\])/g, "$1");

  // ---------------------------------------------------------------- parser

  // Splits a line into commands. Each command: { stages: [[word…], …] (one per pipe stage), words: stage 1,
  // background, operator, text } with word = [{text, quote}]
  function parseLine(line) {
    const commands = [];
    let words = [], word = [], part = "", quote = null, haveWord = false, start = 0, stages = [];
    const flushPart = () => { if (part || quote !== null && haveWord) { word.push({ text: part, quote }); } part = ""; };
    const flushWord = () => { flushPart(); if (word.length || haveWord) words.push(word); word = []; haveWord = false; };
    const flushCommand = (background, nextOperator, end) => {
      flushWord();
      const all = [...stages, words];
      if (all.length > 1 && all.some(s => !s.length)) throw new Error("syntax error near unexpected token `|'");
      commands.push({ stages: all, words: all[0], background, operator: pendingOperator, text: line.slice(start, end).trim() });
      pendingOperator = nextOperator;
      words = []; stages = []; start = end + 1;
    };
    let pendingOperator = null;
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (quote === "'") {
        if (c === "'") { flushPart(); quote = null; } else part += c;
        i++; continue;
      }
      if (quote === '"') {
        if (c === "\\" && i + 1 < line.length && /["\\$`]/.test(line[i + 1])) { part += line[i + 1]; i += 2; continue; }
        if (c === '"') { flushPart(); quote = null; } else part += c;
        i++; continue;
      }
      if (c === "\\") { if (i + 1 < line.length) { flushPart(); quote = null; part += line[i + 1]; word.push({ text: part, quote: "'" }); part = ""; haveWord = true; i += 2; continue; } i++; continue; }
      if (c === "'" || c === '"') { flushPart(); quote = c; haveWord = true; i++; continue; }
      if (c === "#" && !part.length && !word.length) break;
      if (/\s/.test(c)) { flushWord(); i++; continue; }
      if (c === ";" ) { flushCommand(false, null, i); i++; continue; }
      if (c === "&" && line[i + 1] === "&") { flushCommand(false, "&&", i); i += 2; start = i; continue; }
      if (c === "|" && line[i + 1] === "|") { flushCommand(false, "||", i); i += 2; start = i; continue; }
      if (c === "&" && line[i + 1] === ">") { flushWord(); words.push([{ text: "&>", quote: null, redirect: 1, both: true }]); i += 2; if (line[i] === ">") i++; continue; }
      if (c === "&") { flushCommand(true, null, i); i++; continue; }
      if (c === ">" || c === "<") {
        // redirection: > >> 2> 2>&1 &> and < file
        let fd = c === "<" ? 0 : 1;
        if (part === "" && word.length === 0 && words.length && words[words.length - 1].length === 1 && words[words.length - 1][0].quote === null && /^[12]$/.test(words[words.length - 1][0].text) && !/\s/.test(line[i - 1] || " ")) fd = Number(words.pop()[0].text);
        else if (/^[12]$/.test(part) && word.length === 0) { fd = Number(part); part = ""; haveWord = false; }
        flushWord();
        const op = c === ">" && line[i + 1] === ">" ? ">>" : c;
        const token = { text: op, quote: null, redirect: fd };
        i += op.length;
        if (op === ">" && line[i] === "&" && /^[12]$/.test(line[i + 1] || "")) { token.dup = Number(line[i + 1]); i += 2; }
        words.push([token]);
        continue;
      }
      if (c === "|") { flushWord(); stages.push(words); words = []; i++; continue; }
      part += c; haveWord = true; i++;
    }
    if (quote !== null) throw new Error("unexpected EOF while looking for matching `" + quote + "'");
    flushCommand(false, null, line.length);
    return commands.filter(c => c.stages.some(s => s.length));
  }

  // ---------------------------------------------------------------- builtins (run inside the shell process)

  const BUILTINS = {
    async cd(proc, args, io) {
      let target = args[0] ?? proc.env.HOME;
      if (target === "-") target = proc.env.OLDPWD || proc.cwd;
      try {
        const { inode, path } = this.stat(proc, target);
        if (inode.type !== "dir") { io.err(`bash: cd: ${args[0]}: Not a directory`); return 1; }
        if (!this.mayAccess(proc, inode, "x")) { io.err(`bash: cd: ${args[0]}: Permission denied`); return 1; }
        proc.env.OLDPWD = proc.cwd;
        proc.cwd = path;
        proc.env.PWD = path;
        return 0;
      } catch (error) {
        io.err(`bash: cd: ${args[0]}: ${error.message}`);
        return 1;
      }
    },
    async pwd(proc, args, io) { io.out(proc.cwd); return 0; },
    async exit(proc, args, io) {
      const code = args.length ? Number(args[0]) & 0xff : proc.lastStatus;
      proc.exited = true; proc.exitStatus = code;
      if (proc === this.shell) {
        if (proc !== this.loginShell) {
          // leave a su shell
          this.exit(proc, code); this.reap(proc);
          this.shell = proc.parentProc;
          io.out("exit");
        } else {
          (io.notice || io.out)("logout");
          (io.notice || io.out)("(The login shell stays open in the simulation.)");
          proc.exited = false;
        }
      }
      return code;
    },
    async logout(proc, args, io) { return BUILTINS.exit.call(this, proc, args, io); },
    async export(proc, args, io) {
      if (!args.length) { for (const [k, v] of Object.entries(proc.env).sort()) io.out(`declare -x ${k}="${v}"`); return 0; }
      for (const a of args) {
        const eq = a.indexOf("=");
        if (eq < 0) { if (proc.vars?.[a] !== undefined) { proc.env[a] = proc.vars[a]; delete proc.vars[a]; } continue; }
        proc.env[a.slice(0, eq)] = a.slice(eq + 1);
      }
      return 0;
    },
    async unset(proc, args) { for (const a of args) { delete proc.env[a]; if (proc.vars) delete proc.vars[a]; } return 0; },
    async umask(proc, args, io) {
      if (!args.length) { io.out("0" + proc.umask.toString(8).padStart(3, "0")); return 0; }
      if (!/^[0-7]{1,4}$/.test(args[0])) { io.err(`bash: umask: ${args[0]}: octal number out of range`); return 1; }
      proc.umask = parseInt(args[0], 8) & 0o777; return 0;
    },
    async history(proc, args, io) {
      if (args[0] === "-c") { this.history.length = 0; return 0; }
      this.history.forEach((line, i) => io.out(`${String(i + 1).padStart(5)}  ${line}`));
      return 0;
    },
    async type(proc, args, io) {
      let status = 0;
      for (const name of args) {
        if (BUILTINS[name]) io.out(`${name} is a shell builtin`);
        else { const found = this.findCommand(proc, name); if (found) io.out(`${name} is ${found}`); else { io.err(`bash: type: ${name}: not found`); status = 1; } }
      }
      return status;
    },
    async alias(proc, args, io) {
      const aliases = proc.aliases || (proc.aliases = {});
      if (!args.length) { for (const [k, v] of Object.entries(aliases).sort()) io.out(`alias ${k}='${v}'`); return 0; }
      let status = 0;
      for (const a of args) {
        const eq = a.indexOf("=");
        if (eq < 0) { if (aliases[a] !== undefined) io.out(`alias ${a}='${aliases[a]}'`); else { io.err(`bash: alias: ${a}: not found`); status = 1; } continue; }
        aliases[a.slice(0, eq)] = a.slice(eq + 1);
      }
      return status;
    },
    async unalias(proc, args, io) {
      const aliases = proc.aliases || (proc.aliases = {});
      if (args[0] === "-a") { for (const k of Object.keys(aliases)) delete aliases[k]; return 0; }
      let status = 0;
      for (const a of args) { if (aliases[a] === undefined) { io.err(`bash: unalias: ${a}: not found`); status = 1; } else delete aliases[a]; }
      return status;
    },
    async read(proc, args, io) {
      // read [-p PROMPT] [-r] NAME…: a line from the pipe / file, otherwise from the keyboard
      let prompt = "", names = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-p") prompt = args[++i] ?? "";
        else if (args[i] === "-r" || args[i] === "-s") { /* no backslash handling anyway */ }
        else names.push(args[i]);
      }
      let line;
      if (io.stdin !== undefined) {
        const end = io.stdin.indexOf("\n");
        if (io.stdin === "") return 1;
        line = end < 0 ? io.stdin : io.stdin.slice(0, end);
        io.stdin = end < 0 ? "" : io.stdin.slice(end + 1);
      } else line = await io.readLine({ prompt, echo: true });
      proc.vars = proc.vars || {};
      if (!names.length) names = ["REPLY"];
      const parts = line.trim().split(/\s+/);
      names.forEach((name, i) => {
        const value = i === names.length - 1 ? parts.slice(i).join(" ") : parts[i] ?? "";
        if (name in proc.env) proc.env[name] = value; else proc.vars[name] = value;
      });
      return 0;
    },
    async source(proc, args, io) { return BUILTINS["."].call(this, proc, args, io); },
    async "."(proc, args, io) {
      if (!args.length) { io.err("bash: .: filename argument required"); return 2; }
      try { const src = this.readFile(proc, args[0]); return await this.runSource(proc, src, io, args.slice(1)); }
      catch (error) { io.err(`bash: .: ${args[0]}: ${error.message}`); return 1; }
    },
    async trap(proc, args, io) {
      if (!args.length) { for (const [k, v] of Object.entries(proc.traps)) io.out(`trap -- '${v}' ${k}`); return 0; }
      const [handler, ...sigs] = args;
      for (const s of sigs) { const name = s.replace(/^SIG/, "").toUpperCase(); if (!SIGNALS[name] && !/^\d+$/.test(name)) { io.err(`bash: trap: ${s}: invalid signal specification`); return 1; } proc.traps[SIGNAL_NAMES[name] || name] = handler; }
      return 0;
    },
    async test(proc, args, io) { return evalTest.call(this, proc, args, io, "test"); },
    async "["(proc, args, io) {
      if (args[args.length - 1] !== "]") { io.err("bash: [: missing `]'"); return 2; }
      return evalTest.call(this, proc, args.slice(0, -1), io, "[");
    },
    async true() { return 0; },
    async false() { return 1; },
    async help(proc, args, io) {
      io.notice("Simulated Linux shell (LiaScript template linux-shell). man <command> shows a short manual page.");
      io.notice("Shell builtins: " + Object.keys(BUILTINS).filter(n => /^[a-z]/.test(n)).sort().join(" "));
      io.notice("Programs: " + Object.keys(COMMANDS).sort().join(" "));
      return 0;
    },
    async jobs(proc, args, io) {
      for (const job of proc.jobs) {
        const p = this.procs.get(job.pid);
        const state = !p || p.exitCode !== null ? "Done" : p.state === "T" ? "Stopped" : "Running";
        const mark = job === proc.jobs[proc.jobs.length - 1] ? "+" : job === proc.jobs[proc.jobs.length - 2] ? "-" : " ";
        io.out(`[${job.id}]${mark}  ${state.padEnd(23)} ${job.command}${state === "Running" ? " &" : ""}`);
      }
      return 0;
    },
    async fg(proc, args, io) {
      const job = jobSpec(proc, args[0], io, "fg"); if (!job) return 1;
      const p = this.procs.get(job.pid);
      io.out(job.command);
      if (p.state === "T") { p.state = "S"; if (p.wake) p.wake("cont"); }
      job.foreground = true;
      const status = await waitForProcess(this, p);
      proc.jobs = proc.jobs.filter(j => j !== job);
      if (p.exitCode !== null) this.reap(p);
      return status;
    },
    async bg(proc, args, io) {
      const job = jobSpec(proc, args[0], io, "bg"); if (!job) return 1;
      const p = this.procs.get(job.pid);
      if (p.state === "T") { p.state = "S"; if (p.wake) p.wake("cont"); }
      io.out(`[${job.id}]+ ${job.command} &`);
      return 0;
    },
    async wait(proc, args, io) {
      const targets = args.length ? args.map(a => jobSpec(proc, a, io, "wait")).filter(Boolean) : [...proc.jobs];
      let status = 0;
      for (const job of targets) {
        const p = this.procs.get(job.pid);
        if (p) status = await waitForProcess(this, p);
        proc.jobs = proc.jobs.filter(j => j !== job);
        if (p && p.exitCode !== null) this.reap(p);
      }
      return status;
    },
    async kill(proc, args, io) {
      let sig = SIGNALS.TERM;
      const targets = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-l") { io.out(Object.entries(SIGNALS).sort((x, y) => x[1] - y[1]).map(([n, v]) => `${v}) SIG${n}`).join("  ")); return 0; }
        if (a === "-s") { sig = parseSignal(args[++i]); if (sig === null) { io.err(`bash: kill: ${args[i]}: invalid signal specification`); return 1; } continue; }
        if (/^-/.test(a) && a.length > 1 && !targets.length) { sig = parseSignal(a.slice(1)); if (sig === null) { io.err(`bash: kill: ${a}: invalid signal specification`); return 1; } continue; }
        targets.push(a);
      }
      if (!targets.length) { io.err("bash: kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]"); return 2; }
      let status = 0;
      for (const t of targets) {
        let pid;
        if (t.startsWith("%")) { const job = jobSpec(proc, t, io, "kill"); if (!job) { status = 1; continue; } pid = job.pid; }
        else if (/^\d+$/.test(t)) pid = Number(t);
        else { io.err(`bash: kill: ${t}: arguments must be process or job IDs`); status = 1; continue; }
        try { this.signal(proc, pid, sig); }
        catch (error) {
          if (error.code === "ESRCH") io.err(`bash: kill: (${pid}) - No such process`);
          else io.err(`bash: kill: (${pid}) - Operation not permitted`);
          status = 1;
        }
      }
      return status;
    }
  };

  function parseSignal(spec) {
    if (spec === undefined) return null;
    if (/^\d+$/.test(spec)) return SIGNAL_NAMES[Number(spec)] ? Number(spec) : null;
    const name = spec.toUpperCase().replace(/^SIG/, "");
    return SIGNALS[name] ?? null;
  }

  function jobSpec(proc, spec, io, cmd) {
    let job;
    if (spec === undefined || spec === "%%" || spec === "%+") job = proc.jobs[proc.jobs.length - 1];
    else if (spec === "%-") job = proc.jobs[proc.jobs.length - 2];
    else if (/^%\d+$/.test(spec)) job = proc.jobs.find(j => j.id === Number(spec.slice(1)));
    else if (/^\d+$/.test(spec)) job = proc.jobs.find(j => j.pid === Number(spec));
    else if (spec.startsWith("%")) job = proc.jobs.find(j => j.command.startsWith(spec.slice(1)));
    if (!job) { io.err(`bash: ${cmd}: ${spec === undefined ? "current" : spec}: no such job`); return null; }
    return job;
  }

  function waitForProcess(sys, proc) {
    if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
    return new Promise(resolve => {
      const previous = proc.onExit;
      proc.onExit = code => { if (previous) previous(code); resolve(code); };
    });
  }

  function evalTest(proc, args, io, cmd) {
    const unary = (op, path) => {
      let r;
      try { r = this.stat(proc, path); } catch { return op === "!" ? 0 : 1; }
      const { inode } = r;
      switch (op) {
        case "-e": return 0;
        case "-f": return inode.type === "file" ? 0 : 1;
        case "-d": return inode.type === "dir" ? 0 : 1;
        case "-L": case "-h": { try { return this.stat(proc, path, false).inode.type === "link" ? 0 : 1; } catch { return 1; } }
        case "-s": return inode.type === "file" && (inode.generate ? inode.generate() : inode.data).length ? 0 : 1;
        case "-r": return this.mayAccess(proc, inode, "r") ? 0 : 1;
        case "-w": return this.mayAccess(proc, inode, "w") ? 0 : 1;
        case "-x": return this.mayAccess(proc, inode, "x") ? 0 : 1;
        case "-O": return inode.uid === proc.uid ? 0 : 1;
        case "-G": return inode.gid === proc.gid ? 0 : 1;
        default: return null;
      }
    };
    if (!args.length) return 1;
    if (args[0] === "!" && args.length > 1) { const r = evalTest.call(this, proc, args.slice(1), io, cmd); return r === 0 ? 1 : r === 1 ? 0 : r; }
    if (args.length === 1) return args[0] === "" ? 1 : 0;
    if (args.length === 2) {
      if (args[0] === "-z") return args[1] === "" ? 0 : 1;
      if (args[0] === "-n") return args[1] === "" ? 1 : 0;
      const r = unary(args[0], args[1]);
      if (r === null) { io.err(`bash: ${cmd}: ${args[0]}: unary operator expected`); return 2; }
      return r;
    }
    if (args.length === 3) {
      const [a, op, b] = args;
      const n = v => /^-?\d+$/.test(v) ? Number(v) : NaN;
      switch (op) {
        case "=": case "==": return a === b ? 0 : 1;
        case "!=": return a !== b ? 0 : 1;
        case "-eq": return n(a) === n(b) ? 0 : 1;
        case "-ne": return n(a) !== n(b) ? 0 : 1;
        case "-gt": return n(a) > n(b) ? 0 : 1;
        case "-ge": return n(a) >= n(b) ? 0 : 1;
        case "-lt": return n(a) < n(b) ? 0 : 1;
        case "-le": return n(a) <= n(b) ? 0 : 1;
        case "-a": return evalTest.call(this, proc, [a], io, cmd) === 0 && evalTest.call(this, proc, [b], io, cmd) === 0 ? 0 : 1;
        default: io.err(`bash: ${cmd}: ${op}: binary operator expected`); return 2;
      }
    }
    io.err(`bash: ${cmd}: too many arguments`);
    return 2;
  }

  // ---------------------------------------------------------------- programs (each runs as its own process)

  function gnuError(io, cmd, text) { io.err(`${cmd}: ${text}`); }
  const q = s => `'${s}'`;

  // The texts a filter works on: the named files, or the standard input of a pipe / < redirection ("-" too).
  // null when there is neither (the keyboard is not available in the simulation).
  function inputsOf(sys, proc, io, operands, cmd) {
    const list = [];
    if (!operands.length) {
      if (io.stdin === undefined) { io.notice(`(${cmd} without a file reads from the keyboard – in the simulation use a file or a pipe.)`); return null; }
      return [{ name: "-", text: io.stdin }];
    }
    for (const path of operands) {
      if (path === "-") { list.push({ name: "-", text: io.stdin ?? "" }); continue; }
      try { list.push({ name: path, text: sys.readFile(proc, path) }); }
      catch (error) { gnuError(io, cmd, `${path}: ${error.message}`); list.push({ name: path, error: true }); }
    }
    return list;
  }
  const linesOf = text => text === "" ? [] : text.replace(/\n$/, "").split("\n");

  function human(n) {
    if (n < 1024) return String(n);
    const units = ["K", "M", "G"];
    let v = n, u = -1;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + units[u];
  }

  let inodeCounter = 1000;
  const inodeNumber = inode => inode.ino || (inode.ino = ++inodeCounter);
  const sizeOf = inode => inode.type === "dir" ? 4096 : inode.type === "link" ? inode.target.length : (inode.generate ? inode.generate() : inode.data).length;

  const COMMANDS = {
    async ls(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "lah1dRrtSFAinpU", longs: { all: "a", "almost-all": "A", "human-readable": "h", recursive: "R", reverse: "r", classify: "F", inode: "i", "numeric-uid-gid": "n", directory: "d" } }); }
      catch (error) { gnuError(io, "ls", error.message); return 2; }
      const { flags } = opts;
      const paths = opts.operands.length ? opts.operands : ["."];
      let status = 0;
      const listings = [];
      const visible = n => flags.has("a") || flags.has("A") || !n.startsWith(".");
      const addDir = (path, r) => {
        let names;
        try { names = this.readdir(proc, path); }
        catch (error) { gnuError(io, "ls", `cannot open directory ${q(path)}: ${error.message}`); status = 2; return; }
        const entries = names.filter(visible);
        if (flags.has("a")) entries.unshift(".", "..");
        listings.push({ path, dir: r, entries });
        if (flags.has("R")) for (const n of names) {
          const child = r.inode.children.get(n);
          if (child && child.type === "dir" && visible(n)) addDir(joinPath(path, n), { inode: child, parent: r.inode });
        }
      };
      for (const path of paths) {
        try {
          const r = this.stat(proc, path);
          if (r.inode.type === "dir" && !flags.has("d")) addDir(path, r);
          else listings.push({ path, file: r });
        } catch (error) {
          gnuError(io, "ls", `cannot access ${q(path)}: ${error.message}`);
          status = 2;
        }
      }
      const now = this.clock.now();
      const classify = inode => (flags.has("F") || flags.has("p")) && inode.type === "dir" ? "/" : flags.has("F") ? (inode.type === "link" ? "@" : inode.mode & 0o111 ? "*" : "") : "";
      const paint = (name, inode) => {
        const colored = !io.color ? name
          : inode.type === "dir" ? `\x1b[1;34m${name}\x1b[0m`
          : inode.type === "link" ? `\x1b[1;36m${name}\x1b[0m`
          : inode.mode & 0o111 ? `\x1b[1;32m${name}\x1b[0m` : name;
        return (flags.has("i") ? `${String(inodeNumber(inode)).padStart(7)} ` : "") + colored + classify(inode);
      };
      // long format: column widths come from the widest entry of each listing, like GNU ls
      const cells = (name, inode) => ({
        name, inode,
        mode: modeString(inode),
        links: String(inode.type === "dir" ? 2 + [...inode.children.values()].filter(c => c.type === "dir").length : 1),
        owner: flags.has("n") ? String(inode.uid) : String(this.userByUid(inode.uid)?.name ?? inode.uid),
        group: flags.has("n") ? String(inode.gid) : String(this.groupByGid(inode.gid)?.name ?? inode.gid),
        size: flags.has("h") ? human(sizeOf(inode)) : String(sizeOf(inode)),
        date: fmtDate(inode.mtime, now)
      });
      const longLines = rows => {
        const w = key => Math.max(...rows.map(r => r[key].length));
        return rows.map(r => `${r.mode} ${r.links.padStart(w("links"))} ${r.owner.padEnd(w("owner"))} ${r.group.padEnd(w("group"))} ${r.size.padStart(w("size"))} ${r.date} ${paint(r.name, r.inode)}${r.inode.type === "link" ? " -> " + r.inode.target : ""}`);
      };
      // -S by size, -t by time, -U unsorted, -r reversed
      const order = (names, inodeOf) => {
        const list = [...names];
        if (flags.has("S")) list.sort((a, b) => sizeOf(inodeOf(b)) - sizeOf(inodeOf(a)) || a.localeCompare(b));
        else if (flags.has("t")) list.sort((a, b) => inodeOf(b).mtime - inodeOf(a).mtime || a.localeCompare(b));
        if (flags.has("r")) list.reverse();
        return list;
      };
      const print = (names, inodeOf) => {
        if (flags.has("l")) { for (const text of longLines(names.map(n => cells(n, inodeOf(n))))) io.out(text); }
        // one name per line when the output is not a terminal (a pipe or a file), like GNU ls
        else if (flags.has("1") || io.piped) { for (const n of names) io.out(paint(n, inodeOf(n))); }
        else if (names.length) io.out(names.map(n => paint(n, inodeOf(n))).join("  "));
      };
      const files = listings.filter(l => l.file);
      if (files.length) {
        const inodeOf = p => files.find(l => l.path === p).file.inode;
        print(order(files.map(l => l.path), inodeOf), inodeOf);
      }
      listings.filter(l => l.dir).forEach((l, index) => {
        if (listings.length > 1 || flags.has("R")) io.out(`${files.length || index ? "\n" : ""}${l.path}:`);
        const inodeOf = n => n === "." ? l.dir.inode : n === ".." ? (l.dir.parent || this.rootInode) : l.dir.inode.children.get(n);
        const entries = order(l.entries, inodeOf);
        if (flags.has("l")) io.notice(`total ${entries.reduce((s, n) => s + (inodeOf(n).type === "dir" ? 4 : Math.ceil(((inodeOf(n).data || "").length) / 4096) * 4), 0)}`);
        print(entries, inodeOf);
      });
      return status;
    },

    async cat(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "nbAETsv", longs: { number: "n", "number-nonblank": "b", "show-all": "A", "show-ends": "E", "show-tabs": "T", "squeeze-blank": "s" } }); } catch (error) { gnuError(io, "cat", error.message); return 1; }
      const inputs = inputsOf(this, proc, io, opts.operands, "cat");
      if (!inputs) return 0;
      const f = opts.flags;
      const showEnds = f.has("A") || f.has("E"), showTabs = f.has("A") || f.has("T");
      const plain = !f.has("n") && !f.has("b") && !showEnds && !showTabs && !f.has("s");
      let status = 0, n = 1, blank = false;
      for (const input of inputs) {
        if (input.error) { status = 1; continue; }
        if (plain) { io.write(input.text); continue; }
        for (let l of linesOf(input.text)) {
          if (f.has("s")) { if (l === "" && blank) continue; blank = l === ""; }
          const empty = l === "";
          if (showTabs) l = l.replace(/\t/g, "^I");
          if (showEnds) l += "$";
          if (f.has("n") || (f.has("b") && !empty)) l = `${String(n++).padStart(6)}\t${l}`;
          io.out(l);
        }
      }
      return status;
    },
    async less(proc, args, io) { return COMMANDS.cat.call(this, proc, args.filter(a => !a.startsWith("-")), io); },
    async more(proc, args, io) { return COMMANDS.cat.call(this, proc, args.filter(a => !a.startsWith("-")), io); },

    async echo(proc, args, io) {
      let newline = true, escapes = false;
      while (args.length && /^-[neE]+$/.test(args[0])) { const a = args.shift(); if (a.includes("n")) newline = false; if (a.includes("e")) escapes = true; if (a.includes("E")) escapes = false; }
      let text = args.join(" ");
      if (escapes) text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
      io.write(text + (newline ? "\n" : ""));
      return 0;
    },
    async printf(proc, args, io) {
      if (!args.length) { gnuError(io, "printf", "usage: printf format [arguments]"); return 1; }
      let i = 0;
      const ESC = { n: "\n", t: "\t", r: "\r", a: "\x07", "\\": "\\", '"': '"', "'": "'" };
      const text = args[0].replace(/\\(.)/g, (m, c) => ESC[c] ?? m).replace(/%(%|-?\d*(?:\.\d+)?[sdifxXc])/g, (m, spec) => {
        if (spec === "%") return "%";
        const v = args[1 + i++] ?? "";
        const kind = spec.slice(-1), left = spec.startsWith("-"), width = parseInt(spec.replace(/^-/, ""), 10) || 0, precision = /\.(\d+)/.exec(spec);
        let out;
        if (kind === "s") out = precision ? v.slice(0, Number(precision[1])) : v;
        else if (kind === "c") out = v.slice(0, 1);
        else if (kind === "f") out = Number(v || 0).toFixed(precision ? Number(precision[1]) : 6);
        else if (kind === "x" || kind === "X") { out = (Math.trunc(Number(v)) || 0).toString(16); if (kind === "X") out = out.toUpperCase(); }
        else out = String(Math.trunc(Number(v)) || 0);
        return left ? out.padEnd(width) : out.padStart(width);
      });
      io.write(text); return 0;
    },

    async mkdir(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "pv", values: "m", longs: { parents: "p", mode: "m", verbose: "v" } }); } catch (error) { gnuError(io, "mkdir", error.message); return 1; }
      if (!opts.operands.length) { gnuError(io, "mkdir", "missing operand"); return 1; }
      if (opts.values.m !== undefined && !/^[0-7]{3,4}$/.test(opts.values.m)) { gnuError(io, "mkdir", `invalid mode: ${q(opts.values.m)}`); return 1; }
      let status = 0;
      for (const path of opts.operands) {
        try {
          this.mkdir(proc, path, { parents: opts.flags.has("p") });
          if (opts.values.m !== undefined) this.chmod(proc, path, parseInt(opts.values.m, 8));
          if (opts.flags.has("v")) io.out(`mkdir: created directory ${q(path)}`);
        }
        catch (error) {
          if (error.code === "EEXIST" && opts.flags.has("p")) continue;
          gnuError(io, "mkdir", `cannot create directory ${q(path)}: ${error.message}`); status = 1;
        }
      }
      return status;
    },

    async touch(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "acm", longs: { "no-create": "c" } }); } catch (error) { gnuError(io, "touch", error.message); return 1; }
      if (!opts.operands.length) { gnuError(io, "touch", "missing file operand"); return 1; }
      let status = 0;
      for (const path of opts.operands) {
        try {
          if (opts.flags.has("c") && !this.resolve(proc, path).inode) continue;
          this.touch(proc, path);
        }
        catch (error) { gnuError(io, "touch", `cannot touch ${q(path)}: ${error.message}`); status = 1; }
      }
      return status;
    },

    async rm(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "rRfivd", longs: { recursive: "r", force: "f", interactive: "i", verbose: "v", dir: "d" } }); } catch (error) { gnuError(io, "rm", error.message); return 1; }
      if (!opts.operands.length) { gnuError(io, "rm", "missing operand"); return 1; }
      let status = 0;
      for (const path of opts.operands) {
        try {
          const r = this.resolve(proc, path, { follow: false });
          if (!r.inode) throw new SysError("ENOENT", path);
          if (opts.flags.has("i") && !opts.flags.has("f")) {
            const kind = r.inode.type === "dir" ? "directory" : r.inode.type === "link" ? "symbolic link" : r.inode.data.length ? "regular file" : "regular empty file";
            const answer = await io.readLine({ prompt: `rm: remove ${kind} ${q(path)}? `, echo: true });
            if (!/^[yYjJ]/.test(answer)) continue;
          }
          if (r.inode.type === "dir") {
            if (opts.flags.has("d") && !(opts.flags.has("r") || opts.flags.has("R"))) { this.rmdir(proc, path); }
            else {
              if (!(opts.flags.has("r") || opts.flags.has("R"))) { gnuError(io, "rm", `cannot remove ${q(path)}: Is a directory`); status = 1; continue; }
              if (r.inode === this.rootInode) { gnuError(io, "rm", "it is dangerous to operate recursively on '/'"); status = 1; continue; }
              this.removeTree(proc, path);
            }
          } else this.unlink(proc, path);
          if (opts.flags.has("v")) io.out(`removed ${q(path)}`);
        } catch (error) {
          if (error.code === "ENOENT" && opts.flags.has("f")) continue;
          gnuError(io, "rm", `cannot remove ${q(path)}: ${error.message}`); status = 1;
        }
      }
      return status;
    },

    async rmdir(proc, args, io) {
      let status = 0;
      for (const path of args) {
        try { this.rmdir(proc, path); }
        catch (error) { gnuError(io, "rmdir", `failed to remove ${q(path)}: ${error.message}`); status = 1; }
      }
      return status;
    },

    async cp(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "rRvinpa", longs: { recursive: "r", verbose: "v", interactive: "i", "no-clobber": "n" } }); } catch (error) { gnuError(io, "cp", error.message); return 1; }
      if (opts.operands.length < 2) { gnuError(io, "cp", opts.operands.length ? `missing destination file operand after ${q(opts.operands[0])}` : "missing file operand"); return 1; }
      const dest = opts.operands.pop();
      let status = 0;
      for (const src of opts.operands) {
        try {
          const srcStat = this.stat(proc, src);
          if (srcStat.inode.type === "dir" && !(opts.flags.has("r") || opts.flags.has("R") || opts.flags.has("a"))) { gnuError(io, "cp", `-r not specified; omitting directory ${q(src)}`); status = 1; continue; }
          const target = this.targetPath(proc, src, dest);
          if (target.inode && target.inode.type !== "dir") {
            if (opts.flags.has("n")) continue;
            if (opts.flags.has("i")) { const answer = await io.readLine({ prompt: `cp: overwrite ${q(target.display)}? `, echo: true }); if (!/^[yYjJ]/.test(answer)) continue; }
          }
          this.copy(proc, src, dest, { recursive: true });
          if (opts.flags.has("v")) io.out(`${q(src)} -> ${q(target.display)}`);
        } catch (error) {
          gnuError(io, "cp", `cannot ${error.code === "ENOENT" && error.path === src ? "stat" : "create regular file"} ${q(error.path === src ? src : dest)}: ${error.message}`); status = 1;
        }
      }
      return status;
    },

    async mv(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "vinf", longs: { verbose: "v", interactive: "i", "no-clobber": "n", force: "f" } }); } catch (error) { gnuError(io, "mv", error.message); return 1; }
      if (opts.operands.length < 2) { gnuError(io, "mv", opts.operands.length ? `missing destination file operand after ${q(opts.operands[0])}` : "missing file operand"); return 1; }
      const dest = opts.operands.pop();
      let status = 0;
      for (const src of opts.operands) {
        try {
          const target = this.targetPath(proc, src, dest);
          if (target.inode && target.inode.type !== "dir") {
            if (opts.flags.has("n")) continue;
            if (opts.flags.has("i") && !opts.flags.has("f")) { const answer = await io.readLine({ prompt: `mv: overwrite ${q(target.display)}? `, echo: true }); if (!/^[yYjJ]/.test(answer)) continue; }
          }
          this.rename(proc, src, dest);
          if (opts.flags.has("v")) io.out(`renamed ${q(src)} -> ${q(target.display)}`);
        }
        catch (error) { gnuError(io, "mv", `cannot move ${q(src)} to ${q(dest)}: ${error.message}`); status = 1; }
      }
      return status;
    },

    async ln(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "sfv", longs: { symbolic: "s", force: "f" } }); } catch (error) { gnuError(io, "ln", error.message); return 1; }
      if (!opts.flags.has("s")) { gnuError(io, "ln", "hard links are not available in the simulation; use ln -s"); return 1; }
      if (opts.operands.length !== 2) { gnuError(io, "ln", "missing file operand"); return 1; }
      try {
        if (opts.flags.has("f")) { const r = this.resolve(proc, opts.operands[1], { follow: false }); if (r.inode && r.inode.type !== "dir") this.unlink(proc, opts.operands[1]); }
        this.symlink(proc, opts.operands[0], opts.operands[1]); return 0;
      }
      catch (error) { gnuError(io, "ln", `failed to create symbolic link ${q(opts.operands[1])}: ${error.message}`); return 1; }
    },
    async readlink(proc, args, io) {
      try { const { inode } = this.stat(proc, args[0], false); if (inode.type !== "link") return 1; io.out(inode.target); return 0; } catch { return 1; }
    },

    async head(proc, args, io) { return headTail.call(this, proc, args, io, "head"); },
    async tail(proc, args, io) { return headTail.call(this, proc, args, io, "tail"); },

    async wc(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "lwcmL", longs: { lines: "l", words: "w", bytes: "c", chars: "m", "max-line-length": "L" } }); } catch (error) { gnuError(io, "wc", error.message); return 1; }
      const which = opts.flags.size ? [...opts.flags] : ["l", "w", "c"];
      const inputs = inputsOf(this, proc, io, opts.operands, "wc");
      if (!inputs) return 0;
      let status = 0, totals = { l: 0, w: 0, m: 0, c: 0, L: 0 };
      // like GNU wc: columns are padded for files, a single count from a pipe stands alone
      const bare = !opts.operands.length && which.length === 1;
      const fmt = (counts, name) => io.out(["l", "w", "m", "c", "L"].filter(k => which.includes(k)).map(k => bare ? String(counts[k]) : String(counts[k]).padStart(7)).join("") + (name && name !== "-" ? " " + name : ""));
      for (const input of inputs) {
        if (input.error) { status = 1; continue; }
        const text = input.text;
        // a binary file is a byte string: one char per byte
        let binary = false;
        if (input.name && input.name !== "-") { try { binary = Boolean(this.stat(proc, input.name).inode.binary); } catch { binary = false; } }
        const counts = { l: (text.match(/\n/g) || []).length, w: text.split(/\s+/).filter(Boolean).length, m: [...text].length, c: binary ? text.length : new TextEncoder().encode(text).length, L: Math.max(0, ...text.split("\n").map(l => [...l].length)) };
        totals.L = Math.max(totals.L, counts.L);
        for (const k of ["l", "w", "m", "c"]) totals[k] += counts[k];
        fmt(counts, input.name);
      }
      if (opts.operands.length > 1) fmt(totals, "total");
      return status;
    },

    async grep(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "invrcEwlohHqsF", values: "ABC", longs: { "ignore-case": "i", recursive: "r", count: "c", "only-matching": "o", quiet: "q", silent: "q", "no-messages": "s", "line-number": "n", "invert-match": "v", "fixed-strings": "F" } }); } catch (error) { gnuError(io, "grep", error.message); return 2; }
      if (!opts.operands.length) { io.err("Usage: grep [OPTION]... PATTERNS [FILE]..."); return 2; }
      const [pattern, ...paths] = opts.operands;
      const f = opts.flags;
      let re;
      const source = f.has("F") ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : f.has("E") ? pattern : breToJs(pattern);
      try { re = new RegExp(f.has("w") ? `\\b(?:${source})\\b` : source, f.has("i") ? "gi" : "g"); }
      catch { gnuError(io, "grep", `Invalid regular expression: ${pattern}`); return 2; }
      const after = Number(opts.values.A ?? opts.values.C ?? 0), before = Number(opts.values.B ?? opts.values.C ?? 0);
      const files = [];
      const collect = (path, inode) => {
        if (inode.type === "dir") { for (const name of [...inode.children.keys()].sort()) collect(joinPath(path, name), inode.children.get(name)); }
        else files.push(path);
      };
      let status = 1;
      let stdinText = null;
      if (!paths.length) {
        if (f.has("r")) paths.push(".");
        else if (io.stdin !== undefined) stdinText = io.stdin;
        else { io.notice("(grep without a file reads from the keyboard – in the simulation use a file or a pipe.)"); return 2; }
      }
      for (const path of paths) {
        if (path === "-") { stdinText = io.stdin ?? ""; files.push("-"); continue; }
        try {
          const r = this.stat(proc, path);
          if (r.inode.type === "dir") { if (!f.has("r")) { gnuError(io, "grep", `${path}: Is a directory`); continue; } collect(path, r.inode); }
          else files.push(path);
        } catch (error) { if (!f.has("s")) gnuError(io, "grep", `${path}: ${error.message}`); status = 2; }
      }
      if (stdinText !== null && !files.includes("-")) files.push("-");
      const prefix = f.has("H") || (!f.has("h") && (files.length > 1 || f.has("r")));
      const matches = l => { re.lastIndex = 0; return re.test(l); };
      for (const file of files) {
        let text;
        if (file === "-") text = stdinText ?? "";
        else { try { text = this.readFile(proc, file); } catch (error) { if (!f.has("s")) gnuError(io, "grep", `${file}: ${error.message}`); status = 2; continue; } }
        const lines = linesOf(text);
        const hits = lines.map(l => matches(l) !== f.has("v"));
        const count = hits.filter(Boolean).length;
        if (count) status = status === 2 ? 2 : 0;
        if (f.has("q")) { if (count) return 0; continue; }
        if (f.has("c")) { io.out(`${prefix ? file + ":" : ""}${count}`); continue; }
        if (f.has("l")) { if (count) io.out(file); continue; }
        const label = (i, sep) => `${prefix ? (file === "-" ? "(standard input)" : file) + sep : ""}${f.has("n") ? (i + 1) + sep : ""}`;
        if (f.has("o")) {
          lines.forEach((l, i) => { if (!hits[i] || f.has("v")) return; re.lastIndex = 0; for (const m of l.matchAll(re)) if (m[0]) io.out(label(i, ":") + m[0]); });
          continue;
        }
        let lastPrinted = -1;
        lines.forEach((l, i) => {
          if (!hits[i]) return;
          const from = Math.max(0, i - before, lastPrinted + 1), to = Math.min(lines.length - 1, i + after);
          if ((before || after) && lastPrinted >= 0 && from > lastPrinted + 1) io.out("--");
          for (let j = from; j <= to; j++) { if (j <= lastPrinted) continue; io.out(label(j, hits[j] ? ":" : "-") + lines[j]); lastPrinted = j; }
        });
      }
      return status;
    },

    async find(proc, args, io, ctx) {
      const paths = [];
      let i = 0;
      while (i < args.length && !args[i].startsWith("-") && args[i] !== "!") paths.push(args[i++]);
      if (!paths.length) paths.push(".");
      const tests = [], actions = [];
      let maxdepth = Infinity, mindepth = 0, negate = false;
      const add = test => { tests.push(negate ? (n, inode, depth) => !test(n, inode, depth) : test); negate = false; };
      const compare = (spec, value) => spec.startsWith("+") ? value > Number(spec.slice(1)) : spec.startsWith("-") ? value < Number(spec.slice(1)) : value === Number(spec);
      for (; i < args.length; i++) {
        const a = args[i];
        if (a === "!" || a === "-not") { negate = !negate; continue; }
        if (a === "-name" || a === "-iname") { const re = globToRegExp(args[++i] ?? ""); add(name => a === "-iname" ? new RegExp(re.source, "i").test(name) : re.test(name)); }
        else if (a === "-type") { const t = args[++i]; add((name, inode) => (t === "f" && inode.type === "file") || (t === "d" && inode.type === "dir") || (t === "l" && inode.type === "link")); }
        else if (a === "-maxdepth") maxdepth = Number(args[++i]);
        else if (a === "-mindepth") mindepth = Number(args[++i]);
        else if (a === "-user") { const u = args[++i]; add((name, inode) => this.userByUid(inode.uid)?.name === u); }
        else if (a === "-group") { const g = args[++i]; add((name, inode) => this.groupByGid(inode.gid)?.name === g); }
        else if (a === "-perm") { const p = args[++i]; const want = parseInt(p.replace(/^[-/]/, ""), 8); add((name, inode) => p.startsWith("-") ? (inode.mode & want) === want : p.startsWith("/") ? (inode.mode & want) !== 0 : (inode.mode & 0o7777) === want); }
        else if (a === "-empty") add((name, inode) => inode.type === "dir" ? inode.children.size === 0 : !inode.data.length);
        else if (a === "-size") {
          // +1k larger than 1 KiB, -10M smaller than 10 MiB, 5c exactly 5 bytes, 3 = 3 blocks of 512 bytes
          const spec = args[++i] ?? "";
          const m = /^([+-]?)(\d+)([ckMG]?)$/.exec(spec);
          if (!m) { gnuError(io, "find", `invalid argument \`${spec}' to \`-size'`); return 1; }
          const unit = { c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3, "": 512 }[m[3]];
          add((name, inode) => compare(m[1] + m[2], Math.ceil(sizeOf(inode) / unit)));
        }
        else if (a === "-mtime" || a === "-mmin") {
          const spec = args[++i] ?? "";
          const divisor = a === "-mtime" ? 86400000 : 60000;
          add((name, inode) => compare(spec, Math.floor((this.clock.now() - inode.mtime) / divisor)));
        }
        else if (a === "-newer") { const ref = this.stat(proc, args[++i]).inode; add((name, inode) => inode.mtime > ref.mtime); }
        else if (a === "-print") { /* default action */ }
        else if (a === "-delete") actions.push({ kind: "delete" });
        else if (a === "-exec") {
          // -exec command {} \;   ({} is the current path; "+" is treated like ";")
          const cmd = [];
          while (++i < args.length && args[i] !== ";" && args[i] !== "+") cmd.push(args[i]);
          if (!cmd.length) { gnuError(io, "find", "missing argument to `-exec'"); return 1; }
          actions.push({ kind: "exec", cmd });
        }
        else { gnuError(io, "find", `unknown predicate \`${a}'`); return 1; }
      }
      let status = 0;
      const found = [];
      const walk = (path, inode, depth) => {
        const name = path.split("/").filter(Boolean).pop() ?? path;
        if (depth >= mindepth && tests.every(t => t(name, inode, depth))) { if (actions.length) found.push(path); else io.out(path); }
        if (inode.type !== "dir" || depth >= maxdepth) return;
        if (!this.mayAccess(proc, inode, "r") || !this.mayAccess(proc, inode, "x")) { gnuError(io, "find", `${q(path)}: Permission denied`); status = 1; return; }
        for (const child of [...inode.children.keys()].sort()) walk(joinPath(path, child), inode.children.get(child), depth + 1);
      };
      for (const path of paths) {
        try { walk(path, this.stat(proc, path).inode, 0); }
        catch (error) { gnuError(io, "find", `${q(path)}: ${error.message}`); status = 1; }
      }
      for (const path of found) for (const action of actions) {
        if (action.kind === "delete") {
          try { const r = this.resolve(proc, path, { follow: false }); if (r.inode && r.inode.type === "dir") this.rmdir(proc, path); else this.unlink(proc, path); }
          catch (error) { gnuError(io, "find", `cannot delete ${q(path)}: ${error.message}`); status = 1; }
        } else {
          const words = action.cmd.map(w => w.split("{}").join(path));
          const code = await this.execute(ctx.shell, words, io, { line: words.join(" ") });
          if (code !== 0) status = 1;
        }
      }
      return status;
    },

    async tree(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "adF", values: "L" }); } catch (error) { gnuError(io, "tree", error.message); return 1; }
      const root = opts.operands[0] ?? ".";
      const maxLevel = opts.values.L !== undefined ? Number(opts.values.L) : Infinity;
      let dirs = 0, files = 0;
      const walk = (inode, prefix, level) => {
        const names = [...inode.children.keys()].filter(n => (opts.flags.has("a") || !n.startsWith(".")) && (!opts.flags.has("d") || inode.children.get(n).type === "dir")).sort();
        names.forEach((name, i) => {
          const child = inode.children.get(name), last = i === names.length - 1;
          io.out(`${prefix}${last ? "└── " : "├── "}${name}${opts.flags.has("F") && child.type === "dir" ? "/" : ""}${child.type === "link" ? " -> " + child.target : ""}`);
          if (child.type === "dir") { dirs++; if (level < maxLevel && this.mayAccess(proc, child, "r")) walk(child, prefix + (last ? "    " : "│   "), level + 1); }
          else files++;
        });
      };
      try {
        const { inode } = this.stat(proc, root);
        io.out(root);
        if (inode.type === "dir") { this.check(proc, inode, "r", root); walk(inode, "", 1); }
        io.out(`\n${dirs} director${dirs === 1 ? "y" : "ies"}${opts.flags.has("d") ? "" : `, ${files} file${files === 1 ? "" : "s"}`}`);
        return 0;
      } catch (error) { io.out(`${root} [error opening dir]`); return 1; }
    },

    async sort(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "rnufbh", values: "kt", longs: { reverse: "r", "numeric-sort": "n", unique: "u", "ignore-case": "f" } }); } catch (error) { gnuError(io, "sort", error.message); return 2; }
      let lines = [];
      const inputs = inputsOf(this, proc, io, opts.operands, "sort");
      if (!inputs) return 0;
      for (const input of inputs) { if (input.error) return 2; lines.push(...linesOf(input.text)); }
      // -k N sorts by field N (1-based), fields split by -t SEPARATOR or whitespace
      const field = Number(String(opts.values.k ?? "0").split(",")[0]);
      const key = l => {
        let v = l;
        if (field > 0) { const parts = opts.values.t !== undefined ? l.split(opts.values.t) : l.trim().split(/\s+/); v = parts[field - 1] ?? ""; }
        if (opts.flags.has("b")) v = v.replace(/^\s+/, "");
        return opts.flags.has("f") ? v.toLowerCase() : v;
      };
      const numeric = opts.flags.has("n") || opts.flags.has("h");
      lines.sort((a, b) => numeric ? (parseFloat(key(a)) || 0) - (parseFloat(key(b)) || 0) || key(a).localeCompare(key(b)) : key(a).localeCompare(key(b)));
      if (opts.flags.has("r")) lines.reverse();
      if (opts.flags.has("u")) lines = lines.filter((l, i) => lines.findIndex(x => key(x) === key(l)) === i);
      for (const l of lines) io.out(l);
      return 0;
    },
    async uniq(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "cdui", longs: { count: "c", repeated: "d", unique: "u", "ignore-case": "i" } }); } catch (error) { gnuError(io, "uniq", error.message); return 1; }
      const inputs = inputsOf(this, proc, io, opts.operands.slice(0, 1), "uniq");
      if (!inputs) return 0;
      if (inputs[0].error) return 1;
      const lines = linesOf(inputs[0].text);
      const same = (a, b) => opts.flags.has("i") ? a.toLowerCase() === b.toLowerCase() : a === b;
      let prev = null, count = 0;
      const flush = () => {
        if (prev === null) return;
        if (opts.flags.has("d") && count < 2) return;
        if (opts.flags.has("u") && count > 1) return;
        io.out(opts.flags.has("c") ? `${String(count).padStart(7)} ${prev}` : prev);
      };
      for (const l of lines) { if (prev !== null && same(l, prev)) count++; else { flush(); prev = l; count = 1; } }
      flush();
      return 0;
    },
    async cut(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { values: "dfc", longs: { delimiter: "d", fields: "f", characters: "c" } }); } catch (error) { gnuError(io, "cut", error.message); return 1; }
      if (opts.values.f === undefined && opts.values.c === undefined) { gnuError(io, "cut", "you must specify a list of bytes, characters, or fields"); return 1; }
      const inputs = inputsOf(this, proc, io, opts.operands, "cut");
      if (!inputs) return 0;
      const ranges = spec => (spec || "").split(",").map(r => r.split("-").map(Number));
      for (const l of inputs.flatMap(input => input.error ? [] : linesOf(input.text))) {
        if (opts.values.f !== undefined) {
          const parts = l.split(opts.values.d ?? "\t");
          io.out(ranges(opts.values.f).flatMap(([a, b]) => parts.slice(a - 1, b === undefined ? a : (b || parts.length))).join(opts.values.d ?? "\t"));
        } else if (opts.values.c !== undefined) {
          io.out(ranges(opts.values.c).map(([a, b]) => l.slice(a - 1, b === undefined ? a : b)).join(""));
        }
      }
      return 0;
    },
    async tr(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "dsc", longs: { delete: "d", "squeeze-repeats": "s", complement: "c" } }); } catch (error) { gnuError(io, "tr", error.message); return 1; }
      if (io.stdin === undefined) { io.notice("(tr reads from the keyboard – in the simulation use a pipe: cat file | tr a-z A-Z)"); return 0; }
      const [set1, set2] = opts.operands;
      if (set1 === undefined) { gnuError(io, "tr", "missing operand"); return 1; }
      if (!opts.flags.has("d") && set2 === undefined && !opts.flags.has("s")) { gnuError(io, "tr", `missing operand after ${q(set1)}`); return 1; }
      const chars1 = expandCharSet(set1), chars2 = set2 !== undefined ? expandCharSet(set2) : [];
      const inSet1 = c => opts.flags.has("c") ? !chars1.includes(c) : chars1.includes(c);
      let out = "";
      let previous = null;
      for (const c of io.stdin) {
        let mapped = c;
        if (inSet1(c)) {
          if (opts.flags.has("d")) continue;
          if (chars2.length) { const index = opts.flags.has("c") ? chars2.length - 1 : Math.min(chars1.indexOf(c), chars2.length - 1); mapped = chars2[index]; }
        }
        if (opts.flags.has("s") && mapped === previous && (chars2.length ? chars2.includes(mapped) : inSet1(c))) continue;
        out += mapped;
        previous = mapped;
      }
      io.write(out);
      return 0;
    },

    async which(proc, args, io) {
      let status = 0;
      for (const name of args) { const f = this.findCommand(proc, name); if (f && !BUILTINS[name]) io.out(f); else status = 1; }
      return status;
    },
    async nano(proc, args, io, { shell }) {
      // the editor itself lives in the terminal (linux-editor.js); here: read, hand over, write back
      const path = args.filter(a => !a.startsWith("-"))[0];
      if (!io.editor) { io.notice("(nano needs the terminal of the course page – in a pipe or a test there is no editor.)"); return 1; }
      let text = "", isNew = true;
      if (path) {
        try { const r = this.resolve(shell, path); if (r.inode) { if (r.inode.type === "dir") { io.err(`nano: ${path}: Is a directory`); return 1; } text = this.readFile(shell, path); isNew = false; } }
        catch (error) { io.err(`nano: ${path}: ${error.message}`); return 1; }
      }
      const result = await io.editor({ path: path || "", text, isNew, user: shell.user });
      if (!result || result.text === undefined) return 0;
      const target = result.path || path;
      if (!target) return 0;
      try { this.writeFile(shell, target, result.text); }
      catch (error) { io.err(`[ Error writing ${target}: ${error.message} ]`); return 1; }
      return 0;
    },
    async env(proc, args, io) { for (const [k, v] of Object.entries(proc.env)) io.out(`${k}=${v}`); return 0; },
    async printenv(proc, args, io) {
      if (!args.length) return COMMANDS.env.call(this, proc, args, io);
      let status = 0;
      for (const k of args) { if (proc.env[k] !== undefined) io.out(proc.env[k]); else status = 1; }
      return status;
    },
    async clear(proc, args, io) { io.clear(); return 0; },
    async whoami(proc, args, io) { io.out(proc.user); return 0; },
    async hostname(proc, args, io) { io.out(this.hostname); return 0; },
    async uname(proc, args, io) {
      io.out(args.includes("-a") ? `Linux ${this.hostname} 6.1.0-lialinux #1 SMP x86_64 GNU/Linux (simulated)` : args.includes("-r") ? "6.1.0-lialinux" : args.includes("-n") ? this.hostname : args.includes("-m") ? "x86_64" : "Linux");
      return 0;
    },
    async date(proc, args, io) {
      const d = local(this.clock.now());
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const offset = clockOffset();
      const zone = offset === 0 ? "UTC" : `UTC${offset > 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}${offset % 60 ? ":" + pad(Math.abs(offset) % 60) : ""}`;
      const format = args.find(a => a.startsWith("+"));
      if (!format) {
        io.out(`${days[d.getUTCDay()].slice(0, 3)} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${zone} ${d.getUTCFullYear()}`);
        return 0;
      }
      const start = Date.UTC(d.getUTCFullYear(), 0, 1);
      const tokens = {
        Y: String(d.getUTCFullYear()), y: String(d.getUTCFullYear()).slice(-2), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), e: String(d.getUTCDate()).padStart(2),
        H: pad(d.getUTCHours()), I: pad(d.getUTCHours() % 12 || 12), M: pad(d.getUTCMinutes()), S: pad(d.getUTCSeconds()), p: d.getUTCHours() < 12 ? "AM" : "PM",
        A: days[d.getUTCDay()], a: days[d.getUTCDay()].slice(0, 3), B: months[d.getUTCMonth()], b: MONTHS[d.getUTCMonth()], h: MONTHS[d.getUTCMonth()],
        j: String(Math.floor((d.getTime() - start) / 86400000) + 1).padStart(3, "0"), u: String(d.getUTCDay() || 7), w: String(d.getUTCDay()),
        F: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, T: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
        R: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`, D: `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${String(d.getUTCFullYear()).slice(-2)}`,
        s: String(Math.floor(this.clock.now() / 1000)), Z: zone, z: offset === 0 ? "+0000" : `${offset > 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`, n: "\n", t: "\t", "%": "%"
      };
      io.out(format.slice(1).replace(/%(.)/g, (m, c) => tokens[c] ?? m));
      return 0;
    },
    async uptime(proc, args, io) {
      const s = Math.floor(this.uptimeSeconds());
      io.out(` ${fmtClock(this.clock.now())}:00 up ${Math.floor(s / 60)} min,  1 user,  load average: 0.00, 0.01, 0.05`);
      return 0;
    },
    async id(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "ugGnr", longs: { user: "u", group: "g", groups: "G", name: "n" } }); } catch (error) { gnuError(io, "id", error.message); return 1; }
      const who = opts.operands[0];
      const account = who !== undefined ? this.users.get(who) : this.userByUid(proc.uid);
      if (!account) { gnuError(io, "id", `${q(who)}: no such user`); return 1; }
      const gids = who !== undefined ? this.groupsOf(account) : proc.groups;
      const groupName = gid => this.groupByGid(gid)?.name ?? String(gid);
      const f = opts.flags;
      if (f.has("u")) { io.out(f.has("n") ? account.name : String(account.uid)); return 0; }
      if (f.has("g")) { io.out(f.has("n") ? groupName(account.gid) : String(account.gid)); return 0; }
      if (f.has("G")) { io.out(gids.map(gid => f.has("n") ? groupName(gid) : String(gid)).join(" ")); return 0; }
      if (f.has("n")) { gnuError(io, "id", "cannot print only names or real IDs in default format"); return 1; }
      io.out(`uid=${account.uid}(${account.name}) gid=${account.gid}(${groupName(account.gid)}) groups=${gids.map(gid => `${gid}(${groupName(gid)})`).join(",")}`);
      return 0;
    },
    async groups(proc, args, io) {
      const account = args.length ? this.users.get(args[0]) : this.userByUid(proc.uid);
      if (!account) { gnuError(io, "groups", `${q(args[0])}: no such user`); return 1; }
      const gids = args.length ? this.groupsOf(account) : proc.groups;
      io.out((args.length ? `${account.name} : ` : "") + gids.map(gid => this.groupByGid(gid)?.name ?? gid).join(" "));
      return 0;
    },

    async stat(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "L", values: "c", longs: { format: "c" } }); } catch (error) { gnuError(io, "stat", error.message); return 1; }
      let status = 0;
      for (const path of opts.operands) {
        try {
          const { inode } = this.stat(proc, path, opts.flags.has("L"));
          const size = sizeOf(inode);
          const kind = inode.type === "dir" ? "directory" : inode.type === "link" ? "symbolic link" : size ? "regular file" : "regular empty file";
          if (opts.values.c !== undefined) {
            const fields = {
              a: (inode.mode & 0o7777).toString(8), A: modeString(inode), U: this.userByUid(inode.uid)?.name ?? "?", G: this.groupByGid(inode.gid)?.name ?? "?",
              u: String(inode.uid), g: String(inode.gid), n: path, N: inode.type === "link" ? `'${path}' -> '${inode.target}'` : `'${path}'`, s: String(size), F: kind,
              y: new Date(inode.mtime).toISOString().replace("T", " ").replace("Z", ".000000000 +0000"), Y: String(Math.floor(inode.mtime / 1000)), i: String(inodeNumber(inode)), h: "1"
            };
            io.out(opts.values.c.replace(/%(.)/g, (m, c) => fields[c] ?? m));
            continue;
          }
          io.out(`  File: ${path}${inode.type === "link" ? " -> " + inode.target : ""}`);
          io.out(`  Size: ${String(size).padEnd(10)}\tBlocks: ${Math.ceil(size / 512)}          IO Block: 4096   ${kind}`);
          io.out(`Access: (${(inode.mode & 0o7777).toString(8).padStart(4, "0")}/${modeString(inode)})  Uid: (${String(inode.uid).padStart(5)}/${(this.userByUid(inode.uid)?.name ?? "?").padEnd(8)})   Gid: (${String(inode.gid).padStart(5)}/${(this.groupByGid(inode.gid)?.name ?? "?").padEnd(8)})`);
          io.out(`Modify: ${new Date(inode.mtime).toISOString().replace("T", " ").replace("Z", ".000000000 +0000")}`);
        } catch (error) { gnuError(io, "stat", `cannot statx ${q(path)}: ${error.message}`); status = 1; }
      }
      return status;
    },

    async chmod(proc, args, io) {
      let opts;
      // a mode that starts with a minus (chmod -x file, chmod -rw file) is a mode, not an option – like GNU chmod
      const modeAt = args.findIndex(a => /^-[rwxXst]+$/.test(a) || /^-[ugoa]+[-+=]/.test(a));
      const modeArg = modeAt >= 0 ? args.splice(modeAt, 1)[0] : null;
      try { opts = parseArgs(args, { flags: "Rv", longs: { recursive: "R" } }); } catch (error) { gnuError(io, "chmod", error.message); return 1; }
      if (modeArg !== null) opts.operands.unshift(modeArg);
      if (opts.operands.length < 2) { gnuError(io, "chmod", opts.operands.length ? `missing operand after ${q(opts.operands[0])}` : "missing operand"); return 1; }
      const [spec, ...paths] = opts.operands;
      let status = 0;
      const apply = (path, inode, display) => {
        const mode = applyModeSpec(spec, inode.mode, inode.type === "dir", proc.umask);
        if (mode === null) { gnuError(io, "chmod", `invalid mode: ${q(spec)}`); status = 1; return; }
        this.chmod(proc, path, mode);
        if (opts.flags.has("v")) io.out(`mode of ${q(display)} changed to ${(mode & 0o7777).toString(8).padStart(4, "0")} (${modeString(inode).slice(1)})`);
        if (opts.flags.has("R") && inode.type === "dir") for (const name of inode.children.keys()) apply(joinPath(path, name), inode.children.get(name), joinPath(display, name));
      };
      for (const path of paths) {
        try { const { inode } = this.stat(proc, path); apply(path, inode, path); }
        catch (error) {
          if (error.code === "ENOENT") gnuError(io, "chmod", `cannot access ${q(path)}: ${error.message}`);
          else gnuError(io, "chmod", `changing permissions of ${q(path)}: ${error.message}`);
          status = 1;
        }
      }
      return status;
    },

    async chown(proc, args, io) { return chownLike.call(this, proc, args, io, "chown"); },
    async chgrp(proc, args, io) { return chownLike.call(this, proc, args, io, "chgrp"); },

    async su(proc, args, io, { shell }) {
      let login = false;
      const rest = args.filter(a => { if (a === "-" || a === "-l" || a === "--login") { login = true; return false; } return true; });
      const name = rest[0] ?? "root";
      const account = this.users.get(name);
      if (!account) { io.err(`su: user ${name} does not exist or the user entry does not contain all the required fields`); return 1; }
      if (shell.uid !== 0 && !(await this.authenticate(shell, account, io, "Password: "))) { io.err("su: Authentication failure"); return 1; }
      const child = this.spawn(shell, { cmd: "bash", args: ["bash"], user: account.name, cwd: login ? account.home : shell.cwd });
      child.env.USER = account.name; child.env.LOGNAME = account.name; child.env.HOME = account.home; child.env.SHELL = account.shell;
      if (login) child.env.PWD = account.home;
      this.shell = child;
      return 0;
    },

    async sudo(proc, args, io, { shell, line }) {
      // sudo's own options end at the first word that is not an option – the rest belongs to the command
      const opts = { flags: new Set(), values: {}, operands: [] };
      let i = 0;
      for (; i < args.length; i++) {
        const a = args[i];
        if (a === "-u") { opts.values.u = args[++i]; continue; }
        if (a === "-i" || a === "-k" || a === "-s") { opts.flags.add(a[1]); continue; }
        if (a === "--") { i++; break; }
        if (a.startsWith("-")) { io.err(`sudo: invalid option -- '${a.slice(1)}'`); io.err("usage: sudo [-u user] command"); return 1; }
        break;
      }
      opts.operands = args.slice(i);
      if (opts.flags.has("k")) { this.sudoUntil = 0; if (!opts.operands.length) return 0; }
      const account = this.userByUid(shell.uid);
      const target = this.users.get(opts.values.u ?? "root");
      if (!target) { io.err(`sudo: unknown user ${opts.values.u}`); return 1; }
      if (!opts.operands.length && !opts.flags.has("i")) { io.err("usage: sudo [-u user] command"); return 1; }
      if (shell.uid !== 0) {
        if (!this.groups.get("sudo")?.members.includes(account.name)) {
          io.err(`${account.name} is not in the sudoers file.  This incident will be reported.`); return 1;
        }
        if (this.clock.now() > this.sudoUntil) {
          let ok = false;
          for (let attempt = 0; attempt < 3 && !ok; attempt++) {
            const typed = await io.readLine({ prompt: `[sudo] password for ${account.name}: `, echo: false });
            if (typed === account.password) ok = true; else if (attempt < 2) io.err("Sorry, try again.");
          }
          if (!ok) { io.err("sudo: 3 incorrect password attempts"); return 1; }
          this.sudoUntil = this.clock.now() + 15 * 60 * 1000;
        }
      }
      if (opts.flags.has("i")) {
        const child = this.spawn(shell, { cmd: "bash", args: ["-bash"], user: target.name, cwd: target.home });
        Object.assign(child.env, { USER: target.name, LOGNAME: target.name, HOME: target.home, PWD: target.home });
        this.shell = child; return 0;
      }
      const [name] = opts.operands;
      // kill exists as /bin/kill too; the other builtins (cd, export, …) are not programs
      if (BUILTINS[name] && name !== "kill") { io.err(`sudo: ${name}: command not found`); return 1; }
      const child = this.spawn(shell, { cmd: name, args: opts.operands, user: target.name, cwd: shell.cwd });
      if (name === "kill") {
        const status = await BUILTINS.kill.call(this, child, opts.operands.slice(1), io);
        this.exit(child, status); this.reap(child);
        return status;
      }
      Object.assign(child.env, { USER: target.name, LOGNAME: target.name, HOME: target.home, SUDO_USER: account.name });
      const status = await this.execute(child, opts.operands, io, { asProcess: child, line });
      if (child.exitCode === null) { this.exit(child, status); this.reap(child); }
      return child.exitCode ?? status;
    },

    async passwd(proc, args, io, { shell }) {
      const name = args[0] ?? shell.user;
      const account = this.users.get(name);
      if (!account) { io.err(`passwd: user '${name}' does not exist`); return 1; }
      if (shell.uid !== 0 && account.uid !== shell.uid) { io.err("passwd: You may not view or modify password information for " + name + "."); return 1; }
      if (shell.uid !== 0) {
        const current = await io.readLine({ prompt: "Current password: ", echo: false });
        if (current !== account.password) { io.err("passwd: Authentication token manipulation error"); io.err("passwd: password unchanged"); return 1; }
      }
      const a = await io.readLine({ prompt: "New password: ", echo: false });
      const b = await io.readLine({ prompt: "Retype new password: ", echo: false });
      if (a !== b) { io.err("Sorry, passwords do not match."); io.err("passwd: Authentication token manipulation error"); return 1; }
      if (!a) { io.err("No password supplied"); return 1; }
      account.password = a;
      io.out("passwd: password updated successfully");
      return 0;
    },

    async useradd(proc, args, io) {
      if (proc.uid !== 0) { io.err("useradd: Permission denied."); io.err("useradd: cannot lock /etc/passwd; try again later."); return 1; }
      let opts;
      try { opts = parseArgs(args, { flags: "mM", values: "Ggsdcu", longs: { "create-home": "m", groups: "G", shell: "s", "home-dir": "d", comment: "c" } }); } catch (error) { io.err(`useradd: ${error.message}`); return 2; }
      const name = opts.operands[0];
      if (!name) { io.err("Usage: useradd [options] LOGIN"); return 2; }
      if (this.users.has(name)) { io.err(`useradd: user '${name}' already exists`); return 9; }
      for (const g of (opts.values.G || "").split(",").filter(Boolean)) if (!this.groups.has(g)) { io.err(`useradd: group '${g}' does not exist`); return 6; }
      const user = this.addUser(name, { groups: opts.values.G ? opts.values.G.split(",") : [], password: name, home: opts.values.d, uid: opts.values.u !== undefined ? Number(opts.values.u) : undefined, gecos: opts.values.c || "" });
      if (opts.values.s) user.shell = opts.values.s;
      if (!opts.flags.has("m")) { const home = this.lookup(user.home); if (home && home.children.size <= 1) { const parent = this.lookup(user.home.replace(/\/[^/]+$/, "") || "/"); parent && parent.children.delete(user.home.split("/").pop()); } }
      return 0;
    },
    async groupadd(proc, args, io) {
      if (proc.uid !== 0) { io.err("groupadd: Permission denied."); return 1; }
      if (!args[0]) { io.err("Usage: groupadd [options] GROUP"); return 2; }
      if (this.groups.has(args[0])) { io.err(`groupadd: group '${args[0]}' already exists`); return 9; }
      this.addGroup(args[0]); return 0;
    },
    async usermod(proc, args, io) {
      if (proc.uid !== 0) { io.err("usermod: Permission denied."); return 1; }
      const opts = parseArgs(args, { flags: "a", values: "G" });
      const user = this.users.get(opts.operands[0]);
      if (!user) { io.err(`usermod: user '${opts.operands[0]}' does not exist`); return 6; }
      if (opts.values.G !== undefined) {
        const wanted = opts.values.G.split(",").filter(Boolean);
        for (const g of wanted) if (!this.groups.has(g)) { io.err(`usermod: group '${g}' does not exist`); return 6; }
        if (!opts.flags.has("a")) for (const g of this.groups.values()) g.members = g.members.filter(m => m !== user.name);
        for (const g of wanted) { const group = this.groups.get(g); if (!group.members.includes(user.name)) group.members.push(user.name); }
      }
      return 0;
    },

    async ps(proc, args, io) {
      // BSD letters without a dash (aux, ax, u), UNIX options with a dash (-e, -f, -u USER, -p PID)
      let all = false, long = false, full = false, users = null, pids = null;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-u" || a === "--user") { users = (args[++i] || "").split(","); continue; }
        if (a === "-p" || a === "--pid") { pids = (args[++i] || "").split(",").map(Number); continue; }
        if (a.startsWith("-")) {
          for (const c of a.slice(1)) { if (c === "e" || c === "A") all = true; else if (c === "f" || c === "F") full = true; else if (c === "x" || c === "a") all = true; else if (c === "u") { users = (args[++i] || "").split(","); } else if (c === "p") { pids = (args[++i] || "").split(",").map(Number); } else { io.err(`ps: unsupported option (${c})`); return 1; } }
          continue;
        }
        for (const c of a) { if (c === "a" || c === "x") all = true; else if (c === "u") long = true; else if (c === "f") full = true; else { io.err(`ps: unsupported option (${c})`); return 1; } }
      }
      if (users) all = true;
      const procs = [...this.procs.values()].filter(p => (all || (p.uid === proc.uid && (p === proc || p.pid === proc.ppid || p.ppid === proc.ppid || p.ppid === proc.pid)))
        && (!users || users.includes(this.userByUid(p.uid)?.name) || users.includes(String(p.uid)))
        && (!pids || pids.includes(p.pid)));
      const now = this.clock.now();
      const time = p => { const s = Math.floor(p.cpu / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
      if (long) {
        io.out("USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND");
        for (const p of procs) io.out(`${(this.userByUid(p.uid)?.name ?? p.uid).padEnd(8)} ${String(p.pid).padStart(7)}  0.0  0.1 ${String(2000 + p.pid * 13).padStart(6)} ${String(1000 + p.pid * 7).padStart(5)} ${(p.pid === 1 ? "?" : "pts/0").padEnd(8)} ${(p.state + (p.state === "S" ? (p.pid === 1 ? "s" : "") : "")).padEnd(4)} ${fmtClock(p.start)} ${time(p).padStart(6)} ${p.args.join(" ")}`);
      } else if (full) {
        io.out("UID          PID    PPID  C STIME TTY          TIME CMD");
        for (const p of procs) io.out(`${(this.userByUid(p.uid)?.name ?? p.uid).padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)}  0 ${fmtClock(p.start)} ${(p.pid === 1 ? "?" : "pts/0").padEnd(8)} ${time(p).padStart(8)} ${p.args.join(" ")}`);
      } else {
        io.out("    PID TTY          TIME CMD");
        for (const p of procs) io.out(`${String(p.pid).padStart(7)} pts/0    ${time(p).padStart(8)} ${users || pids ? p.args.join(" ") : p.cmd}${p.state === "Z" ? " <defunct>" : ""}`);
      }
      void now;
      return 0;
    },
    async pstree(proc, args, io) {
      const walk = (p, prefix, last) => {
        const kids = [...this.procs.values()].filter(c => c.ppid === p.pid);
        io.out(`${prefix}${p.pid === 1 ? "" : last ? "└─" : "├─"}${p.cmd}${args.includes("-p") ? `(${p.pid})` : ""}`);
        kids.forEach((k, i) => walk(k, p.pid === 1 ? prefix : prefix + (last ? "  " : "│ "), i === kids.length - 1));
      };
      walk(this.init, "", true);
      return 0;
    },
    async pgrep(proc, args, io) {
      const opts = parseArgs(args, { flags: "lf", values: "u" });
      const pattern = new RegExp(opts.operands[0] ?? "");
      let found = false;
      for (const p of this.procs.values()) {
        if (p.pid === proc.pid) continue;
        if (opts.values.u && (this.userByUid(p.uid)?.name) !== opts.values.u) continue;
        if (pattern.test(opts.flags.has("f") ? p.args.join(" ") : p.cmd)) { found = true; io.out(opts.flags.has("l") ? `${p.pid} ${p.cmd}` : String(p.pid)); }
      }
      return found ? 0 : 1;
    },
    async pkill(proc, args, io) {
      let sig = SIGNALS.TERM;
      const rest = args.filter(a => { if (/^-/.test(a)) { const s = parseSignal(a.slice(1)); if (s !== null) { sig = s; return false; } } return true; });
      const pattern = new RegExp(rest[0] ?? "");
      let found = false, status = 0;
      for (const p of [...this.procs.values()]) {
        if (p.pid === proc.pid || p.pid === 1 || !pattern.test(p.cmd)) continue;
        found = true;
        try { this.signal(proc, p.pid, sig); } catch { io.err(`pkill: killing pid ${p.pid} failed: Operation not permitted`); status = 1; }
      }
      return found ? status : 1;
    },
    async top(proc, args, io) {
      io.out(`top - ${fmtClock(this.clock.now())}:00 up ${Math.floor(this.uptimeSeconds() / 60)} min,  1 user,  load average: 0.00, 0.01, 0.05`);
      io.out(`Tasks: ${this.procs.size} total,   1 running, ${[...this.procs.values()].filter(p => p.state === "S").length} sleeping,   ${[...this.procs.values()].filter(p => p.state === "T").length} stopped,   ${[...this.procs.values()].filter(p => p.state === "Z").length} zombie`);
      io.out("MiB Mem :   2048.0 total,   1800.0 free,    120.0 used,    128.0 buff/cache");
      io.out("");
      io.out("    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND");
      for (const p of [...this.procs.values()].sort((a, b) => a.pid - b.pid)) io.out(`${String(p.pid).padStart(7)} ${(this.userByUid(p.uid)?.name ?? p.uid).padEnd(9)} 20   0 ${String(2000 + p.pid * 13).padStart(7)} ${String(1000 + p.pid * 7).padStart(6)} ${String(800).padStart(6)} ${p.state}   0.0   0.1   0:00.0${p.pid % 10} ${p.cmd}`);
      io.notice("(top shows a snapshot in the simulation; no q needed.)");
      return 0;
    },
    async sleep(proc, args, io) {
      const seconds = parseFloat(args[0]);
      if (!(seconds >= 0)) { io.err(`sleep: invalid time interval ${q(args[0] ?? "")}`); return 1; }
      const reason = await this.sleep(proc, seconds * 1000);
      if (reason === "exit") return proc.exitCode;
      if (reason === "trap") { await runTraps(this, proc, io); return this.sleep(proc, Math.max(0, proc.start + seconds * 1000 - this.clock.now())).then(r => r === "exit" ? proc.exitCode : 0); }
      return 0;
    },
    async yes(proc, args, io) {
      const text = args.join(" ") || "y";
      // in a pipe: a generous supply of lines, then the end (a pipe buffers here); at the terminal: 5 lines, then it keeps running
      if (io.piped) { for (let i = 0; i < 10000; i++) io.out(text); return 0; }
      for (let i = 0; i < 5; i++) io.out(text);
      io.notice("(yes would run forever – the simulation shows 5 lines; the process keeps running until it receives a signal.)");
      const reason = await this.sleep(proc, 24 * 3600 * 1000);
      return reason === "exit" ? proc.exitCode : 0;
    },
    async man(proc, args, io) {
      const name = args[0];
      const pages = manPages(io.lang());
      if (!name) { io.notice("What manual page do you want?"); io.notice("For example, try 'man ls'."); return 1; }
      const text = pages[name];
      if (!text) { io.notice(`No manual entry for ${name}`); return 16; }
      const upper = name.toUpperCase();
      io.notice(`${upper}(1)                          User Commands (simulated)                          ${upper}(1)\n`);
      io.notice(`NAME\n       ${name} – ${text.name}\n`);
      io.notice(`SYNOPSIS\n       ${text.synopsis}\n`);
      io.notice(`DESCRIPTION\n${text.description.split("\n").map(l => "       " + l).join("\n")}`);
      return 0;
    },
    async whatis(proc, args, io) { const pages = manPages(io.lang()); for (const n of args) io.notice(pages[n] ? `${n} (1)              - ${pages[n].name}` : `${n}: nothing appropriate.`); return 0; },
    async bash(proc, args, io, { shell }) {
      if (!args.length) { io.notice("(A new interactive bash is not needed in the simulation – you are already in one.)"); return 0; }
      if (args[0] === "-c") { return this.runLine(proc, args[1] ?? "", io, args.slice(2)); }
      return this.runScript(shell, args[0], args.slice(1), io, { asProcess: proc, needExec: false });
    },
    async sh(proc, args, io, ctx) { return COMMANDS.bash.call(this, proc, args, io, ctx); },
    async file(proc, args, io) {
      let status = 0;
      for (const path of args) {
        try {
          const { inode } = this.stat(proc, path, false);
          const kind = inode.type === "dir" ? "directory" : inode.type === "link" ? `symbolic link to ${inode.target}` : binaryKind(inode.data) || (inode.binary ? "data" : inode.data.startsWith("#!ELF") ? "ELF 64-bit LSB executable (simulated)" : inode.data.startsWith("#!") ? `${inode.data.split("\n")[0].slice(2).trim()} script, ASCII text executable` : inode.data.length ? (/[^\x00-\x7f]/.test(inode.data) ? "UTF-8 Unicode text" : "ASCII text") : "empty");
          io.out(`${path}: ${kind}`);
        } catch (error) { io.out(`${path}: cannot open \`${path}' (${error.message})`); status = 1; }
      }
      return status;
    },
    async du(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "shac", values: "d", longs: { summarize: "s", "human-readable": "h", all: "a", total: "c", "max-depth": "d" } }); } catch (error) { gnuError(io, "du", error.message); return 1; }
      const maxDepth = opts.flags.has("s") ? 0 : opts.values.d !== undefined ? Number(opts.values.d) : Infinity;
      const show = n => opts.flags.has("h") ? human(n * 1024) : String(n);
      let grand = 0, status = 0;
      const walk = (path, inode, depth) => {
        if (inode.type !== "dir") { const n = Math.ceil((inode.data || "").length / 1024); if (opts.flags.has("a") && depth <= maxDepth) io.out(`${show(n)}\t${path}`); return n; }
        let total = 4;
        for (const [name, child] of [...inode.children].sort()) total += walk(joinPath(path, name), child, depth + 1);
        if (depth <= maxDepth) io.out(`${show(total)}\t${path}`);
        return total;
      };
      for (const path of opts.operands.length ? opts.operands : ["."]) {
        try { const { inode } = this.stat(proc, path); if (inode.type !== "dir") { const n = Math.ceil((inode.data || "").length / 1024); io.out(`${show(n)}\t${path}`); grand += n; } else grand += walk(path, inode, 0); }
        catch (error) { gnuError(io, "du", `cannot access ${q(path)}: ${error.message}`); status = 1; }
      }
      if (opts.flags.has("c")) io.out(`${show(grand)}\ttotal`);
      return status;
    },
    async df(proc, args, io) {
      io.out("Filesystem     1K-blocks    Used Available Use% Mounted on");
      io.out("/dev/sda1       20480000 3145728  17334272  16% /");
      io.out("tmpfs             524288       0    524288   0% /tmp");
      return 0;
    },
    async free(proc, args, io) {
      io.out("               total        used        free      shared  buff/cache   available");
      io.out("Mem:         2097152      122880     1843200        1024      131072     1900544");
      io.out("Swap:              0           0           0");
      return 0;
    },
    async seq(proc, args, io) {
      const nums = args.map(Number);
      const [a, b] = nums.length === 1 ? [1, nums[0]] : nums;
      for (let i = a; i <= b; i++) io.out(String(i));
      return 0;
    },
    async basename(proc, args, io) { io.out((args[0] ?? "").replace(/\/+$/, "").split("/").pop()); return 0; },
    async dirname(proc, args, io) { const p = (args[0] ?? "").replace(/\/+$/, ""); io.out(p.includes("/") ? p.replace(/\/[^/]*$/, "") || "/" : "."); return 0; }
  };

  async function runTraps(sys, proc, io) {
    const queue = proc.trapQueue || [];
    proc.trapQueue = [];
    for (const handler of queue) await sys.runLine(proc, handler, io);
  }

  function headTail(proc, args, io, cmd) {
    let opts;
    try { opts = parseArgs(args, { flags: "qvf", values: "nc", numeric: "n", longs: { lines: "n", bytes: "c", quiet: "q", verbose: "v", follow: "f" } }); } catch (error) { gnuError(io, cmd, error.message); return 1; }
    const n = Number(opts.values.n ?? 10);
    const chars = opts.values.c !== undefined ? Number(opts.values.c) : null;
    let status = 0;
    const inputs = inputsOf(this, proc, io, opts.operands, cmd);
    if (!inputs) return 0;
    const headers = (inputs.length > 1 || opts.flags.has("v")) && !opts.flags.has("q");
    inputs.forEach((input, i) => {
      if (input.error) { status = 1; return; }
      const text = input.text;
      if (headers) io.out(`${i ? "\n" : ""}==> ${input.name === "-" ? "standard input" : input.name} <==`);
      if (chars !== null) { io.write(cmd === "head" ? text.slice(0, chars) : text.slice(-chars)); return; }
      const lines = linesOf(text);
      for (const l of cmd === "head" ? lines.slice(0, n) : lines.slice(-n)) io.out(l);
    });
    if (opts.flags.has("f")) io.notice("(tail -f would keep waiting for new lines; the simulation stops here.)");
    return status;
  }

  // Character sets of tr: ranges a-z, classes [:upper:] [:lower:] [:digit:] [:alpha:] [:space:] [:punct:], escapes \n \t
  function expandCharSet(set) {
    const classes = {
      "[:upper:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "[:lower:]": "abcdefghijklmnopqrstuvwxyz", "[:digit:]": "0123456789",
      "[:alpha:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", "[:alnum:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "[:space:]": " \t\n\r\f\v", "[:blank:]": " \t", "[:punct:]": "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
    };
    for (const [name, value] of Object.entries(classes)) set = set.split(name).join(value);
    set = set.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
    const out = [];
    for (let i = 0; i < set.length; i++) {
      if (set[i + 1] === "-" && i + 2 < set.length) {
        for (let c = set.charCodeAt(i); c <= set.charCodeAt(i + 2); c++) out.push(String.fromCharCode(c));
        i += 2;
      } else out.push(set[i]);
    }
    return out;
  }

  function chownLike(proc, args, io, cmd) {
    let opts;
    try { opts = parseArgs(args, { flags: "Rv", longs: { recursive: "R" } }); } catch (error) { gnuError(io, cmd, error.message); return 1; }
    if (opts.operands.length < 2) { gnuError(io, cmd, "missing operand"); return 1; }
    const [spec, ...paths] = opts.operands;
    let uid = null, gid = null;
    if (cmd === "chgrp") { const g = this.groups.get(spec); if (!g) { gnuError(io, cmd, `invalid group: ${q(spec)}`); return 1; } gid = g.gid; }
    else {
      const [u, g] = spec.split(":");
      if (u) { const user = this.users.get(u) ?? (/^\d+$/.test(u) ? this.userByUid(Number(u)) : null); if (!user) { gnuError(io, cmd, `invalid user: ${q(spec)}`); return 1; } uid = user.uid; }
      if (g !== undefined) { const group = g === "" ? this.groupByGid(this.users.get(u)?.gid) : this.groups.get(g); if (!group) { gnuError(io, cmd, `invalid group: ${q(spec)}`); return 1; } gid = group.gid; }
    }
    let status = 0;
    const apply = (path, inode) => {
      this.chown(proc, path, uid, gid);
      if (opts.flags.has("R") && inode.type === "dir") for (const name of inode.children.keys()) apply(joinPath(path, name), inode.children.get(name));
    };
    for (const path of paths) {
      try { apply(path, this.stat(proc, path).inode); }
      catch (error) {
        if (error.code === "ENOENT") gnuError(io, cmd, `cannot access ${q(path)}: ${error.message}`);
        else gnuError(io, cmd, `changing ${cmd === "chgrp" ? "group" : "ownership"} of ${q(path)}: ${error.message}`);
        status = 1;
      }
    }
    return status;
  }

  function applyModeSpec(spec, current, isDir, umask) {
    if (/^[0-7]{3,4}$/.test(spec)) return parseInt(spec, 8);
    let mode = current & 0o7777;
    for (const clause of spec.split(",")) {
      const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause);
      if (!m) return null;
      const who = m[1] || "a", op = m[2], perms = m[3];
      let mask = 0;
      if (who.includes("a")) mask = 0o777; else { if (who.includes("u")) mask |= 0o700; if (who.includes("g")) mask |= 0o070; if (who.includes("o")) mask |= 0o007; }
      if (!m[1]) mask &= ~umask;
      let bits = 0;
      if (perms.includes("r")) bits |= 0o444; if (perms.includes("w")) bits |= 0o222;
      if (perms.includes("x") || (perms.includes("X") && (isDir || mode & 0o111))) bits |= 0o111;
      let special = 0;
      if (perms.includes("s")) { if (who.includes("u") || who === "a") special |= 0o4000; if (who.includes("g") || who === "a") special |= 0o2000; }
      if (perms.includes("t")) special |= 0o1000;
      const value = bits & mask;
      if (op === "+") mode |= value | special;
      else if (op === "-") mode &= ~(value | special);
      else mode = (mode & ~mask & ~(who === "a" || !m[1] ? 0o7000 : 0)) | value | special;
    }
    return mode;
  }

  // ---------------------------------------------------------------- short manual pages (English; other languages: packs)

  const MAN = {
    ls: { name: "list directory contents", synopsis: "ls [-l] [-a] [-h] [-S] [-t] [-r] [-R] [-F] [FILE...]", description: "-l  long format: mode, links, owner, group, size, date\n-a  also hidden entries (names starting with .), -A without . and ..\n-h  human-readable sizes (K, M)\n-S  sort by size, -t by modification time, -r reverse\n-R  recursive, -F append / to directories and * to executables, -d the directory itself, -1 one per line" },
    cd: { name: "change the working directory", synopsis: "cd [DIRECTORY]", description: "Without an argument: your home directory (~). cd - returns to the previous one.\nA directory needs the x permission to be entered." },
    pwd: { name: "print the working directory", synopsis: "pwd", description: "Prints the full path of the current directory." },
    cat: { name: "print files", synopsis: "cat [-n] [-A] [-s] FILE...", description: "Prints the content; -n numbers the lines, -A shows tabs and line ends, -s squeezes blank lines. Reading needs the r permission." },
    mkdir: { name: "make directories", synopsis: "mkdir [-p] [-m MODE] DIRECTORY...", description: "-p creates missing parent directories and does not complain when it exists; -m sets the mode (e.g. 700)." },
    touch: { name: "create a file or update its timestamp", synopsis: "touch [-c] FILE...", description: "Creates an empty file; if it exists, only the modification time changes. -c creates nothing." },
    rm: { name: "remove files", synopsis: "rm [-r] [-f] [-i] FILE...", description: "-r removes directories with their content, -f never asks and ignores missing files, -i asks before each removal.\nRemoving needs w and x on the directory, not on the file itself!" },
    cp: { name: "copy", synopsis: "cp [-r] [-i] [-n] [-v] SOURCE DEST", description: "-r copies directories, -i asks before overwriting, -n never overwrites, -v reports each copy. The copy belongs to you." },
    mv: { name: "move or rename", synopsis: "mv [-i] [-n] [-v] SOURCE DEST", description: "If DEST is a directory, SOURCE moves into it. -i asks before overwriting, -n never overwrites." },
    chmod: { name: "change permissions", synopsis: "chmod [-R] MODE FILE...", description: "MODE octal (755, 644) or symbolic: u/g/o/a  +/-/=  r/w/x\nExamples: chmod +x script.sh · chmod o-r secret.txt · chmod 750 folder\nOnly the owner (or root) may change permissions." },
    chown: { name: "change owner and group", synopsis: "chown [-R] USER[:GROUP] FILE...", description: "Only root may change the owner. Example: sudo chown ben:project file" },
    chgrp: { name: "change the group", synopsis: "chgrp [-R] GROUP FILE...", description: "The owner may set the group to one of their own groups." },
    umask: { name: "default permissions of new files", synopsis: "umask [MASK]", description: "The mask removes permissions: 022 → files 644, directories 755." },
    su: { name: "switch user", synopsis: "su [-] [USER]", description: "Asks for the password of the target user. Without a name: root. exit returns.\nsu - starts a login shell in the user's home." },
    sudo: { name: "run a command as root", synopsis: "sudo [-u USER] COMMAND", description: "Asks for your own password (valid for 15 minutes). Only members of the group sudo may do this." },
    ps: { name: "show processes", synopsis: "ps [aux | -ef] [-u USER] [-p PID]", description: "ps alone: processes of this shell. ps aux: all processes with user, PID and state (STAT).\nSTAT: R running, S sleeping, T stopped, Z zombie (finished, not yet collected)." },
    kill: { name: "send a signal to a process", synopsis: "kill [-SIGNAL] PID | %JOB", description: "Default SIGTERM (15): a polite request to finish – a program may catch it.\nkill -9 (SIGKILL) ends it at once and cannot be caught.\n-STOP pauses, -CONT continues. kill -l lists all signals." },
    jobs: { name: "background jobs of this shell", synopsis: "jobs", description: "Shows jobs with their number [n]; fg %n brings one to the foreground, bg %n continues a stopped one." },
    fg: { name: "job to the foreground", synopsis: "fg [%JOB]", description: "Brings the last (or given) job to the foreground and waits for it." },
    bg: { name: "continue a stopped job in the background", synopsis: "bg [%JOB]", description: "After Ctrl+Z, bg lets the job continue in the background." },
    sleep: { name: "wait", synopsis: "sleep SECONDS", description: "Does nothing for the given time – handy for watching processes: sleep 100 &" },
    top: { name: "process overview", synopsis: "top", description: "In the simulation a snapshot of the process table." },
    pgrep: { name: "find processes by name", synopsis: "pgrep [-l] PATTERN", description: "Prints the PIDs whose command name matches the pattern." },
    pkill: { name: "end processes by name", synopsis: "pkill [-SIGNAL] PATTERN", description: "Sends the signal to every matching process." },
    grep: { name: "search lines", synopsis: "grep [-i] [-n] [-r] [-v] [-c] [-o] [-q] [-A N] [-B N] PATTERN FILE...", description: "-i ignore case, -n with line numbers, -r recursive in directories, -v lines without a match, -c count, -o only the match, -q quiet (exit status only), -A/-B lines after/before a match." },
    find: { name: "search files", synopsis: "find [PATH] [-name PATTERN] [-type f|d] [-size +N] [-mtime -N] [-user NAME]", description: "Examples: find . -name '*.txt'   find /home -type d   find . -size +1k   find . -mtime -1" },
    head: { name: "beginning of a file", synopsis: "head [-n N] [-c N] FILE", description: "Default: 10 lines; -c N the first N characters." },
    tail: { name: "end of a file", synopsis: "tail [-n N] [-c N] FILE", description: "Default: 10 lines; -c N the last N characters." },
    wc: { name: "count", synopsis: "wc [-l] [-w] [-c] [-m] [-L] FILE", description: "Lines, words, bytes; -m characters, -L length of the longest line." },
    echo: { name: "print text", synopsis: "echo [-n] [-e] TEXT", description: "Variables are expanded: echo $HOME; -n without the line break, -e interprets \\n and \\t." },
    whoami: { name: "your user name", synopsis: "whoami", description: "Prints the current user – after su the new one." },
    id: { name: "user and group ids", synopsis: "id [-u] [-g] [-G] [-n] [USER]", description: "uid, gid and all groups; -u only the uid, -g the gid, -G all gids, -n names instead of numbers. Groups decide about permissions too." },
    groups: { name: "group memberships", synopsis: "groups [USER]", description: "Lists the groups of the user." },
    stat: { name: "file metadata", synopsis: "stat [-c FORMAT] FILE", description: "Mode in octal and symbolic form, owner, group, size, modification time. -c '%a %U %G %n' prints only those fields." },
    test: { name: "evaluate a condition", synopsis: "test EXPRESSION   or   [ EXPRESSION ]", description: "-e exists, -f file, -d directory, -r/-w/-x readable/writable/executable, = equal. Exit status 0 means true." },
    exit: { name: "leave the shell", synopsis: "exit [CODE]", description: "After su, exit returns to the previous user." },
    history: { name: "command history", synopsis: "history", description: "All commands entered so far; the up arrow brings them back." },
    man: { name: "manual", synopsis: "man COMMAND", description: "Shows the short manual page of a command – in the language set by LANG (export LANG=de_DE.UTF-8)." },
    tree: { name: "directory tree", synopsis: "tree [-a] [-d] [-L N] [DIRECTORY]", description: "Shows files and folders as a tree; -d only directories, -L N at most N levels." },
    useradd: { name: "create a user (root)", synopsis: "useradd -m [-G GROUPS] [-s SHELL] [-c COMMENT] NAME", description: "-m creates the home directory. In the simulation the password equals the name until passwd changes it." },
    usermod: { name: "modify a user (root)", synopsis: "usermod -aG GROUP NAME", description: "-aG adds the user to a group without removing others." },
    passwd: { name: "change a password", synopsis: "passwd [NAME]", description: "Asks for the old password and twice for the new one." },
    trap: { name: "catch signals", synopsis: "trap 'COMMAND' SIGNAL", description: "Example in a script: trap 'echo ignored' TERM – SIGKILL cannot be caught." },
    date: { name: "print the date and time", synopsis: "date [+FORMAT]", description: "FORMAT with %Y %m %d %H %M %S %A %B %F %T %s, e.g. date +%F" },
    du: { name: "disk usage", synopsis: "du [-s] [-h] [-a] [-c] [-d N] [PATH]", description: "-s one total per argument, -h readable sizes, -a also files, -c grand total, -d N depth." },
    export: { name: "set an environment variable", synopsis: "export NAME=VALUE", description: "Child processes see the variable. Example: export LANG=de_DE.UTF-8 switches the messages to German." }
  };

  // ---------------------------------------------------------------- export

  // Commands that belong to an optional package: command → package name (linux-system.js fills it).
  const OPTIONAL_COMMANDS = {};
  const BOOT_HOOKS = [];
  // Executable formats of other templates (linux-dev): { test(source, path) → boolean, run(sys, proc, { path, source, args, io }) → status }.
  // ./datei runs the first format whose test matches, otherwise the file is a shell script.
  const EXEC_FORMATS = [];
  function registerOptionalCommands(pkg, names) { for (const n of names) OPTIONAL_COMMANDS[n] = pkg; }
  function onBoot(fn) { BOOT_HOOKS.push(fn); }
  function registerExecFormat(format) { EXEC_FORMATS.push(format); }

  function createSystem(options) {
    const sys = new System(options);
    sys.installCommands(Object.keys(COMMANDS));
    sys.runBootHooks();
    return sys;
  }

  // Further programs from another file (linux-tools.js): { name: async (proc, args, io, ctx) => status }
  function registerCommands(map) {
    for (const [name, fn] of Object.entries(map)) COMMANDS[name] = fn;
  }
  // Lets an extra program call a built-in one (egrep → grep) with the same process and io.
  function runCommand(name, sys, proc, args, io, ctx) { return COMMANDS[name].call(sys, proc, args, io, ctx || {}); }

  // Helpers the extra programs share with the kernel.
  const helpers = Object.freeze({ parseArgs, gnuError, q, inputsOf, linesOf, sizeOf, human, joinPath, globToRegExp, breToJs, modeString, fmtDate, fmtClock, local: ms => local(ms), pad, MONTHS, SysError });

  function restoreSystem(data, options) {
    const sys = System.restore(data, options);
    sys.installCommands(Object.keys(COMMANDS));
    sys.runBootHooks();
    return sys;
  }

  // Collect all output of one line – for tests and for @Linux.run.
  async function runCollect(sys, line, { input = [], editor, show, upload, download } = {}) {
    let stdout = "", stderr = "";
    const queue = [...input];
    const status = await sys.run(line, {
      write: t => { stdout += t; },
      error: t => { stderr += t; },
      readLine: () => Promise.resolve(queue.shift() ?? ""),
      clear: () => { stdout += "\x1b[clear]"; },
      editor, show, upload, download
    });
    return { stdout, stderr, status };
  }

  function manPages(code) {
    const pack = LANGUAGES[code];
    return pack && Object.keys(pack.man).length ? { ...MAN, ...pack.man } : MAN;
  }

  registerLanguage("en", { name: "English", messages: [], man: {}, terminal: {
    welcome: "Welcome to the simulated Linux shell. Help: help, man <command>",
    restored: "(Session restored – files, users and history are back; processes you started are not.)",
    reset: "(Session reset.)"
  }, ui: {
    terminal: "Linux terminal (simulated) – keys go to the shell",
    check: "Check task", met: "✅ met", notMet: "❌ not yet",
    reset: "Reset session",
    missing: "not there yet", bytes: "bytes",
    setupRan: "Setup done", setupSkipped: "Setup was already done", setupErrors: "Setup with errors", session: "session",
    noOutput: "(no output)", close: "Close image",
    written: "written", owner: "owner"
  } });

  global.LiaLinuxKernel = Object.freeze({
    createSystem, restoreSystem, runCollect, parseLine, fakeClock, realClock, SIGNALS, SysError, modeString, applyModeSpec, globToRegExp,
    registerLanguage, localize, langOf, languages: LANGUAGES, manPages, registerCommands, registerOptionalCommands, registerExecFormat, onBoot, run: runCommand, helpers,
    optionalCommands: OPTIONAL_COMMANDS,
    get commands() { return Object.keys(COMMANDS); }, builtins: Object.keys(BUILTINS), MAN
  });
  if (global.document) global.document.dispatchEvent(new CustomEvent("lia-linux-kernel-ready"));
})(globalThis);
