# Auto Name

Keeps [kagan](https://kagan.sh) sidebar thread titles short and easy to recall.
It scores candidate word sets from the prompt, changed paths, recent events,
branch, and project — deterministically, with no model call — and names a
thread once, as soon as the evidence is good enough.

Kagan keeps a title after the first rename, so this is a single shot per
thread: a thread that already has a name (yours, or one this plugin wrote) is
left alone.

## Install

```sh
kg plugin install git:https://github.com/kagan-sh/auto-name@main
```

Or from a local checkout:

```sh
kg plugin check .
kg plugin install .
```

Approve **threads** and **database** in the window.

## Use

- Open **Auto Name** from the rail, or run **Update thread names now**
- Settings → Auto Name:
  - **Rename threads automatically**
  - **Wait at least this many seconds between checks**
  - **Max words in a thread name**

Refresh rescans threads that have no name yet; it never overrides a title that
is already set. Refresh works even while automatic renaming is off, because you
asked for it. A prompt of fewer than five words is not enough evidence, so
such a thread keeps its title until a longer prompt or changed files arrive.

## Develop

```sh
kg plugin check .
kg plugin reload dev.kagan.auto-name
node --test   # needs Node 22.5+ for node:sqlite in the tests
npx -p typescript@5 tsc -p jsconfig.json   # needs the generated kagan.d.ts and gpui-kit.d.ts
```

`PORT.md` records how this compares with bb's thread titling.
