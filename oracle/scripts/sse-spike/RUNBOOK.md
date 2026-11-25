# SSE probe on ROFL: operator runbook

A throwaway measurement. A tiny Node server (`probeServer.js`) runs as its **own** ROFL app
(`sse-probe`, deployment `probe`) on Sapphire testnet, rented for one hour, and
`probeClient.js` plus a browser check measure how the ROFL proxy treats a long-lived event
stream. It never touches the oracle's manifest, deployments or machines: every command below
runs in `oracle/scripts/sse-spike/rofl/`, which has its own `rofl.yaml` and `compose.yaml`.

The twelve measures and what each answer changes are in the chunk 2 streaming plan, section 4.
The results table to fill in is at the end of this file.

## Rules for every step

- **Never pass `-y`.** Each signing command prints the transaction and asks `Sign this
  transaction? (y/N)`. Read it (the account, the amount, the fee) before typing `y`.
- **Run `oasis` bare here, not through `scripts/oasis-unlock.exp`.** That wrapper answers every
  y/N with `y`, which is the same as `-y`. Type the `oasis_testnet` passphrase when asked.
- **Before retrying any failed signing step, read the nonce first** (step 1's command, the
  `Nonce:` line under the Sapphire ParaTime). Note it before each signing step. If it went up
  by one, the transaction landed even though the command failed: do not send it again; read
  the state instead (each step says how).
- Times are approximate. The rented machine lives for the paid hour only (`Paid until` in
  `machine show`), so steps 2 to 5 are done **before** renting in step 6.

Paths used below (copy each command whole; they are quoted for the spaces):

- worktree: `/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike`
- probe app: `.../tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl`
- client: `.../tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/probeClient.js`

Docs read on 2026-11-21 (cited by number below):
[1] https://docs.oasis.io/build/rofl/features/proxy/
[2] https://docs.oasis.io/build/rofl/workflow/deploy
[3] https://docs.oasis.io/build/rofl/workflow/create
[4] https://docs.oasis.io/node/run-your-node/prerequisites/stake-requirements
[5] https://docs.oasis.io/build/rofl/quickstart
[6] https://docs.oasis.io/build/rofl/features/manifest
[7] https://docs.oasis.io/build/rofl/workflow/containerize-app
[8] https://docs.oasis.io/build/rofl/troubleshooting
[9] https://docs.oasis.io/build/rofl/workflow/build
[10] https://docs.oasis.io/build/rofl/features/marketplace
[11] https://docs.oasis.io/build/rofl/features/secrets
CLI flags are quoted from `oasis <cmd> --help`, Oasis CLI 0.22.1.

---

## 0. Check the tools and the probe (free, about 1 minute)

```bash
oasis --version && docker info --format '{{.ServerVersion}}' && node --test "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/test/"*.test.js
```

- Does: prints the CLI version (expect `Software version: 0.22.1`), checks Docker answers (the
  bundle is built in the containerized builder named in `rofl.yaml`), runs the probe's tests.
- Cost: none.
- Worked: a version line, a Docker version, and `ℹ fail 0` at the end of the test output.
- Undo: nothing to undo.

## 1. Balance, nonce and the current stake rule (read only)

```bash
oasis account show --account oasis_testnet --network testnet --paratime sapphire
```

```bash
oasis paratime show parameters --network testnet --paratime sapphire
```

- Does: the first prints the account's balance and nonce on Sapphire testnet; the second prints
  the ParaTime's current parameters, including the stake needed to create a ROFL app [4].
- Cost: none (reads).
- Worked: note the Sapphire `Nonce:` and the balance. You need about **100 TEST** for the app's
  stake [3][4] (the docs say "Currently, this threshold is 100 tokens" [3]; 100 TEST on
  testnet [4]), plus **5 TEST** for an hour of `playground_short` (the price in the docs'
  offer example, "Price: 5.0 TEST/hour" [2]), plus gas: about **110 TEST** in all. The
  quickstart says "about 150 tokens" for registration, rent and gas [5]. Top up from
  https://faucet.testnet.oasis.io/ if short. (The project's last recorded balance for this
  account was 88.58 TEST in July: likely short.)
- Undo: nothing to undo.

## 2. Register the probe app on Sapphire testnet (signs; stake + gas)

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl create --network testnet --paratime sapphire --deployment probe --account oasis_testnet
```

- Does: registers a new ROFL app with `oasis_testnet` as its admin and writes a `probe`
  deployment with its `app_id` into this folder's `rofl.yaml` (flags from `oasis rofl create
  --help`: `--deployment`, `--network`, `--paratime`, `--account`; default `--scheme cn`).
- Cost: the app stake, 100 TEST [3][4], plus gas. Whether the stake comes back on `rofl remove`
  is **not stated** in the docs [3][4]; step 15 compares balances.
- Worked: `Created ROFL application: rofl1…` [3], and
  `git -C "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike" diff oracle/scripts/sse-spike/rofl/rofl.yaml`
  shows a new `deployments: probe:` block with `app_id:`.
- If it failed: read the nonce (step 1). Up by one means it landed: run
  `oasis rofl list --network testnet --paratime sapphire` and look for an app whose admin is
  your account; do not create a second one.
- Undo: step 15 (`oasis rofl remove`).

## 3. Build the bundle (local, no transaction)

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl build --deployment probe
```

- Does: packs `compose.yaml` with the operating system parts and a trusted block hash into a
  bundle and updates the enclave identity in `rofl.yaml` [9]. No image is built: the compose
  file names a stock public image and carries the probe program itself (see "How the program
  reaches the container" below).
- Cost: none stated [9]; local Docker time only.
- Worked: `ROFL app built and bundle written to 'sse-probe.probe.orc'` (the docs' example
  format [9]); `rofl.yaml` now lists `enclaves:` under `deployments.probe.policy`. The `.orc`
  is ignored by git (`.gitignore` has `*.orc`).
- Undo: delete `sse-probe.probe.orc` from the probe app folder when done.

## 4. Push the enclave identity on chain (signs; gas)

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl update --deployment probe --account oasis_testnet
```

- Does: writes the policy from step 3 (which enclave identities may run the app) to the chain.
  The quickstart runs `oasis rofl update` after build and before deploy [5]; without it the
  machine would run an identity the chain does not allow.
- Cost: gas only (no figure stated).
- Worked: the transaction is confirmed with no error.
  `oasis rofl show --deployment probe`, run in the probe app folder, prints the app with the
  same enclave ids as `rofl.yaml`.
- If it failed: nonce check, then the same `oasis rofl show` to see whether the policy
  already matches.
- Undo: removed with the app in step 15.

## 5. Choose the offer (read only)

```bash
oasis rofl provider list --network testnet --paratime sapphire --show-offers
```

- Does: lists the providers on Sapphire testnet with their offers and prices (`--show-offers`,
  from `oasis rofl provider list --help`). Private offers stay hidden without `--all`.
- Cost: none.
- Worked: pick the cheapest offer with an hourly price and at least 512 MiB and 1 vCPU (this app
  asks for 512 MiB, 1 vCPU, a 1 GiB ephemeral disk). The docs' example is
  `playground_short [0000000000000001] … Price: 5.0 TEST/hour` [2], which is what the project
  rents on testnet today. Step 6 assumes `playground_short`; if another offer is cheaper, use its
  name in step 6's `--offer`.
- Undo: nothing to undo.

## 6. Rent one hour and deploy (signs; the rent)

Start this only when you can do steps 7 to 13 straight away: the hour starts now.

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl deploy --deployment probe --account oasis_testnet --offer playground_short --term hour --term-count 1
```

- Does: pushes the bundle to the Oasis-managed OCI repository, pays the offer to the provider,
  and stores the machine id in `rofl.yaml` [2] (flags from `oasis rofl deploy --help`:
  `--offer`, `--term [hour, month, year]`, `--term-count`).
- Cost: the offer's hourly price times one: 5 TEST for `playground_short` per the docs' example
  [2] and step 5's list; the transaction printed before the y/N shows the amount. Gas on top.
- Worked: `Taking offer: playground_short [...]` [2], then success; `rofl.yaml` gains a
  `machines: default:` entry with `provider`, `offer` and `id`.
- If it failed: nonce check. If `rofl.yaml` already has `machines: default:`, the rent went
  through: rerun the same command **without** `--offer`, `--term` and `--term-count` to push to
  that machine; never rent twice.
- Undo: step 15 (`oasis rofl machine remove`).

## 7. Boot check and the proxy URL (measure 1)

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl machine show --deployment probe
```

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl machine logs --deployment probe --account oasis_testnet
```

- Does: `machine show` prints the machine's status, `Paid until`, and a `Proxy:` section [1][2];
  `machine logs` fetches the app's logs, signed by the admin account [2]. The logs are stored
  unencrypted on the node [2]; the probe logs no address or header value.
- Cost: none stated (`logs` asks for the passphrase to sign the request; no transaction).
- Worked: `machine show` has `Status: accepted` and, under `Proxy:` / `Ports from compose
  file:`, a line `8787 (probe): https://p8787.<machine domain>` (format from [1][2]). The logs
  contain `{"ev":"listening","port":8787,"allowedOrigins":4}`. Allow a few minutes after
  step 6 for the image pull and start; rerun both until they show this.
- Then set the URL for every later step, copying the `https://p8787…` text from that `8787
  (probe):` line exactly:

```bash
export PROBE_URL='https://p8787.PASTE-THE-REST-FROM-THE-8787-LINE'
```

```bash
curl -s "$PROBE_URL/health"
```

  `{"ok":true}` means measure 1 passed. Write the URL and `Paid until` into the results table.
- If the URL is not reachable: the troubleshooting page says this is likely outdated artifacts
  [8]; this manifest uses the artifact versions CLI 0.22.1 writes by default (`rofl init`).
- Undo: nothing to undo.

## 8. Where TLS ends, and the HTTP version to a client (measures 2 and 7, CLI side)

```bash
openssl s_client -connect "${PROBE_URL#https://}:443" -servername "${PROBE_URL#https://}" -alpn h2,http/1.1 </dev/null 2>/dev/null | grep -E 'subject=|issuer=|ALPN protocol|Verify return code'
```

```bash
curl -sv -o /dev/null "$PROBE_URL/health" 2>&1 | grep -E '^< HTTP|ALPN|subject:|issuer:'
```

- Does: shows the certificate the client sees (subject, issuer) and the HTTP version agreed.
  The docs say the default mode `terminate-tls` ends TLS inside the enclave with a Let's
  Encrypt certificate and forwards plain traffic to the container [1].
- Cost: none.
- Worked: a Let's Encrypt issuer for the `p8787…` name and `Verify return code: 0 (ok)` means
  the proxy terminates TLS (plan: Phase 2 as planned, no `node:https`). Note `ALPN protocol`
  (`h2` or `http/1.1`) for measure 7. The probe itself only speaks plain HTTP, so any working
  HTTPS answer already shows the proxy terminated TLS.
- Undo: nothing to undo.

## 9. Headers, the big frame and timing (measures 3, 8, 9, 12; about 2 minutes)

```bash
node "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/probeClient.js" "$PROBE_URL" headers big timing | tee -a "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/results.log"
```

- Does: estimates clock skew from `/health` round trips; `headers` reports which request header
  names reached the app, whether `x-forwarded-for`, `x-forwarded-proto`, `via`, `forwarded`
  are present (never their values) and the HTTP version from the proxy to the app; `big` asks
  for one 64 KiB frame and checks every byte; `timing` holds two streams for 60 s with a frame
  every 3 s, one with `X-Accel-Buffering: no` and one without, and reports mean and max delay
  and whether frames arrived in bursts.
- Cost: none.
- Worked: one JSON line per measure and a table at the end. Read: `timing` bursty `no` on both
  means the proxy streams (`sse` mode); bursty `YES` or a max delay near the stream length means
  it buffers (`poll` mode). `encoding none` means no gzip on the stream. `big` says `intact` or
  `NOT intact`. `headers` gives measure 9.
- Undo: nothing to undo. (`results.log` is an untracked scratch file.)

## 10. Idle, heartbeat and the 10-minute hold, together (measures 4 and 5; 15 minutes)

```bash
node "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/probeClient.js" "$PROBE_URL" idle heartbeat long --parallel | tee -a "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/results.log"
```

- Does: four streams at once, each silent apart from what it tests: no heartbeat (`idle`),
  a `: ping` every 15 s and every 60 s (`heartbeat`), each held up to the probe's 15-minute cap;
  and a 10-minute stream with a frame every 30 s and a ping every 15 s (`long`).
- Cost: none.
- Worked: the table says for each either `held N s to the server end` (the proxy did not cut it)
  or `cut after N s, M s after the last byte`. The idle limit is the silence before the cut on
  the stream that was cut; `STREAM_HEARTBEAT_MS` is half of it. `long` says `held 10 min,
  20/20 frames` or `NOT held`.
- Do step 11 in a browser while this runs.
- Undo: nothing to undo.

## 11. Browser check (measures 3, 7 and 8 from a browser; about 70 seconds)

Nothing is deployed to hosting. Either way works; do A, and B if A is blocked.

**A. From the sandbox dApp's origin.** Open https://sense-ai-app-garrick.web.app in Chrome, open
DevTools, Network tab (tick "Disable cache", right-click the column header and show
"Protocol"), then the Console tab. Chrome may ask you to type `allow pasting` first. Paste the
snippet below and press Enter; when it asks, paste the `$PROBE_URL` value from step 7.

**B. From a local page.** Serve the probe page on the allowed local origin and open it:

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike" && python3 -m http.server 8788 --bind 127.0.0.1
```

Open http://127.0.0.1:8788/probe.html, paste the URL, press Run. Stop the server with Ctrl-C.

- Does: five `/health` round trips for skew, then the stream with a `Last-Event-ID` header, which
  is not a CORS-safelisted header, so the browser must send a preflight first.
- Cost: none.
- Worked: `status 200 … (preflight passed)`, then a `frame N: delay … ms` line every 3 s, then a
  summary. In the Network tab: an `OPTIONS` request to `/probe` with status 204 (the preflight),
  the `GET` with type `fetch`, its Protocol (`h2` or `http/1.1`, measure 7), and in its response
  headers `access-control-allow-origin` equal to the page's origin and no `content-encoding`
  (measure 8). A CORS error in the console means the preflight or a header was blocked: write
  down the exact message; that is the plan's no-go case for measure 8.
- Undo: close the tab.

```js
async function runProbe(base, log) {
  base = base.replace(/\/+$/, '');
  // Clock skew: the /health sample with the shortest round trip; the server read its clock
  // halfway through it, give or take half the round trip.
  let best = null;
  for (let i = 0; i < 6; i += 1) {
    const t0 = Date.now();
    const r = await fetch(base + '/health', { cache: 'no-store' });
    await r.text();
    const t1 = Date.now();
    const server = Number(r.headers.get('x-probe-time'));
    if (!server) throw new Error('X-Probe-Time not readable: is this origin on the allow-list?');
    if (!best || t1 - t0 < best.t1 - best.t0) best = { t0, t1, server };
  }
  const offset = best.server - (best.t0 + best.t1) / 2;
  log('skew: server ' + offset.toFixed(1) + ' ms ahead, +/- ' + ((best.t1 - best.t0) / 2).toFixed(1) + ' ms');
  const every = 3000;
  const url = base + '/probe?every=' + every + '&for=60000&accel=0';
  const res = await fetch(url, { cache: 'no-store', headers: { 'Last-Event-ID': '0' } });
  log('status ' + res.status + ', content-type ' + res.headers.get('content-type') + ' (preflight passed)');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const arrivals = [];
  for (;;) {
    const { value, done } = await reader.read();
    const now = Date.now();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      if (!data || !block.includes('event: tick')) continue;
      const d = JSON.parse(data.slice(6));
      const delay = now - (d.sentAt - offset);
      arrivals.push({ seq: d.seq, now, delay });
      log('frame ' + d.seq + ': delay ' + delay.toFixed(1) + ' ms');
    }
  }
  let bursts = 0;
  for (let i = 1; i < arrivals.length; i += 1) {
    // Frames sent `every` ms apart that arrive within a quarter of that were held back.
    if (arrivals[i].now - arrivals[i - 1].now < every / 4) bursts += 1;
  }
  const delays = arrivals.map((a) => a.delay);
  const entry = performance.getEntriesByName(url).pop();
  const protocol = entry && entry.nextHopProtocol ? entry.nextHopProtocol : 'not exposed: read the Protocol column';
  const summary = {
    frames: arrivals.length,
    meanDelayMs: Math.round(delays.reduce((a, b) => a + b, 0) / (delays.length || 1)),
    maxDelayMs: Math.round(Math.max(...delays)),
    framesArrivingTogether: bursts,
    protocol,
  };
  log('summary ' + JSON.stringify(summary));
  return summary;
}
runProbe(prompt('Probe URL from RUNBOOK step 7'), console.log);
```

## 12. Concurrent connections (measure 6; about 2 minutes)

```bash
ulimit -n 4096 && node "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/probeClient.js" "$PROBE_URL" concurrent | tee -a "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/results.log"
```

- Does: opens 50 streams at once for 30 s (a frame every 2 s), then 200. The probe's own cap is
  250, so a refusal below that comes from the proxy (or from this Mac: `ulimit` raises the open
  file limit for this command first).
- Cost: none.
- Worked: `50: 50 opened, 50 complete …` and the same for 200. Fewer opened or complete, or
  statuses other than `200`, give `STREAM_MAX_CONN_TOTAL`: set it below the number that held.
- Undo: nothing to undo.

## 13. App down, then restart: does the URL survive? (measures 11 and 10, first half)

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl machine stop --deployment probe --account oasis_testnet
```

```bash
node "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/probeClient.js" "$PROBE_URL" down | tee -a "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/results.log"
```

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl machine restart --deployment probe --account oasis_testnet
```

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl machine show --deployment probe
```

```bash
curl -s "$PROBE_URL/health"
```

- Does: `machine stop` stops the machine (signs; gas); `down` asks `/health` once and reports
  the status, content type and body length the proxy returns while nothing answers (or the
  connection error); `machine restart` "Restart[s] a running machine or start[s] a stopped one"
  (its `--help`); `machine show` prints the `Proxy:` URL again.
- Cost: gas for stop and restart. Whether a stopped machine keeps its paid time is **not
  stated**; check `Paid until` in `machine show` is unchanged.
- Worked: `down` gives a status (502 or 503 match the dApp's retry path; anything else, write it
  down) or an error name. After the restart (allow a few minutes), the `8787 (probe):` line is
  compared with `$PROBE_URL`: same means the URL survives a restart. `curl` gives `{"ok":true}`
  when the probe is back.
- This stops the whole machine, so it measures "the proxy with nothing behind it", not "the
  container exited while the machine runs". Note that in the results.
- If a stop or restart fails: nonce check, then `machine show` for the current status.
- Undo: the restart is the undo of the stop.

## 14. Replacement check (measure 10, second half): needs a separate word

Only if there is time left in the hour **and** a second rent is agreed. The docs do not describe
moving an app to a new machine inside a paid term: `--replace-machine` is "rent a new machine if
the provided one expired" (`oasis rofl deploy --help`), so a replacement now means removing this
machine and renting another hour (a second 5 TEST).

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl machine remove --deployment probe --account oasis_testnet
```

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl deploy --deployment probe --account oasis_testnet --offer playground_short --term hour --term-count 1
```

Then step 7's `machine show`: a different `8787 (probe):` URL means a replacement changes the
URL (plan: custom domain, `net.oasis.proxy.ports.8787.custom_domain` with an A and a TXT
record [1], or a URL read at run time). Then go to step 15.

## 15. Take it all down and confirm nothing is left (signs; gas)

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl machine remove --deployment probe --account oasis_testnet
```

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl remove --deployment probe --account oasis_testnet
```

```bash
cd "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl" && oasis rofl machine show --deployment probe ; oasis rofl show --deployment probe ; oasis account show --account oasis_testnet --network testnet --paratime sapphire
```

- Does: `machine remove` is "Cancel rental and remove the machine" (`--help`); `rofl remove`
  removes the app registration; the last line reads the machine, the app and the balance.
- Cost: gas. Whether unused rent is refunded, and whether the 100 TEST stake is returned, are
  **not stated** [2][3][4][10]: compare this balance with step 1's.
- Worked: `machine show` no longer shows a running machine (an error or a removed status),
  `rofl show` says the app does not exist, `curl -s "$PROBE_URL/health"` gets no `{"ok":true}`.
  Nothing is left running or billing once the machine is removed: the rent was paid in advance
  for one hour and nothing renews it.
- If a remove fails: nonce check, then the read line above to see what is still there.
- Then put the probe folder back as committed (the `app_id` and machine id are in
  `results.log` and the table) and drop the bundle:

```bash
git -C "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike" checkout -- oracle/scripts/sse-spike/rofl/rofl.yaml && rm "/Users/tradable/Documents/Work/Tradable/Web and App Development/tokenized-ai-agent-ssespike/oracle/scripts/sse-spike/rofl/sse-probe.probe.orc"
```

---

## How the program reaches the container (no image build)

`rofl/compose.yaml` runs the stock `docker.io/library/node:24-alpine` image, pinned by its
multi-platform index digest `sha256:116b800c…e85f5` (Docker Hub public tag metadata, read
2026-11-21, last pushed 2026-11-11; `platform: linux/amd64` picks the amd64 image), with an
`entrypoint` of `node -e <the whole of probeServer.js>`. `buildCompose.js` writes that file and a
test fails if it drifts from the source. The docs ask for fully qualified image names from a
public registry, pinned by digest [7], and their troubleshooting page works around a compose
limitation by "hardcoding the value in `entrypoint`" [8]; they say nothing either way about
carrying a program in `entrypoint` or using compose `configs` (not stated). The source has no
`$`, so compose has nothing to substitute (the docs warn that variables assigned in compose and
used in commands do not work [8]). `docker compose config` parses the file back to the exact
source; podman compose, which ROFL uses (`stage2-podman` in `rofl.yaml`), was not run locally.
If the container does not start (step 7's logs), the fallback is a two-line image
(`FROM` this digest, `COPY probeServer.js`), which needs a registry push and the owner's word.

To read the digest yourself:

```bash
curl -s https://hub.docker.com/v2/repositories/library/node/tags/24-alpine | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["digest"], d["tag_last_pushed"])'
```

---

## Results (fill in)

Date: 2026-11-25 (22:25 to 23:05 UTC)  Machine `Paid until`: 23:25 UTC (`000000000000077b`, `playground_short`: 2 vCPU, 4096 MiB; not the mainnet size)  App id: `rofl1qqaqv9rvj3n7mns3jd52asmy2hpl90a8uuw6rt07` (removed)  Proxy URL: `https://p8787.m1915.opf-testnet-rofl-9.rofl.app` (gone)

Sapphire **testnet** only: the 30 s cut and the connection counts are to be re-checked on a mainnet machine.

| # | Measure | Step | Result | What it sets |
|---|---|---|---|---|
| 1 | Port published, URL | 7 | Pass: answered about 8 min after the rent | `VITE_REASONING_STREAM_URL` |
| 2 | Where TLS ends, certificate seen | 8 | Ends in the enclave: Let's Encrypt certificate for the `p8787` name, verify code 0 | terminates: Phase 2 as planned; passthrough: add `node:https` and a certificate source |
| 3 | Buffering (CLI accel 0 / 1, browser) | 9, 11 | On time: mean 75 ms, max 298 ms, no bursts, accel 0 and 1; headless Chromium mean 61 ms, max 100 ms | on time: `sse`; bursts or at close: `VITE_REASONING_STREAM_MODE=poll` |
| 4 | Idle timeout (none / 15 s / 60 s heartbeat) | 10 | No idle limit seen: every stream is cut 30.3 to 30.5 s after it opens, silent or with frames every 0.5 s (local control held 75 s; one curl held 41.3 s, unexplained) | `STREAM_HEARTBEAT_MS` = half the idle limit |
| 5 | Longest connection (10 min) | 10 | About 30 s. The 10-minute hold got 1 of 20 frames | `STREAM_MAX_CONN_MS` below it |
| 6 | Concurrent (50 / 200) | 12 | 50 asked: 44 opened, 6 reset. 200 asked: 140 opened, 60 reset. None complete (30 s streams, cut at 30 s). One new connection was refused about 30 s later | `STREAM_MAX_CONN_TOTAL` |
| 7 | HTTP version to the browser (and to curl, and proxy to app) | 11, 8, 9 | HTTP/1.1 to curl and openssl (ALPN), and from the proxy to the app; the browser did not expose it | HTTP/1.1: one stream per tab (already so) |
| 8 | CORS preflight and headers pass, no gzip | 11, 9 | Pass from `http://127.0.0.1:8788` (a request with `Last-Event-ID`): 200, allow-origin echoed, no `content-encoding`. Not run from the sandbox dApp origin | stripped: poll mode; preflight blocked: no-go |
| 9 | `X-Forwarded-For` present | 9 | Absent, with `x-forwarded-proto`, `via` and `forwarded` | present: per-IP limit possible; absent: per-answer and global caps |
| 10 | URL after restart / after replacement | 13, 14 | Not answered: after `machine stop` (a terminate) and `machine restart`, `machine show` kept the same URL but nothing served for 18 min and logs returned 404. Replacement not run | stable: set once; changes: custom domain or URL read at run time |
| 11 | What arrives when the app is down | 13 | A TLS handshake failure (curl exit 35, `ECONNRESET`), no HTTP status | the client treats 502/503 as retry |
| 12 | 64 KiB frame | 9 | Intact | cut: lower the answer-frame cap |

**Outcome:** go (1, 3 and 8 pass). `STREAM_MAX_CONN_MS` must be below 30 s so the server ends each connection before the proxy does; the reader reconnects from its cursor.

**Go / no-go (from the plan):** go if 1, 3 (either mode) and 8 pass. No-go fallback: a
first-party relay that holds the frame buffer in memory, receives ciphertext from the oracle
over an authenticated outbound connection, and serves the same endpoint and contract; the dApp
changes only `VITE_REASONING_STREAM_URL`.
