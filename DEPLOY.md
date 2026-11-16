# DEPLOY — one target: Caddy, same origin

The app is served from the factory host and talks to the bridge on the same
origin. There is no second deployment target and no CORS in the request path.

## Build

```bash
VITE_BRIDGE_URL=https://factory.usman-hermes.duckdns.org npm run build:app
# → dist-app/index.html + dist-app/assets/{index-*.js,index-*.css}
```

`ui-app/vite.config.ts` **throws** if `VITE_BRIDGE_URL` is missing or is not a bare
`http(s)://` URL. The absolute same-origin URL is deliberate: it satisfies the
guard, and because Caddy serves both the app and the API under that hostname the
request is still same-origin — no preflight, no credentials flag, no CORS.

## Serve

Caddy serves the working tree directly, so a build is the whole deploy:

```
factory.usman-hermes.duckdns.org {
    handle /webhook/github { reverse_proxy 127.0.0.1:8787 }   # HMAC, public
    handle /oauth2/*       { reverse_proxy 127.0.0.1:4180 }   # GitHub SSO
    handle {
        forward_auth 127.0.0.1:4180 { ... }
        handle /api/* {
            reverse_proxy 127.0.0.1:8787 {
                header_up X-Farm-User {http.request.header.X-Auth-Request-User}
            }
        }
        handle /ws {
            reverse_proxy 127.0.0.1:8787 {
                header_up X-Farm-User {http.request.header.X-Auth-Request-User}
            }
        }
        handle {
            root * /home/ubuntu/factory-ui-repo/dist-app
            try_files {path} /index.html
            file_server
        }
    }
}
```

Publish a new build with:

```bash
cd ~/factory-ui-repo && git pull && \
  VITE_BRIDGE_URL=https://factory.usman-hermes.duckdns.org npm run build:app
```

No reload, no restart: the next request serves the new asset hash.

## Why there is no Cloudflare target

Cloudflare Pages was explored and dropped. `factory-ui.pages.dev` was never
created, and a second origin would have cost CORS, a different auth path, and a
session cookie that cannot reach the bridge. The origin list in
`~/.config/factory-bridge/env` now names only this host.

`npx wrangler login` is also unusable on this host: it binds a browser callback
to `localhost:8976` on a headless machine.

## Verify a deploy

```bash
# 1. the build produced the expected hash
grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist-app/index.html

# 2. the behavior is actually in the shipped bundle
grep -c 'localStorage\|max-width: 760px' dist-app/assets/*.js

# 3. the edge answers (302 to SSO is correct when unauthenticated)
curl -s -o /dev/null -w '%{http_code}\n' https://factory.usman-hermes.duckdns.org/
```

A green build is not proof the code shipped; step 2 is.
