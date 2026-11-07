# Getting help with Oxide

Oxide is maintained by two people on a best-effort basis. These are the fastest ways to get an answer.

## Before asking

- Read the [README](README.md), especially [Install](README.md#install), [Opening an unsigned build](README.md#opening-an-unsigned-build) and the [FAQ](README.md#faq).
- Check that your Provider works on its own in a terminal (`claude`, `codex` or `agy`) and is logged in. Many problems come from the Provider CLI, not from Oxide.
- Search [existing issues](https://github.com/getoxide/oxide/issues?q=is%3Aissue), open and closed.
- The terms Oxide uses (Project, Thread, Turn, Provider, Surface…) are defined in [GLOSSARY.md](GLOSSARY.md).

## Where to go

| You want to… | Go to |
| --- | --- |
| Report a bug | [Bug report form](https://github.com/getoxide/oxide/issues/new?template=bug_report.yml) |
| Suggest a feature | [Feature request form](https://github.com/getoxide/oxide/issues/new?template=feature_request.yml) |
| Ask a usage question | A [feature request](https://github.com/getoxide/oxide/issues/new?template=feature_request.yml) describing what you're trying to do |
| Report a security vulnerability | [Private vulnerability reporting](https://github.com/getoxide/oxide/security/advisories/new), never a public issue. See [SECURITY.md](SECURITY.md) |
| Report a problem with a Provider CLI itself | The Provider's vendor: [Claude Code](https://github.com/anthropics/claude-code/issues), [Codex](https://github.com/openai/codex/issues) |
| Contribute code or docs | [CONTRIBUTING.md](CONTRIBUTING.md) |

## A good bug report

Include the Oxide version or commit, your operating system, the Provider and its CLI version, steps to reproduce, and the relevant output of the raw-event debug view with anything private removed.
