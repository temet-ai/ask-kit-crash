A unit that keeps restarting: give the crash side, and point to the ops or systemd kit for the unit

1. The crash side: `await scripts.run("recent", { since: "1 day ago", unit: "<part of the unit name>" })`.
   `count` and `first`/`last` give the loop's rhythm; `cores` says whether stacks are stored.
   Without the unit name, group by program: `await scripts.run("recent", { since: "1 day ago", exe })`.
2. Is it one stack or several? `await scripts.run("same", { crash: "last" })`: the same stack every
   time points at one bug; different stacks, or SIGKILL with no core, point at the environment
   (out of memory, a dependency that is gone, a watchdog).
3. A restart without a crash record is not a crash: the program exited with an error code, or was
   stopped by systemd. That is the unit's side. `ask` about ops or systemd answers it (exit status,
   `Restart=` policy, start limit, the unit's own logs); say so in the answer and give the unit
   name and the times from step 1.
4. Under a crash loop the same crash fills the journal and the core directory: say how many cores
   are stored and how large they are (`size` in `recent`'s rows). Do not delete or vacuum them; that
   is not done here.
5. Answer with: the program, signal, count in the window, first and last time, whether the stack is
   identical, the module at fault, and what the ops side needs to look at.
