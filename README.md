# ask-kit-crash

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer why a program crashed on a Linux machine, from systemd-coredump. A cheap model reads the
crash records, the journal, pacman and a stored core (through gdb in batch mode) outside your
agent's context, and answers with the pid and time of the crash, the module and package at fault,
and the evidence.

Questions from its bench, of the kinds agents answer by hand with `coredumpctl`, `gdb` and
`journalctl`:

- Which programs crashed between 2026-11-01 and 2026-11-10, how many times each, and with which signal?
- tapestry-viewer keeps crashing. Is it the same stack each time, and when did that stack first appear?
- Why did glass-clock crash on 2026-11-08: which library faulted, which package owns it and at which version?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up), `coredumpctl` and `journalctl`
(systemd-coredump). `gdb` and `pacman` are optional: without gdb, `backtrace` returns the stack the
journal recorded; without pacman, packages and updates are left out.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-crash
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-crash        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-crash --yes  # installs and enables it
```

Restart your agents so `ask` lists `crash`. It works on Linux only.

## What it carries

| | |
|---|---|
| Scripts | `recent` (programs that crashed in a window, by program and signal, with count, first and last time, core state), `why` (one crash: signal, command line, faulting frame and module, owning package and version, where the fault lies, kernel and out-of-memory lines, the journal just before, earlier crashes with the same stack), `same` (earlier crashes with the same top frames, package versions at each, packages changed in pacman.log before the first), `backtrace` (gdb batch backtrace of the crashing thread, a summary of the other threads, the faulting instruction), `report` (the facts of a bug report as text, in the form Omarchy's reporting rules ask for) |
| Skills | `diagnose` (the diagnose-crash method), `report-upstream` (whose bug it is, where it goes, what Omarchy wants), `crash-loop` (a unit that keeps restarting: the crash side, then the unit's side from the ops or systemd kit) |
| Roles | `diagnostician` for why a program crashed or keeps crashing |

Each script also runs with no model: `ask-kit run crash recent since="7 days ago"`, or
`ask(do: "crash.why", params: { crash: "last" })` from an agent.

## What it can change

A question changes nothing. The two calls that change something need `act`: writing a bug report
to a new file (`report` with `write`; an existing file is refused) and running gdb commands of the
caller's own on a stored core.

A core is a copy of a process's memory, so only backtraces, the signal, module and package names, three
registers and two instructions leave the kit. It never returns memory, the process's environment or
strings from a core. The command line is returned with tokens, password options and URL credentials
masked, and the same masking is applied to journal lines and gdb output. `backtrace` unpacks the core
into a private temporary folder (mode 700), runs gdb with `-nx`, auto-load off and a fixed list of
commands, and deletes the folder afterwards. gdb runs without a shell and with a timeout.

With `symbols: true`, `backtrace` lets gdb ask the Arch debuginfod server for debug info: that needs
the network, sends build ids and saves files to `~/.cache/debuginfod_client`. It is off by default.
The kit does not install debug packages, delete or vacuum cores, restart services, mute notifications,
trigger a crash or file anything on GitHub.

## How well it works

`bench/questions.json` holds five questions and three script runs, each with patterns its answer must
hold. They run against `bench/fixture`: four invented crashes served by fake `coredumpctl` and `journalctl`
programs, selected with the `CRASH_TOOLS_DIR` setting (`CRASH_TOOLS_DIR=bench/fixture/bin ask-kit kit test crash`, from the
kit's folder). The package and update questions need a real pacman history and are not in the bench. It has not been run on a
model yet.
