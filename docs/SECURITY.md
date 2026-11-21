# Security policy

## Threat model

The service accepts untrusted IP traffic and JSON over HTTP. A client can control request headers and bodies, send simultaneous requests, and appear under several egress IPs. The domain of the limiter is one process and one IP identity at a time. Reverse proxies, their source addresses and their forwarding rules are operated by the deployer.

| Concern                         | Control and residual scope                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forwarding header spoofing      | Proxy trust is disabled by default. With a proxy allowlist, Express walks past only explicitly trusted source addresses. Anyone who can connect from a trusted range is inside that trust boundary.                                                                                                               |
| Equivalent client addresses     | Address validation and canonicalization occur before quota use. Only IPv4-mapped IPv6 collapses to native IPv4. IPv6 address rotation and shared IPv4 egress are limitations of per-IP policy.                                                                                                                    |
| High-cardinality client traffic | Bucket and timestamp budgets cap stored state. Active buckets stay in place. New IPs receive `503` until a slot can be reclaimed. Use ingress connection and request controls for pressure before the app.                                                                                                        |
| Body and connection pressure    | Quota admission precedes the echo route's bounded UTF-8 read. Unsupported media and encodings return `415`, and uploads over 16 KiB return `413` with connection close. Node enforces header and request timeouts. Ingress limits remain important for transport floods and requests with bodies on other routes. |
| Information exposure            | JSON errors use stable codes and generic 500 responses. Application logs omit request headers and bodies. Express responses use `Cache-Control: no-store`. The demo endpoint exposes the request's canonical IP to that caller.                                                                                   |
| Public liveness                 | The health route returns a minimal static payload independent of the limiter. Restrict exposure at ingress if only internal probes need it.                                                                                                                                                                       |

## Proxy deployment requirements

Keep Node on a private network or a listener accessible only to the intended peers. Use literal proxy source IPs or narrowly scoped subnets containing only proxy infrastructure. Overwrite inbound `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` at the edge. In multi-proxy deployments, configure downstream proxies to maintain the sanitized chain. Verify all paths to the application and the actual source address observed by Node, including any NAT or sidecars. If the proxy supplies no forwarding chain, its socket address becomes the shared quota identity.

Hop counts alone cannot distinguish a proxy from a direct connection. Older configurations with a positive `TRUST_PROXY_HOPS` value fail startup and require explicit migration. The loopback integration tests exercise Express with simulated peers and headers. Validate forwarding and access controls on the deployment network before enabling trust. [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/)

## Supported configuration and disclosure

Use the latest patched Node.js 22 or 24 release within the supported lines. Keep the dependency lockfile and the Docker base digest current. The service runs with process-local state and is intended to sit behind TLS termination and ingress controls if exposed publicly.

Once the project is hosted, use GitHub's private vulnerability reporting if enabled, or contact the repository owner privately for a disclosure channel. Include the affected version, impact, prerequisites and a minimal sanitized reproduction. Keep credentials, private infrastructure details and third-party data out of public issues. [GitHub private reporting guidance](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)
