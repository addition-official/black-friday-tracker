# black friday tracker

A Black Friday shopping list: categories, items with want / ordered / arrived status,
countdown to Thanksgiving, Black Friday and Cyber Monday, and live package tracking.

Hosted on Netlify. Pushing to `main` deploys automatically.

## Files

- `index.html` - the whole app
- `netlify/functions/bin.mjs` - `/api/bin`, saves and loads the list from jsonbin.io (keeps the key off the page)
- `netlify/functions/track.mjs` - `/api/track`, live tracking through Ship24 (optional)
- `netlify.toml` - Netlify settings

## Environment variables (Netlify > Project configuration > Environment variables)

| name | needed | what |
|---|---|---|
| `JSONBIN_BIN_ID` | yes | the jsonbin bin id |
| `JSONBIN_MASTER_KEY` or `JSONBIN_ACCESS_KEY` | yes | jsonbin key |
| `TRACKER_PASSCODE` | optional | passcode the page asks for |
| `SHIP24_API_KEY` | optional | turns on live tracking |

Changing a variable only takes effect on the next deploy.
