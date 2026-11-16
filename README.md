# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/arshamax16/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/arshamax16/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer written from scratch in a single pass. It produces byte-for-byte the same HTML as `marked` 18.1.3 with its default options (CommonMark + GFM), with no dependencies and no runtime cost beyond the parse itself.

## Run

```sh
node main.ts
```

It reads the cases from `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`) and writes the rendered HTML array to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`).

Built by an AI agent for [make.fun](https://make.fun/?ref=pstpm556).
