# Contributing

Read [AGENTS.md](AGENTS.md) and the [architecture guide](docs/ARCHITECTURE.md) before implementation.

1. Create a focused branch from the current default branch.
2. State the desired behavior and what must remain unchanged.
3. Add a regression test before fixing behavior, or define visual acceptance criteria for presentation changes.
4. Keep content bilingual and use base-aware routes/assets.
5. Run the checks in [TESTING.md](docs/TESTING.md).
6. Open a pull request describing the problem, resulting behavior, validation, and any limitations. Include before/after screenshots for visual changes.

Do not include credentials, generated build output, or unrelated reformatting. Keep original brand downloads intact. Placeholder content must remain clearly understood as demonstration material until maintainers replace it with verified information.

Dependency updates should be scoped, lockfile-backed, and validated with a clean installation. Avoid forced audit upgrades that change major versions without reviewing compatibility.
