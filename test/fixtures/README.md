# Test fixtures — real `@deepseek-ai/dsh-settings` generations

Vendored, unmodified runtime files extracted from the published npm tarballs of
[`@deepseek-ai/dsh-settings`](https://www.npmjs.com/package/@deepseek-ai/dsh-settings)
(the DeepSeek Harness settings seam), one representative generation per API era:

| directory | npm version | why it is in the matrix |
| --- | --- | --- |
| `dsh-settings/0.0.1-rc.1` | `0.0.1-rc.1` | earliest published surface (`Settings` era), helpers exported |
| `dsh-settings/0.1.1-rc.2` | `0.1.1-rc.2` | legacy section-registry era, helpers exported |
| `dsh-settings/0.1.7-rc.2` | `0.1.7-rc.2` | `SettingsForms` seam lands; `installSettingsSection` / `settingsNamespace` **removed** |
| `dsh-settings/0.2.1-alpha.1` | `0.2.1-alpha.1` | current DSH NEXT surface |

`test/compat.mjs` loads the plugin against each generation and installs its
settings on both host seam shapes. Only `lib/index.js`, `lib/invariant.js` and
`package.json` are kept (the `.d.ts` types and READMEs are not needed at
runtime); each directory carries the upstream `LICENSE` (MIT, © DeepSeek).

Upstream: <https://github.com/deepseek-ai/deepseek-harness> —
`packages/settings/settings`. To refresh a generation:
`npm pack @deepseek-ai/dsh-settings@<version>` and extract those files.
