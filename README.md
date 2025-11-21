# Post & Comment Scraper

A cross-browser extension that scrapes the visible social media post and its comments into structured JSON. LinkedIn support ships today (Firefox/Chromium), with other networks on the roadmap.

## Features

- One-click scrape from the toolbar popup
- Works on LinkedIn feed or permalink pages
- Captures author metadata, timestamps, comment text, and a debug HTML snapshot
- Copy-to-clipboard button for quickly exporting JSON
- Manifest V3 compatible with Firefox 109+

## Development

```bash
# install deps if you plan to use web-ext tools
npm install --global web-ext

# lint the extension
web-ext lint

# build a distributable zip
web-ext build -o
```

Mouse-over a post, click the toolbar icon, then "Scrape this page." Watch DevTools console logs (tagged LinkedInScraper vX) for debugging.

## Privacy

All scraping happens locally in your browser; no data leaves the current tab. When publishing to AMO/Chrome Web Store, reference this README and include a short privacy statement reiterating that behavior.

## License

MIT – see [LICENSE](LICENSE).