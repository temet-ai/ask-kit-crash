export const meta = {
  purpose:
    "Which programs crashed in a time window, grouped by program and signal: how many times, the first and last time, whether the core is still stored, and which systemd unit they ran under. Use it for 'what crashed today', 'what keeps crashing' and 'is it a pattern'.",
  params: {
    since: "start of the window, any GNU date phrase or ISO date (default '30 days ago')",
    until: "end of the window, optional",
    exe: "only this program (name or path), optional",
    signal: "only this signal (SIGSEGV, SIGABRT or its number), optional",
    unit: "only crashes under a unit whose name contains this, optional",
    max: "most groups listed, default 10",
  },
  returns: "{window, total, groups:[{exe, signal, count, first, last, cores:'15 present, 1 truncated', units, lastPid, lastCmdline (first 3 groups only)}], cut, byDay, notes}. Times carry the machine's UTC offset.",
  example: 'await scripts.run("recent", { since: "7 days ago" })',
};

export default async function ({ crash }, { since = "30 days ago", until, exe, signal, unit, max = 10 } = {}) {
  const rows = await crash.list({ since, until, exe, signal, unit });
  const groups = new Map();
  for (const c of rows) {
    const k = `${c.exe}\u0000${c.signal}`;
    const g = groups.get(k) ?? { exe: c.exe, signal: c.signal, count: 0, firstMs: c.when, lastMs: c.when, cores: { present: 0, truncated: 0, inaccessible: 0, other: 0 }, units: new Set() };
    g.count++;
    g.firstMs = Math.min(g.firstMs, c.when);
    g.lastMs = Math.max(g.lastMs, c.when);
    g.cores[g.cores[c.core] != null ? c.core : "other"]++;
    if (c.unit) g.units.add(c.unit);
    g.last = c;
    groups.set(k, g);
  }
  const list = [...groups.values()].sort((a, b) => b.lastMs - a.lastMs);
  const byDay = {};
  for (const c of rows) {
    const d = crash.fmt(c.when).slice(0, 10);
    byDay[d] = (byDay[d] ?? 0) + 1;
  }
  const notes = [];
  if (!rows.length) notes.push("no crash in this window; `crash.all()` has every stored crash");
  if (rows.some((c) => c.core === "inaccessible")) notes.push("a core marked inaccessible belongs to another user: its stack is still in the journal, the core itself needs root");
  if (rows.some((c) => c.core === "truncated")) notes.push("a core marked truncated was cut at the size limit: the stack is there, memory is partial");
  return {
    window: { since: since ?? null, until: until ?? null },
    total: rows.length,
    groups: list.slice(0, max).map((g, i) => ({
      exe: g.exe, signal: g.signal, count: g.count, first: crash.fmt(g.firstMs), last: crash.fmt(g.lastMs),
      cores: Object.entries(g.cores).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", "), units: [...g.units].slice(0, 2).join(", ") || null, lastPid: g.last.pid, ...(i < 3 && g.last.cmdline ? { lastCmdline: g.last.cmdline.slice(0, 70) } : {}),
    })),
    cut: Math.max(0, list.length - max),
    byDay,
    notes,
  };
}
