# Auto Name

Keeps [kagan](https://kagan.sh) sidebar thread titles short and easy to recall.
It scores candidate word sets from changed paths, recent events, branch, and
project — deterministically, with no model call — and renames only when a
clearer shorter name is available.

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
  - **Do not change names I set myself**
  - Wait interval and max words

Names you set yourself stay put while Respect is on. Refresh rescans
auto-managed threads; it does not override a held manual title.

## Develop

```sh
kg plugin check .
kg plugin reload dev.kagan.auto-name
node name.test.mjs
```
