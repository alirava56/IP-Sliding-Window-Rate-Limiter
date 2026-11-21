# IP Sliding Window Rate Limiter

An Express 5 service and TypeScript middleware that enforce an exact rolling quota per client IP. A fixed window can admit back-to-back bursts at its boundary. This limiter keeps an acceptance log so the quota applies to every rolling interval.

- Shared quota across `/api` routes with actionable `429` response headers.
- Canonical IPv4 and IPv6 identities and explicit reverse-proxy trust.
- Bounded in-memory state with an explicit `503` policy at capacity.
- Deterministic Node.js tests, a standalone smoke check, and a multi-stage Docker image.

[راهنمای نصب و انتشار در ویندوز](SETUP-FA.md)

## Quick start

Use the latest patched Node.js 22 or 24 release and its bundled npm. The baseline for this release is Node.js 22.23.5 or 24.22.3 on the corresponding major line.

```sh
npm ci
npm run dev
```

In another terminal, make a health request and an API request.

```sh
curl -i http://localhost:3000/health
curl -i http://localhost:3000/api/demo
curl -i http://localhost:3000/api/echo -H 'Content-Type: application/json' -d '{"hello":"world"}'
```

Each IP gets 10 API requests per 60 seconds by default. For the compiled service, use `npm run build` and then `npm start`. The standalone `npm run smoke` command builds and starts its own loopback listener and checks for 10 successes and two `429` responses.

## Architecture and algorithm

Express identifies the network peer or walks a trusted proxy chain, normalizes the resulting address, and calls the synchronous limiter before parsing JSON or invoking a handler. A process-local Map stores a timestamp array per canonical IP.

For time `t`, the active interval is **`(t - windowMs, t]`**. The limiter expires timestamps at or before the lower boundary, rejects if the quota is full, and appends `t` exactly once on acceptance. Rejections leave the log and retry boundary unchanged. For a 2-request, 1000 ms window, requests at 0 ms and 500 ms succeed, a request at 999 ms is blocked, and a request at 1000 ms can take the expired slot.

The log makes the exact quota and the earliest slot release computable from the same data. Timestamp storage costs up to `K × Q` slots for `K` tracked keys and `Q` requests per key. Checks without partial expiration take expected amortized O(1) time. Pruning an array takes O(Q) in the worst case. A full store checks its oldest bucket in expected amortized O(1). A sweep of E expired buckets visits those buckets and at most one active bucket. The configured slot budget bounds stored timestamps. Heap usage also depends on Maps, key lengths, arrays, the runtime and HTTP connections.

[Architecture and design decisions](docs/ARCHITECTURE.md)

## Configuration

Set environment variables before starting Node. `.env.example` shows the supported values. For Docker, pass overrides explicitly with `--env-file`.

| Variable                  | Default | Valid values                                                  |
| ------------------------- | ------: | ------------------------------------------------------------- |
| `PORT`                    |  `3000` | Integer 1–65,535                                              |
| `RATE_LIMIT_WINDOW_MS`    | `60000` | Integer 100–3,600,000 ms                                      |
| `RATE_LIMIT_MAX_REQUESTS` |    `10` | Integer 1–10,000                                              |
| `MAX_TRACKED_IPS`         | `10000` | Integer 1–1,000,000                                           |
| `TRUSTED_PROXY_CIDRS`     |   Empty | Up to 32 comma-separated literal IPv4/IPv6 addresses or CIDRs |

Numeric settings use decimal digits without a sign, leading zeroes or whitespace. The product of `RATE_LIMIT_MAX_REQUESTS` and `MAX_TRACKED_IPS` must be at most 1,000,000. Invalid settings fail startup. PowerShell example:

```powershell
$env:RATE_LIMIT_MAX_REQUESTS = '3'
npm.cmd run dev
```

### Reverse-proxy trust

An empty allowlist uses the socket peer's IP and ignores `X-Forwarded-For`. Set `TRUSTED_PROXY_CIDRS` to the actual source addresses or dedicated subnets of proxies you operate. For example, `127.0.0.1/32` identifies a reverse proxy on IPv4 loopback when that listener is isolated from untrusted local processes. Keep the application listener behind the proxy using network access controls and have the edge overwrite inbound forwarding headers. Each trusted downstream proxy must preserve an accurate chain. Express walks from the socket peer toward the client and stops at the nearest untrusted address.

Earlier releases used `TRUST_PROXY_HOPS`. A positive hop count trusts request paths by length, so a shorter or direct path can let a public connection be treated as a proxy. Replace any positive setting with the explicit allowlist. The legacy literal `0` is accepted during migration. Simulated proxy tests verify application behavior. Deployment owners must verify the actual peers and forwarding rules. [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/) · [Security policy](docs/SECURITY.md)

## HTTP API

| Method | Path        | Result                                                    |
| ------ | ----------- | --------------------------------------------------------- |
| `GET`  | `/health`   | Basic liveness JSON, exempt from quota                    |
| `GET`  | `/api/demo` | Acceptance message and canonical client IP                |
| `POST` | `/api/echo` | Echoes an `application/json` object or array up to 16 KiB |

The quota counts requests admitted to the `/api` pipeline, including downstream JSON errors and unknown API paths. A missing body yields `data: null`, as does a body with a media type outside the JSON parser. The service accepts uncompressed JSON and returns `415` for unsupported JSON charset or content encoding. Every Express response carries `Cache-Control: no-store`.

```http
GET /api/demo HTTP/1.1
Host: localhost:3000

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
RateLimit-Limit: 10
RateLimit-Remaining: 9
RateLimit-Reset: 60

{"message":"Request accepted","ip":"127.0.0.1"}
```

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
RateLimit-Limit: 10
RateLimit-Remaining: 0
RateLimit-Reset: 58
Retry-After: 58

{"error":"TOO_MANY_REQUESTS","message":"Rate limit exceeded. Please retry later."}
```

| Header                | Meaning                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `RateLimit-Limit`     | Maximum accepted requests per rolling window                                                                                |
| `RateLimit-Remaining` | Available slots immediately after the decision                                                                              |
| `RateLimit-Reset`     | Delta seconds until the oldest active timestamp expires, rounded up. Slots recover as individual timestamps age out.        |
| `Retry-After`         | On `429`, the same delta as reset. On capacity `503`, a one-second retry hint with admission subject to available capacity. |

The three `RateLimit-*` fields are this service's compatibility contract. Clients can use the standard delay-seconds form of `Retry-After`. Shared traffic may consume a slot before a retry arrives. [HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) · [IETF RateLimit work](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)

Errors use a JSON `error` code and `message`. Invalid identity or JSON returns `400`, unknown routes return `404`, oversized JSON returns `413`, and unexpected application errors return a generic `500`. A new IP gets `503` when every bucket is active. Existing clients keep their history. Invalid identities and capacity rejections carry no per-IP quota fields.

## Tests and CI

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:core
npm run test:coverage
npm run smoke
npm audit --omit=dev
```

The coverage command runs all tests and enforces a 90% aggregate branch threshold for compiled source. Tests cover five seeded reference-model streams, controlled time, HTTP headers and routing, concurrent admissions, and shutdown. CI installs the lockfile and runs the quality gates on Node.js 22 and 24. [Workflow](.github/workflows/ci.yml) · [Verification evidence](docs/verification/FINAL-REPORT.md)

## Docker

```sh
docker build -t ip-sliding-window-limiter .
docker run --rm --stop-timeout 12 -p 127.0.0.1:3000:3000 ip-sliding-window-limiter
```

The image uses a digest-pinned Node 24 Alpine base and runs Node as the non-root `node` user with only production dependencies. The service drains active HTTP connections for up to ten seconds after a shutdown signal. Allow the container runtime enough time to deliver the signal and let the process drain.

## Benchmarks

```sh
npm run bench
```

The script reports throughput, p50/p95/p99 latency, CPU time, tracked clients, and before/after heap and RSS snapshots. In one local Windows run on Node 24.22.3, 2,000 loopback requests at concurrency 16 produced 1,000 responses of each status, `200` and `429`. Throughput was 3,941 requests/s with p95 of 8.00 ms. The core scenarios each ran 100,000 decisions across repeated clients, independent keys, full capacity and expiration. [Environment, measurements and limitations](docs/verification/FINAL-REPORT.md#performance)

## Deployment scope and future work

State belongs to one Node process and resets on restart. NAT users share a quota, while different IPv6 addresses have independent quotas. A full store can temporarily deny service to new IPs. `/health` remains available during throttling. Perimeter controls handle connection pressure and traffic floods ahead of Node.

The next steps for multi-replica deployment are an atomic shared store, an explicit capacity and outage policy, and metrics for admissions, rejections and memory pressure. Account-based quotas can complement IP quotas where authentication is available. [Design and distribution plan](docs/ARCHITECTURE.md) · [Threat model and disclosure](docs/SECURITY.md)

## License

MIT. [License text](LICENSE)
