# 2themoon — web app for the moonlander1 trampoline sensor

A static, single-page website that connects to the **moonlander1** trampoline sensor over Bluetooth (Web Bluetooth), shows every jump live as one stacked bar (**Bed** at the bottom, **Air** on top, so the bar height is the total jump time `flightMs + contactMs`), and keeps every turn and training session on the device (IndexedDB). There's no server and no build step: it's just files.

```
index.html            page structure
styles.css            all styling: night-sky theme, colour tokens and star layers at the top
app.js                CONFIG + parsePacket() at the top, then everything else
icon.svg              the 2themoon logo mark (trampoline → dotted jump arc → full grey moon), used as favicon / home-screen icon
manifest.webmanifest  lets Android "Add to Home screen"
fonts/                Barlow Condensed (self-hosted, SIL Open Font License, see fonts/OFL.txt)
.nojekyll             tells GitHub Pages to serve the files as they are
```

Works in **Chrome on Android** and **Chrome / Edge on Windows, Mac and ChromeOS**. (Chrome on Linux may need `chrome://flags/#enable-experimental-web-platform-features`.) On iPhone/iPad and other browsers the page shows a friendly message, and the demo and saved history still work.

---

## Publish on GitHub Pages

1. Create a new repository on GitHub (for example `2themoon`). It can be public or private (private Pages needs a paid plan).
2. Upload the files. Either:
   - **In the browser:** open the repo, click **Add file → Upload files**, drag in *everything in this folder* (including the `fonts` folder and the `.nojekyll` file), then click **Commit changes**. Files starting with a dot are hidden on Mac. Press `Cmd+Shift+.` in Finder to show them. Or
   - **With git:**
     ```bash
     cd path/to/this/folder
     git init && git add . && git commit -m "First version"
     git branch -M main
     git remote add origin https://github.com/YOUR-NAME/2themoon.git
     git push -u origin main
     ```
3. In the repo, go to **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to *Deploy from a branch*, **Branch** to `main` and the folder to `/ (root)`. Click **Save**.
5. Wait a minute, then refresh the page. GitHub shows the address, e.g. `https://YOUR-NAME.github.io/2themoon/`. It's HTTPS, which Web Bluetooth needs.

Cloudflare Pages and Netlify work too: point them at the repo, with no build command and the output directory set to the root.

## Run it locally for testing

Web Bluetooth only works on `https://` or on `localhost`, so serve the folder rather than double-clicking `index.html`:

```bash
cd path/to/this/folder
python3 -m http.server 8080
# then open http://localhost:8080 in Chrome
```

(`npx serve` works too.) To test on an Android phone against your computer, use Chrome's remote debugging with port forwarding (`chrome://inspect` → *Port forwarding* → `8080 → localhost:8080`), then open `http://localhost:8080` on the phone.

## Change CONFIG and the packet format

Open `app.js`. The first block is `CONFIG`:

| Setting | What it does | Current value (from the firmware) |
|---|---|---|
| `brandName` | Company name used everywhere (title, wordmark, results card, CSV names). A leading number is drawn in moon yellow and a "the" is set small | `2themoon` |
| `deviceLabel` | The sensor's name as people see it (connect button, status pill, results card) | `moonlander1` |
| `deviceNamePrefix` | Sensors in the Bluetooth picker must have a name starting with this (or advertise the service UUID) | `moonlander` |
| `serviceUUID` | Bluetooth service | Nordic UART `6e400001-…` |
| `characteristicUUID` | Notify characteristic that carries the text lines | `6e400003-…` (TX) |
| `commandCharacteristicUUID` | Write characteristic for commands (used for backfill) | `6e400002-…` (RX) |
| `jumpType` | Line type for a jump | `J` |
| `idleType` + `idleState` | A line of type `S` whose 4th field is `REST` ends the turn | `S` / `REST` |
| `barsVisible` | How many bars fit across a portrait phone before the chart scrolls sideways (bars are capped at 64 px wide, so bigger screens show more) | `12` |
| `idleGraceMs` | Optional wait after idle before closing the turn (a jump in between cancels it) | `0` |
| `turnGapMs` | Starts a new turn if two jumps are this far apart by the sensor clock (a missed idle) | `20000` |
| `newSessionAfterMs` | On connect, start a fresh session if the current one has been quiet this long | 3 hours |
| `reconnectAttempts` | Automatic reconnect tries | `5` |
| `backfillWindowMs` | After (re)connecting, ask the sensor to resend missed jumps if our last jump is this recent | 10 minutes |
| `flagLabels` | Plain-English text shown next to raw flag values | from `detector.h` |
| `dbName` / `dbVersion` | IndexedDB name and schema version | `trampoline-sensor-v1` / `1` |

UUIDs must be **lower-case** for Web Bluetooth.

**Firmware:** to match the new name, set `#define BLE_NAME "moonlander1"` in `config.h`. The picker also accepts any device advertising the service UUID, so the old `Trampoline-m2` name still connects in the meantime. (The firmware comment says to change the name when the GATT table changes because iOS caches it. The rename is a good moment to do that.)

**Look:** colours are CSS variables at the top of `styles.css` (`--moon`, `--air`, `--bed`, …). The star field is three tiled SVG layers (`--stars-a/b/c`) and the background moon is `.sky .moon`. Stars twinkle unless the device asks for reduced motion.

**Packet format:** everything about the wire format is in **`parsePacket(line)`**, right under `CONFIG`. It gets one text line and returns `{kind:'jump', …}`, `{kind:'idle'}`, `{kind:'ignore'}` or `null` (bad line: logged to the console and dropped). Bluetooth notifications are treated as a byte stream and split into lines on `\n` before `parsePacket` sees them, which matches `link.h` (lines can be split across notifications). If you switch to a binary format, change `BLE.onValue` to pass whole packets straight through and rewrite `parsePacket`.

**Schema changes:** bump `dbVersion` and add an `if (e.oldVersion < 2) { … }` block in `DB.open()`.

## Demo mode

Tap **Try demo** on the Live screen. It simulates the firmware's actual output (`J`, `S`, `C`, `X` and `#` lines, split into 20-byte chunks like a real BLE link, plus the odd corrupt line) and feeds it through the same `feedText()` → `parsePacket()` → storage → screen path as Bluetooth. You get turns of 10–30 jumps, then an idle, a pause, and the next jumper.

- A striped moon-yellow **DEMO MODE** banner and a yellow status pill show while it runs.
- Demo jumps go into their own session named **"Demo · …"** with a **Demo** badge. They never mix with real data. **History → Delete all demo data** removes them.
- Reload the page during a demo and it carries on in the same session. This is a good way to check reload safety.
- To test faster, add `?demospeed=10` to the address (10× speed).

## How it behaves

- **Turns** start on the first jump and end on the sensor's idle signal (`S,…,REST`). A **Who was jumping?** panel then appears with recent names as one-tap chips. It doesn't block anything and can be skipped. Unnamed turns can be named later from the turn screen. **End turn** on the Live screen closes a turn by hand.
- **Every jump is saved to IndexedDB as it arrives.** The app asks the browser once for persistent storage.
- **Disconnects:** a banner appears, all data is kept, and the app retries 5 times with back-off. After that a **Reconnect** button shows. On reconnect the app sends the firmware's `b N` command, so jumps made while disconnected are resent (duplicates are ignored).
- **Screen stays on** while connected or in demo (Screen Wake Lock), and the lock comes back when you return to the tab.
- **Flags:** a non-zero `flags` value puts a small ▲ above that jump's bar. Tap the jump to see the raw value and its meaning.
- **CSV:** from a turn, a session, or History (everything). On Android it opens the share sheet; elsewhere it downloads.
- Tap the green **moonlander1 connected** pill to disconnect.
