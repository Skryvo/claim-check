# claim-check

Finds the factual claims in a piece of text, looks for a source for each, and tells you which are supported,
contradicted or unsourced, quoting the passage it relied on.

It runs on your own model and keys: a command line, an MCP server for agents, and a GitHub Action that annotates
pull requests. Apache-2.0.

## 30 seconds

You need Node.js 20 or later and a model behind any chat completions endpoint. There is no default model.

```bash
export CLAIM_CHECK_BASE_URL=https://openrouter.ai/api/v1
export CLAIM_CHECK_MODEL=deepseek/deepseek-v4.1-flash-1017
export CLAIM_CHECK_API_KEY=...                       # your key for that endpoint
export CLAIM_CHECK_MODEL_OPTIONS='{"reasoning":{"enabled":false}}'

curl -O https://raw.githubusercontent.com/Skryvo/claim-check/main/examples/sample.md
npx @skryvo/claim-check sample.md
```

[`examples/sample.md`](examples/sample.md) has five claims, one with a wrong year, citing public-domain United States
government pages. This is the real output (23 November 2026):

```text
sample.md  5 claims: 2 supported, 1 contradicted, 1 no source found, 1 not checkable
  supported       line 3  The ocean covers about 71 percent of the Earth (NOAA)
                  https://oceanservice.noaa.gov/facts/howmanyoceans.html
                  "covers 71 percent of the Earth"
                  The NOAA page states the global ocean covers 71 percent of the Earth.

  contradicted    line 5  The Statue of Liberty was dedicated in 1896 (National Park Service)
                  https://www.nps.gov/stli/index.htm
                  "It was dedicated by President Grover Cleveland on October 28, 1886."
                  The National Park Service page states the statue was dedicated in 1886, not 1896.

  supported       line 7  The Pacific is the largest ocean on Earth
                  https://oceanservice.noaa.gov/facts/pacific.html
                  "the Pacific is by far the largest of the world's ocean basins"
                  The source states the Pacific is by far the largest of the world's ocean basins, which matches the claim that it is the largest ocean on Earth.

  no source found line 9  About 70% of travellers say a famous landmark is the main reason they choose a city
                  The text cites no address for it, and no web search is set.

  not checkable   line 11  New York is the most beautiful city to visit in spring
                  opinion

Model deepseek/deepseek-v4.1-flash-1017 (4 model calls, 2,849 tokens, $0.0006 as reported by the endpoint). Sources: addresses the text cites.
```

It exited with code 1, because a claim was contradicted.

## Three ways to run it

### Command line

```bash
npx @skryvo/claim-check article.md                 # one file
npx @skryvo/claim-check "docs/**/*.md"             # a glob (quote it)
npx @skryvo/claim-check https://example.com/post   # a public page; its links are its citations
cat draft.md | npx @skryvo/claim-check             # stdin (or "-")
npx @skryvo/claim-check article.md --json          # every field, for scripts
npx @skryvo/claim-check "docs/**/*.md" --sarif > claims.sarif   # for code scanning
npx @skryvo/claim-check article.md --search brave  # also search the web for claims the text does not source
```

| Exit code | Meaning |
|---|---|
| 0 | Checked; no claim met `--fail-on` |
| 1 | At least one claim met `--fail-on`: `contradicted` (default), `unsourced` (contradicted or no source found), or `never` |
| 2 | Usage or configuration error, such as no model set |
| 3 | The check could not finish: the model, the search or an input failed |

`claim-check --help` lists every option; `--max-claims` (default 20 per input) caps the work.

### MCP server

`claim-check mcp` serves three tools over stdio:

| Tool | Takes | Does |
|---|---|---|
| `check_text` | `text`, optional `max_claims` | Finds and checks the claims in Markdown or plain text |
| `check_url` | `url`, optional `max_claims` | Fetches a public page and checks its claims against the pages it links to |
| `check_claim` | `claim`, optional `sources` | Checks one claim against the addresses given |

Each answers with the readable report and the same report as structured content. Add it to a client:

```json
{
  "mcpServers": {
    "claim-check": {
      "command": "npx",
      "args": ["-y", "@skryvo/claim-check", "mcp"],
      "env": {
        "CLAIM_CHECK_BASE_URL": "https://openrouter.ai/api/v1",
        "CLAIM_CHECK_MODEL": "deepseek/deepseek-v4.1-flash-1017",
        "CLAIM_CHECK_API_KEY": "...",
        "CLAIM_CHECK_MODEL_OPTIONS": "{\"reasoning\":{\"enabled\":false}}"
      }
    }
  }
}
```

### GitHub Action

```yaml
name: claims
on: pull_request
permissions:
  contents: read
  pull-requests: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Skryvo/claim-check@v0
        with:
          base-url: https://openrouter.ai/api/v1
          model: deepseek/deepseek-v4.1-flash-1017
          api-key: ${{ secrets.MODEL_API_KEY }}
          model-options: '{"reasoning":{"enabled":false}}'
          files: "docs/**/*.md"
          fail-on: contradicted
```

On a pull request it reads the changed files from the GitHub API and checks only the claims on added or edited
lines (`lines: all` checks whole files). A contradicted claim becomes an error annotation on its line and an
unsourced one a warning; the job summary lists every claim with its verdict. On other events it checks every
file the `files` globs match. Outputs: `checked`, `contradicted`, `unsourced` and `report` (the JSON file).
Pull requests from forks get no secrets, so the step stops with "No model is set" there.

## Configuration

Flags win over environment variables. The GitHub Action takes the same settings as inputs.

| Flag | Variable | |
|---|---|---|
| `--base-url` | `CLAIM_CHECK_BASE_URL` | A chat completions endpoint. Required. |
| `--model` | `CLAIM_CHECK_MODEL` | The model id there. Required. |
| `--api-key` | `CLAIM_CHECK_API_KEY` | Its key, if it needs one. Prefer the variable: flags show in process lists. |
| `--model-options` | `CLAIM_CHECK_MODEL_OPTIONS` | Extra request fields as JSON, merged into every call. |
| `--search` | `CLAIM_CHECK_SEARCH` | `cited` (default), `brave`, `serper` or `tavily`. |
| `--search-key` | `BRAVE_SEARCH_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY` | The key for the search you chose. |

A model on your own machine works the same way, for example an Ollama server:

```bash
export CLAIM_CHECK_BASE_URL=http://localhost:11434/v1
export CLAIM_CHECK_MODEL=<a model you pulled>
```

Every call uses temperature 0. The tool asks for JSON in plain words rather than through a JSON mode, so
endpoints without one work; a small local model that cannot follow the instructions will fail loudly, not
quietly.

## How a verdict is reached

1. **Find the claims.** The model reads the text (Markdown is turned into prose first, with code, front matter
   and link addresses taken out) and lists each statistic, date, named fact, quote and superlative, word for word,
   with a version that stands alone. It marks opinion, advice, predictions, private figures and vague wording as
   not checkable. Each claim is then found in the text by code, which gives its line; one the text does not
   contain is dropped.
2. **Find the sources.** The addresses cited in the claim's sentence come first, then the rest of its paragraph.
   With a search set, the standalone claim is searched and the first new results are added. Up to three cited
   and three searched pages are fetched.
3. **Pick the passages.** Each page is cut into paragraphs, and the ones sharing the most words and figures with
   the claim are kept, along with the page's first paragraph: up to ten passages in all.
4. **Judge.** The model is told to judge from the passages alone and to quote the words it relied on.
5. **Check the quote.** Code looks for that quote in the passage, word for word (case, quote marks and spacing
   aside). If it is not there, the claim is reported as **no source found**, whatever the model said. So a
   **supported** or **contradicted** verdict always comes with a page address and words that are on that page,
   never with the model's own belief.

| Verdict | Means |
|---|---|
| `supported` | A fetched page states it; the quote shows where |
| `contradicted` | A fetched page states something that cannot be true with it; the quote shows what |
| `no_source_found` | No page read settles it, no page could be read, or the text cites none and no search is set |
| `not_checkable` | Opinion, advice, prediction, private or too vague for any source to settle |

## Limits

- **Pages it cannot read.** Paywalls, sign-ins, pages that need JavaScript to show their text, PDFs and other
  non-text files give "no source found", with the reason in `why`. A page is read up to 5 MB and 15 seconds.
- **Claims with no public source.** A true claim that no public page states stays "no source found".
- **The model can be wrong.** It can miss a claim, mark one not checkable that is, or judge a passage wrongly.
  The quote check stops it from inventing a source; it does not stop a misreading of a real one. Read the quote.
- **Passages, not whole pages.** The model sees the passages most like the claim, so a fact stated far from the
  claim's words can be missed.
- **One source is enough.** When pages disagree, the verdict follows the passage the model chose; `consulted`
  lists every page that was read.
- **No accuracy figure is claimed.** [`samples/labelled.json`](samples/labelled.json) holds 30 claims with the
  verdict a careful reader reaches from the pages given. `npm run eval` runs them on your model and prints the
  table; your results depend on your model.

## Privacy

The text you check is sent to the model endpoint you configure, and each claim to the search provider if you set
one; their terms apply. Cited and found pages are fetched from your machine with the User-Agent
`claim-check/<version> (+https://github.com/Skryvo/claim-check)`. The tool keeps nothing and sends nothing
anywhere else.

Fetches go to public internet addresses only: loopback, private, link-local, shared and reserved ranges are
refused, checked when the connection is made and again on every redirect, so a page cannot point the tool at your
network. The model endpoint is the one exception, since you choose it and it may run on your machine.

## As a library

```js
import { createChecker, modelFrom, searchFrom } from "@skryvo/claim-check";

const checker = createChecker({ model: modelFrom({}), search: searchFrom({}) }); // reads the variables above
const report = await checker.checkText(markdown, { input: "post.md" });
const one = await checker.checkClaim("The Statue of Liberty was dedicated in 1886.", ["https://www.nps.gov/stli/index.htm"]);
```

## Contributing

```bash
npm ci
npm test              # builds, then runs every test offline
npm run typecheck
npm run build:action  # rebuilds action/index.js; commit it with the source change
npm run eval          # the labelled set, on the model in your environment
```

The tests make no network calls: model replies, pages and search answers are recorded fixtures or local
servers. Report bugs and ideas at https://github.com/Skryvo/claim-check/issues. Questions: support@skryvo.ai.

## Made by Skryvo

[Skryvo](https://skryvo.ai) is a hosted AI writing platform whose articles are fact-checked inside the writing
pipeline, where every cited sentence is checked against its source. claim-check is the
open, standalone checker, built on the same rule that a verdict needs a quoted source. Between 5 September and
4 November 2026 Skryvo's check ran on 452 articles from 7 accounts, most of them Skryvo's own and test accounts;
they hold 6,683 checked claims, and 99.5% of them link to the page that backs them. How it works:
https://skryvo.ai/fact-checking/

Apache-2.0 © Flutter Studio LLC. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
