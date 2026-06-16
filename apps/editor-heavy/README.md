# editor-heavy - the heavy editor mode

The opt-in heavy mode: the real microsoft/vscode "for web", built from source, as
a full IDE for LB scripts. Web-only for now. It needs cross-origin isolation
(`SharedArrayBuffer` for the web tsserver), so it must be served with COOP/COEP
headers and can't go on a header-less static host like GitHub Pages.

Live (static, currently a read-only demo): <https://cb.2d.rocks/liquid-ide/>.

Typings use a build-time ambient-module barrel (`@lb-ide/core`'s `gen-barrel.mjs`)
so deep `@wunk` imports resolve without per-file tsserver probing. The LB build
itself reuses [`@lb-ide/core`](../../packages/lb-ide-core/) (same pipeline as lean).

## Layout

```
host/         the static deploy build (build-static.mjs) + a dev-only node host
              that serves the vscode-web bundle under COI. See host/DEPLOY.md.
lb-glue/      web extension: builds the project via @lb-ide/core (esbuild-wasm
              in-thread, survives COEP) and talks to the host bridge. Adds the
              in-client dev loop (build & run, hot-reload, REPL, log, debug).
lb-fs/        web extension: an `lbfs:/` FileSystemProvider that provisions a
              workspace from the bridge and mirrors writes back.
server-java/  a dependency-free (JDK-only) server that serves the bundle under
              COI and exposes the bridge over HTTP + WebSocket, runnable headlessly
              in-client. See server-java/README.md.
```

The from-source vscode-web bundle (~194 MB, ~9.3 MB gz core) is built outside the
repo and is reproducible; the build recipe and the deploy steps are in
[`host/DEPLOY.md`](host/DEPLOY.md).

## Status

The web path is proven end-to-end on this VM (render under COI, barrel
intellisense, build via core, bridge round-trip over HTTP and WS). The
in-LB-client wiring of the Java server, and webviews under the shared-domain path,
are follow-ups that need a real client / dedicated origin. See `host/DEPLOY.md`
and `server-java/README.md`.
