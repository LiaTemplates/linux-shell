// Model tests for the linux-shell template: node --test lia-templates/linux-shell/check.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import "./linux-kernel.js";
import "./linux-lang-de.js";
import "./linux-tools.js";
import "./linux-system.js";
import "./linux-programs.js";

const kernel = globalThis.LiaLinuxKernel;
const programs = globalThis.LiaLinuxPrograms;

function boot(options = {}) {
  const clock = kernel.fakeClock();
  const sys = kernel.createSystem({ clock, ...options });
  const sh = (line, input, hooks = {}) => kernel.runCollect(sys, line, { input, ...hooks });
  return { sys, clock, sh };
}

// ---------------------------------------------------------------- shell basics

test("prompt names user, host and ~ for the home directory", async () => {
  const { sys, sh } = boot();
  assert.equal(sys.prompt(), "anna@kurs:~$ ");
  await sh("cd /tmp");
  assert.equal(sys.prompt(), "anna@kurs:/tmp$ ");
  await sh("cd");
  assert.equal(sys.prompt(), "anna@kurs:~$ ");
});

test("the line parser handles quotes, comments, ; and &", () => {
  const cmds = kernel.parseLine(`echo "a b" 'c d' e\\ f # comment ; not run`);
  assert.equal(cmds.length, 1);
  assert.deepEqual(cmds[0].words.map(w => w.map(p => p.text).join("")), ["echo", "a b", "c d", "e f"]);
  const two = kernel.parseLine("cd /tmp; ls &");
  assert.equal(two.length, 2);
  assert.equal(two[0].background, false);
  assert.equal(two[1].background, true);
  const piped = kernel.parseLine("ls -l | grep txt | wc -l");
  assert.equal(piped.length, 1);
  assert.equal(piped[0].stages.length, 3);
  assert.deepEqual(piped[0].stages[2].map(w => w[0].text), ["wc", "-l"]);
  assert.throws(() => kernel.parseLine("ls |"), /syntax error near unexpected token `\|'/);
  const redirected = kernel.parseLine("ls -l 2>&1 > out.txt");
  assert.deepEqual(redirected[0].words.map(w => w[0].text), ["ls", "-l", ">", ">", "out.txt"]);
  assert.equal(redirected[0].words[2][0].redirect, 2);
  assert.equal(redirected[0].words[2][0].dup, 1);
});

test("variables, ~ and globbing expand like in bash", async () => {
  const { sh } = boot();
  assert.equal((await sh("echo $HOME $USER")).stdout, "/home/anna anna\n");
  assert.equal((await sh("echo '$HOME'")).stdout, "$HOME\n");
  assert.equal((await sh("echo ~ben")).stdout, "/home/ben\n");
  assert.equal((await sh("echo ~/scripts")).stdout, "/home/anna/scripts\n");
  assert.equal((await sh("echo *.txt")).stdout, "notes.txt\n");
  assert.equal((await sh("echo *.nix")).stdout, "*.nix\n");
  assert.equal((await sh("ls /home/*/*.txt")).stdout, "/home/anna/notes.txt  /home/ben/public.txt  /home/ben/secret.txt\n");
});

test("pipes and < connect the tools: cat | grep | wc, sort -u, tr, head, tee, xargs", async () => {
  const { sh } = boot();
  assert.equal((await sh("cat notes.txt | grep cd | wc -l")).stdout, "1\n");
  assert.equal((await sh("cat < notes.txt | head -n 1")).stdout, "Linux commands I know:\n");
  assert.equal((await sh("echo hallo welt | tr a-z A-Z")).stdout, "HALLO WELT\n");
  assert.equal((await sh("echo 'a,b,c' | tr ',' '\\n' | sort -r | tr '\\n' ' '")).stdout, "c b a ");
  assert.equal((await sh("printf 'b\\na\\nb\\n' | sort | uniq -c")).stdout, "      1 a\n      2 b\n");
  assert.equal((await sh("ls | grep -c .")).stdout, "3\n");
  assert.equal((await sh("echo x | cat -")).stdout, "x\n");
  assert.equal((await sh("grep nix notes.txt | wc -l")).stdout, "0\n");
  assert.equal((await sh("echo eins | tee kopie.txt")).stdout, "eins\n");
  assert.equal((await sh("cat kopie.txt")).stdout, "eins\n");
  assert.equal((await sh("echo a b c | xargs -n 1 echo -")).stdout, "- a\n- b\n- c\n");
  assert.equal((await sh("echo 'ls' | xargs")).stdout, "ls\n");
  assert.equal((await sh("cat nix | wc -l")).stderr, "cat: nix: No such file or directory\n");
  assert.equal((await sh("cat nix | wc -l")).stdout, "0\n");
  assert.equal((await sh("echo hi | sleep 0; echo $?")).stdout, "0\n");
  assert.equal((await sh("cat /etc/passwd | cut -d : -f 1 | grep -c '^[ab]'")).stdout, "2\n");
  // a pipeline in the background is one job
  assert.match((await sh("sleep 100 | sleep 100 &")).stdout, /^\[1\] \d+\n$/);
  assert.match((await sh("jobs")).stdout, /bash -c sleep 100 \| sleep 100/);
});

test("output redirection: > >> 2> 2>&1 &> and /dev/null", async () => {
  const { sh } = boot();
  assert.equal((await sh("echo hallo > datei.txt")).stdout, "");
  assert.equal((await sh("cat datei.txt")).stdout, "hallo\n");
  await sh("echo welt >> datei.txt");
  assert.equal((await sh("cat datei.txt")).stdout, "hallo\nwelt\n");
  await sh("echo neu > datei.txt");
  assert.equal((await sh("cat datei.txt")).stdout, "neu\n");
  assert.equal((await sh("ls /nix 2> fehler.txt")).stderr, "");
  assert.equal((await sh("cat fehler.txt")).stdout, "ls: cannot access '/nix': No such file or directory\n");
  assert.equal((await sh("ls /nix > alles.txt 2>&1")).stdout, "");
  assert.match((await sh("cat alles.txt")).stdout, /cannot access/);
  await sh("ls /nix &> beides.txt");
  assert.match((await sh("cat beides.txt")).stdout, /cannot access/);
  assert.equal((await sh("ls > /dev/null")).stdout, "");
  assert.equal((await sh("echo x > /etc/x")).stderr, "bash: /etc/x: Permission denied\n");
  assert.equal((await sh("echo x > /etc/x")).status, 1);
  assert.equal((await sh("cat < datei.txt")).stdout, "neu\n");
  assert.equal((await sh("cat < nix")).stderr, "bash: nix: No such file or directory\n");
  assert.match((await sh("echo >")).stderr, /unexpected token `newline'/);
  // the redirect target is created before the command runs, with the umask
  await sh("ls -l > liste.txt");
  assert.match((await sh("cat liste.txt")).stdout, /liste\.txt/);
  assert.match((await sh("ls -l liste.txt")).stdout, /^-rw-r--r-- /);
});

test("exit status, $?, ! and && || chaining", async () => {
  const { sh } = boot();
  assert.equal((await sh("cat /nirgends")).status, 1);
  assert.equal((await sh("echo $?")).stdout, "1\n");
  assert.equal((await sh("! cat /nirgends")).status, 0);
  assert.equal((await sh("false || echo fallback")).stdout, "fallback\n");
  assert.equal((await sh("true && echo weiter")).stdout, "weiter\n");
  assert.equal((await sh("nichtda")).stderr, "bash: nichtda: command not found\n");
  assert.equal((await sh("nichtda")).status, 127);
});

// ---------------------------------------------------------------- acceptance 1: one session across pages

test("acceptance 1: a file created in one terminal is visible from a second terminal on the same session", async () => {
  const { sys, sh } = boot();
  await sh("touch /home/anna/seite1.txt");
  // a second terminal attaches to the same system object – it only has another io
  const second = await kernel.runCollect(sys, "ls");
  assert.match(second.stdout, /seite1\.txt/);
  assert.equal(second.stdout, "notes.txt  project  scripts  seite1.txt\n");
});

test("serialize and restore keep files, users, cwd and history", async () => {
  const { sys, sh } = boot();
  await sh("mkdir /home/anna/neu");
  await sh("cd /home/anna/neu");
  await sh("touch datei");
  const data = JSON.parse(JSON.stringify(sys.serialize()));
  const restored = kernel.restoreSystem(data, { clock: kernel.fakeClock() });
  assert.equal(restored.prompt(), "anna@kurs:~/neu$ ");
  assert.equal((await kernel.runCollect(restored, "ls")).stdout, "datei\n");
  assert.equal((await kernel.runCollect(restored, "cat /etc/passwd")).stdout.includes("ben:x:1001"), true);
  assert.deepEqual(restored.history.slice(0, 3), ["mkdir /home/anna/neu", "cd /home/anna/neu", "touch datei"]);
  // processes are not persisted: after the restore only init, the shell and the daemons of the enabled services
  assert.equal(restored.procs.size, 4);
  assert.deepEqual([...restored.procs.values()].map(p => p.cmd).sort(), ["bash", "cron", "init", "sshd"]);
});

// ---------------------------------------------------------------- acceptance 2: processes, jobs, signals

test("acceptance 2: sleep 100 & appears in ps and jobs; kill %1 ends it and jobs is empty", async () => {
  const { sys, clock, sh } = boot();
  const started = await sh("sleep 100 &");
  assert.match(started.stdout, /^\[1\] \d+\n$/);
  assert.match((await sh("ps")).stdout, /sleep/);
  assert.match((await sh("jobs")).stdout, /\[1\]\+  Running                 sleep 100 &/);
  const killed = await sh("kill %1");
  assert.equal(killed.status, 0);
  assert.match(killed.stdout, /\[1\]\+  Terminated              sleep 100/);
  assert.equal((await sh("jobs")).stdout, "");
  assert.doesNotMatch((await sh("ps")).stdout, /sleep/);
  await clock.advance(200000);
  assert.equal((await sh("jobs")).stdout, "");
});

test("a job ends by itself when its time is up", async () => {
  const { clock, sh } = boot();
  await sh("sleep 5 &");
  await clock.advance(6000);
  assert.match((await sh("jobs")).stdout, /Done/);
  assert.equal((await sh("jobs")).stdout, "");
});

test("SIGTERM can be ignored with trap, SIGKILL cannot", async () => {
  const { sh, clock } = boot();
  await sh(`bash -c 'trap "" TERM; sleep 100' &`);
  assert.equal((await sh("kill %1")).status, 0);
  assert.match((await sh("jobs")).stdout, /Running/);
  const killed = await sh("kill -9 %1");
  assert.equal(killed.status, 0);
  assert.match(killed.stdout, /\[1\]\+  Killed/);
  await clock.advance(1);
  assert.equal((await sh("jobs")).stdout, "");
});

test("kill needs the right user or root; numbers and names are accepted", async () => {
  const { sys, sh } = boot();
  await sh("sleep 100 &");
  const pid = sys.shell.lastBg;
  await sh("su ben", ["ben"]);
  const denied = await sh(`kill ${pid}`);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /Operation not permitted/);
  assert.match((await sh("kill 99999")).stderr, /No such process/);
  await sh("exit");
  assert.equal((await sh(`kill -s TERM ${pid}`)).status, 0);
  assert.equal((await sh("kill -l")).stdout.includes("9) SIGKILL"), true);
});

test("a stopped job: STOP, jobs shows Stopped, CONT resumes, exit status 143 after TERM", async () => {
  const { sys, sh, clock } = boot();
  await sh("sleep 50 &");
  const pid = sys.shell.lastBg;
  await sh(`kill -STOP ${pid}`);
  assert.match((await sh("jobs")).stdout, /Stopped/);
  assert.equal(sys.procs.get(pid).state, "T");
  await sh(`kill -CONT ${pid}`);
  assert.equal(sys.procs.get(pid).state, "S");
  const killed = await sh(`kill ${pid}`);
  assert.match(killed.stdout, /\[1\]\+  Terminated              sleep 50/);
  assert.equal(sys.procs.has(pid), false);
  // a TERM sent while stopped is delivered only on CONT
  await sh("sleep 50 &");
  const pid2 = sys.shell.lastBg;
  await sh(`kill -STOP ${pid2}`);
  await sh(`kill ${pid2}`);
  assert.equal(sys.procs.get(pid2).state, "T");
  const resumed = await sh(`kill -CONT ${pid2}`);
  assert.match(resumed.stdout, /Terminated/);
  await clock.advance(1);
});

test("a child nobody waits for becomes a zombie until its parent ends", async () => {
  const { sys, sh, clock } = boot();
  await sh(`bash -c 'sleep 1 & sleep 100' &`);
  await clock.advance(2000);
  const ps = (await sh("ps aux")).stdout;
  assert.match(ps, /Z\s+\d\d:\d\d\s+\d\d:\d\d sleep 1\n/);
  await sh("kill -9 %1");
  await clock.advance(1);
  assert.doesNotMatch((await sh("ps aux")).stdout, /sleep 1\n/);
});

test("Ctrl+C interrupts the foreground command, Ctrl+Z stops it and fg brings it back", async () => {
  const { sys, sh, clock } = boot();
  let out = "";
  const run = sys.run("sleep 30", { write: t => { out += t; } });
  await Promise.resolve();
  assert.equal(sys.interrupt(), true);
  assert.equal(await run, 130);
  const run2 = sys.run("sleep 30", { write: t => { out += t; } });
  await Promise.resolve();
  assert.equal(sys.suspend(), true);
  assert.equal(await run2, 148);
  assert.match(out, /\[1\]\+  Stopped                 sleep 30/);
  assert.match((await sh("jobs")).stdout, /Stopped/);
  const fg = kernel.runCollect(sys, "fg");
  await clock.advance(31000);
  assert.equal((await fg).status, 0);
  assert.equal((await sh("jobs")).stdout, "");
  assert.equal(sys.interrupt(), false);
});

// ---------------------------------------------------------------- acceptance 3: users, groups, permissions

test("acceptance 3: anna may not read Ben's secret file; after chmod o+r by ben she may", async () => {
  const { sh } = boot();
  const denied = await sh("cat /home/ben/secret.txt");
  assert.equal(denied.status, 1);
  assert.equal(denied.stderr, "cat: /home/ben/secret.txt: Permission denied\n");
  assert.match((await sh("ls -l /home/ben/secret.txt")).stdout, /^-rw------- 1 ben ben /);
  // anna is not the owner: chmod is refused
  assert.match((await sh("chmod o+r /home/ben/secret.txt")).stderr, /changing permissions of '\/home\/ben\/secret.txt': Operation not permitted/);
  const su = await sh("su ben", ["falsch"]);
  assert.equal(su.stderr, "su: Authentication failure\n");
  await sh("su ben", ["ben"]);
  assert.equal((await sh("whoami")).stdout, "ben\n");
  assert.equal((await sh("chmod o+r /home/ben/secret.txt")).status, 0);
  await sh("exit");
  assert.equal((await sh("whoami")).stdout, "anna\n");
  const allowed = await sh("cat /home/ben/secret.txt");
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, "Ben's password list (do not read!)\n");
  assert.match((await sh("ls -l /home/ben/secret.txt")).stdout, /^-rw----r-- /);
});

test("the permission matrix: owner, group, other, root – r w x for files and directories", () => {
  const { sys } = boot();
  const anna = sys.users.get("anna"), ben = sys.users.get("ben"), root = sys.users.get("root");
  const procFor = user => ({ uid: user.uid, gid: user.gid, groups: sys.groupsOf(user) });
  const file = (mode, uid, gid) => ({ type: "file", mode, uid, gid });
  const project = sys.groups.get("project").gid;
  // owner
  assert.equal(sys.mayAccess(procFor(anna), file(0o600, anna.uid, anna.gid), "r"), true);
  assert.equal(sys.mayAccess(procFor(anna), file(0o400, anna.uid, anna.gid), "w"), false);
  assert.equal(sys.mayAccess(procFor(anna), file(0o644, anna.uid, anna.gid), "x"), false);
  // group via supplementary group membership
  assert.equal(sys.mayAccess(procFor(ben), file(0o660, anna.uid, project), "w"), true);
  assert.equal(sys.mayAccess(procFor(ben), file(0o600, anna.uid, project), "r"), false);
  // other
  assert.equal(sys.mayAccess(procFor(ben), file(0o604, anna.uid, anna.gid), "r"), true);
  assert.equal(sys.mayAccess(procFor(ben), file(0o640, anna.uid, anna.gid), "r"), false);
  // the owner's bits win even when group/other would allow more
  assert.equal(sys.mayAccess(procFor(anna), file(0o066, anna.uid, anna.gid), "r"), false);
  // root reads and writes everything, executes only with some x bit
  assert.equal(sys.mayAccess(procFor(root), file(0o000, anna.uid, anna.gid), "w"), true);
  assert.equal(sys.mayAccess(procFor(root), file(0o644, anna.uid, anna.gid), "x"), false);
  assert.equal(sys.mayAccess(procFor(root), file(0o700, anna.uid, anna.gid), "x"), true);
  assert.equal(sys.mayAccess(procFor(root), { type: "dir", mode: 0o000, uid: anna.uid, gid: anna.gid }, "x"), true);
});

test("directory rights: no x means no cd and no access to files inside; w on the directory allows rm of a read-only file", async () => {
  const { sh } = boot();
  await sh("mkdir ~/tresor");
  await sh("touch ~/tresor/inhalt.txt");
  await sh("chmod 600 ~/tresor");
  assert.equal((await sh("cd ~/tresor")).stderr, "bash: cd: /home/anna/tresor: Permission denied\n");
  assert.equal((await sh("cat ~/tresor/inhalt.txt")).stderr, "cat: /home/anna/tresor/inhalt.txt: Permission denied\n");
  await sh("chmod 700 ~/tresor");
  await sh("chmod 444 ~/tresor/inhalt.txt");
  assert.equal((await sh("rm ~/tresor/inhalt.txt")).status, 0);
  // a file in a directory without w cannot be removed even by its owner
  await sh("touch ~/tresor/fest.txt");
  await sh("chmod 500 ~/tresor");
  assert.equal((await sh("rm ~/tresor/fest.txt")).stderr, "rm: cannot remove '/home/anna/tresor/fest.txt': Permission denied\n");
  // /tmp has the sticky bit: ben cannot delete anna's file there
  await sh("touch /tmp/anna.tmp");
  await sh("su ben", ["ben"]);
  assert.equal((await sh("rm /tmp/anna.tmp")).stderr, "rm: cannot remove '/tmp/anna.tmp': Operation not permitted\n");
});

test("chmod: octal and symbolic modes, -R, and only the owner or root may change", async () => {
  const { sh } = boot();
  await sh("touch ~/a");
  await sh("chmod 640 ~/a");
  assert.match((await sh("ls -l ~/a")).stdout, /^-rw-r----- /);
  await sh("chmod u-w,g+x,o=r ~/a");
  assert.match((await sh("ls -l ~/a")).stdout, /^-r--r-xr-- /);
  await sh("chmod a+x ~/a");
  assert.match((await sh("ls -l ~/a")).stdout, /^-r-xr-xr-x /);
  await sh("chmod +w ~/a");
  assert.match((await sh("ls -l ~/a")).stdout, /^-rwxr-xr-x /);
  assert.equal(kernel.applyModeSpec("g-w", 0o777, false, 0o022), 0o757);
  assert.equal(kernel.applyModeSpec("u+s", 0o755, false, 0o022), 0o4755);
  assert.equal(kernel.applyModeSpec("xyz", 0o755, false, 0o022), null);
  assert.match((await sh("chmod 777 /etc/passwd")).stderr, /Operation not permitted/);
  assert.equal((await sh("sudo chmod 644 /etc/passwd", ["anna"])).status, 0);
  assert.match((await sh("chmod 644 /nix")).stderr, /cannot access '\/nix': No such file or directory/);
});

test("chown, chgrp, umask, id and groups", async () => {
  const { sh } = boot();
  await sh("touch ~/gemeinsam.txt");
  assert.match((await sh("chown ben ~/gemeinsam.txt")).stderr, /Operation not permitted/);
  assert.equal((await sh("chgrp project ~/gemeinsam.txt")).status, 0);
  assert.match((await sh("ls -l ~/gemeinsam.txt")).stdout, / anna project /);
  // a group anna does not belong to is refused; sudo (a group of hers) would be allowed
  assert.match((await sh("chgrp users ~/notes.txt")).stderr, /changing group of '\/home\/anna\/notes.txt': Operation not permitted/);
  assert.match((await sh("chgrp shadow ~/notes.txt")).stderr, /Operation not permitted/);
  assert.equal((await sh("chgrp sudo ~/notes.txt")).status, 0);
  assert.equal((await sh("sudo chown ben:ben ~/gemeinsam.txt", ["anna"])).status, 0);
  assert.match((await sh("ls -l ~/gemeinsam.txt")).stdout, / ben ben /);
  assert.equal((await sh("umask")).stdout, "0022\n");
  await sh("umask 077");
  await sh("touch ~/privat.txt");
  await sh("mkdir ~/privat");
  assert.match((await sh("ls -l ~/privat.txt")).stdout, /^-rw------- /);
  assert.match((await sh("ls -ld ~/privat")).stdout, /^drwx------ /);
  assert.equal((await sh("id")).stdout, "uid=1000(anna) gid=1000(anna) groups=1000(anna),27(sudo),1002(project)\n");
  assert.equal((await sh("groups ben")).stdout, "ben : ben project\n");
});

test("su, sudo with password, sudoers and the 15-minute cache", async () => {
  const { sys, sh, clock } = boot();
  assert.equal((await sh("sudo whoami", ["falsch", "falsch", "falsch"])).stderr, "Sorry, try again.\nSorry, try again.\nsudo: 3 incorrect password attempts\n");
  const ok = await sh("sudo whoami", ["anna"]);
  assert.equal(ok.stdout, "root\n");
  assert.equal((await sh("sudo whoami", [])).stdout, "root\n"); // cached
  await clock.advance(16 * 60 * 1000);
  assert.equal((await sh("sudo whoami", [])).stderr, "Sorry, try again.\nSorry, try again.\nsudo: 3 incorrect password attempts\n");
  await sh("su ben", ["ben"]);
  assert.equal((await sh("sudo ls /root")).stderr, "ben is not in the sudoers file.  This incident will be reported.\n");
  assert.equal((await sh("cat /etc/shadow")).stderr, "cat: /etc/shadow: Permission denied\n");
  await sh("exit");
  assert.equal(sys.shell.user, "anna");
  assert.match((await sh("sudo cat /etc/shadow", ["anna"])).stdout, /^root:\$6\$/);
  await sh("su", ["root"]);
  assert.equal(sys.prompt(), "root@kurs:/home/anna# ");
  assert.equal((await sh("pwd")).stdout, "/home/anna\n");
  assert.equal((await sh("echo $HOME")).stdout, "/root\n");
  await sh("exit");
  await sh("su - root", ["root"]);
  assert.equal((await sh("pwd")).stdout, "/root\n");
});

test("root creates users and groups; new users get a home and a password", async () => {
  const { sh } = boot();
  assert.match((await sh("useradd -m carla")).stderr, /Permission denied/);
  assert.equal((await sh("sudo useradd -m carla", ["anna"])).status, 0);
  assert.equal((await sh("sudo usermod -aG project carla")).status, 0);
  assert.equal((await sh("groups carla")).stdout, "carla : carla project\n");
  assert.match((await sh("ls -ld /home/carla")).stdout, /^drwxr-xr-x \d+ carla carla/);
  await sh("su carla", ["carla"]);
  assert.equal((await sh("whoami")).stdout, "carla\n");
  assert.equal((await sh("passwd", ["carla", "neu", "neu"])).stdout, "passwd: password updated successfully\n");
  await sh("exit");
  assert.equal((await sh("su carla", ["carla"])).stderr, "su: Authentication failure\n");
  assert.equal((await sh("su carla", ["neu"])).status, 0);
});

// ---------------------------------------------------------------- acceptance 4: scripts and the x bit

test("acceptance 4: ./script.sh without x fails with 126, bash script.sh works, after chmod +x it runs", async () => {
  const { sh } = boot();
  const denied = await sh("./scripts/hello.sh");
  assert.equal(denied.status, 126);
  assert.equal(denied.stderr, "bash: ./scripts/hello.sh: Permission denied\n");
  assert.equal((await sh("bash scripts/hello.sh")).stdout, "Hello, anna!\n");
  await sh("chmod +x scripts/hello.sh");
  assert.match((await sh("ls -l scripts/hello.sh")).stdout, /^-rwxr-xr-x /);
  const ok = await sh("./scripts/hello.sh");
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "Hello, anna!\n");
  assert.equal((await sh("./nix.sh")).status, 127);
  assert.equal((await sh("./nix.sh")).stderr, "bash: ./nix.sh: No such file or directory\n");
  // a script without r cannot be read even with x
  await sh("chmod 100 scripts/hello.sh");
  assert.equal((await sh("./scripts/hello.sh")).status, 126);
});

test("scripts: positional parameters, exit codes, $0 and a trap inside the script", async () => {
  const { sys, sh } = boot();
  sys.writeFile(sys.shell, "/home/anna/args.sh", "#!/bin/bash\necho \"$# Argumente: $1 und $2 ($0)\"\nexit 3\necho nie\n", { mode: 0o755 });
  const r = await sh("./args.sh eins zwei");
  assert.equal(r.stdout, "2 Argumente: eins und zwei (./args.sh)\n");
  assert.equal(r.status, 3);
  assert.equal((await sh("echo $?")).stdout, "3\n");
});

test("executable formats: another template registers how ./datei runs; chmod -x is a mode", async () => {
  const { sys, sh } = boot();
  kernel.registerExecFormat({ test: source => source.startsWith("#!TESTFMT"), run: async (system, proc, { path, source, args, io }) => { io.out(`${proc.cmd} ran ${path} with ${args.join(",")}: ${source.split("\n")[1]}`); return 5; } });
  sys.writeFile(sys.shell, "/home/anna/prog", "#!TESTFMT\npayload\n", { mode: 0o755 });
  const run = await sh("./prog a b");
  assert.equal(run.stdout, "bash ran ./prog with a,b: payload\n");
  assert.equal(run.status, 5);
  assert.equal((await sh("chmod -x prog")).status, 0);
  assert.equal((await sh("./prog")).status, 126);
  assert.equal((await sh("chmod -v +x prog")).status, 0);
  assert.equal((await sh("./prog")).status, 5);
  // a shell script is still a shell script
  assert.equal((await sh("./scripts/hello.sh")).status, 126);
  // sed keeps ; inside s/…/…/, printf knows %% and widths
  assert.equal((await sh("echo 'int x; int y;' | sed 's/x;/z;/; s/int/long/g'")).stdout, "long z; long y;\n");
  assert.equal((await sh("printf '%%d|%5s|%-4d|%.2f|%%\\n' 7 ab 3 2.5")).stdout, "%d|    7|0   |3.00|%\n");
  assert.equal((await sh("printf '%5.1f %x %c\\n' 3.14159 255 hallo")).stdout, "  3.1 ff h\n");
});

// ---------------------------------------------------------------- everyday commands and their messages

test("ls, mkdir, touch, rm, cp, mv with GNU-style messages", async () => {
  const { sh } = boot();
  assert.equal((await sh("ls")).stdout, "notes.txt  project  scripts\n");
  assert.equal((await sh("ls -a")).stdout, ".  ..  .bashrc  notes.txt  project  scripts\n");
  assert.match((await sh("ls -l")).stdout, /^total \d+\n-rw-r--r-- 1 anna anna +\d+ Nov 10 18:13 notes.txt\ndrwxr-xr-x 2 anna anna 4096 Nov 10 18:13 project\n/);
  assert.equal((await sh("ls /nix")).stderr, "ls: cannot access '/nix': No such file or directory\n");
  assert.equal((await sh("mkdir project")).stderr, "mkdir: cannot create directory 'project': File exists\n");
  assert.equal((await sh("mkdir -p a/b/c")).status, 0);
  assert.equal((await sh("rmdir a")).stderr, "rmdir: failed to remove 'a': Directory not empty\n");
  assert.equal((await sh("rm a")).stderr, "rm: cannot remove 'a': Is a directory\n");
  assert.equal((await sh("rm -r a")).status, 0);
  assert.equal((await sh("touch /etc/neu")).stderr, "touch: cannot touch '/etc/neu': Permission denied\n");
  assert.equal((await sh("mkdir /etc/neu")).stderr, "mkdir: cannot create directory '/etc/neu': Permission denied\n");
  await sh("cp notes.txt kopie.txt");
  assert.equal((await sh("cat kopie.txt")).stdout, "Linux commands I know:\nls, cd, pwd, cat\n");
  await sh("mv kopie.txt project/");
  assert.equal((await sh("ls project")).stdout, "data.csv  kopie.txt\n");
  assert.equal((await sh("cp scripts kopie")).stderr, "cp: -r not specified; omitting directory 'scripts'\n");
  assert.equal((await sh("cp -r scripts kopie")).status, 0);
  assert.equal((await sh("ls kopie")).stdout, "hello.sh\n");
  assert.equal((await sh("cat project")).stderr, "cat: project: Is a directory\n");
  assert.equal((await sh("cd notes.txt")).stderr, "bash: cd: notes.txt: Not a directory\n");
  assert.equal((await sh("cd /nix")).stderr, "bash: cd: /nix: No such file or directory\n");
});

test("text tools: head, tail, wc, grep, find, sort, cut", async () => {
  const { sh } = boot();
  assert.equal((await sh("head -n 1 notes.txt")).stdout, "Linux commands I know:\n");
  assert.equal((await sh("tail -1 notes.txt")).stdout, "ls, cd, pwd, cat\n");
  assert.equal((await sh("wc -l notes.txt")).stdout, "      2 notes.txt\n");
  assert.equal((await sh("grep -n cd notes.txt")).stdout, "2:ls, cd, pwd, cat\n");
  assert.equal((await sh("grep -i LINUX notes.txt")).status, 0);
  assert.equal((await sh("grep nix notes.txt")).status, 1);
  assert.equal((await sh("grep -r ben /home/anna/project")).stdout, "/home/anna/project/data.csv:ben;9\n");
  assert.equal((await sh("find . -name '*.sh'")).stdout, "./scripts/hello.sh\n");
  assert.equal((await sh("find /home -type d -maxdepth 1")).stdout, "/home\n/home/anna\n/home/ben\n");
  assert.equal((await sh("sort -r project/data.csv")).stdout, "name;points\nben;9\nanna;12\n");
  assert.equal((await sh("cut -d ';' -f 1 project/data.csv")).stdout, "name\nanna\nben\n");
  assert.equal((await sh("cat /etc/hostname")).stdout, "kurs\n");
  assert.match((await sh("cat /proc/1/status")).stdout, /Name:\tinit/);
});

test("which, type, env, export, history and man", async () => {
  const { sh } = boot();
  assert.equal((await sh("which ls")).stdout, "/usr/local/bin/ls\n".replace("/usr/local/bin", "/usr/bin"));
  assert.equal((await sh("which cd")).status, 1);
  assert.equal((await sh("type cd")).stdout, "cd is a shell builtin\n");
  await sh("export FARBE=blau");
  assert.equal((await sh("echo $FARBE")).stdout, "blau\n");
  assert.equal((await sh("printenv FARBE")).stdout, "blau\n");
  assert.match((await sh("history")).stdout, /    1  which ls\n/);
  assert.match((await sh("man chmod")).stdout, /change permissions/);
  assert.equal((await sh("man nix")).stdout, "No manual entry for nix\n");
  assert.equal((await sh("ls -z")).stderr, "ls: invalid option -- 'z'\n");
});

test("LANG switches the messages, prompts and man pages between English and German", async () => {
  const { sh } = boot();
  assert.equal((await sh("cat /nix")).stderr, "cat: /nix: No such file or directory\n");
  assert.match((await sh("man ls")).stdout, /list directory contents/);
  await sh("export LANG=de_DE.UTF-8");
  assert.equal((await sh("cat /nix")).stderr, "cat: /nix: Datei oder Verzeichnis nicht gefunden\n");
  assert.equal((await sh("cat /home/ben/secret.txt")).stderr, "cat: /home/ben/secret.txt: Keine Berechtigung\n");
  assert.equal((await sh("ls /nix")).stderr, "ls: Zugriff auf '/nix' nicht möglich: Datei oder Verzeichnis nicht gefunden\n");
  assert.equal((await sh("nichtda")).stderr, "bash: nichtda: Kommando nicht gefunden.\n");
  assert.equal((await sh("mkdir project")).stderr, "mkdir: das Verzeichnis 'project' kann nicht angelegt werden: Die Datei existiert bereits\n");
  assert.equal((await sh("su ben", ["falsch"])).stderr, "su: Authentifizierungsfehler\n");
  assert.match((await sh("man ls")).stdout, /Verzeichnisinhalt auflisten/);
  assert.match((await sh("man ls")).stdout, /BESCHREIBUNG/);
  assert.equal((await sh("man nix")).stdout, "Kein Handbucheintrag für nix vorhanden\n");
  assert.match((await sh("ls -l")).stdout, /^insgesamt \d+\n/);
  await sh("sleep 100 &");
  assert.match((await sh("kill %1")).stdout, /\[1\]\+  Beendet +sleep 100/);
  // file contents and command output are never translated
  assert.equal((await sh("cat notes.txt")).stdout, "Linux commands I know:\nls, cd, pwd, cat\n");
  await sh("export LANG=C");
  assert.equal((await sh("cat /nix")).stderr, "cat: /nix: No such file or directory\n");
  await sh("export LANG=fr_FR.UTF-8");
  assert.equal((await sh("cat /nix")).stderr, "cat: /nix: No such file or directory\n");
  assert.equal(kernel.langOf("de_AT.UTF-8"), "de");
  assert.equal(kernel.langOf("POSIX"), "en");
});

test("more options: ls -Shal -R -F, cat -A, grep -o -A -q, find -size -mtime, sort -k, date +, id -un, stat -c, du, ps -u, rm -i", async () => {
  const { sh, clock } = boot();
  const bySize = (await sh("ls -Shal")).stdout.split("\n");
  assert.match(bySize[0], /^insgesamt|^total/);
  assert.match(bySize[1], /4\.0K Nov 10 18:13 \.$/);
  assert.match((await sh("ls -S")).stdout, /^project  scripts  notes\.txt\n$/);
  assert.match((await sh("ls -F")).stdout, /^notes\.txt  project\/  scripts\/\n$/);
  assert.match((await sh("ls -R scripts")).stdout, /^scripts:\nhello\.sh\n$/);
  assert.match((await sh("ls -i notes.txt")).stdout, /^ *\d+ notes\.txt\n$/);
  assert.match((await sh("ls -ln notes.txt")).stdout, /^-rw-r--r-- 1 1000 1000 /);
  assert.equal((await sh("cat -A notes.txt")).stdout, "Linux commands I know:$\nls, cd, pwd, cat$\n");
  assert.equal((await sh("grep -o 'c[a-z]*' notes.txt")).stdout, "commands\ncd\ncat\n");
  assert.equal((await sh("grep -q cat notes.txt")).stdout, "");
  assert.equal((await sh("grep -q cat notes.txt")).status, 0);
  assert.equal((await sh("grep -A 1 Linux notes.txt")).stdout, "Linux commands I know:\nls, cd, pwd, cat\n");
  assert.equal((await sh("grep -c -v nix notes.txt")).stdout, "2\n");
  assert.equal((await sh("find . -size +1c -name '*.txt'")).stdout, "./notes.txt\n");
  await clock.advance(3 * 86400000);
  await sh("touch neu.txt");
  assert.equal((await sh("find . -mtime -1 -type f")).stdout, "./neu.txt\n");
  assert.equal((await sh("find . -not -name '*.txt' -type f")).stdout, "./.bashrc\n./project/data.csv\n./scripts/hello.sh\n");
  assert.equal((await sh("sort -t ';' -k 2 -n project/data.csv")).stdout, "name;points\nben;9\nanna;12\n");
  assert.equal((await sh("date +%F")).stdout, "2026-11-13\n");
  assert.equal((await sh("date '+%H:%M %A'")).stdout, "18:13 Friday\n");
  assert.equal((await sh("id -un")).stdout, "anna\n");
  assert.equal((await sh("id -G")).stdout, "1000 27 1002\n");
  assert.equal((await sh("stat -c '%a %U %G %n' notes.txt")).stdout, "644 anna anna notes.txt\n");
  assert.equal((await sh("du -s project")).stdout, "5\tproject\n");
  assert.match((await sh("du -ac project")).stdout, /total\n$/);
  await sh("sleep 100 &");
  assert.match((await sh("ps -u anna")).stdout, /sleep 100/);
  assert.doesNotMatch((await sh("ps -u ben")).stdout, /sleep/);
  assert.equal((await sh("rm -i neu.txt", ["n"])).status, 0);
  assert.equal((await sh("test -f neu.txt")).status, 0);
  await sh("rm -i neu.txt", ["y"]);
  assert.equal((await sh("test -f neu.txt")).status, 1);
  assert.equal((await sh("cp -n notes.txt project/data.csv")).status, 0);
  assert.match((await sh("cat project/data.csv")).stdout, /^name;points/);
  await sh("mkdir -m 700 tresor");
  assert.match((await sh("ls -ld tresor")).stdout, /^drwx------ /);
  assert.equal((await sh("head -c 5 notes.txt")).stdout, "Linux");
  assert.equal((await sh("wc -L notes.txt")).stdout, "     22 notes.txt\n");
  assert.equal((await sh("tree -d -L 1 .")).stdout, ".\n├── project\n├── scripts\n└── tresor\n\n3 directories\n");
  assert.equal((await sh("sudo useradd -m -s /bin/sh -c 'Carla Test' carla", ["anna"])).status, 0);
  assert.match((await sh("cat /etc/passwd")).stdout, /carla:x:\d+:\d+:Carla Test:\/home\/carla:\/bin\/sh/);
  assert.equal((await sh("ls -z")).stderr, "ls: invalid option -- 'z'\n");
});

test("package 1: egrep, fgrep, alias, tac, rev, nl, fold, realpath, expr, cal, hashes, who, user management, hardware tables", async () => {
  const { sys, sh } = boot();
  assert.equal((await sh("egrep 'c(d|at)' notes.txt")).stdout, "ls, cd, pwd, cat\n");
  assert.equal((await sh("fgrep 'c(d|at)' notes.txt")).status, 1);
  assert.match((await sh("alias")).stdout, /alias ll='ls -alF'/);
  assert.match((await sh("ll")).stdout, /^total \d+\n.*\.\/\n/);
  await sh("alias zeig='echo zeig:'");
  assert.equal((await sh("zeig hallo")).stdout, "zeig: hallo\n");
  await sh("unalias zeig");
  assert.equal((await sh("zeig")).status, 127);
  assert.equal((await sh("tac notes.txt")).stdout, "ls, cd, pwd, cat\nLinux commands I know:\n");
  assert.equal((await sh("echo abc | rev")).stdout, "cba\n");
  assert.equal((await sh("nl notes.txt")).stdout, "     1\tLinux commands I know:\n     2\tls, cd, pwd, cat\n");
  assert.equal((await sh("echo 'eins zwei drei' | fold -w 5")).stdout, "eins \nzwei \ndrei\n");
  assert.equal((await sh("realpath scripts/../notes.txt")).stdout, "/home/anna/notes.txt\n");
  assert.equal((await sh("expr 3 + 4 \\* 2")).stdout, "11\n");
  assert.equal((await sh("expr 10 / 3")).stdout, "3\n");
  assert.equal((await sh("expr 5 = 5")).stdout, "1\n");
  assert.equal((await sh("expr length hallo")).stdout, "5\n");
  assert.equal((await sh("expr 1 - 1")).status, 1);
  assert.equal((await sh("expr 1 + x")).stderr, "expr: non-integer argument\n");
  const cal = (await sh("cal 11 2026")).stdout.split("\n");
  assert.equal(cal[0], "   November 2026");
  assert.equal(cal[1], "Su Mo Tu We Th Fr Sa");
  assert.equal(cal[2], " 1  2  3  4  5  6  7");
  assert.match((await sh("cal")).stdout, /November 2026/);
  await sh("printf abc > abc.txt");
  assert.equal((await sh("md5sum abc.txt")).stdout, "900150983cd24fb0d6963f7d28e17f72  abc.txt\n");
  assert.equal((await sh("sha256sum abc.txt")).stdout, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  abc.txt\n");
  assert.equal((await sh("sha1sum abc.txt")).stdout, "a9993e364706816aba3e25717850c26c9cd0d89d  abc.txt\n");
  assert.equal((await sh("echo -n abc | md5sum")).stdout, "900150983cd24fb0d6963f7d28e17f72  -\n");
  await sh("sha256sum abc.txt > abc.sha");
  assert.equal((await sh("sha256sum -c abc.sha")).stdout, "abc.txt: OK\n");
  assert.match((await sh("who")).stdout, /^anna {5}pts\/0 {8}Nov 10 18:13 \(:0\)\n$/);
  assert.match((await sh("w")).stdout, /USER {5}TTY {6}FROM/);
  assert.match((await sh("last")).stdout, /still logged in/);
  assert.equal((await sh("sudo groupadd team", ["anna"])).status, 0);
  assert.equal((await sh("sudo groupdel anna")).stderr, "groupdel: cannot remove the primary group of user 'anna'\n");
  assert.equal((await sh("sudo groupdel team")).status, 0);
  assert.equal((await sh("sudo userdel anna")).stderr, "userdel: user anna is currently used by process 2\n");
  assert.equal((await sh("sudo userdel -r ben")).status, 0);
  assert.equal((await sh("ls /home")).stdout, "anna\n");
  assert.equal((await sh("id ben")).stderr, "id: 'ben': no such user\n");
  assert.equal((await sh("chsh -s /bin/sh")).status, 0);
  assert.match((await sh("grep anna /etc/passwd")).stdout, /\/bin\/sh\n$/);
  assert.equal((await sh("grep 'a+' notes.txt")).status, 1);
  assert.equal((await sh("echo 'aaa' | grep -c 'a\\{3\\}'")).stdout, "1\n");
  assert.equal((await sh("chsh -s /bin/zsh")).stderr, "chsh: /bin/zsh is an invalid shell\n");
  assert.match((await sh("htop")).stdout, /PID USER/);
  assert.match((await sh("lsblk")).stdout, /sda2/);
  assert.match((await sh("mount")).stdout, /on \/ type ext4/);
  assert.equal((await sh("mount /dev/sdb1 /mnt")).stderr, "mount: only root can do that\n");
  assert.equal((await sh("fdisk -l")).stderr, "fdisk: cannot open /dev/sda: Permission denied\n");
  assert.match((await sh("sudo fdisk -l")).stdout, /\/dev\/sda2/);
  assert.match((await sh("reboot")).stderr, /Interactive authentication required/);
  assert.match((await sh("apropos permissions")).stdout, /chmod/);
  await sh("sleep 100 &");
  const before = sys.procs.size;
  assert.match((await sh("sudo reboot")).stdout, /going down for reboot NOW/);
  await sys.clock.advance(10);
  assert.equal(sys.procs.size < before, true);
  assert.equal(sys.shell.user, "anna");
  assert.equal((await sh("jobs")).stdout, "");
  assert.equal((await sh("cat abc.txt")).stdout, "abc");
});

test("package 2: sed, awk, diff, cmp, read, find -exec, nohup, time, tr -d -s", async () => {
  const { sys, sh, clock } = boot();
  assert.equal((await sh("sed 's/cd/CD/' notes.txt")).stdout, "Linux commands I know:\nls, CD, pwd, cat\n");
  assert.equal((await sh("echo aaa | sed 's/a/b/g'")).stdout, "bbb\n");
  assert.equal((await sh("sed -n '2p' notes.txt")).stdout, "ls, cd, pwd, cat\n");
  assert.equal((await sh("sed '1d' notes.txt")).stdout, "ls, cd, pwd, cat\n");
  assert.equal((await sh("sed -n '/Linux/p' notes.txt")).stdout, "Linux commands I know:\n");
  assert.equal((await sh("printf '1\\n2\\n3\\n4\\n' | sed '2,3d'")).stdout, "1\n4\n");
  assert.equal((await sh("echo 'a-b' | sed 's/\\(.\\)-\\(.\\)/\\2-\\1/'")).stdout, "b-a\n");
  assert.equal((await sh("echo hallo | sed -e 's/h/H/' -e 's/o/O/'")).stdout, "HallO\n");
  await sh("sed -i 's/know/master/' notes.txt");
  assert.match((await sh("cat notes.txt")).stdout, /master/);
  assert.equal((await sh("awk '{print $1}' project/data.csv")).stdout, "name;points\nanna;12\nben;9\n");
  assert.equal((await sh("awk -F ';' '{print $2}' project/data.csv")).stdout, "points\n12\n9\n");
  assert.equal((await sh("awk -F ';' 'NR > 1 {sum += $2} END {print sum}' project/data.csv")).stdout, "21\n");
  // like real awk: "points" > 10 compares as strings, so the header line counts too
  assert.equal((await sh("awk -F ';' '$2 > 10 {print $1}' project/data.csv")).stdout, "name\nanna\n");
  assert.equal((await sh("awk -F ';' 'NR > 1 && $2 > 10 {print $1}' project/data.csv")).stdout, "anna\n");
  assert.equal((await sh("awk -F ';' 'NR==2, NR==3 {print NR\": \"$1}' project/data.csv")).stdout, "2: anna\n3: ben\n");
  assert.equal((await sh("awk '/ben/' project/data.csv")).stdout, "ben;9\n");
  assert.equal((await sh("printf 'a b\\nb c\\na d\\n' | awk '{count[$1]++} END {for (k in count) print k, count[k]}'")).stdout, "a 2\nb 1\n");
  assert.equal((await sh("awk 'BEGIN {printf \"%5.2f|%-4s|%03d\\n\", 3.14159, \"ab\", 7}'")).stdout, " 3.14|ab  |007\n");
  assert.equal((await sh("echo 'Hallo Welt' | awk '{print toupper($2), length($1), NF}'")).stdout, "WELT 5 2\n");
  assert.equal((await sh("awk 'BEGIN { if (2 > 1) print \"ja\"; else print \"nein\" }'")).stdout, "ja\n");
  assert.equal((await sh("awk -F ';' -v OFS='\\t' 'NR>1 {print $1, $2 * 2}' project/data.csv")).stdout, "anna\t24\nben\t18\n");
  assert.equal((await sh("awk 'BEGIN { for (i = 1; i <= 3; i++) s = s i; print s }'")).stdout, "123\n");
  assert.equal((await sh("echo x | awk '{ print substr(\"hallo\", 2, 3), index(\"hallo\", \"l\") }'")).stdout, "all 3\n");
  assert.match((await sh("awk '{print $1'")).stderr, /^awk: syntax error/);
  await sh("printf 'a\\nb\\nc\\n' > eins.txt");
  await sh("printf 'a\\nx\\nc\\nd\\n' > zwei.txt");
  assert.equal((await sh("diff eins.txt zwei.txt")).stdout, "2c2\n< b\n---\n> x\n3a4\n> d\n");
  assert.equal((await sh("diff eins.txt zwei.txt")).status, 1);
  assert.equal((await sh("diff eins.txt eins.txt")).status, 0);
  assert.equal((await sh("diff -q eins.txt zwei.txt")).stdout, "Files eins.txt and zwei.txt differ\n");
  assert.equal((await sh("diff -u eins.txt zwei.txt")).stdout, "--- eins.txt\n+++ zwei.txt\n@@ -1,3 +1,4 @@\n a\n-b\n+x\n c\n+d\n");
  assert.equal((await sh("cmp eins.txt zwei.txt")).stdout, "eins.txt zwei.txt differ: byte 3, line 2\n");
  assert.equal((await sh("cmp eins.txt eins.txt")).status, 0);
  assert.equal((await sh("echo 'Anna Beispiel' | read vor nach; echo $nach")).stdout, "\n");
  await sh("echo 'Anna Beispiel' > name.txt");
  assert.equal((await sh("read vor nach < name.txt; echo $nach-$vor")).stdout, "Beispiel-Anna\n");
  assert.equal((await sh("read antwort", ["ja bitte"])).status, 0);
  assert.equal((await sh("echo $antwort")).stdout, "ja bitte\n");
  assert.equal((await sh("find . -name '*.txt' -maxdepth 1 -exec wc -l {} \\;")).stdout.split("\n").filter(Boolean).length, 4);
  await sh("mkdir leer; touch leer/x.tmp");
  assert.equal((await sh("find leer -name '*.tmp' -delete; ls leer")).stdout, "");
  const nohup = await sh("nohup sleep 5 &");
  assert.match(nohup.stderr, /nohup: ignoring input/);
  await clock.advance(6000);
  assert.equal((await sh("test -f nohup.out")).status, 0);
  const timedRun = sh("time sleep 2");
  await new Promise(r => setTimeout(r, 0)); // the sleep timer is set in a microtask – let it be before the clock moves
  await clock.advance(2000);
  const timed = await timedRun;
  assert.match(timed.stderr, /real\t0m2\.000s/);
  assert.equal((await sh("echo 'hello world' | tr -d l")).stdout, "heo word\n");
  assert.equal((await sh("echo 'aaabbb   c' | tr -s 'ab '")).stdout, "ab c\n");
  assert.equal((await sh("echo abc | tr '[:lower:]' '[:upper:]'")).stdout, "ABC\n");
  void sys;
});

test("curl and wget use fetch: body to the terminal or into a file, errors like the originals", async () => {
  const { sh } = boot();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("offline")) throw new TypeError("fetch failed");
    return { status: 200, statusText: "OK", headers: new Map([["content-type", "text/plain"]]), text: async () => options && options.method === "HEAD" ? "" : `Antwort von ${url}\n` };
  };
  try {
    assert.equal((await sh("curl http://example.org/datei.txt")).stdout, "Antwort von http://example.org/datei.txt\n");
    assert.equal((await sh("curl -s -o lokal.txt example.org/datei.txt")).status, 0);
    assert.equal((await sh("cat lokal.txt")).stdout, "Antwort von http://example.org/datei.txt\n");
    assert.equal((await sh("curl -O http://example.org/datei.txt; cat datei.txt")).stdout, "Antwort von http://example.org/datei.txt\n");
    assert.match((await sh("curl -I http://example.org/")).stdout, /^HTTP\/1\.1 200 OK\ncontent-type: text\/plain\n$/);
    assert.match((await sh("curl http://offline.test/")).stderr, /^curl: \(6\) Could not resolve host: offline\.test/);
    assert.equal((await sh("curl -s http://offline.test/")).stderr, "");
    assert.equal((await sh("curl -s http://offline.test/")).status, 6);
    const wget = await sh("wget http://example.org/seite.html");
    assert.equal(wget.status, 0);
    assert.match(wget.stderr, /'seite\.html' saved \[\d+\/\d+\]/);
    assert.equal((await sh("cat seite.html")).stdout, "Antwort von http://example.org/seite.html\n");
    assert.equal((await sh("wget -q -O - http://example.org/x")).stdout, "Antwort von http://example.org/x\n");
    assert.equal((await sh("wget -q http://offline.test/")).status, 4);
    assert.equal((await sh("wget")).stderr, "wget: missing URL\nUsage: wget [OPTION]... [URL]...\n");
    assert.equal((await sh("curl http://example.org/ | wc -l")).stdout, "1\n");
  } finally { globalThis.fetch = original; }
});

test("packages: command-not-found hint, apt update/install/remove with root and locks, dpkg, persistence", async () => {
  const { sys, sh } = boot();
  const missing = await sh("cowsay hi");
  assert.equal(missing.status, 127);
  assert.equal(missing.stderr, "Command 'cowsay' not found, but can be installed with:\nsudo apt install cowsay\n");
  assert.equal((await sh("which cowsay")).status, 1);
  const lock = await sh("apt install cowsay");
  assert.equal(lock.status, 100);
  assert.match(lock.stderr, /are you root\?/);
  const early = await sh("sudo apt install cowsay", ["anna"]);
  assert.equal(early.status, 100);
  assert.match(early.stderr, /E: Unable to locate package cowsay/);
  assert.match((await sh("sudo apt update")).stdout, /Reading package lists\.\.\. Done/);
  const declined = await sh("sudo apt install cowsay", ["n"]);
  assert.match(declined.stdout, /The following NEW packages will be installed:\n  cowsay\n/);
  assert.match(declined.stdout, /Abort\./);
  assert.equal((await sh("which cowsay")).status, 1);
  const install = await sh("sudo apt install -y cowsay");
  assert.equal(install.status, 0);
  assert.match(install.stdout, /Setting up cowsay \(3\.03\+dfsg2-8\)/);
  assert.equal((await sh("which cowsay")).stdout, "/usr/bin/cowsay\n");
  assert.match((await sh("cowsay Moo")).stdout, /^ _____\n< Moo >\n -----\n/);
  assert.match((await sh("echo hallo | cowsay")).stdout, /< hallo >/);
  assert.match((await sh("sudo apt install -y cowsay")).stdout, /cowsay is already the newest version/);
  assert.match((await sh("apt list --installed")).stdout, /cowsay\/stable,now 3\.03\+dfsg2-8 all \[installed\]/);
  assert.match((await sh("dpkg -l cowsay")).stdout, /^ii  cowsay/m);
  assert.match((await sh("dpkg -L cowsay")).stdout, /\/usr\/bin\/cowsay/);
  assert.match((await sh("dpkg -S /usr/bin/cowsay")).stdout, /^cowsay: /);
  assert.match((await sh("apt search talking")).stdout, /cowsay\/stable,now/);
  assert.match((await sh("apt show sl")).stdout, /Package: sl\nVersion: 5\.02-1/);
  assert.match((await sh("sudo apt remove coreutils")).stderr, /essential packages stay installed/);
  // the installed state survives a save and a reboot
  const restored = kernel.restoreSystem(JSON.parse(JSON.stringify(sys.serialize())), { clock: kernel.fakeClock() });
  assert.equal((await kernel.runCollect(restored, "which cowsay")).stdout, "/usr/bin/cowsay\n");
  assert.equal(restored.installed.has("cowsay"), true);
  const remove = await sh("sudo apt remove -y cowsay");
  assert.match(remove.stdout, /Removing cowsay/);
  assert.equal((await sh("cowsay x")).status, 127);
  assert.equal((await sh("sudo apt remove -y cowsay")).stdout.includes("Package 'cowsay' is not installed, so not removed"), true);
  assert.equal((await sh("sudo apt install -y sl fortune neofetch")).status, 0);
  assert.match((await sh("sl")).stdout, /====/);
  assert.equal((await sh("fortune")).status, 0);
  assert.match((await sh("neofetch")).stdout, /anna@kurs/);
  assert.match((await sh("apt frobnicate")).stderr, /E: Invalid operation frobnicate/);
});

test("services: ssh and cron run, systemctl needs root, journalctl, reboot keeps enabled services, nginx comes with its package", async () => {
  const { sys, sh, clock } = boot();
  assert.match((await sh("systemctl status ssh")).stdout, /● ssh\.service - OpenBSD Secure Shell server\n.*enabled.*\n\s+Active: active \(running\)/);
  assert.match((await sh("ps aux")).stdout, /sshd -D/);
  assert.match((await sh("systemctl")).stdout, /ssh\.service\s+loaded active\s+running/);
  assert.equal((await sh("systemctl is-active cron")).stdout, "active\n");
  const denied = await sh("systemctl stop ssh");
  assert.equal(denied.status, 1);
  assert.equal(denied.stderr.split("\n")[0], "Failed to stop ssh.service: Interactive authentication required.");
  assert.equal((await sh("sudo systemctl stop ssh", ["anna"])).status, 0);
  assert.equal((await sh("systemctl is-active ssh")).stdout, "inactive\n");
  assert.equal((await sh("systemctl is-active ssh")).status, 3);
  assert.doesNotMatch((await sh("ps aux")).stdout, /sshd -D/);
  assert.match((await sh("journalctl -u ssh")).stdout, /Stopped OpenBSD Secure Shell server/);
  assert.equal((await sh("sudo systemctl start ssh")).status, 0);
  assert.match((await sh("ps aux")).stdout, /sshd -D/);
  assert.match((await sh("journalctl -u ssh -n 1")).stdout, /Started OpenBSD Secure Shell server\.\n$/);
  assert.match((await sh("service cron status")).stdout, /active \(running\)/);
  assert.match((await sh("systemctl status nix")).stderr, /Unit nix\.service could not be found/);
  assert.match((await sh("cat /lib/systemd/system/cron.service")).stdout, /ExecStart=\/usr\/sbin\/cron -f/);
  // kill the daemon by hand: the service notices
  const pid = (await sh("pgrep sshd")).stdout.trim();
  await sh(`sudo kill ${pid}`);
  await clock.advance(1);
  assert.equal((await sh("systemctl is-active ssh")).stdout, "inactive\n");
  assert.match((await sh("journalctl -u ssh -n 2")).stdout, /killed/);
  // enable/disable and a reboot
  await sh("sudo systemctl disable cron");
  await sh("sudo systemctl enable ssh");
  await sh("sudo reboot");
  await clock.advance(10);
  assert.equal((await sh("systemctl is-active cron")).stdout, "inactive\n");
  assert.equal((await sh("systemctl is-active ssh")).stdout, "active\n");
  // nginx arrives with its package, enabled and started (after the reboot sudo asks for the password again)
  assert.equal((await sh("sudo apt update", ["anna"])).status, 0);
  assert.equal((await sh("sudo apt install -y nginx")).status, 0);
  assert.equal((await sh("systemctl is-active nginx")).stdout, "active\n");
  assert.equal((await sh("systemctl is-enabled nginx")).stdout, "enabled\n");
  assert.match((await sh("nginx -v")).stderr, /nginx version: nginx\/1\.22\.1/);
  await sh("sudo apt remove -y nginx");
  assert.match((await sh("systemctl status nginx")).stderr, /could not be found/);
  void sys;
});

test("archives: tar (c, t, x, z, -C), gzip/gunzip/zcat, zip/unzip", async () => {
  const { sh } = boot();
  const tar = await sh("tar -czvf project.tar.gz project");
  assert.equal(tar.status, 0);
  assert.equal(tar.stdout, "project/\nproject/data.csv\n");
  assert.equal((await sh("tar -tf project.tar.gz")).stdout, "project/\nproject/data.csv\n");
  assert.match((await sh("file project.tar.gz")).stdout, /project\.tar\.gz: /);
  await sh("mkdir ziel");
  assert.equal((await sh("tar -xzf project.tar.gz -C ziel")).status, 0);
  assert.equal((await sh("cat ziel/project/data.csv")).stdout, "name;points\nanna;12\nben;9\n");
  assert.match((await sh("tar -xf notes.txt")).stderr, /This does not look like a tar archive/);
  assert.match((await sh("tar -cf x.tar")).stderr, /Cowardly refusing to create an empty archive/);
  assert.match((await sh("tar notes.txt")).stderr, /You must specify one of/);
  await sh("gzip notes.txt");
  assert.equal((await sh("test -f notes.txt")).status, 1);
  assert.equal((await sh("test -f notes.txt.gz")).status, 0);
  assert.equal((await sh("zcat notes.txt.gz")).stdout, "Linux commands I know:\nls, cd, pwd, cat\n");
  await sh("gunzip notes.txt.gz");
  assert.equal((await sh("cat notes.txt")).stdout, "Linux commands I know:\nls, cd, pwd, cat\n");
  assert.equal((await sh("gzip -k notes.txt; test -f notes.txt")).status, 0);
  assert.equal((await sh("zip -r scripts.zip scripts")).status, 0);
  assert.match((await sh("unzip -l scripts.zip")).stdout, /scripts\/hello\.sh/);
  await sh("unzip -q -d entpackt scripts.zip");
  assert.equal((await sh("cat entpackt/scripts/hello.sh")).stdout, "#!/bin/bash\necho \"Hello, $USER!\"\n");
  assert.match((await sh("unzip notes.txt")).stderr, /cannot find zipfile directory/);
});

test("nano: the kernel hands the file to the terminal's editor and writes the result back", async () => {
  const { sys } = boot();
  const edits = [];
  const editor = options => { edits.push(options); return Promise.resolve({ path: options.path, text: "erste Zeile\nzweite Zeile\n" }); };
  const run = (line, ed = editor) => kernel.runCollect(sys, line, { editor: ed });
  assert.equal((await run("nano neu.txt")).status, 0);
  assert.equal(edits[0].isNew, true);
  assert.equal((await run("cat neu.txt")).stdout, "erste Zeile\nzweite Zeile\n");
  assert.equal((await run("nano neu.txt")).status, 0);
  assert.equal(edits[1].text, "erste Zeile\nzweite Zeile\n");
  assert.equal(edits[1].isNew, false);
  // leaving without saving changes nothing
  assert.equal((await run("nano neu.txt", () => Promise.resolve(null))).status, 0);
  assert.equal((await run("cat neu.txt")).stdout, "erste Zeile\nzweite Zeile\n");
  assert.match((await run("nano /etc/passwd")).stderr, /Error writing \/etc\/passwd: Permission denied/);
  assert.match((await run("nano project")).stderr, /nano: project: Is a directory/);
  assert.match((await kernel.runCollect(sys, "nano x")).stdout, /nano needs the terminal/);
});

test("every program runs at least once without throwing and ends with a number", async () => {
  const { sys } = boot();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, statusText: "OK", headers: new Map(), text: async () => "x\n" });
  const samples = {
    ls: "ls -la", cat: "cat notes.txt", less: "less notes.txt", more: "more notes.txt", echo: "echo x", printf: "printf x", mkdir: "mkdir d1", touch: "touch t1",
    rm: "rm t1", rmdir: "rmdir d1", cp: "cp notes.txt c1", mv: "mv c1 c2", ln: "ln -s c2 l1", readlink: "readlink l1", head: "head -n 1 c2", tail: "tail -n 1 c2",
    wc: "wc c2", grep: "grep a c2", find: "find . -name c2", tree: "tree", sort: "sort c2", uniq: "uniq c2", cut: "cut -c 1 c2", tr: "echo a | tr a b", which: "which ls",
    env: "env", printenv: "printenv HOME", clear: "clear", whoami: "whoami", hostname: "hostname", uname: "uname -a", date: "date", uptime: "uptime", id: "id", groups: "groups",
    stat: "stat c2", chmod: "chmod 600 c2", chown: "chown anna c2", chgrp: "chgrp anna c2", su: "su anna", sudo: "sudo true", passwd: "passwd", useradd: "sudo useradd x1",
    groupadd: "sudo groupadd g1", usermod: "sudo usermod -aG g1 x1", ps: "ps aux", pstree: "pstree -p", pgrep: "pgrep bash", pkill: "pkill nix", top: "top", sleep: "sleep 0",
    yes: "yes | head -n 1", man: "man ls", whatis: "whatis ls", bash: "bash -c 'echo hi'", sh: "sh -c 'echo hi'", file: "file c2", du: "du -sh .", df: "df -h", free: "free -m",
    seq: "seq 3", basename: "basename /a/b", dirname: "dirname /a/b", egrep: "egrep a c2", fgrep: "fgrep a c2", tac: "tac c2", rev: "rev c2", nl: "nl c2", fold: "fold -w 3 c2",
    realpath: "realpath c2", expr: "expr 1 + 1", cal: "cal", sha256sum: "sha256sum c2", sha1sum: "sha1sum c2", md5sum: "md5sum c2", who: "who", w: "w", last: "last",
    userdel: "sudo userdel x1", groupdel: "sudo groupdel g1", chsh: "chsh -s /bin/bash", htop: "htop", lsblk: "lsblk", mount: "mount", umount: "umount /mnt", fdisk: "fdisk -l",
    shutdown: "shutdown -r now", reboot: "reboot", poweroff: "poweroff", halt: "halt", nohup: "nohup true", time: "time true", nice: "nice -n 5 true", renice: "renice 5 2",
    apropos: "apropos list", reset: "reset", tee: "echo a | tee t2", xargs: "echo a | xargs echo", sed: "sed -n p c2", awk: "awk '{print}' c2", curl: "curl -s http://x/",
    wget: "wget -q http://x/y", diff: "diff c2 c2", cmp: "cmp c2 c2",
    apt: "apt list", "apt-get": "sudo apt-get update", "apt-cache": "apt-cache search cow", dpkg: "dpkg -l", systemctl: "systemctl status ssh", service: "service cron status",
    journalctl: "journalctl -u cron -n 2", tar: "tar -cf t.tar c2", gzip: "gzip -k c2", gunzip: "gunzip c2.gz", zcat: "gzip -k c2; zcat c2.gz", zip: "zip t.zip c2", unzip: "unzip -l t.zip",
    cowsay: "cowsay hi", cowthink: "cowthink hi", sl: "sl", fortune: "fortune", neofetch: "neofetch", nginx: "nginx -v", nano: "nano c2",
    python3: "python3 -V", python: "python -V", node: "node -v", nodejs: "nodejs -v", gcc: "gcc", cc: "cc", pip: "pip list", pip3: "pip3 list",
    upload: "upload", download: "download c2", "xdg-open": "xdg-open c2", display: "display c2", eog: "eog c2"
  };
  try {
    const missing = kernel.commands.filter(name => !(name in samples));
    assert.deepEqual(missing, [], "every program needs a sample line");
    await kernel.runCollect(sys, "sudo apt update", { input: ["anna"] });
    await kernel.runCollect(sys, "sudo apt install -y cowsay sl fortune neofetch nginx python3 nodejs gcc");
    for (const [name, line] of Object.entries(samples)) {
      const result = await kernel.runCollect(sys, line, { input: ["anna", "anna", "anna", "anna"] });
      assert.equal(typeof result.status, "number", `${name}: status is a number`);
      assert.equal(Number.isInteger(result.status) && result.status >= 0, true, `${name}: status ${result.status}`);
      assert.doesNotMatch(result.stdout + result.stderr, /TypeError|ReferenceError|undefined is not|Cannot read/, `${name}: ${result.stderr}`);
    }
  } finally { globalThis.fetch = original; }
});

test("test and [ decide about files and strings – the basis for @Linux.check", async () => {
  const { sh } = boot();
  assert.equal((await sh("test -f notes.txt")).status, 0);
  assert.equal((await sh("test -d notes.txt")).status, 1);
  assert.equal((await sh("[ -x scripts/hello.sh ]")).status, 1);
  await sh("chmod +x scripts/hello.sh");
  assert.equal((await sh("[ -x scripts/hello.sh ]")).status, 0);
  assert.equal((await sh("test -r /home/ben/secret.txt")).status, 1);
  assert.equal((await sh("[ anna = anna ]")).status, 0);
  assert.equal((await sh("[ 3 -gt 2 ]")).status, 0);
  assert.equal((await sh("! test -e /nix")).status, 0);
  assert.equal((await sh("[ -f notes.txt")).stderr, "bash: [: missing `]'\n");
});

// ---------------------------------------------------------------- programming languages as packages (linux-programs.js)
// The JavaScript engine is the real one (Node runs the same code the browser runs); the Python and C runtimes of the
// browser (Pyodide, JSCPP, linux-runtimes.js) are replaced by stubs with the same interface.

// a tiny Python: print("…"), print(f"…{x}…"), x = input("…"), open(...).write, import, raise – enough for the plumbing
function fakePython() {
  const packages = new Map();   // name → version, like the package set of the runtime
  const SET = { numpy: "2.4.6", matplotlib: "3.10.8", pandas: "2.3.3" };
  const run = (source, stdin, write, files, sys) => {
    const vars = {};
    const text = s => s.replace(/^f?"(.*)"$/, "$1").replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? "");
    for (const raw of source.split("\n")) {
      const line = raw.trim();
      let m;
      if ((m = /^print\((f?"[^"]*")\)$/.exec(line))) write(text(m[1]) + "\n");
      else if ((m = /^(\w+) = input\("([^"]*)"\)$/.exec(line))) { write(m[2]); const got = stdin.next(); if (got === null) throw new Error("EOFError: EOF when reading a line"); vars[m[1]] = got.replace(/\n$/, ""); }
      else if ((m = /^open\("([^"]+)", "w"\)\.write\((f?"[^"]*")\)$/.exec(line))) files[m[1]] = text(m[2]);
      else if ((m = /^import (\w+)$/.exec(line))) { if (!packages.has(m[1]) && !["sys", "os", "random", "math"].includes(m[1])) throw new Error(`Traceback (most recent call last):\n  File "x", line 1\nModuleNotFoundError: No module named '${m[1]}'`); }
      else if ((m = /^savefig\("([^"]+)"\)$/.exec(line))) files[m[1]] = { binary: true, data: "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x02\x00\x00\x00\x03" };
      else if (/^raise /.test(line)) throw new Error(`Traceback (most recent call last):\n  File "x", line 1\n${line.slice(6)}`);
    }
    return 0;
  };
  return {
    version: "3.14.0",
    hasPackage: name => packages.has(name),
    packageVersion: name => packages.get(name) || null,
    packageRequires: name => name === "matplotlib" ? ["numpy"] : [],
    async installPackage(name, say) {
      if (!SET[name]) throw new Error("not in the package set, not on PyPI (stub)");
      say(`stub download ${name}`);
      packages.set(name, SET[name]);
      return SET[name];
    },
    runFile(sys, proc, { path, source, io }) {
      return programs.replay(io, (stdin, write) => {
        const files = {};
        let status;
        try { status = run(source, stdin, write, files, sys); }
        catch (error) { if (stdin.asked) throw error; io.error(error.message + "\n"); status = 1; }
        for (const [name, data] of Object.entries(files)) { if (typeof data === "string") sys.writeFile(proc, name, data); else sys.writeFile(proc, name, data.data, { binary: true }); }
        return status;
      });
    },
    runCode(sys, proc, { code, io }) { return programs.replay(io, (stdin, write) => run(code, stdin, write, {}, sys)); },
    async repl(sys, proc, io) { io.out("Python 3.14.0 (stub)"); io.write(">>> "); const line = await io.readLine({ prompt: "" }); io.out(`got ${line}`); return 0; }
  };
}

// a tiny C: printf("…", args) and scanf("%d", &x); a line containing SYNTAX_ERROR fails to compile
function fakeC() {
  return {
    version: "2.0.9",
    compile(source) {
      const lines = source.split("\n");
      const bad = lines.findIndex(l => l.includes("SYNTAX_ERROR"));
      if (bad >= 0) { const e = new Error("expected ';' but found 'SYNTAX_ERROR'"); e.line = bad + 1; e.column = lines[bad].indexOf("SYNTAX_ERROR") + 1; throw e; }
      if (!source.includes("main")) throw new Error("undefined reference to `main'");
    },
    // like JSCPP: the whole input is taken once at the start; scanf on an empty input fails with "line:col Memory overflow"
    run(source, { stdin, write }) {
      const vars = {};
      const input = stdin.rest().split("\n").filter(Boolean);
      const lines = source.split("\n");
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n].trim();
        let m;
        if ((m = /^printf\("([^"]*)"(?:,\s*(.*))?\);$/.exec(line))) {
          const args = m[2] ? m[2].split(",").map(a => a.trim()) : [];
          write(m[1].replace(/\\n/g, "\n").replace(/%d/g, () => { const a = args.shift(); const mm = /^(\w+)\s*\*\s*(\w+)$/.exec(a); return mm ? String(vars[mm[1]] * vars[mm[2]]) : String(vars[a] ?? a); }));
        } else if ((m = /^scanf\("%d", &(\w+)\);$/.exec(line))) {
          if (!input.length) { if (!stdin.piped) { stdin.asked = true; throw new Error(`${n + 1}:5 Memory overflow`); } return 1; }
          vars[m[1]] = Number(input.shift());
        }
        else if ((m = /^return (\d+);$/.exec(line))) return Number(m[1]);
      }
      return 0;
    }
  };
}

// the stub loaders stand in for linux-runtimes.js
programs.loaders.python3 = async say => { say("stub python"); return fakePython(); };
programs.loaders.gcc = async say => { say("stub c"); return fakeC(); };

const HALLO_PY = 'print("Hallo aus Python!")\nname = input("Wie heißt du? ")\nprint(f"Schön, dich zu sehen, {name}.")\nopen("gruss.txt", "w").write(f"Gruß an {name}")\n';

test("programs, acceptance 4 (former linux-dev): the runtimes load only at apt install – not at boot, not for the not-found hint", async () => {
  const { sh } = boot();
  // the smoke test above already loaded the stubs: start from a fresh page
  delete programs.engines.python3; delete programs.engines.gcc; programs.loads.length = 0;
  assert.deepEqual(programs.loads, []);
  assert.equal((await sh("python3 hallo.py")).status, 127);
  assert.equal((await sh("gcc hallo.c")).status, 127);
  assert.equal((await sh("node app.js")).status, 127);
  assert.equal((await sh("pip install numpy")).status, 127);
  assert.deepEqual(programs.loads, []);
  assert.deepEqual(Object.keys(programs.engines), ["nodejs"]);   // JavaScript needs no download: the browser brings it
  await sh("sudo apt update", ["anna"]);
  const install = await sh("sudo apt install -y nodejs");
  assert.equal(install.status, 0);
  assert.doesNotMatch(install.stdout, /Loading the/);
  assert.deepEqual(programs.loads, []);
  const python = await sh("sudo apt install -y python3");
  assert.match(python.stdout, /Setting up python3 \(3\.14\.0-1\) \.\.\.\n  Loading the Python runtime \.\.\.\n  stub python\n  Python runtime ready/);
  assert.deepEqual(programs.loads, ["python3"]);
  const gcc = await sh("sudo apt install -y gcc");
  assert.match(gcc.stdout, /Loading the C runtime/);
  assert.deepEqual(programs.loads, ["python3", "gcc"]);
  // a second install (another session) reuses the loaded runtime
  const again = boot();
  await again.sh("sudo apt update", ["anna"]);
  assert.doesNotMatch((await again.sh("sudo apt install -y python3")).stdout, /Loading the/);
  assert.deepEqual(programs.loads, ["python3", "gcc"]);
});

test("programs, acceptance 1 (former linux-dev): the not-found hint names the package; after apt install python3 runs a script and input() reads the terminal once", async () => {
  const { sys, sh } = boot();
  const missing = await sh("python3 hallo.py");
  assert.equal(missing.status, 127);
  assert.equal(missing.stderr, "Command 'python3' not found, but can be installed with:\nsudo apt install python3\n");
  assert.equal((await sh("which python3")).status, 1);
  await sh("sudo apt update", ["anna"]);
  assert.equal((await sh("sudo apt install -y python3")).status, 0);
  assert.equal((await sh("which python3")).stdout, "/usr/bin/python3\n");
  assert.equal((await sh("python3 -V")).stdout, "Python 3.14.0\n");
  sys.writeFile(sys.shell, "/home/anna/hallo.py", HALLO_PY);
  const run = await sh("python3 hallo.py", ["Lia"]);
  assert.equal(run.status, 0);
  // the first line appears once although the program ran twice (replay after the input)
  assert.equal(run.stdout, "Hallo aus Python!\nWie heißt du? Schön, dich zu sehen, Lia.\n");
  assert.equal((await sh("cat gruss.txt")).stdout, "Gruß an Lia");
  assert.match((await sh("ls -l gruss.txt")).stdout, / anna anna /);
  // a pipe feeds stdin directly, EOF ends it
  assert.equal((await sh("echo Ben | python3 hallo.py")).stdout, "Hallo aus Python!\nWie heißt du? Schön, dich zu sehen, Ben.\n");
  assert.match((await sh("python3 hallo.py < /dev/null")).stderr, /EOFError/);
  assert.equal((await sh("python3 -c 'print(\"direkt\")'")).stdout, "direkt\n");
  assert.equal((await sh("python3 nix.py")).stderr, "python3: can't open file '/home/anna/nix.py': [Errno 2] No such file or directory\n");
  assert.equal((await sh("python3 nix.py")).status, 2);
  assert.equal((await sh("python3 -x")).status, 2);
  sys.writeFile(sys.shell, "/home/anna/kaputt.py", "raise ValueError('kaputt')\n");
  const failed = await sh("python3 kaputt.py");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /ValueError/);
  // the interactive prompt and a shebang script
  assert.equal((await sh("python3", ["1+1"])).stdout, "Python 3.14.0 (stub)\n>>> got 1+1\n");
  sys.writeFile(sys.shell, "/home/anna/skript.py", "#!/usr/bin/env python3\nprint(\"via env\")\n", { mode: 0o755 });
  assert.equal((await sh("./skript.py")).stdout, "via env\n");
  // after apt remove the command and the shebang are gone
  await sh("sudo apt remove -y python3");
  assert.equal((await sh("python3 hallo.py")).status, 127);
  const env = await sh("./skript.py");
  assert.equal(env.status, 127);
  assert.equal(env.stderr, "/usr/bin/env: 'python3': No such file or directory\n");
  assert.equal((await sh("man python3")).status, 0);
  assert.match((await sh("man python3")).stdout, /input\(\) reads a line/);
  await sh("export LANG=de_DE.UTF-8");
  assert.match((await sh("man gcc")).stdout, /Übersetzt eine C-Datei/);
  assert.match((await sh("man pip")).stdout, /Python-Pakete installieren/);
});

test("programs, acceptance 2 (former linux-dev): node app.js runs JavaScript – console.log in the terminal, fs writes into the simulated file system", async () => {
  const { sys, sh } = boot();
  await sh("sudo apt update", ["anna"]);
  await sh("sudo apt install -y nodejs");
  assert.equal((await sh("node -v")).stdout, "v22.0.0\n");
  sys.writeFile(sys.shell, "/home/anna/app.js", [
    'const fs = require("fs");',
    'const path = require("node:path");',
    'console.log("Hallo aus Node", 1 + 1, { a: [1, 2], b: "x" }, [true, null]);',
    'console.log("%s hat %d Zeilen", "ausgabe.txt", 3);',
    'fs.writeFileSync("ausgabe.txt", "geschrieben von node\\n");',
    'fs.appendFileSync("ausgabe.txt", path.basename("/x/y.txt") + "\\n");',
    'console.log(fs.readFileSync("ausgabe.txt", "utf8").trim().split("\\n").length, fs.existsSync("nix.txt"), fs.readdirSync(".").includes("ausgabe.txt"));',
    'console.log(process.argv.slice(2), process.env.USER, process.cwd(), __filename);',
    'console.error("Warnung");',
    ""
  ].join("\n"));
  const run = await sh("node app.js eins zwei");
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "Hallo aus Node 2 { a: [ 1, 2 ], b: 'x' } [ true, null ]\nausgabe.txt hat 3 Zeilen\n2 false true\n[ 'eins', 'zwei' ] anna /home/anna /home/anna/app.js\n");
  assert.equal(run.stderr, "Warnung\n");
  assert.equal((await sh("cat ausgabe.txt")).stdout, "geschrieben von node\ny.txt\n");
  assert.match((await sh("ls -l ausgabe.txt")).stdout, / anna anna /);
  // input through readline, both styles
  sys.writeFile(sys.shell, "/home/anna/frage.js", 'const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });\nrl.question("Name? ", name => { console.log("Hallo, " + name); rl.close(); });\n');
  assert.equal((await sh("node frage.js", ["Lia"])).stdout, "Name? Hallo, Lia\n");
  assert.equal((await sh("echo Ben | node frage.js")).stdout, "Name? Hallo, Ben\n");
  assert.equal((await sh("node frage.js < /dev/null")).stdout, "Name? ");
  sys.writeFile(sys.shell, "/home/anna/zeilen.js", 'const rl = require("readline").createInterface({ input: process.stdin });\nlet n = 0;\nrl.on("line", l => { n += l.length; });\nrl.on("close", () => console.log("Zeichen:", n));\n');
  assert.equal((await sh("printf 'ab\\ncde\\n' | node zeilen.js")).stdout, "Zeichen: 5\n");
  sys.writeFile(sys.shell, "/home/anna/frage2.js", 'const rl = require("readline/promises").createInterface({ input: process.stdin, output: process.stdout });\nconst n = Number(await rl.question("Zahl? "));\nconsole.log(n * 2);\nrl.close();\n');
  assert.equal((await sh("node frage2.js", ["21"])).stdout, "Zahl? 42\n");
  // timers finish before the program ends; process.exit sets the status
  sys.writeFile(sys.shell, "/home/anna/timer.js", 'setTimeout(() => { console.log("spät"); process.exit(3); }, 5);\nconsole.log("früh");\n');
  const timer = await sh("node timer.js");
  assert.equal(timer.stdout, "früh\nspät\n");
  assert.equal(timer.status, 3);
  // errors like node: file and line, name and message; status 1
  sys.writeFile(sys.shell, "/home/anna/fehler.js", 'console.log("eins");\nconsol.log("zwei");\n');
  const failed = await sh("node fehler.js");
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "eins\n");
  assert.match(failed.stderr, /^\/home\/anna\/fehler\.js:2\nconsol\.log\("zwei"\);\n\^\n\nReferenceError: consol is not defined\n/);
  sys.writeFile(sys.shell, "/home/anna/enoent.js", 'require("fs").readFileSync("nix.txt", "utf8");\n');
  assert.match((await sh("node enoent.js")).stderr, /Error: ENOENT: no such file or directory, open 'nix.txt'/);
  sys.writeFile(sys.shell, "/home/anna/syntax.js", 'console.log("x"\n');
  assert.match((await sh("node syntax.js")).stderr, /SyntaxError: /);
  // permissions apply to fs calls as the current user
  sys.writeFile(sys.shell, "/home/anna/geheim.js", 'console.log(require("fs").readFileSync("/home/ben/secret.txt", "utf8"));\n');
  assert.match((await sh("node geheim.js")).stderr, /EACCES: permission denied, open '\/home\/ben\/secret.txt'/);
  // -e, -p, a local module and the missing file message
  assert.equal((await sh("node -e 'console.log(2 + 3)'")).stdout, "5\n");
  assert.equal((await sh("node -p '[1, 2].map(x => x * 2)'")).stdout, "[ 2, 4 ]\n");
  sys.writeFile(sys.shell, "/home/anna/lib.js", "module.exports = { add: (a, b) => a + b };\n");
  sys.writeFile(sys.shell, "/home/anna/nutzt.js", 'const { add } = require("./lib");\nconsole.log(add(2, 40));\n');
  assert.equal((await sh("node nutzt.js")).stdout, "42\n");
  assert.match((await sh("node nix.js")).stderr, /Cannot find module '\/home\/anna\/nix.js'/);
  assert.equal((await sh("node nix.js")).status, 1);
  // the prompt keeps variables between lines
  assert.equal((await sh("node", ["const x = 20", "x + 22", ".exit"])).stdout, "Welcome to Node.js v22.0.0.\nType \".help\" for more information.\n> 20\n> 42\n> ");
  sys.writeFile(sys.shell, "/home/anna/bin.js", "#!/usr/bin/env node\nconsole.log('shebang')\n", { mode: 0o755 });
  assert.equal((await sh("./bin.js")).stdout, "shebang\n");
});

test("programs, acceptance 3 (former linux-dev): gcc hallo.c -o hallo creates an executable; ./hallo needs x; a syntax error names the line", async () => {
  const { sys, sh } = boot();
  assert.equal((await sh("gcc hallo.c")).stderr, "Command 'gcc' not found, but can be installed with:\nsudo apt install gcc\n");
  await sh("sudo apt update", ["anna"]);
  assert.equal((await sh("sudo apt install -y gcc")).status, 0);
  assert.equal((await sh("gcc")).stderr, "gcc: fatal error: no input files\ncompilation terminated.\n");
  assert.equal((await sh("gcc nix.c")).stderr, "gcc: error: nix.c: No such file or directory\ngcc: fatal error: no input files\ncompilation terminated.\n");
  sys.writeFile(sys.shell, "/home/anna/hallo.c", '#include <stdio.h>\n\nint main(void) {\n    int zahl;\n    printf("Hallo aus C!\\n");\n    printf("Eine Zahl bitte: ");\n    scanf("%d", &zahl);\n    printf("%d zum Quadrat ist %d\\n", zahl, zahl * zahl);\n    return 0;\n}\n');
  const compile = await sh("gcc -Wall hallo.c -o hallo");
  assert.equal(compile.status, 0);
  assert.equal(compile.stdout + compile.stderr, "");
  assert.match((await sh("ls -l hallo")).stdout, /^-rwxr-xr-x .* hallo\n$/);
  assert.match((await sh("cat hallo")).stdout, /^#!LIACBIN/);
  const run = await sh("./hallo", ["5"]);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "Hallo aus C!\nEine Zahl bitte: 5 zum Quadrat ist 25\n");
  assert.equal((await sh("echo 7 | ./hallo")).stdout, "Hallo aus C!\nEine Zahl bitte: 7 zum Quadrat ist 49\n");
  await sh("chmod -x hallo");
  const denied = await sh("./hallo");
  assert.equal(denied.status, 126);
  assert.equal(denied.stderr, "bash: ./hallo: Permission denied\n");
  await sh("chmod +x hallo");
  assert.equal((await sh("./hallo", ["3"])).status, 0);
  // without -o the program is a.out
  assert.equal((await sh("gcc hallo.c")).status, 0);
  assert.match((await sh("ls -l a.out")).stdout, /^-rwxr-xr-x /);
  // a syntax error: file, line and column, no program
  sys.writeFile(sys.shell, "/home/anna/kaputt.c", '#include <stdio.h>\n\nint main(void) {\n    printf("x") SYNTAX_ERROR\n    return 0;\n}\n');
  const broken = await sh("gcc kaputt.c -o kaputt");
  assert.equal(broken.status, 1);
  assert.equal(broken.stderr, "kaputt.c:4:17: error: expected ';' but found 'SYNTAX_ERROR'\ncompilation terminated.\n");
  assert.equal((await sh("test -e kaputt")).status, 1);
  // return code of main becomes the exit status; a file that is no C file
  sys.writeFile(sys.shell, "/home/anna/drei.c", "int main(void) {\n    return 3;\n}\n");
  await sh("gcc drei.c -o drei");
  assert.equal((await sh("./drei")).status, 3);
  assert.match((await sh("gcc notes.txt")).stderr, /file format not recognized/);
  assert.equal((await sh("gcc -o")).stderr, "gcc: error: missing filename after '-o'\n");
  // C headers get their C++ names for the interpreter
  assert.equal(programs.translateC("#include <stdio.h>\n#include <stdbool.h>\n#include <math.h>\nint main(void) { f( void ); }"), "#include <cstdio>\n\n#include <cmath>\nint main() { f(); }");
  assert.equal(programs.translateC("struct P { int x; };\nstruct P p; struct Q q; struct P *z;"), "struct P { int x; };\nP p; struct Q q; P *z;");
  assert.equal(programs.translateC('puts("x"); printf("Hallo, %s und %d", a, b);'), 'printf("%s\\n", "x"); printf("Hallo,\\x20%s und %d", a, b);');
});

test("programs: the replay reads one line per attempt and shows every output once; a pipe ends with EOF", async () => {
  let attempts = 0;
  const typed = ["a", "b"];
  const io = { stdin: undefined, write: t => { io.out += t; }, error: () => {}, readLine: async () => typed.shift() };
  io.out = "";
  const status = await programs.replay(io, (stdin, write) => {
    attempts++;
    write("start\n");
    const x = stdin.next();
    write(`x=${x}`);
    const y = stdin.next();
    write(`y=${y}`);
    return 7;
  });
  assert.equal(status, 7);
  assert.equal(attempts, 3);
  assert.equal(io.out, "start\nx=a\ny=b\n");
  const piped = { stdin: "p\n", write: t => { piped.out += t; }, out: "", readLine: async () => { throw new Error("must not read"); } };
  await programs.replay(piped, (stdin, write) => { write(String(stdin.next())); write(String(stdin.next())); return 0; });
  assert.equal(piped.out, "p\nnull");
});

test("programs: the packages stay installed over save and restore, dpkg knows them, apt remove takes the commands away", async () => {
  const { sys, sh } = boot();
  await sh("sudo apt update", ["anna"]);
  await sh("sudo apt install -y python3 nodejs gcc");
  assert.match((await sh("dpkg -l")).stdout, /ii  python3 .*\nii  .*/);
  assert.match((await sh("apt show gcc")).stdout, /Package: gcc\nVersion: 12\.2\.0-14/);
  const restored = kernel.restoreSystem(JSON.parse(JSON.stringify(sys.serialize())), { clock: kernel.fakeClock() });
  assert.equal((await kernel.runCollect(restored, "which gcc node python3")).stdout, "/usr/bin/gcc\n/usr/bin/node\n/usr/bin/python3\n");
  assert.equal((await kernel.runCollect(restored, "node -p 1")).stdout, "1\n");
  await sh("sudo apt remove -y nodejs");
  assert.equal((await sh("node -v")).status, 127);
  assert.equal((await sh("which cc")).stdout, "/usr/bin/cc\n");
});

test("programs: console.log formats like node: strings bare, nested strings quoted, objects and arrays with spaces", () => {
  assert.equal(programs.format(["a", "b"]), "a b");
  assert.equal(programs.format([["a", 1]]), "[ 'a', 1 ]");
  assert.equal(programs.format([{ k: { deep: { deeper: { deepest: 1 } } } }]), "{ k: { deep: { deeper: [Object] } } }");
  assert.equal(programs.format(["%d%% von %s", 50, "allem", "extra"]), "50% von allem extra");
  assert.equal(programs.format([null, undefined, 1.5, true]), "null undefined 1.5 true");
  assert.equal(programs.inspect(() => 1, 1), "[Function: (anonymous)]");
  assert.equal(programs.inspect(new Map([["a", 1]]), 1), "Map(1) { 'a' => 1 }");
});

// ---------------------------------------------------------------- pip, images, upload and download (the merged brief)

test("acceptance 2 (pip): packages load only at pip install, pip list shows them, a saved figure is a PNG that xdg-open shows", async () => {
  const { sys, sh } = boot();
  const shown = [];
  const hooks = { show: async image => { shown.push(image); return true; } };
  assert.equal((await sh("pip install numpy")).status, 127);   // needs python3
  await sh("sudo apt update", ["anna"]);
  await sh("sudo apt install -y python3");
  const engine = programs.engines.python3;
  assert.equal(engine.hasPackage("numpy"), false);
  const install = await sh("pip install numpy matplotlib");
  assert.equal(install.status, 0);
  assert.match(install.stdout, /Collecting numpy\n  stub download numpy\nSuccessfully installed numpy-2\.4\.6\nCollecting matplotlib/);
  assert.equal(engine.hasPackage("matplotlib"), true);
  assert.deepEqual([...sys.pip], ["numpy", "matplotlib"]);
  assert.match((await sh("pip install numpy")).stdout, /Requirement already satisfied: numpy/);
  assert.equal((await sh("pip list")).stdout, "Package           Version\n----------------- ----------\nmatplotlib        3.10.8\nnumpy             2.4.6\n");
  assert.equal((await sh("pip freeze")).stdout, "matplotlib==3.10.8\nnumpy==2.4.6\n");
  assert.match((await sh("pip show matplotlib")).stdout, /Name: matplotlib\nVersion: 3\.10\.8\n.*\nRequires: numpy/);
  assert.match((await sh("pip install nixda")).stderr, /No matching distribution found for nixda/);
  assert.equal((await sh("python3 -m pip list")).status, 0);
  // the figure is a binary file in the file system; file recognizes it, xdg-open shows it
  sys.writeFile(sys.shell, "/home/anna/plot.py", 'import numpy\nimport matplotlib\nprint("zeichne")\nsavefig("plot.png")\n');
  assert.equal((await sh("python3 plot.py")).stdout, "zeichne\n");
  assert.match((await sh("ls -l plot.png")).stdout, /^-rw-r--r-- 1 anna anna 24 /);
  assert.match((await sh("file plot.png")).stdout, /^plot\.png: PNG image data, 2 x 3/);
  assert.equal((await sh("xdg-open plot.png", [], hooks)).status, 0);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].name, "plot.png");
  assert.equal(shown[0].binary, true);
  assert.match((await sh("xdg-open notes.txt", [], hooks)).stderr, /only images open here/);
  assert.match((await sh("xdg-open plot.png")).stdout, /no display here/);
  // the pip packages survive a save and a reload; a missing module is reported like Python does
  const restored = kernel.restoreSystem(JSON.parse(JSON.stringify(sys.serialize())), { clock: kernel.fakeClock() });
  assert.deepEqual([...restored.pip], ["numpy", "matplotlib"]);
  assert.match((await kernel.runCollect(restored, "file plot.png")).stdout, /PNG image data/);
  await sh("pip uninstall matplotlib");
  assert.equal((await sh("pip list")).stdout.includes("matplotlib"), false);
  sys.writeFile(sys.shell, "/home/anna/fehlt.py", "import scipy\n");
  assert.match((await sh("python3 fehlt.py")).stderr, /ModuleNotFoundError: No module named 'scipy'/);
});

test("acceptance 3 and 4 (upload, download): binary and text files keep their bytes, land with the user as owner, download needs r", async () => {
  const { sys, sh } = boot();
  // the browser side is a hook: upload reports lines, download collects the files
  const uploads = [], downloads = [];
  const hooks = {
    upload: async dir => { const lines = []; for (const f of uploads) { const text = f.text ?? null; sys.writeFile(sys.shell, `${dir}/${f.name}`, text ?? f.bytes, { binary: text === null }); lines.push(`${f.name} (${f.size}) -> ${dir}/${f.name}`); } return lines; },
    download: async files => { downloads.push(...files); return true; }
  };
  uploads.push({ name: "data.csv", size: "12 B", text: "a;b\n1;2\n" }, { name: "logo.png", size: "20 B", bytes: "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x10\x00\x00\x00\x08" });
  const up = await sh("upload", [], hooks);
  assert.equal(up.status, 0);
  assert.match(up.stdout, /data\.csv \(12 B\) -> \/home\/anna\/data\.csv\nlogo\.png \(20 B\) -> \/home\/anna\/logo\.png/);
  assert.match((await sh("ls -l")).stdout, /-rw-r--r-- 1 anna anna +8 .* data\.csv\n/);
  assert.equal((await sh("cat data.csv")).stdout, "a;b\n1;2\n");
  assert.match((await sh("file logo.png data.csv")).stdout, /^logo\.png: PNG image data, 16 x 8.*\ndata\.csv: ASCII text\n$/);
  assert.equal((await sh("wc -c logo.png")).stdout.trim(), "24 logo.png");
  assert.match((await sh("upload /nix", [], hooks)).stderr, /upload: \/nix: No such file or directory/);
  assert.match((await sh("upload notes.txt", [], hooks)).stderr, /Not a directory/);
  assert.match((await sh("upload")).stderr, /no browser file dialog here/);
  // download: the same bytes come back; a directory is refused with a hint; no r means Permission denied
  const down = await sh("download logo.png data.csv", [], hooks);
  assert.equal(down.status, 0);
  assert.deepEqual(downloads.map(f => [f.name, f.binary, f.data.length]), [["logo.png", true, 24], ["data.csv", false, 8]]);
  assert.equal(downloads[0].data, "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x10\x00\x00\x00\x08");
  assert.match(down.stdout, /logo\.png: 24 bytes sent/);
  assert.match((await sh("download scripts", [], hooks)).stderr, /Is a directory – pack it first: zip -r scripts\.zip scripts/);
  const denied = await sh("download /home/ben/secret.txt", [], hooks);
  assert.equal(denied.status, 1);
  assert.equal(denied.stderr, "download: /home/ben/secret.txt: Permission denied\n");
  assert.match((await sh("download nix")).stderr, /No such file or directory/);
  assert.match((await sh("download")).stderr, /usage: download FILE/);
  // binary files survive cp, mv, zip, save and restore
  await sh("cp logo.png kopie.png; mv kopie.png bilder.png");
  assert.match((await sh("file bilder.png")).stdout, /PNG image data/);
  const restored = kernel.restoreSystem(JSON.parse(JSON.stringify(sys.serialize())), { clock: kernel.fakeClock() });
  assert.equal(restored.stat(restored.shell, "/home/anna/logo.png").inode.binary, true);
  assert.equal((await kernel.runCollect(restored, "wc -c logo.png")).stdout.trim(), "24 logo.png");
  // writing text over a binary file makes it text again
  await sh("echo text > logo.png");
  assert.equal(sys.stat(sys.shell, "/home/anna/logo.png").inode.binary, undefined);
  assert.equal((await sh("file logo.png")).stdout, "logo.png: ASCII text\n");
});
