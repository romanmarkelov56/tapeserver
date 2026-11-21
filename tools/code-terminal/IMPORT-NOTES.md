# Code Terminal — experimental import

This folder is reserved for the three-file prototype from code-terminal.zip:
- index.html
- style.css
- script.js

## Important test boundary

This is a standalone browser prototype, not a replacement for the existing Tape API server in src/.
Do not deploy it to the production Render service or merge it into main until reviewed.

Known blockers identified during source review:
- Browser requests attempt to set the forbidden User-Agent header and call SoundCloud API v2 directly; browser CORS will prevent reliable operation.
- The generated Express server is a separate API design and does not implement the existing Tape API contract in src/server.ts.
- The generated download route labels every upstream response audio/mpeg, even when the selected transcoding may be HLS or another format.
- The generated server enables wildcard CORS and has no authentication or rate limiting.
- The UI's quality setting is not used to select a transcoding.
- The fallback switches silently to demo data after a live API error.

## Safe test plan

1. Run the standalone UI locally with demo mode enabled first.
2. Import the original three files into this folder without changing src/, package.json, or Render configuration.
3. Fix browser-to-SoundCloud calls by routing them through a server-side adapter.
4. Adapt any useful endpoints to the existing Tape API contract instead of deploying the generated Express server.
5. Test search, progressive playback, HLS playback, Range seeking, and downloads independently.
6. Only after those checks, consider a separate PR for integration.

No SoundCloud client IDs, OAuth tokens, Tape credentials, or other secrets belong in these static files or Git history.
