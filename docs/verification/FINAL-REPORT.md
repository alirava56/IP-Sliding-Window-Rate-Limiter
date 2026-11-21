# Release verification

Verified on 2026-11-21. The implementation and lockfile are in local commit `263f69a`. See the [baseline audit](BASELINE-AUDIT.md) for the original behavior and the regression checks that address it.

## Commands and results

The Windows run began with a fresh local Git clone, without `node_modules` or `dist`. It used Node.js 24.22.3 and npm 11.16.0. Separate fresh checkouts in Docker ran the workflow commands on Debian with Node.js 22.23.5 and npm 10.9.9, and on Alpine with Node.js 24.22.3 and npm 11.19.1.

| Command or check               | Result       | Evidence                                                                                                                                                                                     |
| ------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                       | PASS         | Installed 177 packages on each of the three environments.                                                                                                                                    |
| `npm run typecheck`            | PASS         | Strict TypeScript check exited 0 on Windows and both Linux runs.                                                                                                                             |
| `npm run lint`                 | PASS         | ESLint exited 0 with the zero-warning limit on Windows and both Linux runs.                                                                                                                  |
| `npm run format:check`         | PASS         | Prettier exited 0 on Windows and both Linux runs.                                                                                                                                            |
| `npm run build`                | PASS         | Compiled the service and produced `dist/src/server.js` on each environment.                                                                                                                  |
| `npm test`                     | PASS         | 50 passed, zero failed or skipped on Windows.                                                                                                                                                |
| `npm run test:core`            | PASS         | 18 passed from the Windows clone before any manual build.                                                                                                                                    |
| `npm run test:coverage`        | PASS         | 50 passed on all three environments. Coverage was 99.03% lines, 96.25% branches and 95.56% functions.                                                                                        |
| `npm run smoke`                | PASS         | Built and opened a private loopback listener. Observed 10 admissions, two 429s and a working health route in each environment. A second Windows clone ran it before any other build.         |
| `npm audit --omit=dev`         | PASS         | Registry returned zero advisories for the production dependency set.                                                                                                                         |
| `npm audit`                    | PASS         | Registry returned zero advisories including development dependencies.                                                                                                                        |
| `npm run dev` and `npm start`  | PASS         | Both loaded a PowerShell process environment override and handled health 200, JSON echo 200 and subsequent demo 429 at quota 1.                                                              |
| `docker build --no-cache`      | PASS         | Built the Linux amd64 runtime from the digest-pinned Node.js 24.22.3 Alpine image.                                                                                                           |
| Container startup and shutdown | PASS         | Health and demo returned 200. Node ran as PID 1 and UID 1000. `/app` contained compiled code, production dependencies and a byte-identical copy of the MIT license.                          |
| `actionlint` 1.7.11            | PASS         | The workflow passed static validation. All required npm steps ran locally against both Node versions in the matrix.                                                                          |
| Git history and source review  | PASS         | Gitleaks 8.30.1 reported no detected secrets. Confirmed the lockfile is tracked, dependency artifacts and local env files are ignored, and the original MIT license matches its source hash. |
| Hosted GitHub Actions          | NOT VERIFIED | The project is still local. The first push or pull request will trigger the hosted workflow.                                                                                                 |

Npm 11 printed an install-script policy notice for development dependency esbuild. Installation, the TypeScript build and the `tsx` development command completed. The production image installed its 66 packages in a dedicated stage with `npm ci --omit=dev`. Registry audit results are specific to the lockfile and the audit date.

### Branch coverage

| Compiled source             | Branches covered |
| --------------------------- | ---------------: |
| `config.js`                 |          100.00% |
| `ip.js`                     |           95.65% |
| `limiter/sliding-window.js` |          100.00% |
| `middleware/rate-limit.js`  |          100.00% |
| `app.js`                    |           85.71% |
| `server.js`                 |           89.47% |
| All compiled source         |           96.25% |

The core tests compare 15,000 generated operations against a reference log over five reproducible seeds. The HTTP concurrency test admits exactly five of 20 simultaneous requests with a fixed clock. The app-level tests exercise proxy decisions under simulated conditions. Production proxy network controls require separate validation on the target deployment.

### Container lifecycle

- `docker stop --time 12` delivered SIGTERM and the idle service exited 0.
- SIGINT followed by SIGTERM while an admitted upload was active allowed the upload to finish with HTTP 200. The container exited 0.
- A stalled request was disconnected after SIGTERM. The container exited 1 in 10.38 seconds, including the Docker signal and wait calls.

## Performance

The command `npm run bench` ran on Windows 11 Pro x64, build 26300, with Node.js 24.22.3, an Intel Core i5-12500H, 12 logical CPUs visible to Node and 7.7 GiB of reported system memory.

The core warmed up with 20,000 decisions, then made 100,000 single-threaded decisions per scenario using a controlled 1,000 ms window and a 10,000-client cap. The reclamation case prefilled the store and advanced the clock one window per 10,000 replacements. The HTTP case warmed 16 loopback workers on health checks and measured 2,000 complete responses on one client IP, with a 1,000-request quota in 60 seconds.

| Scenario                     | Outcomes                                 | Decisions or requests/s |         p50 / p95 / p99 (µs) | CPU (ms) | Tracked IPs |
| ---------------------------- | ---------------------------------------- | ----------------------: | ---------------------------: | -------: | ----------: |
| Single key, exhausted quota  | 10 allowed, 99,990 limited               |               5,344,307 |              0.1 / 0.3 / 0.4 |       32 |           1 |
| 1,000 independent keys       | 100,000 allowed                          |               2,640,864 |              0.1 / 0.6 / 0.9 |       78 |       1,000 |
| High cardinality at capacity | 10,000 allowed, 90,000 capacity refusals |               2,514,281 |              0.2 / 0.6 / 0.7 |       63 |      10,000 |
| Expired bucket reclamation   | 100,000 allowed                          |               1,734,290 |              0.3 / 0.7 / 1.6 |      140 |      10,000 |
| Loopback HTTP                | 1,000 HTTP 200, 1,000 HTTP 429           |                   3,941 | 3,191.2 / 8,000.6 / 11,198.1 |      813 |           1 |

| Scenario                   | Heap before → after (MiB) | RSS before → after (MiB) |
| -------------------------- | ------------------------: | -----------------------: |
| Single key                 |               7.54 → 7.54 |            56.23 → 58.63 |
| Independent keys           |               7.58 → 8.77 |            59.48 → 58.94 |
| High cardinality           |             11.35 → 14.09 |            61.11 → 67.79 |
| Expired bucket reclamation |             14.70 → 15.22 |           73.20 → 109.08 |
| Loopback HTTP              |             11.32 → 14.45 |          133.37 → 150.68 |

Percentiles use nearest rank on per-operation samples. Throughput uses elapsed time for the full measured loop. Timing and decision collection add overhead. CPU is user plus system time, across the whole process. RSS and post-GC heap figures are snapshots and include the harness state. Loopback client and server ran in the same process with no TLS or external proxy, and the core case omitted HTTP. Results describe a single local run.

A preliminary run using a Map iterator to discover the oldest entry reclaimed 137,568 decisions/s with p99 of 18.9 µs. The final implementation links the existing buckets and keeps a direct pointer to the oldest one. The reclamation run above measured 1,734,290 decisions/s at p99 of 1.6 µs. The measurement supports the choice to avoid restarting Map iteration after deletions.

## Release gates

| Gate                      | Status | Basis                                                                                                                                            |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A — Correctness           | PASS   | Exact expiry boundaries, clock handling and IP canonicalization passed regression and reference-model checks.                                    |
| B — Security              | PASS   | Default and explicit proxy trust, input limits, safe HTTP responses, dependency audits and secret scan passed within the local scope.            |
| C — Reliability           | PASS   | Capacity reclamation, concurrency and bounded shutdown passed tests and Docker verification.                                                     |
| D — Code quality          | PASS   | Typecheck, lint, formatting and build passed.                                                                                                    |
| E — Testing               | PASS   | 50 tests passed in all three environments. Each critical module passed the 90% branch coverage target.                                           |
| F — Reproducibility       | PASS   | Clean-clone installs, builds and the digest-pinned container build succeeded.                                                                    |
| G — Documentation         | PASS   | Development and compiled startup, commands, endpoint behavior and operational requirements were checked against the code.                        |
| H — Publication readiness | PASS   | Source and packaging checks passed, and the workflow passed static and local matrix validation. Hosted execution remains pending the first push. |

**GO — READY FOR GITHUB PORTFOLIO PUBLICATION**
