Diagnose one crash from systemd-coredump records, the way the diagnose-crash skill does: facts, boring causes, timeline, whole stack, symbols, honest report

1. Facts. `const w = await scripts.run("why", { crash })`. Note the pid, time, signal, program,
   unit, and the command line: it often shows what the program was working on. A repeated or
   related crash is a pattern: `await scripts.run("recent", { since: "14 days ago" })`.
2. Boring causes. `w.oom` lists out-of-memory kills in the five minutes before; `w.kernel` lists
   kernel trap and GPU lines. A process killed by the OOM killer is not a bug in that process.
   SIGKILL leaves no core at all: a program that "crashed" with no record may have been killed from
   outside (check `journalctl` lines in `journalBefore` for oomd or the kernel).
3. Timeline. `w.journalBefore` is the minute before. A line from the program itself (an error, "failed
   to", "assertion") is often the answer. For a signal abort the message before it is the cause.
   Package updates: `await scripts.run("same", { crash })` says whether a package in the stack
   changed in the days before the first occurrence.
4. The whole stack, not only frame 0. `w.stack.frames` starts at the frame that faulted.
   `await scripts.run("backtrace", { crash })` adds the other threads' top frames: thumbnailers,
   image loaders, IPC readers and GPU queues show what was in flight. Third-party code in the stack
   (plugins, extensions, out-of-tree drivers) is worth naming, but do not blame it without evidence
   that it faulted.
5. Symbols. Count `w.stack.unresolved`. If names are missing and the caller wants them, run
   `backtrace` with `symbols: true` once (network, can take minutes). If frames stay unnamed, say so
   and name the package whose `-debug` build would be needed; never invent names. An unnamed stack
   still has shape: which library each frame is in, and whether the crash came from a signal handler,
   a main loop or a worker thread.
6. Classification. `w.where.kind`: program (fault in its own code), library (name it, with package
   and version), libc (bad arguments from the caller), gpu-driver, compositor, unknown. Quote
   `w.where.evidence`.
7. Report: what crashed and what it was doing; the most likely mechanism with proven and inferred
   kept apart; whether user data could be lost (the crash records say nothing about files: say that
   you did not check); whether it will recur (`same`) and what would avoid it.
8. Leave the system as you found it. The scripts unpack a core to a private folder and delete it.
   You never mute notifications, vacuum cores or fix anything.
