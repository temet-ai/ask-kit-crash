# Recipe: crash kit

## What it answers

Why a program crashed on a Linux machine with systemd-coredump: which programs crashed and when,
one crash in detail (signal, command line, crashing thread's stack, faulting frame and module, owning
package and version), whether the same stack crashed before, whether an update preceded the first
occurrence, whether the fault is in the program, a library, libc, the GPU stack or the compositor, and
whose bug it is. It writes a bug report to a file when asked.

## What it needs

- Linux with `coredumpctl` and `journalctl` (listed in `requires`). The optional `CRASH_TOOLS_DIR` setting names a folder searched
  before PATH, for testing against recorded output.
- Optional: `gdb` (backtrace with symbols and registers; without it the journal's stack is used),
  `pacman` (owning package, versions, pacman.log), `c++filt` (demangling), `ldconfig` (library paths),
  `omarchy` (version in reports). `eu-stack` and `debuginfod-find` are not used; gdb does the
  debuginfod lookup itself when asked.
- The user must be able to read the system journal (wheel or systemd-journal group) and, for gdb, the
  core files (`coredumpctl dump` works for the user's own crashes).

## What it reads and runs

- `coredumpctl list --json=short` and `coredumpctl dump <pid> --output=<private temp file>`.
- `journalctl` for coredump records (selected fields only: never the environment, mappings or open
  files that the journal entry also holds), for the minute before a crash and for kernel lines.
- `pacman -Qo`, `-Qi`, `-Qmq`, `-Q`, and `/var/log/pacman.log` (read-only).
- `gdb -nx -q -batch` with auto-load off and a fixed set of commands; `ldconfig -p`, `c++filt`, `date`,
  `omarchy version`.
- No shell anywhere: every program runs through `execFile` with an argument list and a timeout.

## Rebuild it from an empty folder

Write `ask-kit.toml` with `platforms = ["linux"]`, `requires = ["coredumpctl", "journalctl"]`, one
`module` source named `crash`, and `acts = ["crash.gdb", "crash.writeFile"]` (written as
`<source>.<function>`, so the host holds those two functions back in a read-only ask). The module
exports `make({settings, push, cwd, act})` returning a client with:

- `all()`/`list(o)`/`pick(sel)`: the coredump records, from `coredumpctl list --json=short` joined
  with `journalctl MESSAGE_ID=fc2e22bc6ee647b6b90729ab34a250b1 -o json` on pid and record time. The
  crash time is `COREDUMP_TIMESTAMP`, not the time the entry was written. Command lines are masked.
- `parseStacks(message)`: the `Stack trace of thread N:` blocks of the journal message; the first
  block is the crashing thread (inside a sandbox the thread id differs from the pid).
- `faultingFrame(frames, signo)`: skip raise/abort chains (SIGABRT, SIGTRAP: the caller of the chain
  is the fault) and a program's own crash handler that re-raises a SEGV (the frame after the signal
  trampoline, a nameless libc frame, is the fault).
- `analyse(sel)`: stack, faulting frame, owner package of the faulting module (module name to path
  through `ldconfig -p`, then `pacman -Qo`), classification (program, library, libc, gpu-driver,
  compositor), Omarchy evidence.
- `history(a)`: earlier crashes of the same program whose top 5 frames match (unnamed frames matched
  by library, since offsets change with the build).
- `around(c)` and `kernelNear(c)`: journal lines around the crash and kernel trap, GPU and OOM lines.
- `versionAt`, `upgrades`, `pkgInfo`, `owners`, `system`: pacman.log and pacman queries.
- `backtrace(sel, o)`: dump the core to `mkdtemp` (mode 700), run gdb with `-nx`, `set auto-load no`,
  `set print frame-arguments none`, `set print frame-info location-and-address`, `set debuginfod
  enabled off|on`, and only `bt N`, `info threads`, `info sharedlibrary`, `p $_siginfo...`, `thread
  apply all bt 4`, `info registers rip rsp eflags`, `x/2i $pc`; map frame addresses to modules through
  the `info sharedlibrary` ranges; delete the folder in a `finally`.
- `gdb(sel, commands)` and `writeFile(path, text)`: throw "not in this ask" unless `act`.
- `mask(text)`: URL credentials, secret-named options and variables, token shapes, long opaque strings.

Scripts: `recent`, `why`, `same`, `backtrace`, `report`. Keep each script's output under 4000
characters: the REPL clips larger values. Skills: `diagnose`, `report-upstream`, `crash-loop`. Role:
`diagnostician`. `instructions.md`: start from a script, keep proven and inferred apart, never invent
a function name, never return memory, never file anything.

## Bench

`bench/questions.json`: five questions of the kinds agents answer by hand, and three script runs, put to the four invented
crashes in `bench/fixture` (fake `coredumpctl` and `journalctl` in `bench/fixture/bin`, selected with the `CRASH_TOOLS_DIR`
setting, which puts a folder before PATH for every program the kit runs).
