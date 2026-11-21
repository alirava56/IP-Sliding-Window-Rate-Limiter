# Release verification

This review was performed on 2026-11-21 against published commit `18c2c97`. Its [hosted CI run](https://github.com/alirava56/IP-Sliding-Window-Rate-Limiter/actions/runs/44846458500) completed successfully before the review. The original project audit remains available in the [baseline audit](BASELINE-AUDIT.md).

## Findings and fixes

| Area                    | Observed behavior in the preceding version                                                                                                                                                                   | Correction                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sliding-window boundary | Subtracting the accepted timestamp from a much larger clock sample could round the elapsed time up to the expiration boundary.                                                                               | Compare the stored timestamp directly with the cutoff. Quota checks, capacity reclamation and background cleanup agree on the boundary.                               |
| Capacity retry          | A fixed one-second hint ignored the actual earliest bucket expiration.                                                                                                                                       | Derive `Retry-After` from the oldest bucket's most recent acceptance, rounded up to seconds.                                                                          |
| Cleanup                 | A background pass could delete the entire expired prefix in one event-loop turn.                                                                                                                             | Limit each scheduled callback to 1,024 deletions and yield before another full batch.                                                                                 |
| Echo contract           | A JSON body could be changed by lenient decoding or number reserialization. Deeply nested valid JSON could return 500. Empty inputs could return inconsistent data, and the parser could intercept API 404s. | Read only the echo route's body, validate its media type, UTF-8 bytes and JSON syntax, and embed the validated JSON value in the response. Empty input yields `null`. |
| HTTP upload             | Express's previous parser could wait for an oversized body to finish before returning 413. Node could send `100 Continue` before application admission.                                                      | Enforce declared and streamed limits. Send `100 Continue` after quota and header checks, and close connections on oversized uploads.                                  |
| Shutdown                | A request arriving on an existing socket could reach the app after shutdown began.                                                                                                                           | Refuse new requests with 503 while previously admitted requests drain within the grace period.                                                                        |

Seven focused regression tests for time, capacity, sweeps and HTTP behavior were run against a clean checkout of `18c2c97` with the new tests. All seven failed on that checkout and passed on the corrected source. New integration tests also exercise continuation, early 413 on a chunked upload, and two ordered responses on a single connection during shutdown.

## Verification

Commands ran from fresh source snapshots on Windows with Node 24.22.3, Debian with Node 22.23.5, and Alpine with Node 24.22.3. The full suite includes 15,000 operations checked against a reference log across five deterministic seeds. The parallel HTTP test admits exactly five of twenty requests with the clock held fixed.

| Command                                   | Result | Evidence                                                                                                                                                                                                        |
| ----------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                  | PASS   | Clean lockfile install on Windows and both Linux environments                                                                                                                                                   |
| `npm run typecheck`                       | PASS   | Strict TypeScript on all three environments                                                                                                                                                                     |
| `npm run lint` and `npm run format:check` | PASS   | Both checks passed on all three environments                                                                                                                                                                    |
| `npm run build`                           | PASS   | Standalone compiled server on all three environments                                                                                                                                                            |
| `npm test`                                | PASS   | 61 passed on Windows                                                                                                                                                                                            |
| `npm run test:core`                       | PASS   | 21 passed from clean sources on Windows                                                                                                                                                                         |
| `npm run test:coverage`                   | PASS   | 61 passed with zero skips on all three environments                                                                                                                                                             |
| `npm run smoke`                           | PASS   | 10 accepted, two rate-limited and a working liveness route on all three environments                                                                                                                            |
| `npm audit --omit=dev` and `npm audit`    | PASS   | Zero vulnerabilities reported for the locked production and full dependency graphs                                                                                                                              |
| `docker build --no-cache`                 | PASS   | Linux amd64 image built against the pinned Node 24.22.3 Alpine base                                                                                                                                             |
| Docker runtime                            | PASS   | UID 1000, Node as PID 1, production dependencies and the original MIT notice. Both signals drained an active upload to HTTP 200. A stalled request disconnected and the container exited 1 after 10.38 seconds. |
| `actionlint` 1.7.11                       | PASS   | Workflow file passed static validation                                                                                                                                                                          |

The two newly declared application dependencies were already in the lockfile as transitive dependencies. Npm 11's install-script policy notice concerns the existing development dependency esbuild. The package installation, build and tests completed.

| Compiled source             | Branch coverage |
| --------------------------- | --------------: |
| `app.js`                    |          91.84% |
| `config.js`                 |         100.00% |
| `ip.js`                     |          95.65% |
| `limiter/sliding-window.js` |         100.00% |
| `middleware/rate-limit.js`  |         100.00% |
| `server.js`                 |          92.86% |
| All compiled source         |          96.53% |

Total line coverage was 98.60%. See the [repository's CI runs](https://github.com/alirava56/IP-Sliding-Window-Rate-Limiter/actions/workflows/ci.yml) for hosted results by commit.

## Performance

`npm run bench` ran on Windows 11 Pro x64 with Node 24.22.3, an Intel Core i5-12500H, 12 logical CPUs visible to Node and 7.7 GiB of reported memory.

Each core case measured 100,000 decisions on one thread after a 20,000-decision warmup. A controlled clock provided a 1,000 ms window with a 10,000-key limit. The reclamation case started with a full store and advanced the clock one window per 10,000 replacements. The real-clock HTTP case measured 2,000 complete responses on loopback at concurrency 16.

| Scenario                     | Outcomes                                 | Decisions or requests/s |         p50 / p95 / p99 (µs) | CPU (ms) | Tracked keys |
| ---------------------------- | ---------------------------------------- | ----------------------: | ---------------------------: | -------: | -----------: |
| Single key, exhausted quota  | 10 allowed, 99,990 limited               |               6,142,619 |              0.1 / 0.3 / 0.4 |       31 |            1 |
| 1,000 independent keys       | 100,000 allowed                          |               4,271,807 |              0.1 / 0.4 / 0.5 |       47 |        1,000 |
| High cardinality at capacity | 10,000 allowed, 90,000 capacity refusals |               4,132,658 |              0.1 / 0.5 / 0.6 |       47 |       10,000 |
| Expired bucket reclamation   | 100,000 allowed                          |               1,857,162 |              0.3 / 0.7 / 1.5 |       47 |       10,000 |
| Loopback HTTP                | 1,000 HTTP 200, 1,000 HTTP 429           |                   4,499 | 2,585.3 / 7,353.2 / 10,260.8 |      735 |            1 |

| Scenario                   | Heap before → after (MiB) | RSS before → after (MiB) |
| -------------------------- | ------------------------: | -----------------------: |
| Single key                 |               7.55 → 7.55 |            56.02 → 58.21 |
| Independent keys           |               7.59 → 8.79 |            59.02 → 58.46 |
| High cardinality           |             11.36 → 14.17 |            60.44 → 68.30 |
| Expired bucket reclamation |             14.78 → 15.30 |           72.20 → 109.04 |
| Loopback HTTP              |             11.32 → 14.57 |          137.72 → 149.45 |

Percentiles use nearest rank. Throughput includes the measurement loop, and CPU is user plus system process time. RSS and post-GC heap figures are snapshots that include the harness. The HTTP client and server shared one process, with no TLS or external proxy. The measurements describe one local run.

## Operating scope

The verified limiter contract is an exact per-IP rolling quota in one Node.js process. Restart clears state and replicas have independent quotas. Trusted reverse-proxy behavior was tested with local peers and simulated forwarding chains. Validate the real peer addresses and header handling before enabling proxy trust on a deployment. The [security policy](../SECURITY.md) and [architecture notes](../ARCHITECTURE.md) describe the operating assumptions.
