# Review configuration

## Quality gate

None: this repository holds a README and two images. Before calling a change done, check that every path in `README.md`
resolves and that nothing private (repositories, work, clients, personal data) is named.

## Excluded items

<!-- toolkit-begin -->
- [quality][performance][tests][docs] Vendored toolkit: every path listed in `.claude/toolkit/MANIFEST.json` (skills, `.claude/agents/`, `.claude/tools/`, `.claude/toolkit/`, `.claude/rules/dev-core-rules.md`) is a generated copy from Development-Base. Do not review it as project code; a local edit there is drift to report, not a finding.
<!-- toolkit-end -->

- The banner shows every vdWolde app icon: that is the guide's own banner and is accepted.
