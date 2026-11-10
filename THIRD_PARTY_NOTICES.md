# Third-party notices

`hanse` is licensed under the MIT License (see [LICENSE](LICENSE)). It includes and depends on the
following third-party software. Full license texts are distributed with each component.

## Runtime npm dependencies

| Package | License |
| --- | --- |
| `@balena/dockerignore` | Apache-2.0 |
| `better-sqlite3` | MIT (bundles SQLite, public domain) |
| `ssh2` | MIT (includes `asn1`, `bcrypt-pbkdf`, `cpu-features`, `nan`, `safer-buffer`, and `tweetnacl` under their respective licenses) |
| `yaml` | ISC |
| `zod` | MIT |

The complete license text of every installed dependency is present in its package directory under
`node_modules/`.

## Client bundle

The Vue client is built with Vite and bundles:

- Vue, Vue Router, Pinia, and `@tanstack/vue-query` — MIT
- Tailwind CSS and daisyUI — MIT

## Vendored static assets

| Component | Version | License | License text |
| --- | --- | --- | --- |
| PrismJS | 1.30.0 | MIT | [`assets/vendor/prism/LICENSE`](assets/vendor/prism/LICENSE) |
| xterm.js | 6.0.0 | MIT | [`assets/vendor/xterm/LICENSE`](assets/vendor/xterm/LICENSE) |
| xterm.js addon-fit | 0.11.0 | MIT | [`assets/vendor/xterm/LICENSE.addon-fit`](assets/vendor/xterm/LICENSE.addon-fit) |
| xterm.js addon-unicode11 | 0.9.0 | MIT | [`assets/vendor/xterm/LICENSE.addon-unicode11`](assets/vendor/xterm/LICENSE.addon-unicode11) |
| xterm.js addon-unicode-graphemes | 0.4.0 | MIT | [`assets/vendor/xterm/LICENSE.addon-unicode-graphemes`](assets/vendor/xterm/LICENSE.addon-unicode-graphemes) |

## Container images

The published images build on Debian, Node.js, code-server, opencode, and other base images. Their
license texts are included in the images under `/usr/share/doc/` and the respective package
directories.
