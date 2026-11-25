# Changelog

## Unreleased
- **`tools/enrich.mjs`** (optional, runs on your computer, not part of the userscript):
  adds channel, category, tags, topics and length to a backup using the YouTube Data API.
  Answers are cached, so running it again only looks up new videos.

## 1.2.0
- **Backup & restore** (buttons at the bottom of the panel):
  - **Backup** downloads a `.json` file with your queue, history and saved queues.
  - **CSV** downloads a list you can open in Excel, Numbers or Google Sheets.
  - **Import** reads a backup and asks: **Merge** (add only what you don't have yet)
    or **Replace all** (make everything match the backup; needs a second click).
    Saved queues with the same name but different videos are kept as "Name (imported)".

## 1.1.0
- **Export to a YouTube playlist** from the Saved tab: creates a real playlist on your
  signed-in account (Private by default), adds the videos one at a time with progress,
  skips unavailable ones, and can pause and resume, even after a page reload.

## 1.0.0
- First public release.
