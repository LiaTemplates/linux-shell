/* LiaScript template linux-shell – services (systemctl, journalctl), packages (apt, dpkg) and archives
   (tar, gzip, zip). Loaded after linux-kernel.js; registers its commands with LiaLinuxKernel.registerCommands.
   Other templates add packages with LiaLinuxKernel.registerPackage (linux-dev: python3, nodejs, gcc). */
(function (global) {
  "use strict";
  if (global.LiaLinuxSystem) return;
  // the header scripts may load in any order: wait for the kernel instead of giving up
  let tries = 0;
  (function wait() { if (global.LiaLinuxKernel) start(); else if (++tries < 400) setTimeout(wait, 50); })();
  function start() {
  const kernel = global.LiaLinuxKernel;
  const { parseArgs, gnuError, q, linesOf, joinPath, local, pad, MONTHS, fmtClock } = kernel.helpers;

  // ---------------------------------------------------------------- the package index

  // Packages that are always installed (the commands of the kernel and the tools) …
  const BASE_PACKAGES = {
    bash: { version: "5.2.15-2", description: "GNU Bourne Again SHell", size: 1456 },
    coreutils: { version: "9.1-1", description: "GNU core utilities", size: 2830 },
    findutils: { version: "4.9.0-4", description: "utilities for finding files--find, xargs", size: 616 },
    grep: { version: "3.8-5", description: "GNU grep, egrep and fgrep", size: 489 },
    sed: { version: "4.9-1", description: "GNU stream editor for filtering/transforming text", size: 360 },
    gawk: { version: "5.2.1-2", description: "GNU awk, a pattern scanning and processing language", size: 1270 },
    procps: { version: "4.0.2-3", description: "/proc file system utilities", size: 1050 },
    "util-linux": { version: "2.38.1-5", description: "miscellaneous system utilities", size: 3160 },
    diffutils: { version: "3.8-4", description: "File comparison utilities", size: 496 },
    curl: { version: "7.88.1-10", description: "command line tool for transferring data with URL syntax", size: 530 },
    wget: { version: "1.21.3-1", description: "retrieves files from the web", size: 3500 },
    nano: { version: "7.2-1", description: "small, friendly text editor inspired by Pico", size: 2900 },
    tar: { version: "1.34+dfsg-1.2", description: "GNU version of the tar archiving utility", size: 1052 },
    gzip: { version: "1.12-1", description: "GNU compression utilities", size: 249 },
    zip: { version: "3.0-13", description: "Archiver for .zip files", size: 616 },
    unzip: { version: "6.0-28", description: "De-archiver for .zip files", size: 390 },
    tree: { version: "2.1.0-1", description: "displays an indented directory tree, in color", size: 110 },
    htop: { version: "3.2.2-2", description: "interactive processes viewer", size: 346 },
    sudo: { version: "1.9.13p3-1", description: "Provide limited super user privileges to specific users", size: 2540 },
    systemd: { version: "252.19-1", description: "system and service manager", size: 12000 },
    "openssh-server": { version: "9.2p1-2", description: "secure shell (SSH) server, for secure access from remote machines", size: 1900 },
    cron: { version: "3.0pl1-162", description: "process scheduling daemon", size: 250 },
    man: { version: "2.11.2-2", description: "tools for reading manual pages", size: 2800 }
  };

  // … and the ones learners can install. `commands` appear in /bin after apt install, `service` creates a unit.
  const PACKAGES = {
    cowsay: { version: "3.03+dfsg2-8", description: "configurable talking cow", size: 20, commands: ["cowsay", "cowthink"] },
    sl: { version: "5.02-1", description: "Correct you if you type `sl' by mistake", size: 26, commands: ["sl"] },
    fortune: { version: "1:1.99.1-7.3", description: "provides fortune cookies on demand", size: 44, commands: ["fortune"] },
    neofetch: { version: "7.1.0-4", description: "Shows Linux System Information with Distribution Logo", size: 84, commands: ["neofetch"] },
    nginx: { version: "1.22.1-9", description: "small, powerful, scalable web/proxy server", size: 590, commands: ["nginx"], service: { name: "nginx", description: "A high performance web server and a reverse proxy server", enabledAfterInstall: true, startAfterInstall: true } }
  };

  const index = () => ({ ...BASE_PACKAGES, ...PACKAGES });
  const isBase = name => name in BASE_PACKAGES;
  const installed = (sys, name) => isBase(name) || sys.installed.has(name);

  // A template that brings a runtime (linux-dev) registers its package here; install() loads the runtime.
  function registerPackage(name, spec) {
    PACKAGES[name] = spec;
    kernel.registerOptionalCommands(name, spec.commands || []);
  }
  for (const [name, spec] of Object.entries(PACKAGES)) kernel.registerOptionalCommands(name, spec.commands || []);

  function dpkgStatus(sys) {
    return Object.entries(index()).filter(([name]) => installed(sys, name)).sort()
      .map(([name, p]) => `Package: ${name}\nStatus: install ok installed\nVersion: ${p.version}\nArchitecture: ${name === "cowsay" || name === "fortune" ? "all" : "amd64"}\nDescription: ${p.description}\n`).join("\n");
  }

  async function installPackage(sys, name, io) {
    const spec = PACKAGES[name];
    sys.installed.add(name);
    sys.installCommands(spec.commands || []);
    if (spec.install) { try { await spec.install(sys, io); } catch (error) { io.err(`E: ${name}: ${error.message}`); } }
    if (spec.service) { ensureService(sys, spec.service.name, { description: spec.service.description, enabled: Boolean(spec.service.enabledAfterInstall) }); if (spec.service.startAfterInstall) startService(sys, spec.service.name); }
  }

  function removePackage(sys, name) {
    const spec = PACKAGES[name];
    sys.installed.delete(name);
    sys.uninstallCommands(spec.commands || []);
    if (spec.service) { stopService(sys, spec.service.name); sys.services.delete(spec.service.name); sys.lookup("/lib/systemd/system")?.children.delete(`${spec.service.name}.service`); }
  }

  // ---------------------------------------------------------------- services

  const UNITS = {
    ssh: { description: "OpenBSD Secure Shell server", exec: "/usr/sbin/sshd -D", enabled: true, autostart: true },
    cron: { description: "Regular background program processing daemon", exec: "/usr/sbin/cron -f", enabled: true, autostart: true },
    nginx: { description: "A high performance web server and a reverse proxy server", exec: "nginx -g 'daemon on; master_process on;'", enabled: false, autostart: false, optional: "nginx" }
  };

  function stamp(sys) {
    const d = local(sys.clock.now());
    return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${sys.hostname}`;
  }

  function ensureService(sys, name, { description, enabled, exec } = {}) {
    if (!sys.services.has(name)) sys.services.set(name, { description: description || UNITS[name]?.description || name, exec: exec || UNITS[name]?.exec || `/usr/sbin/${name}`, enabled: Boolean(enabled), active: false, pid: null, since: null, log: [] });
    const dir = sys.ensureDir("/lib/systemd/system", { mode: 0o755 });
    if (!dir.children.has(`${name}.service`)) sys.putFile(`/lib/systemd/system/${name}.service`, `[Unit]\nDescription=${sys.services.get(name).description}\nAfter=network.target\n\n[Service]\nExecStart=${sys.services.get(name).exec}\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n`, { mode: 0o644 });
    return sys.services.get(name);
  }

  function log(sys, name, text) {
    const s = sys.services.get(name);
    s.log.push(`${stamp(sys)} ${name}[${s.pid ?? "-"}]: ${text}`);
    if (s.log.length > 200) s.log.shift();
  }

  function startService(sys, name) {
    const s = sys.services.get(name);
    if (s.active) return false;
    const proc = sys.spawn(sys.init, { cmd: s.exec.split(" ")[0].split("/").pop(), args: s.exec.split(" "), user: "root", cwd: "/" });
    proc.state = "S";
    proc.service = name;
    // a daemon sleeps until it is stopped or killed; ending it by hand counts as a crash in the journal
    sys.sleep(proc, 365 * 24 * 3600 * 1000).then(() => {
      if (proc.exitCode === null) sys.exit(proc, 0);
      const current = sys.services.get(name);
      if (current && current.pid === proc.pid) { current.active = false; current.pid = null; log(sys, name, `${proc.cmd} exited (killed)`); current.log.push(`${stamp(sys)} systemd[1]: ${name}.service: Main process exited, code=killed, status=15/TERM`); }
    });
    s.active = true; s.pid = proc.pid; s.since = sys.clock.now();
    log(sys, name, `Starting ${s.description}...`);
    log(sys, name, `Started ${s.description}.`);
    return true;
  }

  function stopService(sys, name) {
    const s = sys.services.get(name);
    if (!s || !s.active) return false;
    const proc = sys.procs.get(s.pid);
    s.active = false; const pid = s.pid; s.pid = null;
    if (proc && proc.exitCode === null) { if (proc.wake) proc.wake("exit"); sys.exit(proc, 0); }
    s.log.push(`${stamp(sys)} systemd[1]: Stopping ${s.description}...`);
    s.log.push(`${stamp(sys)} ${name}[${pid}]: received signal 15; terminating.`);
    s.log.push(`${stamp(sys)} systemd[1]: Stopped ${s.description}.`);
    return true;
  }

  function serviceState(s) { return s.active ? "active (running)" : "inactive (dead)"; }

  function statusBlock(sys, name, io) {
    const s = sys.services.get(name);
    const since = s.since ? new Date(s.since).toISOString().slice(0, 19).replace("T", " ") : null;
    const mins = s.since ? Math.max(0, Math.floor((sys.clock.now() - s.since) / 60000)) : 0;
    io.out(`${s.active ? "●" : "○"} ${name}.service - ${s.description}`);
    io.out(`     Loaded: loaded (/lib/systemd/system/${name}.service; ${s.enabled ? "enabled" : "disabled"}; preset: enabled)`);
    io.out(`     Active: ${serviceState(s)}${since ? ` since ${since} UTC; ${mins} min ago` : ""}`);
    if (s.active) { io.out(`   Main PID: ${s.pid} (${s.exec.split(" ")[0].split("/").pop()})`); io.out(`      Tasks: 1`); io.out(`     Memory: 2.1M`); io.out(`     CGroup: /system.slice/${name}.service`); io.out(`             └─${s.pid} ${s.exec}`); }
    io.out("");
    for (const line of s.log.slice(-5)) io.out(line);
  }

  kernel.onBoot(sys => {
    // first boot: the base services; later boots: the enabled ones start again
    const saved = sys.restoredServices;
    for (const [name, unit] of Object.entries(UNITS)) {
      if (unit.optional && !sys.installed.has(unit.optional)) continue;
      const s = ensureService(sys, name, { description: unit.description, exec: unit.exec, enabled: unit.enabled });
      if (saved) { const entry = saved.find(([n]) => n === name); if (entry) { s.enabled = entry[1].enabled; s.log = entry[1].log || []; } }
      if (s.enabled && !s.active) startService(sys, name);
    }
    for (const [name, s] of sys.services) if (!UNITS[name] && s.enabled && !s.active) startService(sys, name);
    sys.restoredServices = null;
  });

  // ---------------------------------------------------------------- archives (a JSON manifest inside the file)

  const TAR_MARK = "#!LIATAR\n", GZ_MARK = "#!LIAGZIP\n", ZIP_MARK = "#!LIAZIP\n";

  function collectTree(sys, proc, path, base) {
    const entries = [];
    const walk = (p, rel) => {
      const { inode } = sys.stat(proc, p);
      if (inode.type === "dir") {
        entries.push({ name: rel + "/", type: "dir", mode: inode.mode & 0o777, size: 0 });
        for (const name of [...inode.children.keys()].sort()) walk(joinPath(p, name), rel + "/" + name);
      } else if (inode.type === "link") entries.push({ name: rel, type: "link", mode: 0o777, target: inode.target, size: 0 });
      else { const text = sys.readFile(proc, p); entries.push({ name: rel, type: "file", mode: inode.mode & 0o777, size: text.length, data: text }); }
    };
    walk(path, base);
    return entries;
  }

  function extract(sys, proc, entries, io, verbose, cmd, dest = ".") {
    for (const e of entries) {
      const target = joinPath(dest, e.name.replace(/\/$/, ""));
      if (verbose) io.out(e.name);
      try {
        if (e.type === "dir") { try { sys.mkdir(proc, target, { parents: true }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
        else if (e.type === "link") { try { sys.unlink(proc, target); } catch { /* new */ } sys.symlink(proc, e.target, target); }
        else { const parent = target.replace(/\/[^/]+$/, ""); if (parent && parent !== target) { try { sys.mkdir(proc, parent, { parents: true }); } catch { /* exists */ } } sys.writeFile(proc, target, e.data, { mode: e.mode }); }
      } catch (error) { gnuError(io, cmd, `${target}: Cannot open: ${error.message}`); return 2; }
    }
    return 0;
  }

  function readArchive(sys, proc, path, mark, cmd, io) {
    let text;
    try { text = sys.readFile(proc, path); } catch (error) { gnuError(io, cmd, `${path}: Cannot open: ${error.message}`); return null; }
    if (!text.startsWith(mark)) { gnuError(io, cmd, cmd === "tar" ? "This does not look like a tar archive" : cmd === "unzip" ? `cannot find zipfile directory in one of ${path}` : `${path}: not in gzip format`); return null; }
    try { return JSON.parse(text.slice(mark.length)); } catch { gnuError(io, cmd, `${path}: archive is damaged`); return null; }
  }

  function listing(entries, sys, verbose, io) {
    const now = sys.clock.now();
    for (const e of entries) io.out(verbose ? `${e.type === "dir" ? "d" : e.type === "link" ? "l" : "-"}${kernel.helpers.modeString({ mode: e.mode, type: "file" }).slice(1)} anna/anna ${String(e.size).padStart(9)} ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} ${e.name}${e.target ? " -> " + e.target : ""}` : e.name);
  }

  // ---------------------------------------------------------------- fun programs of the optional packages

  const COW = (text) => {
    const lines = [];
    const words = text.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) { if ((line + " " + w).trim().length > 38) { lines.push(line.trim()); line = w; } else line = (line + " " + w).trim(); }
    if (line || !lines.length) lines.push(line);
    const width = Math.max(...lines.map(l => l.length));
    const out = [" " + "_".repeat(width + 2)];
    lines.forEach((l, i) => {
      const [a, b] = lines.length === 1 ? ["<", ">"] : i === 0 ? ["/", "\\"] : i === lines.length - 1 ? ["\\", "/"] : ["|", "|"];
      out.push(`${a} ${l.padEnd(width)} ${b}`);
    });
    out.push(" " + "-".repeat(width + 2));
    return out.join("\n");
  };
  const COW_BODY = "        \\   ^__^\n         \\  (oo)\\_______\n            (__)\\       )\\/\\\n                ||----w |\n                ||     ||";
  const FORTUNES = [
    "The best way to predict the future is to invent it. -- Alan Kay",
    "Talk is cheap. Show me the code. -- Linus Torvalds",
    "Any sufficiently advanced technology is indistinguishable from magic. -- Arthur C. Clarke",
    "There are only two hard things in Computer Science: cache invalidation and naming things. -- Phil Karlton",
    "Simplicity is prerequisite for reliability. -- Edsger W. Dijkstra",
    "Programs must be written for people to read, and only incidentally for machines to execute. -- Abelson & Sussman",
    "In theory, theory and practice are the same. In practice, they are not.",
    "A clean desk is a sign of a cluttered desk drawer.",
    "Unix is user-friendly. It's just selective about who its friends are."
  ];

  // ---------------------------------------------------------------- the programs

  const commands = {
    async apt(proc, args, io, ctx) { return apt.call(this, proc, args, io, ctx, "apt"); },
    "apt-get": async function (proc, args, io, ctx) { return apt.call(this, proc, args, io, ctx, "apt-get"); },
    "apt-cache": async function (proc, args, io, ctx) { return apt.call(this, proc, [args[0] === "search" || args[0] === "show" ? args[0] : args[0], ...args.slice(1)], io, ctx, "apt-cache"); },
    async dpkg(proc, args, io) {
      const all = index();
      if (args[0] === "-l" || args[0] === "--list") {
        const pattern = args[1] ? kernel.helpers.globToRegExp(args[1]) : null;
        io.out("Desired=Unknown/Install/Remove/Purge/Hold");
        io.out("| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend");
        io.out("|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)");
        io.out("||/ Name           Version          Architecture Description");
        io.out("+++-==============-================-============-=================================");
        for (const [name, p] of Object.entries(all).sort()) { if (!installed(this, name)) continue; if (pattern && !pattern.test(name)) continue; io.out(`ii  ${name.padEnd(14)} ${p.version.padEnd(16)} ${(name === "cowsay" || name === "fortune" ? "all" : "amd64").padEnd(12)} ${p.description}`); }
        return 0;
      }
      if (args[0] === "-s" || args[0] === "--status") {
        const name = args[1];
        if (!name || !installed(this, name)) { io.err(`dpkg-query: package '${name ?? ""}' is not installed and no information is available`); io.err("Use dpkg --info (= dpkg-deb --info) to examine archive files."); return 1; }
        const p = all[name];
        io.out(`Package: ${name}\nStatus: install ok installed\nPriority: optional\nSection: ${name === "nginx" ? "httpd" : "utils"}\nInstalled-Size: ${p.size}\nMaintainer: Debian Maintainers <debian@example.org>\nArchitecture: ${name === "cowsay" || name === "fortune" ? "all" : "amd64"}\nVersion: ${p.version}\nDescription: ${p.description}`);
        return 0;
      }
      if (args[0] === "-L" || args[0] === "--listfiles") {
        const name = args[1];
        if (!name || !installed(this, name)) { io.err(`dpkg-query: package '${name ?? ""}' is not installed`); return 1; }
        io.out("/."); io.out("/usr"); io.out("/usr/bin");
        for (const c of (all[name].commands || [name])) io.out(`/usr/bin/${c}`);
        io.out("/usr/share"); io.out("/usr/share/doc"); io.out(`/usr/share/doc/${name}`); io.out(`/usr/share/doc/${name}/copyright`);
        return 0;
      }
      if (args[0] === "-S" || args[0] === "--search") {
        const needle = (args[1] || "").split("/").pop();
        const hit = Object.entries(all).find(([name, p]) => (p.commands || [name]).includes(needle) && installed(this, name));
        if (!hit) { io.err(`dpkg-query: no path found matching pattern ${args[1] ?? ""}`); return 1; }
        io.out(`${hit[0]}: /usr/bin/${needle}`); return 0;
      }
      io.err("dpkg: error: need an action option"); io.err("Type dpkg --help for help about installing and deinstalling packages [*];"); return 2;
    },

    async systemctl(proc, args, io) {
      const [action, unitArg] = args.filter(a => !a.startsWith("-"));
      const name = (unitArg || "").replace(/\.service$/, "");
      const needsRoot = ["start", "stop", "restart", "reload", "enable", "disable"].includes(action);
      if (!action || action === "list-units" || action === "status" && !name) {
        io.out("  UNIT            LOAD   ACTIVE   SUB     DESCRIPTION");
        for (const [n, s] of [...this.services].sort()) io.out(`${s.active ? "●" : " "} ${(n + ".service").padEnd(15)} loaded ${(s.active ? "active" : "inactive").padEnd(8)} ${(s.active ? "running" : "dead").padEnd(7)} ${s.description}`);
        io.out(""); io.out("LOAD   = Reflects whether the unit definition was properly loaded.");
        io.out("ACTIVE = The high-level unit activation state, i.e. generalization of SUB.");
        io.out("SUB    = The low-level unit activation state, values depend on unit type.");
        io.out(`\n${this.services.size} loaded units listed.`);
        return 0;
      }
      if (!name) { io.err(`Too few arguments.`); return 1; }
      const s = this.services.get(name);
      if (!s) {
        if (["start", "stop", "restart", "enable", "disable", "status", "is-active", "is-enabled"].includes(action)) {
          if (action === "status") { io.err(`Unit ${name}.service could not be found.`); return 4; }
          if (action === "is-active") { io.out("inactive"); return 3; }
          if (action === "is-enabled") { io.err(`Failed to get unit file state for ${name}.service: No such file or directory`); return 1; }
          io.err(`Failed to ${action} ${name}.service: Unit ${name}.service not found.`); return 5;
        }
        io.err(`Unknown command verb ${action}.`); return 1;
      }
      if (needsRoot && proc.uid !== 0) {
        io.err(`Failed to ${action} ${name}.service: Interactive authentication required.`);
        io.err(`See system logs and 'systemctl status ${name}.service' for details.`);
        return 1;
      }
      switch (action) {
        case "status": statusBlock(this, name, io); return s.active ? 0 : 3;
        case "is-active": io.out(s.active ? "active" : "inactive"); return s.active ? 0 : 3;
        case "is-enabled": io.out(s.enabled ? "enabled" : "disabled"); return s.enabled ? 0 : 1;
        case "start": startService(this, name); return 0;
        case "stop": stopService(this, name); return 0;
        case "restart": stopService(this, name); startService(this, name); return 0;
        case "reload": if (!s.active) { io.err(`Failed to reload ${name}.service: Unit ${name}.service is not active.`); return 1; } s.log.push(`${stamp(this)} systemd[1]: Reloaded ${s.description}.`); return 0;
        case "enable": s.enabled = true; io.err(`Created symlink /etc/systemd/system/multi-user.target.wants/${name}.service → /lib/systemd/system/${name}.service.`); return 0;
        case "disable": s.enabled = false; io.err(`Removed "/etc/systemd/system/multi-user.target.wants/${name}.service".`); return 0;
        default: io.err(`Unknown command verb ${action}.`); return 1;
      }
    },
    async service(proc, args, io, ctx) {
      const [name, action] = args;
      if (!name || !action) { io.err("Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]"); return 1; }
      return commands.systemctl.call(this, proc, [action, name], io, ctx);
    },
    async journalctl(proc, args, io) {
      let unit = null, lines = Infinity, follow = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-u" || args[i] === "--unit") unit = (args[++i] || "").replace(/\.service$/, "");
        else if (args[i].startsWith("--unit=")) unit = args[i].slice(7).replace(/\.service$/, "");
        else if (args[i] === "-n" || args[i] === "--lines") lines = Number(args[++i]);
        else if (/^-n\d+$/.test(args[i])) lines = Number(args[i].slice(2));
        else if (args[i] === "-f" || args[i] === "--follow") follow = true;
        else if (args[i] === "-b" || args[i] === "-e" || args[i] === "--no-pager" || args[i] === "-x") { /* accepted */ }
        else { io.err(`journalctl: invalid option -- '${args[i].replace(/^-+/, "")}'`); return 1; }
      }
      if (unit && !this.services.has(unit)) { io.out("-- No entries --"); return 0; }
      let entries = unit ? this.services.get(unit).log : [...this.services.values()].flatMap(s => s.log).sort();
      if (proc.uid !== 0 && !this.groupByGid(4) ? false : proc.uid !== 0 && !proc.groups.includes(4) && !unit) io.notice("Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.");
      if (!entries.length) { io.out("-- No entries --"); return 0; }
      io.out(`-- Journal begins at ${new Date(this.bootTime).toISOString().slice(0, 19).replace("T", " ")} UTC. --`);
      for (const line of entries.slice(lines === Infinity ? 0 : -lines)) io.out(line);
      if (follow) io.notice("(journalctl -f would keep waiting for new lines; the simulation stops here.)");
      return 0;
    },

    async tar(proc, args, io) {
      let mode = null, verbose = false, gz = false, file = null;
      const rest = [];
      let i = 0;
      for (; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith("--")) { if (a === "--create") mode = "c"; else if (a === "--extract") mode = "x"; else if (a === "--list") mode = "t"; else if (a === "--verbose") verbose = true; else if (a === "--gzip") gz = true; else if (a.startsWith("--file=")) file = a.slice(7); else if (a === "--file") file = args[++i]; else { gnuError(io, "tar", `unrecognized option '${a}'`); return 2; } continue; }
        if (a.startsWith("-") || (i === 0 && /^[cxtvzf]+$/.test(a))) {
          for (const c of a.replace(/^-/, "")) { if (c === "c" || c === "x" || c === "t") mode = c; else if (c === "v") verbose = true; else if (c === "z" || c === "j" || c === "J") gz = true; else if (c === "f") file = args[++i]; else if (c === "C") { rest.push("-C", args[++i]); } else if (c === "p") { /* keep permissions – always */ } else { gnuError(io, "tar", `invalid option -- '${c}'`); return 64; } }
          continue;
        }
        rest.push(a);
      }
      if (!mode) { io.err("tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options"); io.err("Try 'tar --help' or 'tar --usage' for more information."); return 2; }
      if (!file) { gnuError(io, "tar", "Refusing to read/write archive contents from terminal (missing -f option)"); return 2; }
      let dest = ".";
      const paths = [];
      for (let k = 0; k < rest.length; k++) { if (rest[k] === "-C") dest = rest[++k]; else paths.push(rest[k]); }
      if (mode === "c") {
        if (!paths.length) { gnuError(io, "tar", "Cowardly refusing to create an empty archive"); return 2; }
        const entries = [];
        for (const p of paths) {
          try { entries.push(...collectTree(this, proc, p, p.replace(/^\.\//, "").replace(/\/+$/, ""))); if (verbose) for (const e of entries.slice(-collectTree(this, proc, p, p).length)) io.out(e.name); }
          catch (error) { gnuError(io, "tar", `${p}: Cannot stat: ${error.message}`); gnuError(io, "tar", "Exiting with failure status due to previous errors"); return 2; }
        }
        try { this.writeFile(proc, file, TAR_MARK + JSON.stringify({ gz, entries })); } catch (error) { gnuError(io, "tar", `${file}: Cannot open: ${error.message}`); return 2; }
        return 0;
      }
      const archive = readArchive(this, proc, file, TAR_MARK, "tar", io);
      if (!archive) return 2;
      if (mode === "t") { listing(archive.entries, this, verbose, io); return 0; }
      return extract(this, proc, archive.entries, io, verbose, "tar", dest);
    },
    async gzip(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "dkvl123456789", longs: { decompress: "d", keep: "k", list: "l" } }); } catch (error) { gnuError(io, "gzip", error.message); return 1; }
      let status = 0;
      for (const path of opts.operands) {
        try {
          const text = this.readFile(proc, path);
          if (opts.flags.has("l")) { const a = text.startsWith(GZ_MARK) ? JSON.parse(text.slice(GZ_MARK.length)) : null; io.out("         compressed        uncompressed  ratio uncompressed_name"); io.out(`${String(text.length).padStart(19)} ${String(a ? a.data.length : 0).padStart(19)} ${a ? Math.round((1 - text.length / Math.max(1, a.data.length)) * 100) : 0}% ${path.replace(/\.gz$/, "")}`); continue; }
          if (opts.flags.has("d")) {
            if (!path.endsWith(".gz")) { gnuError(io, "gzip", `${path}: unknown suffix -- ignored`); status = 2; continue; }
            const a = readArchive(this, proc, path, GZ_MARK, "gzip", io); if (!a) { status = 1; continue; }
            this.writeFile(proc, path.replace(/\.gz$/, ""), a.data, { mode: a.mode });
          } else {
            if (path.endsWith(".gz")) { gnuError(io, "gzip", `${path} already has .gz suffix -- unchanged`); status = 2; continue; }
            const { inode } = this.stat(proc, path);
            this.writeFile(proc, path + ".gz", GZ_MARK + JSON.stringify({ name: path.split("/").pop(), mode: inode.mode & 0o777, data: text }), { mode: inode.mode & 0o777 });
          }
          if (!opts.flags.has("k")) this.unlink(proc, path);
          if (opts.flags.has("v")) io.err(`${path}:\t${opts.flags.has("d") ? "" : "48.0% -- replaced with "}${opts.flags.has("d") ? "" : path + ".gz"}`.trim());
        } catch (error) { gnuError(io, "gzip", `${path}: ${error.message}`); status = 1; }
      }
      if (!opts.operands.length) { io.notice("(gzip without a file reads from the keyboard – in the simulation name a file: gzip datei.txt)"); }
      return status;
    },
    async gunzip(proc, args, io, ctx) { return commands.gzip.call(this, proc, ["-d", ...args], io, ctx); },
    async zcat(proc, args, io) {
      let status = 0;
      for (const path of args) { const a = readArchive(this, proc, path, GZ_MARK, "gzip", io); if (!a) { status = 1; continue; } io.write(a.data); }
      return status;
    },
    async zip(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "rqv", longs: { recurse: "r" } }); } catch (error) { gnuError(io, "zip", error.message); return 16; }
      if (opts.operands.length < 2) { io.err("zip error: Nothing to do! (try: zip -r archive.zip . -i ...)"); return 12; }
      const [file, ...paths] = opts.operands;
      const target = file.endsWith(".zip") ? file : file + ".zip";
      const entries = [];
      for (const p of paths) {
        try {
          const { inode } = this.stat(proc, p);
          if (inode.type === "dir" && !opts.flags.has("r")) { if (!opts.flags.has("q")) io.out(`  adding: ${p.replace(/\/$/, "")}/ (stored 0%)`); entries.push({ name: p.replace(/\/$/, "") + "/", type: "dir", mode: inode.mode & 0o777, size: 0 }); continue; }
          const found = collectTree(this, proc, p, p.replace(/^\.\//, "").replace(/\/+$/, ""));
          for (const e of found) { entries.push(e); if (!opts.flags.has("q")) io.out(`  adding: ${e.name} (${e.type === "file" && e.size > 20 ? "deflated 40%" : "stored 0%"})`); }
        } catch (error) { io.err(`zip warning: name not matched: ${p}`); }
      }
      if (!entries.length) { io.err(`zip error: Nothing to do! (${target})`); return 12; }
      try { this.writeFile(proc, target, ZIP_MARK + JSON.stringify({ entries })); } catch (error) { io.err(`zip I/O error: ${error.message}`); return 14; }
      return 0;
    },
    async unzip(proc, args, io) {
      let opts;
      try { opts = parseArgs(args, { flags: "lqo", values: "d" }); } catch (error) { gnuError(io, "unzip", error.message); return 10; }
      const file = opts.operands[0];
      if (!file) { io.err("UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP."); io.err("Usage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]"); return 10; }
      const archive = readArchive(this, proc, file, ZIP_MARK, "unzip", io);
      if (!archive) return 9;
      if (opts.flags.has("l")) {
        io.out(`Archive:  ${file}`); io.out("  Length      Date    Time    Name"); io.out("---------  ---------- -----   ----");
        let total = 0;
        const d = local(this.clock.now());
        for (const e of archive.entries) { total += e.size; io.out(`${String(e.size).padStart(9)}  ${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}   ${e.name}`); }
        io.out("---------                     -------"); io.out(`${String(total).padStart(9)}                     ${archive.entries.length} files`);
        return 0;
      }
      if (!opts.flags.has("q")) io.out(`Archive:  ${file}`);
      const dest = opts.values.d ?? ".";
      for (const e of archive.entries) {
        const target = joinPath(dest, e.name.replace(/\/$/, ""));
        if (!opts.flags.has("q")) io.out(`  ${e.type === "dir" ? "creating" : e.type === "file" && e.size > 20 ? "inflating" : "extracting"}: ${joinPath(dest === "." ? "" : dest, e.name)}`);
        try {
          if (e.type === "dir") { try { this.mkdir(proc, target, { parents: true }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
          else { const parent = target.replace(/\/[^/]+$/, ""); if (parent && parent !== target) { try { this.mkdir(proc, parent, { parents: true }); } catch { /* exists */ } } this.writeFile(proc, target, e.data, { mode: e.mode }); }
        } catch (error) { io.err(`unzip: cannot create ${target}: ${error.message}`); return 2; }
      }
      return 0;
    },

    async cowsay(proc, args, io) {
      const text = args.length ? args.join(" ") : (io.stdin ?? "").replace(/\n$/, "") || "Moo";
      io.out(COW(text)); io.out(COW_BODY); return 0;
    },
    async cowthink(proc, args, io) {
      const text = args.length ? args.join(" ") : (io.stdin ?? "").replace(/\n$/, "") || "Hmm";
      io.out(COW(text).replace(/^(.)/gm, m => m)); io.out(COW_BODY.replace(/\\/g, "o").replace(/\/|\)|\(/g, ch => ch)); return 0;
    },
    async sl(proc, args, io) {
      io.out("                 (@@) (  ) (@)  ( )  @@    ()    @     O     @     O      @");
      io.out("            (   )");
      io.out("        (@@@@)");
      io.out("     (    )");
      io.out("");
      io.out("   (@@@@)");
      io.out("");
      io.out("      ====        ________                ___________");
      io.out("  _D _|  |_______/        \\__I_I_____===__|_________|");
      io.out("   |(_)---  |   H\\________/ |   |        =|___ ___|      _________________");
      io.out("   /     |  |   H  |  |     |   |         ||_| |_||     _|                \\_____A");
      io.out("  |      |  |   H  |__--------------------| [___] |   =|                        |");
      io.out("  | ________|___H__/__|_____/[][]~\\_______|       |   -|                        |");
      io.out("  |/ |   |-----------I_____I [][] []  D   |=======|____|________________________|_");
      io.out("__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__|__________________________|_");
      io.out(" |/-=|___|=    ||    ||    ||    |_____/~\\___/          |_D__D__D_|  |_D__D__D_|");
      io.out("  \\_/      \\O=====O=====O=====O_/      \\_/               \\_/   \\_/    \\_/   \\_/");
      io.notice("(sl: the train has left – you meant ls.)");
      return 0;
    },
    async fortune(proc, args, io) {
      const pick = FORTUNES[Math.floor((this.clock.now() / 1000) % FORTUNES.length)];
      io.out(pick); return 0;
    },
    async neofetch(proc, args, io) {
      const s = Math.floor(this.uptimeSeconds());
      const left = ["       _,met$$$$$gg.", "    ,g$$$$$$$$$$$$$$$P.", "  ,g$$P\"\"       \"\"\"Y$$.\".", " ,$$P'              `$$$.", "',$$P       ,ggs.     `$$b:", "`d$$'     ,$P\"'   .    $$$", " $$P      d$'     ,    $$P", " $$:      $$.   -    ,d$$'", " $$;      Y$b._   _,d$P'", " Y$$.    `.`\"Y$$$$P\"'", " `$$b      \"-.__", "  `Y$$", "   `Y$$.", "     `$$b.", "       `Y$$b.", "          `\"Y$b._", "              `\"\"\"\""];
      const right = [`${proc.user}@${this.hostname}`, "-".repeat(proc.user.length + this.hostname.length + 1), "OS: LiaLinux 1 (simulated) x86_64", "Host: LiaScript Virtual Machine", "Kernel: 6.1.0-lialinux", `Uptime: ${Math.floor(s / 60)} mins`, `Packages: ${Object.keys(index()).filter(n => installed(this, n)).length} (dpkg)`, "Shell: bash 5.2.15", "Terminal: xterm.js", "CPU: LiaLinux Simulated CPU (1) @ 2.000GHz", "Memory: 120MiB / 2048MiB"];
      left.forEach((l, i) => io.out(`${l.padEnd(30)} ${right[i] ?? ""}`));
      return 0;
    },
    async nginx(proc, args, io) {
      if (args.includes("-v") || args.includes("-V")) { io.err("nginx version: nginx/1.22.1"); return 0; }
      if (args.includes("-t")) { io.err("nginx: the configuration file /etc/nginx/nginx.conf syntax is ok"); io.err("nginx: configuration file /etc/nginx/nginx.conf test is successful"); return 0; }
      if (proc.uid !== 0) { io.err("nginx: [emerg] open() \"/var/log/nginx/error.log\" failed (13: Permission denied)"); return 1; }
      io.notice("(nginx is managed by systemd here: sudo systemctl start nginx)");
      return 0;
    }
  };

  async function apt(proc, args, io, ctx, tool) {
    const yes = args.includes("-y") || args.includes("--yes") || args.includes("--assume-yes");
    const words = args.filter(a => !a.startsWith("-"));
    const action = words[0];
    const names = words.slice(1);
    const all = index();
    const lockError = (lists) => {
      if (lists) { io.out("Reading package lists... Done"); io.err("E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)"); io.err("E: Unable to lock directory /var/lib/apt/lists/"); }
      else { io.err("E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)"); io.err("E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?"); }
      return 100;
    };
    const kb = n => `${(n / 1).toFixed(1)} kB`;
    switch (action) {
      case "update": {
        if (proc.uid !== 0) return lockError(true);
        io.out("Hit:1 http://deb.debian.org/debian bookworm InRelease");
        io.out("Get:2 http://deb.debian.org/debian bookworm-updates InRelease [55.4 kB]");
        io.out("Get:3 http://security.debian.org/debian-security bookworm-security InRelease [48.0 kB]");
        io.out("Fetched 103 kB in 1s (95.2 kB/s)");
        io.out("Reading package lists... Done");
        if (tool === "apt") { io.out("Building dependency tree... Done"); io.out("Reading state information... Done"); io.out("All packages are up to date."); }
        this.aptUpdated = true;
        return 0;
      }
      case "upgrade": case "full-upgrade": case "dist-upgrade": {
        if (proc.uid !== 0) return lockError(false);
        io.out("Reading package lists... Done"); io.out("Building dependency tree... Done"); io.out("Reading state information... Done");
        io.out("Calculating upgrade... Done");
        io.out("0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.");
        return 0;
      }
      case "install": {
        if (!names.length) { io.err("E: Nothing to install"); return 100; }
        if (proc.uid !== 0) return lockError(false);
        io.out("Reading package lists... Done"); io.out("Building dependency tree... Done"); io.out("Reading state information... Done");
        const toInstall = [];
        for (const name of names) {
          if (!(name in all) || (!this.aptUpdated && !isBase(name))) { io.err(`E: Unable to locate package ${name}`); if (!this.aptUpdated && name in all) io.notice("(In the simulation apt only knows the index after 'sudo apt update' – like a fresh installation.)"); return 100; }
          if (installed(this, name)) { io.out(`${name} is already the newest version (${all[name].version}).`); continue; }
          toInstall.push(name);
        }
        if (!toInstall.length) { io.out("0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded."); return 0; }
        const size = toInstall.reduce((s, n) => s + all[n].size, 0);
        io.out("The following NEW packages will be installed:"); io.out("  " + toInstall.join(" "));
        io.out(`0 upgraded, ${toInstall.length} newly installed, 0 to remove and 0 not upgraded.`);
        io.out(`Need to get ${kb(size)} of archives.`);
        io.out(`After this operation, ${kb(size * 4)} of additional disk space will be used.`);
        if (!yes && toInstall.length) {
          const answer = await io.readLine({ prompt: "Do you want to continue? [Y/n] ", echo: true });
          if (/^[nN]/.test(answer.trim())) { io.out("Abort."); return 1; }
        }
        toInstall.forEach((n, i) => io.out(`Get:${i + 1} http://deb.debian.org/debian bookworm/main amd64 ${n} ${n === "cowsay" || n === "fortune" ? "all" : "amd64"} ${all[n].version} [${kb(all[n].size)}]`));
        io.out(`Fetched ${kb(size)} in 0s (${kb(size * 3)}/s)`);
        for (const n of toInstall) {
          io.out(`Selecting previously unselected package ${n}.`);
          io.out(`Preparing to unpack .../${n}_${all[n].version}_amd64.deb ...`);
          io.out(`Unpacking ${n} (${all[n].version}) ...`);
        }
        for (const n of toInstall) { io.out(`Setting up ${n} (${all[n].version}) ...`); await installPackage(this, n, io); }
        io.out("Processing triggers for man-db (2.11.2-2) ...");
        return 0;
      }
      case "remove": case "purge": case "autoremove": {
        if (proc.uid !== 0) return lockError(false);
        io.out("Reading package lists... Done"); io.out("Building dependency tree... Done"); io.out("Reading state information... Done");
        if (action === "autoremove" && !names.length) { io.out("0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded."); return 0; }
        const toRemove = [];
        for (const name of names) {
          if (!(name in all)) { io.err(`E: Unable to locate package ${name}`); return 100; }
          if (isBase(name)) { io.err(`E: Removing ${name} would break the simulation – essential packages stay installed.`); return 100; }
          if (!this.installed.has(name)) { io.out(`Package '${name}' is not installed, so not removed`); continue; }
          toRemove.push(name);
        }
        if (!toRemove.length) { io.out("0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded."); return 0; }
        io.out("The following packages will be REMOVED:"); io.out("  " + toRemove.join(" "));
        io.out(`0 upgraded, 0 newly installed, ${toRemove.length} to remove and 0 not upgraded.`);
        io.out(`After this operation, ${kb(toRemove.reduce((s, n) => s + all[n].size * 4, 0))} disk space will be freed.`);
        if (!yes) { const answer = await io.readLine({ prompt: "Do you want to continue? [Y/n] ", echo: true }); if (/^[nN]/.test(answer.trim())) { io.out("Abort."); return 1; } }
        for (const n of toRemove) { io.out(`Removing ${n} (${all[n].version}) ...`); removePackage(this, n); }
        io.out("Processing triggers for man-db (2.11.2-2) ...");
        return 0;
      }
      case "search": {
        const needle = (names[0] || "").toLowerCase();
        io.out("Sorting... Done"); io.out("Full Text Search... Done");
        for (const [name, p] of Object.entries(all).sort()) if (name.includes(needle) || p.description.toLowerCase().includes(needle)) { io.out(`${name}/stable${installed(this, name) ? ",now" : ""} ${p.version} ${name === "cowsay" || name === "fortune" ? "all" : "amd64"}${installed(this, name) ? " [installed]" : ""}`); io.out(`  ${p.description}`); io.out(""); }
        return 0;
      }
      case "show": {
        const name = names[0];
        if (!name || !(name in all)) { io.err(`E: Unable to locate package ${name ?? ""}`); return 100; }
        const p = all[name];
        io.out(`Package: ${name}\nVersion: ${p.version}\nPriority: optional\nSection: ${name === "nginx" ? "httpd" : "utils"}\nMaintainer: Debian Maintainers <debian@example.org>\nInstalled-Size: ${p.size * 4} kB\nDownload-Size: ${kb(p.size)}\nAPT-Sources: http://deb.debian.org/debian bookworm/main amd64 Packages\nDescription: ${p.description}${installed(this, name) ? "\n\nN: This package is installed." : ""}`);
        return 0;
      }
      case "list": {
        const onlyInstalled = args.includes("--installed");
        io.out("Listing... Done");
        for (const [name, p] of Object.entries(all).sort()) { if (onlyInstalled && !installed(this, name)) continue; io.out(`${name}/stable${installed(this, name) ? ",now" : ""} ${p.version} ${name === "cowsay" || name === "fortune" ? "all" : "amd64"}${installed(this, name) ? " [installed]" : ""}`); }
        return 0;
      }
      case "policy": { const name = names[0]; if (!name || !(name in all)) { io.out("Package files:"); io.out(" 500 http://deb.debian.org/debian bookworm/main amd64 Packages"); return 0; } io.out(`${name}:\n  Installed: ${installed(this, name) ? all[name].version : "(none)"}\n  Candidate: ${all[name].version}`); return 0; }
      default:
        if (!action) { io.out(`${tool} ${tool === "apt" ? "2.6.1" : "2.6.1"} (amd64)`); io.out("Usage: apt [options] command"); io.out(""); io.out("Most used commands:\n  list - list packages based on package names\n  search - search in package descriptions\n  show - show package details\n  install - install packages\n  remove - remove packages\n  update - update list of available packages\n  upgrade - upgrade the system by installing/upgrading packages"); return 0; }
        io.err(`E: Invalid operation ${action}`); return 100;
    }
  }

  kernel.registerCommands(commands);
  global.LiaLinuxSystem = Object.freeze({ registerPackage, packages: PACKAGES, basePackages: BASE_PACKAGES, startService, stopService, ensureService, installPackage, removePackage, isInstalled: installed });
  void fmtClock; void linesOf; void q;
  }
})(globalThis);
