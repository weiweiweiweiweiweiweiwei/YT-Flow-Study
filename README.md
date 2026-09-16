# MyWordLookup

A Chrome extension for learning English vocabulary while watching YouTube videos. Click any word (or select a phrase) in the video's subtitles to see an instant translation, hear its pronunciation, and track your immersion progress over time.

## Features

- **Click-to-translate** — click any word in a YouTube caption to see its translation in a small popup box.
- **Phrase lookup** — select a run of words in the captions to translate the whole phrase.
- **Pronunciation playback** — hear the word spoken aloud via Google Translate's TTS voice.
- **Auto-pause on hover** — the video pauses while your mouse is over the captions, so you have time to read, and resumes automatically when you move away (unless you just looked something up).
- **Sentence navigation** — with the video focused, press `a` / `s` / `d` to jump to the previous / replay the current / jump to the next caption sentence.
- **Adjustable popup size** — set the translation box to 75%, 100%, 150%, or 200% from the extension's toolbar popup.
- **Learning dashboard** (`review.html`) — see how many words you've saved, your daily and total immersion minutes, and a 7-day activity chart.

## Installation

This extension isn't published on the Chrome Web Store yet, so it needs to be loaded manually:

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this project's folder.
5. Open any YouTube video, turn on captions (CC), and click a subtitle word to try it out.

## How it works

- `content.js` runs on YouTube pages: it wraps caption text in per-word spans, handles click/selection lookups, manages the hover-to-pause behavior, and reads keyboard shortcuts for sentence navigation.
- `background.js` is the extension's service worker. It receives lookup requests from the content script and queries Google Translate for text translation and speech audio, caching translation results in `chrome.storage.local` to avoid repeat lookups.
- `popup.html` / `popup.js` is the small settings panel opened from the toolbar icon, used to change the translation box size.
- `review.html` / `review.js` renders the learning dashboard from data stored in `chrome.storage.local`.

## Permissions

Declared in `manifest.json`:

- `storage` — save your popup size preference, cached translations, and immersion stats locally.
- `activeTab`, `tabs` — interact with the current YouTube tab.
- Host access to `youtube.com` and Google Translate's endpoints — to read captions and fetch translations/audio.

No data is sent anywhere other than Google Translate's public API, and no personal browsing data is collected.
