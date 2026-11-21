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

Runtime dependency license texts ship with the installed packages in the build environment. The
Mermaid client bundle is a client devDependency, so the final image does not contain its
`node_modules` tree; its texts are checked in under [`licenses/`](licenses/) and linked below.

## Client bundle

The Vue client is built with Vite and bundles:

- Vue, Vue Router, Pinia, and `@tanstack/vue-query` — MIT
- Tailwind CSS and daisyUI — MIT
- Mermaid 12.3.0 and its bundled dependency tree — see [`licenses/components.md`](licenses/components.md)
  and the per-package texts under [`licenses/packages/`](licenses/packages/). The tree includes MIT,
  ISC, BSD-3-Clause, Apache-2.0, MPL-2.0, and EPL-2.0 components (Mermaid MIT; elkjs EPL-2.0;
  DOMPurify MPL-2.0/Apache-2.0; chevrotain Apache-2.0; d3-sankey BSD-3-Clause). `npm run
  licenses:collect` regenerates the files; `npm run licenses:collect -- --check` verifies them.

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
