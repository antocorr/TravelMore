<div align="center">

# TravelMore

### Fewer tabs. More room for the journey.

Itineraries, maps, places, checklists and flights in one local workspace—with an AI assistant that works on your plans.

[Get started](#get-started) · [Features](#what-you-can-do) · [Screenshots](#inside-the-app) · [Architecture](#under-the-hood) · [Configuration](#configuration)

</div>

![TravelMore showing a Japan itinerary, interactive map, Kyoto photo and AI assistant](screenshots/japan-itinerary.png)

<p align="center"><em>Tokyo → Kyoto → Osaka. A real trip in the app, completed by the TravelMore agent with DeepSeek V4.1 Flash: three stops, six places and four checklist items.</em></p>

---

## Plan the trip, not the copy-and-paste

Turn a conversation into an itinerary you can edit: cities, places on a map, photos, dates and things
to do. The assistant does more than suggest a list in chat. It uses server-side tools to update the
same records you can manage by hand.

The **dashboard is your trip library**. The **workspace is your planning desk**: itinerary on the
left, map and details in the middle, assistant on the right. Resize the panels to suit your work.
Notes, checklists, photos and flights stay attached to the trip or place they belong to.

**Your data lives on your server. You choose the AI provider.** No TravelMore account required.
Maps, search and AI still use external services: see [privacy and limitations](#privacy-security-and-limitations).

## What you can do

| | Features |
|---|---|
| **Organize trips** | A searchable library with cover photos, dates, counts and filters. A trip → stops → places tree with expandable sections and node moves. |
| **Plan on the map** | OpenStreetMap and Leaflet, city/address/landmark search, manual pins and reverse geocoding. Linked selection across the itinerary, map and details. |
| **Keep the context** | Descriptions, notes, dates and checklists on each node. Photos from URLs, primary images, galleries and server support for local uploads. |
| **Fill in missing details** | Coordinates and addresses from Nominatim; descriptions and photos from Wikipedia. Enrichment fills empty fields without overwriting your work. |
| **Work with AI** | Tool-based itinerary creation and editing, sourced web research, place enrichment, checklists and bounded JavaScript calculations. Progress updates and a stop button. |
| **Choose your model** | The models.dev catalog, reusable connections, custom endpoints, quick model selection, token budgets and reasoning levels. Shared settings or per-trip overrides. |
| **Sign in with ChatGPT** | Pi's Codex OAuth flow as an alternative to an API key, with credentials and refresh handled server-side. |
| **Compare flights** | Separate outbound/return watches, Google Flights or Skyscanner, multiple airports and dates, adults and children, route matrices, cheapest badges, single-cell refresh and price history. |
| **Use another device** | LAN or Tailscale access through the API/WebSocket proxy and origin checks. Trusted networks only: there is no authentication. |
| **Consult a developer** | Optional intercom between the agent and a local Pi session. Off by default and available only in development from localhost. |

## Inside the app

### One library, one workspace

The dashboard gives you the overview. Open a trip to work with its structure, map and assistant in
one place. Each stop has a reading view and an editor with **Save changes / Cancel**.

![Trip library filtered to the Japan demo, with a cover photo, dates and counts](screenshots/japan-library.png)

### Places you can open, not just read about

Pins show a photo, address and description. Clicking opens the popup without forcing a zoom;
**⌖** explicitly centers and zooms, while **⤢** opens the detail view. An off-screen pin can be
panned into view without changing the zoom. **Fit itinerary** frames the whole plan.

![Fushimi Inari-taisha popup with a sourced photo and description on the Kyoto map](screenshots/japan-place.png)

### From ideas to things to do

Checklists are itinerary records, not text lost in a conversation. Attach them to a trip, stop or
place, then add, check off or edit items from the interface.

![Japan trip checklist created and saved by the TravelMore agent](screenshots/japan-checklist.png)

These are screenshots of the running app, not mockups or generated images. The demo was planned
through TravelMore's chat; the library is filtered to keep other trips out of view. No bookings or
flight prices were fabricated. [Photo credits and licenses →](#screenshot-credits)

## Get started

**Requirements:** Node.js **22.19+**, npm and Git. Chrome is needed only for flight scans.

```bash
npm install
npm run dev
```

Open the URL printed as `[dev] client ready on …`. Ports are assigned automatically, and the launcher
connects Vite to the backend. Press Ctrl+C to stop both.

1. Create a trip with **＋ New trip**.
2. Open **⚙** in the assistant and save your provider connection.
3. Choose a tool-capable model, or use **Sign in with ChatGPT**.
4. Ask the assistant to build your plan, or add stops and places manually.
5. Review sources and content, then refine the itinerary through the map and detail views.

To experiment without using your own archive:

```bash
TRAVELMORE_DATA_DIR=/tmp/travelmore-demo npm run dev
```

The default data directory is `~/.travelmore/`. Records, credentials, media and caches stay outside the
repository. Do not run multiple backends against the same directory. [Configuration options →](#configuration)

### A prompt to start with

> Plan a trip to Japan from May 10 to 23, 2027, for two adults.
> Create Tokyo, Kyoto and Osaka as stops, with two places in each city. Save dates,
> real map pins, sourced photos, short descriptions and a pre-departure checklist.
> Do not book anything. Leave details blank if you cannot verify them.

A trip name is a theme, not a location to geocode. Coordinates belong to stops and places.
When a source is unavailable, a missing field is better than an invented fact.

## One assistant, two contexts

- **On the dashboard:** the assistant works across the library with a bounded trip digest. It can
  compare plans and create new ones.
- **Inside a trip:** it works within the current trip's scope, using dedicated tools.
- **You stay in control:** destructive agent tools are disabled. Delete records through the interface;
  the assistant has no shell or unrestricted filesystem access.

The agent uses **Pi SDK** with an explicit set of TravelMore tools. Your personal Pi extensions are
not automatically loaded into the app. `web_search` uses Exa MCP or a configured SearxNG endpoint;
`web_read` reads HTTPS pages rather than driving an interactive browser.

Providers are interchangeable through OpenAI Completions/Responses, Anthropic Messages, Google
Generative AI and Codex Responses protocols. Models and capabilities depend on the connection you
choose. DeepSeek V4.1 Flash powers this demo; it is not a project requirement.

Connections can be shared across trips, with a per-trip model override. Keys stay server-side;
the client receives only their presence (`hasKey`). ChatGPT sign-in uses a local OAuth callback on
port **1455**, which must be free. The server stores and refreshes its credentials.

## Flights: observations, not promises

In the **Flights** tab, a scan covers every combination:

```text
origins × destinations × dates
```

Each column is a route and each cell is a date. **cheapest** marks the route's lowest observed fare;
**cheapest overall** marks the lowest across that direction. **↻** refreshes just one cell.
An animated border identifies the active search. Click a price to inspect its history and changes.

| Google Flights | Skyscanner |
|---|---|
| Verifies passengers and the Cheapest selection | Verifies travelers and includes children's ages |
| Waits for the loader to finish, then requires four identical samples | Waits for the single-date price to settle |
| Records the settled value, not a transient minimum | Converts the per-person price into a party total |

Both adapters use a **dedicated Chrome profile**, never a copy of your personal profile. If a site
requires a human check or does not provide a usable price, the run reports it rather than inventing a result.

> The monitor is experimental and started manually from the UI. It is not a commercial pricing API,
> does not book flights, and cannot guarantee availability or the final checkout price. Its adapters
> depend on the providers' rendered pages.

<details>
<summary>Flight monitor limits, history and command-line use</summary>

A watch supports up to 8 origins, 8 destinations, 120 days and **400 cells**, with up to 9 travelers.
Runs are manual, with one active scan per trip. The default pause is 10 seconds plus adapter jitter.
Repeated observations update the latest offer; a history point is appended when the price changes.
Changing a date window preserves existing observations, but a full run searches every cell again.

The monitor uses `<data-dir>/browser-profile`. A provider challenge stops the run for human review;
it is not bypassed. Do not share a Chrome profile between concurrent scanner processes.

The CLI uses the same store. Stop the backend first or use an isolated copy. Even `--dry-run` saves
the watch; it avoids network searches, not every write.

```bash
TRAVELMORE_DATA_DIR=/tmp/travelmore-demo \
npm --workspace server run scan:flights -- \
  --trip TRIP-ID --from FCO,MXP --to NRT,HND \
  --dates 2027-05-08..2027-05-10 --pause 10000 --dry-run
```

The separate **Manual fare record** flow stores observed candidates with their source and provenance.
A `searchFlights` receipt provides provider links, not live quotes. Browser scanning and manual
search receipts are distinct flows.

</details>

## Under the hood

```text
Browser · TinyBubble + Leaflet
    ↕ WebSocket / RpcAble
Node.js + Express + UserSession
    ├── TravelService → atomic JSON + local media
    ├── TravelAgent → Pi SDK → your chosen AI provider
    ├── Sources → Nominatim, Wikipedia, Exa / SearxNG
    └── FlightMonitor → Chrome / CDP → Google Flights, Skyscanner
```

| Choice | Purpose |
|---|---|
| **TinyBubble + hand-written CSS** | Lightweight components, a custom interface and resizable panels |
| **TypeScript + RpcAble** | Explicit remote methods, push updates and a documented contract |
| **Serialized JSON store** | No database service to install; atomic writes within one process |
| **Providers separate from trip data** | Server-side secrets; credentials and catalogs stay out of travel records |
| **Source provenance** | URLs and observation times distinguish retrieved data, missing fields and suggestions |
| **Functional fullfill checks** | Verification through RPC, Pi sessions and real integration boundaries—not just internal functions |

## Configuration

Set server variables before starting the launcher. By default, private state lives in `~/.travelmore/`:
`travelmore.json`, `providers.json`, catalog cache, uploaded media and the dedicated browser profile.
Trip records are not stored in the browser; only panel-layout preferences use `localStorage`.
For a consistent backup, stop the server and copy the complete data directory. Never publish it.

<details>
<summary>Environment variable reference</summary>

| Variable | Purpose |
|---|---|
| `TRAVELMORE_DATA_DIR` | Private data directory; defaults to `~/.travelmore` |
| `PORT` | Backend port; assigned automatically when omitted |
| `HOST` | Backend bind address; defaults to `127.0.0.1` |
| `TRAVELMORE_ALLOW_LAN=1` | Required for a non-loopback backend bind |
| `TRAVELMORE_ALLOWED_ORIGINS` | Comma-separated exact origins, replacing the default origin policy |
| `TRAVELMORE_SERVER_URL` | Client proxy target when starting frontend and backend separately |
| `TRAVELMORE_GEOCODER_URL` | Compatible public HTTPS Nominatim endpoint, or `off` |
| `TRAVELMORE_GEOCODER_CONTACT` | Contact added to the identifying User-Agent; recommended |
| `TRAVELMORE_PLACE_INFO_URL` | Wikipedia origin; defaults to `https://en.wikipedia.org`, or `off` |
| `TRAVELMORE_SEARCH_URL` | Public HTTPS SearxNG JSON endpoint; otherwise uses Exa MCP |
| `TRAVELMORE_SEARCH_PROVIDER=off` | Disables web search |
| `TRAVELMORE_CHROME_PATH` | Chrome executable when not found in standard locations |
| `TRAVELMORE_CHROME_DEBUG_URL` | Explicit opt-in to an existing debug browser; use loopback only |
| `TRAVELMORE_FLIGHTS_DEBUG=1` | Logs flight-reader samples |
| `TRAVELMORE_SKYSCANNER_PROFILE` | Direct adapter fallback; the monitor's explicit profile takes precedence |
| `TRAVELMORE_AGENT_EXECUTE_JS=1` | Enables the optional sandboxed `execute_js` tool for the agent (off by default) |
| `TRAVELMORE_DEV_INTERCOM=1` | Enables the optional development-only intercom capability |
| `TRAVELMORE_INTERCOM_TARGET` | Full fixed recipient Pi session ID |
| `TRAVELMORE_INTERCOM_CLI` | Absolute path to the official pi-intercom CLI |

A custom geocoder must speak Nominatim's format. The web reader accepts public HTTPS only, with
DNS/address checks, bounded responses and redirect validation. A configured SearxNG failure does
not silently fall back to Exa. Headless is an internal scanner option, not a UI setting.

</details>

### LAN and Tailscale

The launcher prints local, LAN and available tailnet URLs. Vite serves the interface on network
interfaces and proxies API/WebSocket requests to the loopback backend. An existing Tailscale setup
is required for tailnet access; TravelMore does not install it.

The default origin policy allows HTTP loopback/private origins, local IPv6, `.local` and `*.ts.net`
names, and Tailscale's `100.64.0.0/10` range. Public origins are rejected. Use
`TRAVELMORE_ALLOWED_ORIGINS` for an explicit allowlist, including HTTPS behind a trusted proxy.
**There is no login: only expose the app on networks you trust.**

### Sandboxed JavaScript tool

`execute_js` is **off by default**; set `TRAVELMORE_AGENT_EXECUTE_JS=1` to expose it to the agent and
the RPC layer. When disabled, neither the RPC method nor the agent tool is advertised, and a forced
call fails with an actionable error.

When enabled, the code runs in a separate Node process started with `--experimental-permission`
(no filesystem or child-process access, empty environment) inside a V8 context that cannot run
generated code and never receives a host object. What that means in practice, measured on Node 22:

| Attempt from inside the tool | Result |
|---|---|
| `fetch('http://127.0.0.1:…')` | `ReferenceError`: no network API |
| `input.constructor.constructor('return process')()` | `EvalError`: string code generation disabled |
| `fs.readFileSync('/etc/hosts')` | `ERR_ACCESS_DENIED` from the permission model |
| `while (true) {}` | stopped after 750 ms with a timeout error |

The earlier version passed the input object into the sandbox directly, which let the code recover the
child process and make outbound HTTP requests even though the filesystem stayed blocked; the input is
now parsed inside the context. Limits remain: 8,000 characters of code, 64 KB input and result, 128 KB
stdout, 750 ms execution, 1.5 s process lifetime. Treat it as a convenience for arithmetic and data
reshaping, not as a general-purpose runtime, and leave it disabled if you do not need it.

### Developer intercom

This optional tool lets the agent ask a local Pi session for advice and receive its reply.
It is off by default. With Pi/intercom already running:

```bash
TRAVELMORE_DEV_INTERCOM=1 \
TRAVELMORE_INTERCOM_TARGET='FULL-PI-SESSION-ID' \
npm run dev
```

Read the recipient ID using `intercom({action:"status"})` in Pi. The launcher can inherit
`PI_INTERCOM_SESSION_ID`; an explicit target takes precedence. The default CLI path is
`~/.pi/agent/npm/node_modules/pi-intercom/cli.mjs`; override it for other installations.

The capability requires development mode and a launcher-attested loopback connection. It is not
available through LAN/Tailscale or in production. The model cannot list sessions or change the
recipient. Messages are limited to 4,000 characters, replies to 16,000 and the reply wait to two minutes.
`Cancel` ends the wait, not an already-delivered message; there are no automatic retries. Developer
advice does not grant permission to change code or expand the agent's tools.

## Privacy, security and limitations

- **Local does not mean offline.** Your AI provider receives prompts, context and tool results.
  Geocoding, Wikipedia and web search receive their respective queries. The browser loads external maps and photos.
- **No credentials in the client.** Keys and tokens stay on the server. Never publish private data
  files. The repository does not ship a shared AI key.
- **No multi-user authentication.** LAN and Tailscale access is for trusted networks. Anyone who can
  reach the app can read or change data and use the provider. Do not expose it directly to the Internet.
- **One process per archive.** Serialized writes are not a lock between independent backends.
- **Sources can fail.** Nominatim is paced at 1.1 seconds between requests with caching and backoff.
  Wikipedia and flight sites can become unavailable or change their structure.
- **`execute_js` is opt-in.** Disabled unless `TRAVELMORE_AGENT_EXECUTE_JS=1`; see [the sandbox notes](#sandboxed-javascript-tool).
- **Review AI output.** Sources and guardrails reduce errors; they do not make suggestions infallible.
  Use the UI/RPC for flight monitoring: some declared agent flight tools are still incomplete.
- **Intercom is opt-in.** Off by default; development and localhost only, with a fixed server-side
  recipient and no LAN/Tailscale access. [Enable it →](#developer-intercom)

## Development and verification

```bash
npm run typecheck
npm run build
npm test
npm run test:agent
```

`npm test` runs self-tests and a real WebSocket/RpcAble flow with a temporary store and a mock
provider. `test:agent` checks the Pi tool loop. Live search and intercom checks are separate and
require those services. Offline tests do not need commercial provider credentials.

Optional checks: `npm run test:intercom` requires a running Pi/intercom broker.
`node fullfill/web-search-live.mjs` and `node fullfill/agent-web-search-live.mjs` check live search.

The build produces `client/dist/` and `server/dist/`, **not** a ready-made public deployment.
`npm --workspace server start` serves only the compiled backend. A deployment must separately serve
the frontend with SPA fallback, proxy `/rpc` WebSocket upgrades, `/api` and `/media`, and configure
HTTPS, origins and access controls.

## Project layout

```text
client/src/components/       TinyBubble interface components
client/src/rpc/              Browser RPC connection
client/src/layout.js         Resizable panel preferences
server/src/agent/            Pi sessions, tools, OAuth and optional intercom
server/src/rpc/              Per-peer application methods
server/src/services/         Trips, media, providers, sources and flight monitoring
server/src/data/airports.json Local OurAirports dataset
server/src/store.ts          Serialized atomic JSON storage
fullfill/                   Functional verification scripts
screenshots/           Public application captures
dev.mjs                     Coordinated development launcher
```

Implementation entry points: [RPC methods](server/src/rpc/UserSession.ts),
[agent tools](server/src/agent/travelTools.ts), [storage](server/src/store.ts), and
[flight monitoring](server/src/services/flightMonitor.ts).

### Sources and attribution

Maps and geocoding: [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) and
[Nominatim](https://nominatim.org/). Descriptions and images: [Wikipedia](https://www.wikipedia.org/) and
[Wikimedia Commons](https://commons.wikimedia.org/), under each work's license.
Airports: [OurAirports](https://ourairports.com/data/). Model catalog: [models.dev](https://models.dev/).

TravelMore is not affiliated with Google Flights, Skyscanner or the supported AI providers.

### Screenshot credits

The screenshots show the running app at a 1600 × 800 viewport; the library view is cropped to
1250 × 540. Images and trip content were sourced through the agent, not inserted as mock records.
Other trips and credentials are kept out of view. Photos are resized and cropped by the interface;
each retains its original license. Map captures retain OpenStreetMap attribution.

<details>
<summary>Photographers, originals and image licenses</summary>

Authors and licenses were checked against Wikimedia Commons metadata. A generic Wikipedia license
reference in assistant text does not replace each photograph's specific license below.

| Photograph / original | Author | License |
|---|---|---|
| [Skyscrapers of Shinjuku 2009 January](https://commons.wikimedia.org/wiki/File:Skyscrapers_of_Shinjuku_2009_January.jpg) | Morio | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| [Kiyomizu](https://commons.wikimedia.org/wiki/File:Kiyomizu.jpg) | Jordy Meow | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| [Torii path with lantern at Fushimi Inari Taisha Shrine, Kyoto, Japan](https://commons.wikimedia.org/wiki/File:Torii_path_with_lantern_at_Fushimi_Inari_Taisha_Shrine,_Kyoto,_Japan.jpg) | Basile Morin | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| [Kiyomizu-dera, Kyoto, November 2016 -02](https://commons.wikimedia.org/wiki/File:Kiyomizu-dera,_Kyoto,_November_2016_-02.jpg) | Martin Falbisoner | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| [Sensoji 2023](https://commons.wikimedia.org/wiki/File:Sensoji_2023.jpg) | Akonnchiroll | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| [Shibuya Crossing, Aerial](https://commons.wikimedia.org/wiki/File:Shibuya_Crossing,_Aerial.jpg) | David Kernan | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| [Osaka Castle 03bs3200](https://commons.wikimedia.org/wiki/File:Osaka_Castle_03bs3200.jpg) | 663highland | [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/) |
| [Osaka Dotonbori Ebisu Bridge](https://commons.wikimedia.org/wiki/File:Osaka_Dotonbori_Ebisu_Bridge.jpg) | Type specimen | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |

The first three appear at larger sizes; the others may appear as pin thumbnails. These credits do
not relicense third-party work or imply that the demonstration itinerary is a booking.

</details>

## License

TravelMore's original source code and documentation are licensed under the [MIT License](LICENSE).
Third-party dependencies, map data, photographs and other source material retain their respective
licenses. See [sources and attribution](#sources-and-attribution) and the
[screenshot credits](#screenshot-credits) for details.
