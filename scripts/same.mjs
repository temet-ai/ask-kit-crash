export const meta = {
  purpose:
    "Has this stack crashed before, and did an update come first? Lists earlier crashes of the same program whose top frames match (and those that only share the faulting module), the package versions at each, and the packages pacman.log shows changed in the days before the first occurrence, with the owners of the modules in the stack listed first. It says plainly when the packages in the stack had not changed in that window.",
  params: {
    crash: "a pid, 'last' (default), or a program name (its newest crash)",
    days: "how many days before the first matching crash to read pacman.log, default 7",
    depth: "how many frames must match, default 5",
  },
  returns: "{crash, signature, occurrences:['time pid N'], versionsAtOccurrences:{package:[versions]}, similar:['time pid N'], first, relevantPackages:[{package, versionNow, versionAtFirst, lastChange}], verdict, changedBeforeFirst:{windowStart, relevant:['time action package from -> to'], others:[same, newest 12], othersCut}}",
  example: 'await scripts.run("same", { crash: "last", days: 7 })',
};

export default async function ({ crash }, { crash: sel = "last", days = 7, depth = 5 } = {}) {
  const a = await crash.analyse(sel);
  const [hist, log] = await Promise.all([crash.history(a), crash.pacmanLog()]);
  const occ = [...hist.same, a.c].sort((x, y) => x.when - y.when);
  const first = occ[0];
  const stackPkgs = new Map();
  for (const f of a.frames.slice(a.faultIndex ?? 0, (a.faultIndex ?? 0) + 14)) {
    const p = a.pkgOfModule(f.module);
    if (p) stackPkgs.set(p.pkg, p.version);
  }
  if (a.exePkg) stackPkgs.set(a.exePkg.pkg, a.exePkg.version);
  const rel = await Promise.all([...stackPkgs].map(async ([pkg, now]) => {
    const ev = log.filter((e) => e.pkg === pkg && e.t <= first.when).at(-1);
    return { package: pkg, versionNow: now, versionAtFirst: await crash.versionAt(pkg, first.when), lastChange: ev ? `${ev.action} ${ev.from ? ev.from + " -> " : ""}${ev.to} at ${crash.fmt(ev.t)}` : "before pacman.log begins" };
  }));
  const start = first.when - days * 86400_000;
  const changes = await crash.upgrades(start, first.when);
  const relNames = new Set(stackPkgs.keys());
  const relevant = changes.filter((e) => relNames.has(e.pkg));
  const others = changes.filter((e) => !relNames.has(e.pkg));
  let verdict;
  if (!log.length) verdict = "pacman.log could not be read, so updates cannot be compared";
  else if (relevant.length) verdict = `yes: ${relevant.map((e) => `${e.pkg} ${e.from ?? ""} -> ${e.to} (${e.when})`).join("; ")} changed in the ${days} days before the first crash of this stack (${crash.fmt(first.when)})`;
  else if (changes.length) verdict = `no package that owns a module in this stack changed in the ${days} days before the first crash of this stack; ${changes.length} other package changes did (they are listed, but nothing ties them to the stack)`;
  else verdict = `no package changed in the ${days} days before the first crash of this stack`;
  if (hist.same.length === 0) verdict = `this stack has not crashed before (checked ${hist.sameExe} crashes of ${a.c.exe}); ` + verdict.replace(/first crash of this stack/, "crash");
  const line = (e) => `${e.when.slice(0, 16)} ${e.action} ${e.pkg} ${e.from ? e.from + " -> " : ""}${e.to}`;
  const ver = async (c) => Object.fromEntries(await Promise.all([...stackPkgs.keys()].slice(0, 4).map(async (p) => [p, await crash.versionAt(p, c.when)])));
  return {
    crash: crash.crashRow(a.c),
    signature: hist.signature,
    programCrashes: hist.sameExe,
    occurrences: occ.slice(-15).map((c) => `${crash.fmt(c.when)} pid ${c.pid}`),
    versionsAtOccurrences: await (async () => {
      const seen = {};
      for (const vs of await Promise.all(occ.map(ver))) for (const [p, v] of Object.entries(vs)) (seen[p] ??= new Set()).add(v ?? "unknown");
      return Object.fromEntries(Object.entries(seen).map(([p, v]) => [p, [...v]]));
    })(),
    occurrencesCut: Math.max(0, occ.length - 15),
    similar: hist.similar.slice(-10).map((c) => `${crash.fmt(c.when)} pid ${c.pid}`),
    first: crash.fmt(first.when),
    relevantPackages: rel,
    verdict,
    changedBeforeFirst: { windowStart: crash.fmt(start), relevant: relevant.map(line), others: others.slice(-12).map(line), othersCut: Math.max(0, others.length - 12) },
  };
}
