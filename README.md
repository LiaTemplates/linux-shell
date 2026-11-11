<!--
author:   André Dietrich
email:    LiaScript@web.de
version:  0.1.0
language: en
narrator: US English Female
logo:     ./logo.png
comment:  A simulated Linux shell inside the course: file system, users and permissions, processes and signals, services and packages, Python, JavaScript and C as packages with pip, images and file transfer – one session across all pages.

script:   https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.js
          https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.js
          ./linux-kernel.js
          ./linux-tools.js
          ./linux-system.js
          ./linux-programs.js
          ./linux-runtimes.js
          ./linux-lang-de.js
          ./linux-terminal.js
          ./linux-editor.js
link:     https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css
          ./linux-shell.css

attribute: [xterm.js](https://xtermjs.org) 6.0.0 and [addon-fit](https://github.com/xtermjs/xterm.js) 0.11.0
           by the xterm.js authors, licensed under [MIT](https://github.com/xtermjs/xterm.js/blob/master/LICENSE)
           [Pyodide](https://pyodide.org) 314.0.7 by the Pyodide authors, licensed under [MPL-2.0](https://github.com/pyodide/pyodide/blob/main/LICENSE) – loaded only on `apt install python3`
           [JSCPP](https://github.com/felixhao28/JSCPP) 2.0.9 by Felix Hao, licensed under [MIT](https://github.com/felixhao28/JSCPP/blob/master/LICENSE) – loaded only on `apt install gcc`

@Linux.terminal: @Linux.terminal_(@uid,@0,@1,@2)

@Linux.terminal_
<div id="linux_@0" class="lia-linux-terminal" role="application" aria-label="Linux terminal (simulated) – keys go to the shell"></div>
<script modify="false">
const lib = () => new Promise((ok, no) => { let n = 0; (function t() { if (window.LiaLinux) return window.LiaLinux.ready().then(ok, no); if (++n > 160) return no(new Error("Linux template not loaded")); setTimeout(t, 50); })(); });
lib().then(L => {
  (function mount(tries) {
    if (document.getElementById("linux_@0")) { L.mount("linux_@0", L.arg("@'1"), L.arg("@'2"), L.arg("@'3")); send.lia("LIA: stop"); }
    else if (tries < 40) setTimeout(() => mount(tries + 1), 50);
    else { send.lia("Linux: terminal element not found"); send.lia("LIA: stop"); }
  })(0);
}).catch(error => { send.lia("Linux: " + error.message); send.lia("LIA: stop"); });
"LIA: wait"
</script>
@end

@Linux.setup
<script modify="false" run-once style="display:block">
const lib = () => new Promise((ok, no) => { let n = 0; (function t() { if (window.LiaLinux) return window.LiaLinux.ready().then(ok, no); if (++n > 160) return no(new Error("Linux template not loaded")); setTimeout(t, 50); })(); });
lib().then(async L => {
  const [session, content] = L.blockArgs("@'0", "@'1", "@'input");
  const result = await L.setup(session, content);
  if (result.errors) send.lia("HTML: <span class=\"lia-linux-result fail\">" + L.ui(session, "setupErrors") + ": " + result.errors.replace(/</g, "&lt;") + "</span>");
  else send.lia("HTML: <span class=\"lia-linux-result ok\">" + L.ui(session, result.ran ? "setupRan" : "setupSkipped") + " (" + L.ui(session, "session") + " " + (session || "default") + ")</span>");
  send.lia("LIA: stop");
}).catch(error => { send.lia("Linux: " + error.message); send.lia("LIA: stop"); });
"LIA: wait"
</script>
@end

@Linux.file
<script run-once style="display:block">
const lib = () => new Promise((ok, no) => { let n = 0; (function t() { if (window.LiaLinux) return window.LiaLinux.ready().then(ok, no); if (++n > 160) return no(new Error("Linux template not loaded")); setTimeout(t, 50); })(); });
lib().then(L => {
  const [session, content] = L.blockArgs("@'1", "@'2", "@'input");
  const result = L.writeFile(session, L.arg("@'0"), content);
  send.lia("HTML: <span class=\"lia-linux-result " + (result.ok ? "ok" : "fail") + "\">" + (result.ok ? "💾 " : "❌ ") + result.message.replace(/</g, "&lt;") + "</span>");
  send.lia("LIA: stop");
}).catch(error => { send.lia("Linux: " + error.message); send.lia("LIA: stop"); });
"LIA: wait"
</script>
@end

@Linux.run
<script run-once style="display:block">
const lib = () => new Promise((ok, no) => { let n = 0; (function t() { if (window.LiaLinux) return window.LiaLinux.ready().then(ok, no); if (++n > 160) return no(new Error("Linux template not loaded")); setTimeout(t, 50); })(); });
lib().then(async L => {
  const [session, content] = L.blockArgs("@'0", "@'1", "@'input");
  const output = await L.run(session, content);
  send.lia("HTML: <pre class=\"lia-linux-output\">" + (output.replace(/\x1b\[[0-9;]*m/g, "").replace(/</g, "&lt;") || L.ui(session, "noOutput")) + "</pre>");
  send.lia("LIA: stop");
}).catch(error => { send.lia("Linux: " + error.message); send.lia("LIA: stop"); });
"LIA: wait"
</script>
@end

@Linux.check: @Linux.check_(@uid,@0,@1)

@Linux.check_
<div class="lia-linux-check"><button type="button" class="lia-linux-button" id="check_@0">Check task</button> <span id="result_@0" class="lia-linux-result" role="status" aria-live="polite" hidden></span></div>
<script modify="false">
const lib = () => new Promise((ok, no) => { let n = 0; (function t() { if (window.LiaLinux) return window.LiaLinux.ready().then(ok, no); if (++n > 160) return no(new Error("Linux template not loaded")); setTimeout(t, 50); })(); });
lib().then(L => {
  (function wire(tries) {
    const button = document.getElementById("check_@0"), out = document.getElementById("result_@0");
    if (!button) { if (tries < 40) setTimeout(() => wire(tries + 1), 50); return; }
    const session = L.arg("@'1");
    button.textContent = L.ui(session, "check");
    button.onclick = async () => {
      const result = await L.check(session, "@'2");
      out.hidden = false;
      out.className = "lia-linux-result " + (result.ok ? "ok" : "fail");
      out.textContent = result.ok ? L.ui(session, "met") : L.ui(session, "notMet") + (result.output ? " – " + result.output : "");
    };
  })(0);
  send.lia("LIA: stop");
}).catch(error => { send.lia("Linux: " + error.message); send.lia("LIA: stop"); });
"LIA: wait"
</script>
@end

@Linux.reset: @Linux.reset_(@uid,@0)

@Linux.reset_
<button type="button" class="lia-linux-button" id="reset_@0">Reset session</button>
<script modify="false">
const lib = () => new Promise((ok, no) => { let n = 0; (function t() { if (window.LiaLinux) return window.LiaLinux.ready().then(ok, no); if (++n > 160) return no(new Error("Linux template not loaded")); setTimeout(t, 50); })(); });
lib().then(L => {
  (function wire(tries) {
    const button = document.getElementById("reset_@0");
    if (!button) { if (tries < 40) setTimeout(() => wire(tries + 1), 50); return; }
    const session = L.arg("@'1");
    button.textContent = L.ui(session, "reset");
    button.onclick = () => L.reset(session);
  })(0);
  send.lia("LIA: stop");
}).catch(error => { send.lia("Linux: " + error.message); send.lia("LIA: stop"); });
"LIA: wait"
</script>
@end

@Linux.image: @Linux.image_(@uid,@0,@1)

@Linux.image_
<figure class="lia-linux-viewer missing" id="image_@0"><img alt="" hidden><figcaption><span class="lia-linux-viewer-name">@1 – not there yet</span></figcaption></figure>
<script modify="false">
const lib = () => new Promise((ok, no) => { let n = 0; (function t() { if (window.LiaLinux) return window.LiaLinux.ready().then(ok, no); if (++n > 160) return no(new Error("Linux template not loaded")); setTimeout(t, 50); })(); });
lib().then(L => {
  (function wire(tries) {
    const figure = document.getElementById("image_@0");
    if (!figure) { if (tries < 40) setTimeout(() => wire(tries + 1), 50); return; }
    const img = figure.querySelector("img"), caption = figure.querySelector(".lia-linux-viewer-name");
    const path = L.arg("@'1"), session = L.arg("@'2");
    const stop = L.watch(session, path, data => {
      if (!data) { figure.classList.add("missing"); img.hidden = true; img.removeAttribute("src"); caption.textContent = path + " – " + L.ui(session, "missing"); return; }
      figure.classList.remove("missing"); img.hidden = false; img.src = data.src; img.alt = data.name; caption.textContent = path + " (" + data.size + " " + L.ui(session, "bytes") + ")";
    });
    new MutationObserver(() => { if (!document.body.contains(figure)) stop(); }).observe(document.body, { childList: true, subtree: true });
  })(0);
  send.lia("LIA: stop");
}).catch(error => { send.lia("Linux: " + error.message); send.lia("LIA: stop"); });
"LIA: wait"
</script>
@end
-->

[![LiaScript](https://raw.githubusercontent.com/LiaScript/LiaScript/master/badges/course.svg)](https://liascript.github.io/course/?https://raw.githubusercontent.com/LiaTemplates/linux-shell/master/README.md)

![Linux Shell – an interactive terminal for LiaScript](./logo.png)

A simulated Linux shell for [LiaScript](https://liascript.github.io) courses – file system, users and permissions, processes and signals, services, packages, Python, JavaScript and C, all in the learner's browser. **[Try it live](https://liascript.github.io/course/?https://raw.githubusercontent.com/LiaTemplates/linux-shell/master/README.md)** · [Repository](https://github.com/LiaTemplates/linux-shell) · [More LiaScript templates](https://github.com/topics/liascript-template)

Import the template into a course with one of these header lines (pinned release, or the latest state):

```markdown
import: https://raw.githubusercontent.com/LiaTemplates/linux-shell/0.1.0/README.md
import: https://raw.githubusercontent.com/LiaTemplates/linux-shell/master/README.md
```

# Linux Shell – Template

![Linux Shell – an interactive terminal for LiaScript](./logo.png)

This template brings a **simulated Linux shell** into the course: a terminal with a file system, users, groups and permissions, processes, jobs and signals, services, packages and archives – and, through `apt`, Python, JavaScript and C as programming languages, `pip` for Python packages, an image viewer and file transfer between the browser and the simulation. Everything runs in the browser, nothing on a real machine. Error messages and outputs match those of bash and the GNU tools, so learners recognize them later on a real system.

**One session for the whole course:** every page that shows a terminal attaches to the same session. What was created on page 1 is still there on page 3; a process started on page 2 keeps running on page 3. The session also survives a page reload (it is stored in the learner's browser). Processes the learner started end at that point, as after a reboot; processes from a setup block (`@Linux.setup`) are started again.

Import it with one of these lines in the course header (the pinned release keeps a course stable, `master` follows every change):

```markdown
<!--
import: https://raw.githubusercontent.com/LiaTemplates/linux-shell/0.1.0/README.md
-->
```

Macros:

1. `@Linux.terminal` – the terminal
2. `@Linux.setup` – prepare a task (as root, once per session); in the fence line of a code block
3. `@Linux.file(path)` – write the code block into the system as a file
4. `@Linux.run` – run the code block in the session
5. `@Linux.check(session, condition)` – a check button for a task
6. `@Linux.reset(session)` – reset the session to its initial state
7. `@Linux.image(path, session)` – show an image file from the simulated file system on the page (for example a plot made with Python)

Learners are logged in as **anna** (password `anna`, may use `sudo`). There is also **ben** (password `ben`) and **root** (password `root`), the group `project` with both users, and a small file system with `/home/anna`, `/home/ben` and `/srv/project`.

## `@Linux.terminal`

The terminal of the default session. Try: `ls -l`, `cat notes.txt`, `cat /home/ben/secret.txt` (Permission denied!), `ps aux`, `man chmod`. The arrow keys recall the history, Tab completes, Ctrl+C aborts, Ctrl+L clears the screen.

@Linux.terminal

With parameters: `@Linux.terminal(session, rows, language)` – a second, independent session called `lab` with 10 rows and German messages. Independent means: its own file system, its own users, its own processes. Try `cat /nothing` and `man ls` here.

@Linux.terminal(lab, 10, de)

**Language.** As on a real system, the variable `LANG` decides in which language `bash` and the tools report and `man` answers. The third parameter sets it when the session is created (`de` or `en`; without it English, as on most servers). It also sets the language of the macros' labels and feedback (check button, reset button, setup messages). Learners switch at any time: `export LANG=de_DE.UTF-8` or `export LANG=C`. The outputs of the commands themselves (`ls`, `ps`, file contents) stay as they are – only messages, password prompts and help texts change. German ships in `linux-lang-de.js` next to the template; another language is a copy of that file with translated texts, added with one more `script:` line. The German messages follow the translations of bash and the GNU tools in meaning; individual distributions word them slightly differently.

## `@Linux.setup`

Prepares a task: the commands run **as root** and **once per session** – not again on the next visit of the page or after a reload. The output does not appear in the terminal; only errors are reported below the block. With `>` and `>>` files with content are created. The macro stands **in the fence line of the code block**, right after the language – so the fence line reads: three backticks, then `bash @Linux.setup`. This is what it looks like in a course:

```bash @Linux.setup
mkdir -p /home/anna/task
echo "This report belongs to Ben." > /home/anna/task/report.txt
chown ben:ben /home/anna/task/report.txt
chmod 600 /home/anna/task/report.txt
sudo -u anna sleep 3600 &
```

For a named session: `@Linux.setup(lab)` in the fence line. The terminal above now shows the folder `task`, and `ps aux` the sleeping process – on every page of this session.

## `@Linux.file(path)`

The code block is a file in the system. It is written when the page is shown. The owner is the current user of the session, the permissions follow the `umask` – so a script is **not executable** at first. The macro stands in the fence line:

```bash @Linux.file(/home/anna/scripts/greeting.sh)
#!/bin/bash
echo "Hello, $USER!"
echo "Your home: $HOME"
date
```

In the terminal: `./scripts/greeting.sh` fails with *Permission denied*, `bash scripts/greeting.sh` runs, and after `chmod +x scripts/greeting.sh` `./scripts/greeting.sh` runs too. With a second parameter the file lands in another session: `@Linux.file(/tmp/test.txt, lab)`. If you prefer to write in the terminal: `nano scripts/greeting.sh` opens the file in the editor – ^O saves, ^X quits.

## `@Linux.run`

Runs the lines of the block in the session as if the learners had typed them – they also appear in the terminal. The output stands below the block.

```bash @Linux.run
whoami
ls -l /home/anna/task
id
```

For a named session: `@Linux.run(lab)` in the fence line.

## `@Linux.check(session, condition)`

A check button. The condition is a shell test in the session; exit status 0 means met. The feedback names the real error text, if there is one.

**Task 1:** Create the file `report.txt` in your home directory.

@Linux.check(default, test -f /home/anna/report.txt)

**Task 2:** Make `scripts/greeting.sh` executable.

@Linux.check(default, test -x /home/anna/scripts/greeting.sh)

**Task 3:** End the sleeping process from the setup (`ps aux`, then `kill`).

@Linux.check(default, ! pgrep sleep)

**Task 4:** Make sure you may read `task/report.txt` – without staying root (hint: `su ben`, `chmod`, `exit`).

@Linux.check(default, test -r /home/anna/task/report.txt)

**Task 5:** Install the package `cowsay` (hint: `sudo apt update` first) and let the cow say something.

@Linux.check(default, which cowsay)

**Task 6:** Start the web server `nginx` as a service and make sure it also runs after a reboot (`apt`, `systemctl enable`, `systemctl start`).

@Linux.check(default, `systemctl is-active nginx && systemctl is-enabled nginx`)

If the condition contains a comma, put it in backticks – like every macro parameter with a comma. The test runs as the user who is currently logged in to the session. Note: a macro call with parentheses is also executed inside inline code; in documentation, show calls only descriptively.

## `@Linux.reset(session)`

Resets the session to its initial state: fresh file system, default users, empty history. The setups of all `@Linux.setup` blocks visited so far run once more afterwards. The state stored in the browser is deleted as well.

@Linux.reset(default)

@Linux.reset(lab)

## Programs: Python, JavaScript and C

Learners install programming languages like on a real system, **as packages**: `sudo apt install python3` (password `anna`), `nodejs`, `gcc`. Before that the shell reports "Command 'python3' not found, but can be installed with: sudo apt install python3". The runtimes are **loaded only on installation** – Python about 10 MB once, then from the browser cache; C about 300 KB; JavaScript is the browser's own. After a reload the packages stay installed, the runtime comes back on the first call. The setup of this page has already run `apt update`.

```bash @Linux.setup
apt update
```

@Linux.terminal

### Python: `python3`

```python @Linux.file(/home/anna/hello.py)
print("Hello from Python!")
name = input("What is your name? ")
print(f"Nice to see you, {name}.")
with open("greeting.txt", "w") as file:
    file.write(f"Greetings to {name}\n")
```

**Task 7:** Install `python3` and run `python3 hello.py`. Answer the question – the program writes `greeting.txt`.

@Linux.terminal

@Linux.check(default, test -f /home/anna/greeting.txt)

`python3 file.py` runs a program, `python3 -c "print(2**10)"` one line, `python3` alone opens the prompt `>>>` (`exit()` leaves it). `print()` writes to the terminal, `input()` reads a line from it, `open()` reads and writes files of the current directory with the permissions of the logged-in user. An error shows the traceback with file name and line, `sys.exit(3)` sets the exit status. A first line `#!/usr/bin/env python3` makes a script directly runnable after `chmod +x`. **Input:** the Python runtime cannot wait for the keyboard in the browser; when a program asks with `input()` for a line nobody has typed yet, the terminal reads it and restarts the program in the background with all answers so far – the output appears only once, random numbers stay the same within one run, files are written only by the last pass.

A number guessing game to try – `python3 guess.py`:

```python @Linux.file(/home/anna/guess.py)
import random

secret = random.randint(1, 100)
tries = 0
print("I am thinking of a number between 1 and 100.")
while True:
    guess = input("Your guess: ")
    if not guess.isdigit():
        print("Please enter a whole number.")
        continue
    tries += 1
    number = int(guess)
    if number < secret:
        print("Higher!")
    elif number > secret:
        print("Lower!")
    else:
        print(f"Correct! The number was {secret} – after {tries} tries.")
        break
with open("highscores.txt", "a") as file:
    file.write(f"{tries} tries\n")
```

### JavaScript: `node`

```javascript @Linux.file(/home/anna/app.js)
const fs = require("fs");
const readline = require("readline");

console.log("Hello from JavaScript!", process.argv.slice(2));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("How many lines? ", answer => {
  const n = Number(answer) || 3;
  const lines = Array.from({ length: n }, (_, i) => `Line ${i + 1}`);
  fs.writeFileSync("lines.txt", lines.join("\n") + "\n");
  console.log(`lines.txt written: ${n} lines`);
  rl.close();
});
```

**Task 8:** Install `nodejs`, run `node app.js one two` and have at least five lines written (`cat lines.txt`, `wc -l lines.txt`).

@Linux.terminal

@Linux.check(default, grep -q "Line 5" /home/anna/lines.txt)

`node file.js`, `node -e "console.log(1 + 1)"`, `node -p "[1, 2].map(x => x * 2)"`, `node` alone as the prompt `>` (`.exit`). There are `console`, `process` (`argv`, `env`, `exit`, `stdout.write`, `cwd`), the modules `fs` (read, write, append, delete, directories; also `fs.promises` and callbacks), `path`, `os`, `readline` (`question`, `on("line")`, `readline/promises`), `events`, `assert`, `util` and `require("./own.js")`. Errors name file and line like Node, `process.exit(2)` sets the exit status. Limits: no network and child-process modules, and an **endless loop freezes the course page** (reloading the page helps, the session survives).

### C: `gcc`

```c @Linux.file(/home/anna/hello.c)
#include <stdio.h>

int main(void) {
    int number;
    printf("Hello from C!\n");
    printf("A number, please: ");
    scanf("%d", &number);
    printf("%d squared is %d\n", number, number * number);
    return 0;
}
```

**Task 9:** Install `gcc`, compile with `gcc hello.c -o hello` and run `./hello`. Look with `ls -l hello` at the permissions the compiler set – and what happens when you take them away with `chmod -x hello`. Then delete a semicolon in `nano hello.c` and compile again: the compiler names file, line and column.

@Linux.terminal

@Linux.check(default, `echo 12 | ./hello | grep -q 144`)

`gcc source.c -o program` checks the file and creates the program with the `x` permission (`a.out` without `-o`; `-Wall`, `-O2`, `-std=c11` are accepted and ignored); `./program` runs it – the C interpreter translates the stored source step by step. Supported: `stdio.h` (`printf` with widths and decimals, `scanf`, `puts`, `getchar`), `stdlib.h` (`atoi`, `abs`, `rand`), `string.h`, `math.h`, `ctype.h`, functions including recursion, arrays including multidimensional ones, pointers, `char` strings, `switch`, all loops; a program that computes for more than 10 seconds is aborted. Not included: `struct` and `typedef`, `malloc`, `goto`, several source files, linking libraries, file access (`fopen`); at the end of the input `scanf` does not return a value – the program ends with a message instead. `scanf` reads like `input()` in Python, through the restart mechanism.

## Python packages and images: `pip`, `@Linux.image`

With `pip install` learners fetch packages from the stock of the Python runtime – built for the browser: `numpy`, `matplotlib`, `pandas`, `scipy`, `sympy` and many more; pure Python packages from PyPI usually work too. Loading happens only at `pip install` (matplotlib with numpy about 15 MB once, then from the cache), `pip list` shows the state, and after a reload the packages come back on the first run.

```python @Linux.file(/home/anna/curve.py)
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 2 * np.pi, 200)
plt.plot(x, np.sin(x), label="sin")
plt.plot(x, np.cos(x), label="cos")
plt.legend()
plt.title("Two curves")
plt.savefig("curve.png")
print("curve.png saved")
```

**Task 10:** Install `python3`, then `pip install numpy matplotlib`, and run `python3 curve.py`. The image appears below as soon as the file exists; in the terminal `xdg-open curve.png` shows it as well, and `file curve.png` reveals format and size.

@Linux.terminal

@Linux.image(/home/anna/curve.png)

@Linux.check(default, test -s /home/anna/curve.png)

The macro `@Linux.image` takes a path and optionally the session; it shows the file as soon as it exists and updates after every command that changes it. `plt.show()` saves the figure as `figure.png` and opens it in the viewer below the terminal. Otherwise a terminal shows no graphics – like the original.

## Uploading and downloading files

Own files come into the simulation in three ways: **drag them onto the terminal** (they land in the current directory of the session), with `upload` (opens the browser's file dialog; `upload folder` puts them there), or with the course's file macro. The way back is `download file …`: the browser downloads every file unchanged; pack a directory first (`zip -r project.zip project`). Permissions apply as usual: uploaded files belong to the logged-in user, `download` needs the `r` permission. Text files stay readable, everything else (images, zip, PDF) is stored as a binary file – `ls -l` shows the real size, `file` the type, `cat` gibberish like the original. Limit: 2 MB per file, so the browser storage suffices.

**Task 11:** Drag a text file from your computer onto the terminal above (or use `upload`), look at it with `ls -l` and `cat`, and get it back with `download`.

@Linux.check(default, `ls -l /home/anna | grep -q -v -e notes -e scripts -e project -e total -e hello -e guess -e app.js -e lines -e curve -e greeting -e highscores -e task -e report`)

## What is simulated – and what is not

**File system:** `ls` (`-l -a -A -h -S -t -r -R -F -i -n -1 -d`), `cd`, `pwd`, `cat` (`-n -b -A -E -T -s`), `echo` (`-n -e`), `printf`, `mkdir` (`-p -m -v`), `touch -c`, `rm` (`-r -f -i -d -v`), `cp` (`-r -i -n -v`), `mv` (`-i -n -v`), `rmdir`, `ln -s -f`, `readlink`, `head`/`tail` (`-n -c`), `wc` (`-l -w -c -m -L`), `grep` (`-i -n -v -r -c -w -l -o -q -h -H -s -F -A -B -C`), `find` (`-name -iname -type -maxdepth -mindepth -user -group -perm -empty -size -mtime -mmin -newer -not`), `sort` (`-r -n -u -f -b -k -t`), `uniq` (`-c -d -u -i`), `cut` (`-d -f -c`), `tree` (`-a -d -L -F`), `stat -c`, `file`, `du` (`-s -h -a -c -d`), `df`, `free`, `which`, `type`, `env`, `printenv`, `export`, `unset`, `history`, `man`, `whatis`, `help`, `date +FORMAT`, `uptime`, `uname`, `hostname`, `seq`, `basename`, `dirname`, redirections `>`, `>>`, `2>`, `2>&1`, `&>`, wildcards `*`, `?`, `[…]`, variables `$HOME`, `$?`, `$$`, `$!`. Unknown options report like the original (`ls: invalid option -- 'z'`).

**Users and permissions:** `/etc/passwd`, `/etc/group`, `/etc/shadow` (root only), `whoami`, `id` (`-u -g -G -n`), `groups`, `su`, `su -`, `sudo` (with password, valid for 15 minutes, group `sudo` only; `-u`, `-i`, `-k`), `passwd`, `useradd` (`-m -G -s -d -c -u`), `groupadd`, `usermod -aG`, `chmod` (octal and symbolic, `-R -v`), `chown`, `chgrp`, `umask`. The permission check follows the Linux kernel: owner → group → others; root reads and writes everything but executes only what has an x bit; `x` on a directory decides over `cd` and access to its files; deleting needs `w` in the directory, not on the file; `/tmp` has the sticky bit.

**Processes and signals:** `ps` (`aux`, `-ef`, `-u USER`, `-p PID`), `pstree -p`, `top` (snapshot), `pgrep`, `pkill`, `kill` (names and numbers, `-l`), `jobs`, `fg`, `bg`, `wait`, `sleep`, `&`, Ctrl+C, Ctrl+Z, `trap`, `/proc/<pid>/status`. SIGTERM can be caught with `trap`, SIGKILL cannot; a stopped process receives other signals only after SIGCONT; a child nobody waits for stays as a zombie (`Z`) until its parent ends. An example of indestructibility: `bash -c 'trap "" TERM; sleep 100' &`

**Scripts:** `bash file.sh`, `./file.sh` (needs `r` and `x`), `bash -c`, `source`, positional parameters `$1 $@ $#`, `exit`, `test` / `[ ]`. Further executable formats register with the kernel (`LiaLinuxKernel.registerExecFormat`): this is how compiled C programs and scripts with `#!/usr/bin/env python3` run via `./file`.

**Pipes and streams:** `command | command` (every stage runs to its end, its output becomes the input of the next), `< file`, `tee` (`-a`), `xargs` (`-n -I -t`), `tr` (`-d -s -c`, ranges and classes like `[:upper:]`), `read` (`-p`), `find -exec … {} \;` and `-delete`, `yes` in a pipe ends after 10,000 lines.

**Text tools:** `sed` (`s/old/new/g`, `-n` with `p`, `d`, addresses `3`, `/pattern/`, `2,4`, `$`, `-e`, `-i`, `-E`), `awk` (`-F`, `-v`, `$1 … $NF`, `NR`, `NF`, `BEGIN`/`END`, patterns and ranges, `if`/`else`, `for`, `for (k in arr)`, `while`, arrays, `printf`, `length`, `substr`, `index`, `toupper`, `tolower`, `split`, `sub`/`gsub`, `sprintf`, `match`), `diff` (`-u -q -i`), `cmp`, `tac`, `rev`, `nl`, `fold -w`, `egrep`, `fgrep`, `expr`, `cal`, `sha256sum`, `sha1sum`, `md5sum` (`-c`). Regular expressions in `grep` and `sed` follow the basic syntax (`\(` `\)` `\{` `\}` are the operators), with `-E` the extended one.

**Network:** `curl` (`-o -O -s -S -I`) and `wget` (`-O -q`) fetch pages with the browser's means. That works only for addresses whose server allows access from foreign pages (CORS – for example raw files on GitHub or open APIs); otherwise `curl` reports "Could not resolve host" like the original. No `ssh`, `ping`, `ip`.

**Miscellaneous:** `alias`/`unalias` (preset `ll`, `la`, `l`), `who`, `w`, `last`, `userdel -r`, `groupdel`, `chsh -s`, `htop`, `lsblk`, `mount`, `umount`, `fdisk -l`, `nohup`, `time`, `nice`, `renice`, `apropos`, `reset`; `shutdown -r now`/`reboot` as root restarts the session (all processes end, files stay, enabled services start again), as a user the message from systemd appears.

**Editor:** `nano file` opens the editor in the terminal – title bar, text area, status line and the shortcuts of the original: ^O save (asks for the file name), ^X quit ("Save modified buffer?"), ^K cut line, ^U paste, ^W search, ^/ go to line, ^G help, arrow keys, Page Up/Down, Home/End; pasting from the clipboard works. Permissions apply as usual: a file without `w` reports "Error writing … Permission denied" on saving.

**Services:** `systemctl status|start|stop|restart|reload|enable|disable|is-active|is-enabled|list-units`, `service name status`, `journalctl [-u service] [-n number]`. `ssh` and `cron` run preinstalled; `nginx` comes with its package. Starting and stopping need root ("Interactive authentication required"), a running service is a process in `ps aux`, `kill` on it lands as a crash in the journal, after a reboot only enabled services run. Unit files are readable under `/lib/systemd/system/`.

**Packages:** `apt update|install|remove|purge|search|show|list [--installed]|upgrade|policy` (`-y`), `apt-get`, `apt-cache`, `dpkg -l|-s|-L|-S`. As on a fresh installation, `apt` knows the index only after `sudo apt update`; without root the lock errors of Debian appear. All commands of the template are preinstalled (packages `coreutils`, `bash`, `grep`, `sed`, `gawk`, `procps`, `curl`, `wget`, `nano`, `tar`, `gzip`, `zip`, `tree`, `htop`, …). Installable: `cowsay`, `sl`, `fortune`, `neofetch`, `nginx`, `python3`, `nodejs`, `gcc`. A command from the index whose package is missing reports like Ubuntu: "Command 'cowsay' not found, but can be installed with: sudo apt install cowsay". After `apt remove` the command is gone again. Other templates attach packages with runtimes to the same index (`LiaLinuxSystem.registerPackage`). The outputs of `apt` stay English.

**Archives:** `tar` (`-c -x -t -v -f -z`, `-C`), `gzip`/`gunzip`/`zcat` (`-k -l`), `zip -r`, `unzip` (`-l -d`). Archives are files in the simulated file system; `file` recognizes them.

**Programs:** `python3`, `node`, `gcc` as packages (page "Programs"); `python3 -m pip` and `pip install|list|show|uninstall|freeze`; scripts with `#!/usr/bin/env python3` or `node` run after `chmod +x` with `./script`; pipes and redirections (`echo 5 | ./hello`, `python3 script.py < input.txt`) work as with every command. Not: `npm`, threads, network from programs, Ctrl+C during a Python or C program (they run in one piece; the 10-second guard applies to C).

**Images and files:** `xdg-open image.png` (also `display`, `eog`) shows png, jpg, gif, webp and svg below the terminal; `upload [folder]`, `download file …`, dragging onto the terminal; binary files with their real size, `file` recognizes PNG, JPEG, GIF, PDF, Zip, gzip; `cp`, `mv`, `zip`, saving and reloading keep the bytes.

**Not included** (a separate template, `linux-bash`, is planned for these): `if`/`for`/`while` in the shell, functions, `$(…)`, arrays, heredocs. Also not: `vi`/`vim`, `ssh`/`ping`, packages outside the small index, real CPU load in `top`, the effect of SUID/SGID, ACLs.

**Security:** everything lives in the learner's browser. The passwords of the practice users are trivial on purpose; a "breakout" from the simulation is impossible because there is nothing to break out into.

## Implementation

The macros stand in the metadata comment of this file. The kernel (`linux-kernel.js`: file system with text and binary files, permissions, processes, parser with pipes and redirections, basic commands, executable formats of other files via `registerExecFormat`) runs in the browser and in Node without a DOM; `linux-tools.js` adds the further programs (`sed`, `awk`, `diff`, hashes, `curl`, …), `linux-system.js` services, packages and archives, `linux-programs.js` the programming languages as packages (`python3`, `node`, `gcc`, `pip`), the JavaScript engine, the restart mechanism for input, plus `upload`, `download` and `xdg-open` – all through `LiaLinuxKernel.registerCommands`; `linux-runtimes.js` loads Pyodide (`python3`, `pip` from its package stock and micropip) and JSCPP (`gcc`) in the browser on demand and translates between them and the terminal (input and output, mirroring the working directory with binary files, tracebacks without inner frames, C headers with C++ names, `plt.show()`); `linux-terminal.js` attaches xterm.js terminals to the sessions, stores them in `localStorage`, accepts dropped files and provides the image viewer, the file dialog and the download; `linux-editor.js` is the `nano` in the terminal; `linux-lang-de.js` is the German language pack; `linux-shell.css` styles frames, feedback and the image viewer.

```markdown
script:   https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.js
          https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.js
          ./linux-kernel.js
          ./linux-tools.js
          ./linux-system.js
          ./linux-programs.js
          ./linux-runtimes.js
          ./linux-lang-de.js
          ./linux-terminal.js
          ./linux-editor.js
link:     https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css
          ./linux-shell.css
```

Model tests: `node --test check.mjs` in the repository folder – permission matrix, directory permissions, `chmod`/`chown`/`umask`, `su`/`sudo`, jobs and signals, zombies, Ctrl+C/Ctrl+Z, scripts and the x bit, redirections and pipes, error texts, language switch via `LANG`, the options of the tools, `sed`/`awk`/`diff`, `curl`/`wget` with a mocked network, packages, services, archives, `nano`, the programming languages (JavaScript real, Python and C as stubs with the same interface as the browser runtimes), `pip`, binary files, `upload`/`download`, and a pass that calls every program once. The real runtimes are checked in the browser.

Languages: `linux-lang-de.js` registers German with `LiaLinuxKernel.registerLanguage("de", {messages, man, terminal, ui})` – `messages` are pattern–replacement pairs for the messages of bash and the tools, `man` the short manual pages, `terminal` the three texts of the terminal, `ui` the labels and feedback of the macros. A copy of the file with another code and translated texts is a new language.

Sessions in code: `LiaLinux.session("default").sys` is the system; `LiaLinuxKernel.runCollect(sys, "ls -l")` runs one line and returns `{stdout, stderr, status}`.
