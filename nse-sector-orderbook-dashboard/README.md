# NSE Sector + Order Book Dashboard

This is a standalone, local dashboard in its own folder. It does not import from or change any other project. It is read-only and has no order placement controls.

## Start it

Requires Node.js 20 or newer. No package installation or settings file is needed.

Double-click `Start Dashboard.bat` in this folder. It starts the local server and opens the dashboard in your browser. Leave the server window open while using the dashboard; press Ctrl+C there when finished. If the usual port is occupied, the app will open the address it selected instead.

You can also start it from PowerShell:

~~~powershell
Set-Location "C:\path\to\nse-sector-orderbook-dashboard"
npm start
~~~

Open the local address printed in the PowerShell window, usually `http://127.0.0.1:8765`. If that port is already in use, the app tries the next port and prints the address to use. Keep the PowerShell window open while using the dashboard. Press Ctrl+C to stop it.

At startup, the dashboard opens its Angel One sign-in prompt. Enter these into the local page, never into chat:

- SmartAPI key
- Client code
- PIN
- Current authenticator code (TOTP)

The local IP, public IP, and device MAC fields are filled automatically when possible. The public IP lookup uses ipify.org and sends only the network lookup request there; if it does not fill, enter the public IP in the expandable Network details section. These are required SmartAPI request headers.

The sign-in form sends credentials from this computer to Angel One. The PIN and one-time authenticator code are not retained. Session tokens and the API key/client code are kept only in server memory. The dashboard stays signed in across browser refreshes while the server runs. Sign out in the dashboard to clear the session and request Angel One logout, or stop the server to clear local memory. SmartAPI sessions may expire at midnight and may then require a fresh sign-in.

Use only an account you are eligible and authorized to access. Do not share its credentials in chat.

## What it shows

- NSE sector-index tiles with change-based green/red coloring, readable bold names, last-fetch time, and open/high/low/close details. Tiles default to biggest gain → biggest decline; the selector can reverse them or sort A–Z. Selecting a tile filters the Green, Red, and White tables to that index’s constituents. Select it again or choose **Show all symbols** to clear the filter. Use **Details** to open the index values.
- Angel One cash and nearest unexpired stock future quotes for the configured F&O universe.
- Buy and sell quantities summed separately across the five available depth levels.
- Color groups based on **cash net quantity** and **future net quantity**:
  - Green: both buy-minus-sell totals are positive.
  - Red: both totals are negative.
  - White: signs differ or either total is zero.
- Each Green, Red, and White table sorts independently by its clickable headers: symbol, LTP/day change, cash net, or nearest-future net. On narrow screens, each table has its own sort menu. Filters cover symbol, minimum/maximum LTP, group, day-change sign, cash net sign, and future net sign.
- The view bar beside the result count has **Clear all** and **Refresh**. Clear all restores the default tile order, clears the selected sector and all searches/filters, and resets each table’s sort; it keeps the Angel One session and project settings. Refresh requests fresh market data.
- Source timestamps, refresh countdown, summary cards, and CSV export. When a sector is selected, the export is limited to that sector’s constituents.

Sector filtering uses official NSE Indices constituent CSV files linked from its index pages. A saved official symbol list is included so tiles work immediately after restart; the dashboard checks for updates at startup and then daily while open, and keeps a browser cache. If an update is unavailable, the saved list stays usable. NSE Indices marks the published lists as being for the last trading day of the previous month, so membership can change less often than quotes. The table filter is the intersection of index membership and symbols tracked by this dashboard, so it shows the F&O symbols available in the configured universe.

Angel One market-data quotes refresh every 60 seconds. Requests are batched to stay within 50 instruments per full quote call, with a pause between batches.

## NSE index data

Sector tiles use NSE's own market indices JSON data source, following the index-list and `getIndicesData` method used in the separate NSE Accumulation research project. The displayed percentage is NSE's `pChange` value for the matching index row, rather than a value inferred from an end-of-day MCP snapshot. The research project caches NSE index data for five minutes, so this dashboard uses the same five-minute index refresh. Angel One order-book refresh remains at 60 seconds. Each tile shows the source's last-update time when NSE supplies one; a failed refresh keeps the prior values marked stale by the connection status.

The market indices endpoint is an official NSE website data path, but it is not a versioned public API contract and NSE may change it or limit requests. The dashboard also downloads constituent CSV files from the official NSE Indices site. It does not scrape HTML pages.

## Render hosting

The `nse-sector-orderbook-dashboard/render.yaml` Blueprint defines one free Node web service in Render's Singapore region, using build command `npm install`, start command `npm start`, and `/healthz` for its health check. It sets the service root to `nse-sector-orderbook-dashboard`, reads Render's `PORT`, and binds to `0.0.0.0`. On Render, the whole site is protected by HTTP Basic Authentication: set `DASHBOARD_PASSWORD` to a random password of at least 24 characters when applying the Blueprint. The username is `dashboard`. Keep the password private; do not put its value in GitHub or send it in chat. The app refuses page and API access on Render until a sufficiently long password is configured.

Angel One API key, client code, PIN, and current authenticator code entered on the hosted sign-in page are sent over HTTPS to the Render service for the sign-in request. Session tokens stay in server memory and are cleared when the service restarts or sleeps. Render's Free web services can spin down after 15 minutes without inbound traffic, so automatic refreshes pause while the dashboard is asleep; opening the dashboard wakes it. The service is configured as a free plan to avoid choosing a paid plan. Angel One requests come from Render's network, not your computer; if your SmartAPI key has an IP allowlist, its restrictions may need to include the service's Render outbound IP ranges.

## Change the F&O symbols

The default watchlist automatically discovers NSE cash stocks with active Angel One stock-futures contracts. For a smaller list, edit `config/watchlist.json` to:

~~~json
{"mode":"selected","symbols":["ABB","HDFCBANK"]}
~~~

The sector names used for matching are in `config/sectoral-indices.json`.

## Official references

- [Angel One SmartAPI documentation](https://smartapi.angelone.in/docs)
- [NSE live market indices](https://www.nseindia.com/market-data/live-market-indices)
- [NSE Indices sectoral index pages and constituent downloads](https://www.niftyindices.com/indices/equity/sectoral-indices)
- [NSE Data Sharing & Usage Policy](https://betanseapi.nseindia.com/static/market-data/nse-data-policy)
