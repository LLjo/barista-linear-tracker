# barista-linear-tracker

A [Barista](https://github.com/LLjo/Barista) tracker plugin: a project set to **Linear** files its Barista items
as Linear issues. Epics become **parent issues** and their sub-issues become Linear children. Each item's
branch is the issue's own Linear branch name, so when the branch's PR opens, Linear's GitHub integration links
it to the issue.

It is a separate plugin from [Linear Radar](https://github.com/LLjo/barista-linear-radar), which only reads.
This one writes, so it needs a key with write access.

## Install

In Barista, open **Plugins → Install from repo** and enter `https://github.com/LLjo/barista-linear-tracker`.
It needs a Barista with pluggable trackers (the `contributes.tracker` contract).

## Setup

1. In Linear, open **Settings → Security & access → Personal API keys** and create a key with **write** access.
2. In Barista, open **Settings › Linear**, paste the key and press **Add**. Add one key per Linear workspace.
3. In **Settings › Project**, choose **Linear** as the project's tracker, then pick the workspace and team
   (and, optionally, a label to put on every issue Barista files; it is created in the team if it is missing).

The key stays on the Barista host, in this plugin's own database (owner-only file). It is never shown again,
never logged, never sent to the browser and never part of the board's project settings; only its last 4
characters are shown.

## What maps to what

| Barista | Linear |
|---|---|
| issue | an issue in the project's team |
| epic | a parent issue, titled as the epic |
| sub-issue | a child issue (`parentId`); link and unlink set or clear the parent |
| ref / link | the issue identifier (`ENG-42`) and its URL |
| item branch | the issue's `branchName` (Linear's "Copy git branch name") |
| close (done / not planned) | the team's first *completed* / *canceled* state; an already closed issue is left alone |
| reopen | the team's first *unstarted* state |
| import | `ENG-42`, or a `linear.app/<workspace>/issue/ENG-42/…` link of the project's workspace |

Items keep Barista's own `#N` number for worktrees and lookups and show `ENG-42` wherever a ref is shown.
If a branch with Linear's name already exists (for example you created it from Linear), Barista uses its own
branch name for that item instead.

Each operation costs one or two Linear requests (Linear allows 1500 an hour per key). Team workflow states and
label ids are cached for 10 minutes. Nothing polls Linear: changes there are read only when Barista asks.

Issue titles, descriptions and comments are written by people in your Linear workspace. Barista hands them to
agents as the item's spec, so treat a Linear workspace you share with outsiders accordingly.

## Develop

Clone it into a Barista checkout as `plugins/barista-linear-tracker` (it imports the SDK from `../../shared`).

```bash
bun install && bun test && bunx tsc -p server/tsconfig.json
LINEAR_SCHEMA_CHECK=1 bun test server/queries.test.ts   # checks every query against Linear's live schema, no key needed
cd ui && bun install && bun run build
```

Tests run against an in-memory Linear (`server/fake-linear.ts`) with invented data and keys.

## License

MIT, see `LICENSE`.
