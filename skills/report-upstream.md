Decide whose bug a crash is and prepare the report: Omarchy, the program's upstream, or Arch; nothing is ever filed from here

1. `const r = await scripts.run("report", { crash })`. Read `r.inOmarchySphere`, `r.upstream` and
   `r.searches`.
2. Is it Omarchy's? Omarchy is a configuration layer over Arch. Its sphere is the `omarchy-*`
   commands, the desktop shell and its plugins, the Hyprland and terminal configuration it ships,
   its themes, its install and migration scripts, and how it packages and configures what it
   installs. A crash inside a program it only installs (a file manager, a browser, a GNOME or Qt
   library) is an upstream bug of that project unless Omarchy's packaging or configuration is
   implicated. `r.inOmarchySphere.evidence` lists what in the stack or command line is Omarchy's.
   Running Omarchy's shell config inside a program is not the same as a bug in Omarchy: say which
   one the stack shows.
3. Where it goes, from `r.upstream` (the URL pacman records for the package):
   - official Arch package: the project at that URL; Arch's packaging tracker only for a packaging
     fault (a missing dependency, a wrong build flag).
   - foreign package (AUR or a local build): its AUR page or its own repository.
   - an Omarchy package or file with the three conditions below met: github.com/omacom/omarchy.
   - a question of whether something is a bug at all: the Omarchy Discord (omarchy.org/discord); a
     feature idea: GitHub Discussions under Suggestions.
4. The three conditions for an Omarchy issue, all required: it is a verified bug in Omarchy's sphere,
   on evidence; the user has explicitly agreed to the exact title and body; the machine can file it
   (`gh auth status` succeeds, otherwise the finished text is handed over to submit by hand). You
   cannot check the second and third: report them as open and stop.
5. Search before filing: give the searches in `r.searches` for the caller to run (or `ask` about
   github to run them). Include closed issues: a closed match that still reproduces on a current system
   is a regression, which is worth more than a duplicate. Adding to an existing report is right only
   when the caller has something the thread lacks (a symbolized stack, a narrower trigger, a version
   where it regressed); "it happens to me too" is noise.
6. The text. `r.text` follows the reporting form: what happened, expected, steps (marked "not
   established" when they are), system details, diagnostics. Leave the last line
   ("Filed by <model name> via <agent harness>.") for the caller to complete with the real names.
   The report names only what the records show; do not add a cause you did not see. A report
   written to a file (`write`, needs act) goes to a new file; an existing file is refused.
7. In the answer: the verdict (Omarchy / upstream program / Arch / foreign package) with the evidence,
   the upstream URL, the searches, and the text or the path of the file you wrote. Say that nothing
   was filed.
