# park

A Claude Code mod that adds one slash command: `/park <idea>`.

You are mid-task and an idea shows up. Type `/park` and the idea, and it goes to the end of a
markdown file with the date, the project you were in and what you were doing. No Claude turn is
spent, and it works even while Claude is still working. Claude sees only the confirmation in the
transcript (the idea, up to 120 characters, and the file path); it never reads the file itself.

You never have to hold an idea in your head to keep it.

```
/park a status line that shows the week's hours
```

```
Parked: a status line that shows the week's hours
Logged to /Users/you/.claude/IDEA_PARKING_LOT.md under 2026-10-29.
```

The entry it writes:

```markdown
## 2026-10-29: a status line that shows the week's hours
**What:** a status line that shows the week's hours
**Why it came up:** parked with /park from `my-project` while working on "add the userConfig block to the manifest"
**First action:** (fill in when revived)
```

## Install

At the prompt of a terminal session:

```
/plugin install park --marketplace booksbyveterans-web/claude-park
```

Answer `y` to add the marketplace, pick a scope (user is first), and fill in the settings screen
or press Enter to keep the defaults.

From a shell:

```
claude plugin install park --marketplace booksbyveterans-web/claude-park
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins,
Add marketplace with `booksbyveterans-web/claude-park`, then Add plugin.

Tested on Claude Code 2.1.302 and 2.1.309. The Scope picker uses `userConfig` options, which the plugin manifest reference says need Claude Code 2.1.271 or later.

## Settings

Set at install, and later under `/config` in the `park` rows.

| Setting | Default | What it does |
| --- | --- | --- |
| Parking lot file | `~/.claude/IDEA_PARKING_LOT.md` | The file entries go to. Must end in `.md`, `.markdown` or `.txt` (entries are markdown either way), and be an absolute path or start with `~/` (your home folder). Not `CLAUDE.md`, `CLAUDE.local.md` or `AGENTS.md`, and not under `.claude/rules/`: Claude reads those as instructions. Created on the first `/park` if missing. |
| Scope | `global` | `global` writes to the file above every time. `project` writes to a file with the same name in the folder Claude is working in, so each project keeps its own lot. In project scope, add the file to `.gitignore` or commit it on purpose. |
| Record what you were doing | on | Adds about the first 200 characters of your last typed prompt to each entry. Reset by `/clear`. Pasted text counts, so anything you paste into a prompt can land in the parking lot file. Turn this off if that is a problem for you. Relayed prompts (channels, peers, schedules, notifications) are never recorded. |

## What it does not do

- It never reads the parking lot back to Claude. The file is yours; open it when you want to revive something.
- It never edits or deletes an earlier entry. Each `/park` reads the file and writes it back whole with the new entry at the end, so keep the file somewhere synced or versioned if it matters to you.
- Calls are queued within one session, so two quick `/park`s in the same window never lose one. Two sessions parking into the same file at the same instant can still lose one.
- If the file cannot be read (for example it is over 4 MiB, or it holds a NUL or U+FFFD character and so is binary or not UTF-8), `/park` refuses and writes nothing rather than risk the file.
- It sends nothing anywhere. The only side effect is one local file.

## How it works

One hooks module, `hooks/register.ts`:

- `session.start` registers the `/park` command and reads your home folder.
- `prompt.submit` remembers a trimmed copy of your last typed prompt (when the setting is on).
- `command.run` on `park` resolves the file from the settings, reads it, adds the entry and writes it back.

Run the tests with `claude plugin test .` from the mod's folder. To type-check with `tsc -p .`,
Claude Code must first have written the engine's typings to `.claude-plugin/types/` (gitignored):
it does that when an interactive session loads the mod, so run `claude --plugin-dir .` in a terminal once, then quit. A headless `claude -p` run does not write them.

## License

MIT. Built by Phil Smith for his own ADHD workflow; shared in case it helps yours.
