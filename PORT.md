```
Plugin: Auto Name
Source: /Users/aorumbayev/projects/bb
kagan id: dev.kagan.auto-name

Compared against (no single bb plugin owns titling):
- apps/server/src/services/threads/title-generation.ts and
  thread-metadata-inference.ts — how bb derives, generates, clamps and applies
  a thread title
- packages/templates/src/templates/generate-thread-metadata.md — the title
  prompt: word budget, "the problem, not the tools", slash commands, language
- plugins/thread-list — how a title is displayed and renamed, and when the
  person's own name wins
- builtin-plugins/bb-ai and its bb-cloud-ai skill — the model service, its
  on/off setting, and the fallback when no service is ready

Verdict per behaviour:
- Title width, clamped at a word boundary ............ same (36 chars vs bb 48)
- Word budget (bb has none, it is prose) ............. differs (2-4 words)
- Evidence: the first prompt ......................... same
- Evidence: invoked slash commands ................... same
- Evidence: "the problem, not the tools" ............. same (stop list)
- Evidence: changed paths, events, branch, project ... differs (bb: prompt only)
- One name per thread, never recomputed .............. same (Kagan locks it)
- A title the person set is never overwritten ........ same (Kagan locks it)
- A prompt of 5+ words is the bar for naming ......... same
- A shorter prompt keeps the current title ........... same
- Name only when the title is still a placeholder .... same (bb: title empty)
- Failed or thin generation keeps the title .......... same
- Title shown before a name exists ................... differs (bb: prompt text,
  kagan: the program name; the plugin cannot set a fallback without locking)
- Stability: a name never flickers ................... same (one shot)
- Debounce between name changes ...................... differs (bb: none)
- Rescan command ..................................... differs (bb: none)
- Sidebar inline rename and tooltip .................. missing (host-owned)
- Branch name follows the title ...................... missing (created first)
- Same language as the prompt ........................ missing (no model)
- Sentence case ...................................... differs (lowercase)

Close (what differs):
- Deterministic scoring instead of a model call. The model prompt asks for
  "short, clear, sentence case, under about 40 characters"; this plugin scores
  word sets from tokens, so the budget is 36 characters, 2-4 words, lowercase.
- Evidence is richer: bb titles from the prompt alone, this also reads changed
  paths, events, answered questions, branch, and project name.
- Timing: bb names at provisioning, before the first turn runs. This waits for
  a turn to end or the next sweep, so the evidence is real rather than
  half-typed.
- bb has no rescan; a title is generated once when the thread is created. This
  is event-driven and can miss a busy thread, so it has Update thread names now
  (command, panel button) and a check interval.
- bb shows the full title in a tooltip and renames inline on double-click;
  kagan's sidebar belongs to the host, so this plugin has neither.

Gaps (workaround, or cannot move):
- Repeated renaming cannot move. threads.rename is rename_once: it stores the
  title and locks it, and later calls fail with "the title is kept; rename it
  in the window". Every thread is therefore named once, and the plugin records
  settled so it does not ask again. respectManual was removed: a manual title
  is locked, so the setting could never change an outcome.
- Branch names cannot follow the title. bb builds bb/<slug>-<threadId> from the
  generated title; kagan creates the worktree branch at spawn, before any
  evidence exists. The plugin names the thread afterwards and leaves the branch.
- Language detection cannot move: bb keeps the prompt's language. A
  deterministic scorer has no language model, so names are English tokens.
- Sentence case cannot move without a model; word sets are lowercase.
- Inline rename and the sidebar affordance are host-owned (see above).
- No model means no cost, no spend limit, no service fallback: the bb-ai
  "task off / no service ready / daily limit" paths have no analogue.

Powers asked:
- areas: threads, database

Right panel: no (left tool panel)
Theme: no theme
kg plugin check: passed
Manifest version: 0.4.0 (names table schema 0.4)
Tried: node --test (45 tests across text, name, policy, signal, store, main)
```
