# jmilkiewicz.github.io

Technical blog (Temporal, TypeScript). Built with Jekyll and deployed by GitHub Pages from `main`.

## Run locally

```sh
bundle install
bundle exec jekyll serve --livereload
# http://localhost:4000
```

## Writing a post

Posts go in `_posts/` as `YYYY-MM-DD-slug.md` (the date comes from the file name). URLs look like `/YYYY/MM/slug/`.
A post dated in the future (Europe/Warsaw time) is skipped until the site is rebuilt on or after that date.

```yaml
---
title: "Durable timers in Temporal"
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

## Social preview image (LinkedIn, X, …)

Every page uses `assets/images/og-default.png` unless a post sets its own `image:`.
To generate a card with the post's title (and series, if any):

```sh
node tools/og-image.ts _posts/YYYY-MM-DD-slug.md   # writes assets/images/og-slug.png
node tools/og-image.ts --default                   # regenerates og-default.png from _config.yml
```

Then add the printed `image:` line to the post's front matter. Needs Node 23.6+ and
`rsvg-convert` (`brew install librsvg`). After publishing, check the card in
[LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/).
