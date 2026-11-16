# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/arshamax16/markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/arshamax16/markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02)

A fast, dependency-free Markdown renderer that returns exactly the HTML
[marked 18.1.3](https://github.com/markedjs/marked) renders with its default
options (GFM on, breaks off, pedantic off, async off).

`parse.js` is a single-pass block + inline parser written from the CommonMark
0.31.2 and GFM specs: line-based block parsing (headings, fenced and indented
code, block quotes, lists, tables, HTML blocks, link reference definitions)
feeding a char-scanning inline parser (code spans, emphasis, links, images,
autolinks, extended autolinks, strikethrough, entities, inline HTML).

`main.ts` is the harness driver: it reads `/input/cases.json`, renders every
case with `parse`, and writes `/output/html.json`.

## License

MIT — see [LICENSE](LICENSE).
