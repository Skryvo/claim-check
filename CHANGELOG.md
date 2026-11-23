# Changelog

## 0.1.0

- First release. Finds the factual claims in a text (statistics, dates, named facts, quotes, superlatives),
  looks for a source for each, and gives every claim a verdict: supported, contradicted, no source found or not
  checkable, with why. Supported and contradicted always carry the source address and a passage quoted word for
  word from a page that was fetched.
- Sources: the addresses the text cites (inline, reference and footnote links, bare addresses, HTML anchors),
  then, when one is set, a Brave, Serper or Tavily web search.
- Any model behind a chat completions endpoint; no default model.
- Command line: files, globs, stdin or a public page; readable, JSON or SARIF output; `--fail-on` and exit codes
  for CI.
- MCP server over stdio with `check_text`, `check_url` and `check_claim`.
- GitHub Action: checks the Markdown a pull request changes, annotates contradicted and unsourced claims on their
  lines, and writes a job summary.
- Pages are fetched from public addresses only (checked at connect time and after every redirect), up to 5 MB and
  15 seconds each.
