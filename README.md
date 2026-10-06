# jmilkiewicz.github.io

Technical blog (Temporal, TypeScript). Built with Jekyll and deployed by GitHub Pages from `main`.

## Run locally

```sh
bundle install
bundle exec jekyll serve --livereload
# http://localhost:4000
```

## Writing a post

Posts go in `_posts/` as `YYYY-MM-DD-slug.md`. URLs look like `/YYYY/MM/slug/`.

```yaml
---
title: "Durable timers in Temporal"
date: 2026-10-06
tags: [temporal, typescript]
description: "One-sentence summary used for SEO and the feed."
# Optional: series
series: "Temporal in practice"
series_part: 1
---
```

- Code: fenced blocks with a language, e.g. ```` ```ts ````
- Tables: GitHub-flavoured Markdown tables
- Tags are listed at `/tags/`, series at `/series/`; posts in a series show a table of contents
