xterm.js 6.0.0 + @xterm/addon-fit 0.11.0 (vendored)
==================================================

This directory contains checked-in UMD builds of xterm.js and the fit addon,
used only by `assets/terminal.js`. They are not npm dependencies, there is no
build step for them, and they are served from the same origin through the
explicit asset allowlist in `src/http/handler.ts`. The product stays offline/LAN
friendly: no CDN request is made.

Files:

  LICENSE                 xterm.js upstream MIT license
  LICENSE.addon-fit       @xterm/addon-fit upstream MIT license
  VERSION                 vendored versions
  SHA256SUMS              checksums of the three served files
  xterm-6.0.0.js          UMD build, exposes the `Terminal` global
  xterm-6.0.0.css         terminal viewport styles
  addon-fit-0.11.0.js     UMD build, exposes the `FitAddon` global

`terminal.js` is a classic script (like `app.js`), so the UMD globals are
loaded with `<script defer>` before it and used without a bundler.

Update procedure:

  1. `npm pack @xterm/xterm@<version>` and `npm pack @xterm/addon-fit@<version>`
     in a temporary directory.
  2. Verify `npm view <package>@<version> dist.integrity` matches the tarball
     before extracting. Never vendor a tarball from a non-registry URL.
  3. Copy `package/lib/xterm.js`, `package/css/xterm.css`, and
     `package/lib/addon-fit.js` under the versioned filenames above; copy both
     LICENSE files.
  4. Run `sha256sum` on the three files, update `SHA256SUMS` and `VERSION`, and
     update the versioned paths in `src/http/handler.ts`, `src/http/terminal.ts`,
     and the vendored-xterm test.
  5. Run `npm test` (checksum, size, and asset-serving tests) and `npm run lint`.

Source and integrity:

  xterm 6.0.0:
    tarball:   https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz
    integrity: sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg==

  @xterm/addon-fit 0.11.0:
    tarball:   https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz
    integrity: sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g==
