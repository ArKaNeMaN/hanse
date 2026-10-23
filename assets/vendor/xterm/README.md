xterm.js 6.0.0 + addons (vendored)
==================================

This directory contains checked-in UMD builds of xterm.js, the fit addon, and
the Unicode 11 and Unicode 15 grapheme addons, used only by
`assets/terminal.js`. They are not npm dependencies, there is no build step for
them, and they are served from the same origin through the explicit asset
allowlist in `src/http/handler.ts`. The product stays offline/LAN friendly: no
CDN request is made.

Files:

  LICENSE                           xterm.js upstream MIT license
  LICENSE.addon-fit                 @xterm/addon-fit upstream MIT license
  LICENSE.addon-unicode11           @xterm/addon-unicode11 upstream MIT license
  LICENSE.addon-unicode-graphemes   @xterm/addon-unicode-graphemes upstream MIT license
  VERSION                           vendored versions
  SHA256SUMS                        checksums of the five served files
  xterm-6.0.0.js                    UMD build, exposes the `Terminal` global
  xterm-6.0.0.css                   terminal viewport styles
  addon-fit-0.11.0.js               UMD build, exposes the `FitAddon` global
  addon-unicode11-0.9.0.js          UMD build, exposes the `Unicode11Addon` global
  addon-unicode-graphemes-0.4.0.js  UMD build, exposes the `UnicodeGraphemesAddon` global

`terminal.js` is a classic script (like `app.js`), so the UMD globals are
loaded with `<script defer>` before it and used without a bundler. The
graphemes addon is experimental upstream; `terminal.js` activates its
`15-graphemes` provider and falls back to the stable `11` provider if the
graphemes addon cannot load.

Update procedure:

  1. `npm pack @xterm/xterm@<version>`, `npm pack @xterm/addon-fit@<version>`,
     `npm pack @xterm/addon-unicode11@<version>`, and
     `npm pack @xterm/addon-unicode-graphemes@<version>` in a temporary
     directory.
  2. Verify `npm view <package>@<version> dist.integrity` matches the tarball
     before extracting. Never vendor a tarball from a non-registry URL.
  3. Copy `package/lib/xterm.js`, `package/css/xterm.css`,
     `package/lib/addon-fit.js`, `package/lib/addon-unicode11.js`, and
     `package/lib/addon-unicode-graphemes.js` under the versioned filenames
     above; copy the LICENSE files.
  4. Run `sha256sum` on the five served files, update `SHA256SUMS` and
     `VERSION`, and update the versioned paths in `src/http/handler.ts`,
     `src/http/terminal.ts`, and the vendored-xterm tests.
  5. Run `npm test` (checksum, size, and asset-serving tests) and `npm run lint`.

Source and integrity:

  xterm 6.0.0:
    tarball:   https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz
    integrity: sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg==

  @xterm/addon-fit 0.11.0:
    tarball:   https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz
    integrity: sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g==

  @xterm/addon-unicode11 0.9.0:
    tarball:   https://registry.npmjs.org/@xterm/addon-unicode11/-/addon-unicode11-0.9.0.tgz
    integrity: sha512-FxDnYcyuXhNl+XSqGZL/t0U9eiNb/q3EWT5rYkQT/zuig8Gz/VagnQANKHdDWFM2lTMk9ly0EFQxxxtZUoRetw==

  @xterm/addon-unicode-graphemes 0.4.0:
    tarball:   https://registry.npmjs.org/@xterm/addon-unicode-graphemes/-/addon-unicode-graphemes-0.4.0.tgz
    integrity: sha512-9+/CqwbKcnlkJU4d3wIgO+wjsL8f6vyz+UwUWLu6nADQz8Gr8ONqGCJfdDjIdI+yYZLABQqQy47FzEM6AWELjw==
