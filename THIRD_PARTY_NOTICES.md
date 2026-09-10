# Third-Party Notices

This repository captures and redistributes portions of the upstream
[bevy_brp](https://github.com/natepiano/bevy_brp) project.

## bevy_brp / bevy_brp_mcp

- Upstream repository: <https://github.com/natepiano/bevy_brp>
- Captured package: `bevy_brp_mcp` version **0.22.3**
- Pinned upstream commit: `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b`
- License: **MIT**

Portions of this repository derive from the upstream project at the pinned
commit:

- `contracts/bevy-brp-mcp-0.22.3-tools.json` — the tool metadata (names,
  titles, descriptions, annotations, input schemas, and output schemas)
  captured from the upstream `tools/list` response;
- `src/tools/brp-shape.ts` — per-tool success `message` templates and
  `metadata` derivations, BRP error enhancement, format-error type-guide
  embedding, and the serde parameter echo (upstream `brp_tools/tools/*.rs`
  and macros, `brp_client/client.rs`, `brp_client/operation.rs`);
- `src/tools/type-guides/` — the type-guide subsystem: core data model and
  schema/type-kind info, spawn/insert value examples, mutation paths,
  curated Bevy type knowledge, and agent guidance (upstream
  `brp_type_guide/` modules: `response.rs`, `type_kind.rs`,
  `path_example.rs`, `variant_signature.rs`, `guide.rs`,
  `mutation_path_builder/`);
- `src/tools/app.ts` — the app-lifecycle tool semantics: port/profile/
  instance-count validation constants and rules, launch target search order
  and package disambiguation, BRP plugin source detection, the predicted
  builds display, and the launch/status/shutdown message and error shapes
  (upstream `src/app_tools/` including `constants.rs` and `targets/`);
- `src/tools/watches.ts` — the watch tool start/error message shapes and
  result placements (upstream `src/brp_tools/watch_tools/`);
- `src/runtime/watch-manager.ts` and `src/runtime/log-store.ts` — the watch
  lifecycle, log naming, and record line formats (upstream
  `src/brp_tools/watch_tools/` and `src/log_tools/`), with the retired
  upstream `bevy_brp_mcp_` log filename prefix replaced by the
  repository-owned `bevy-mcp` prefix.

These captured metadata and translated portions are used under the upstream
MIT license, reproduced below as it appears in the upstream `mcp/LICENSE-MIT`
at the pinned commit.

## MIT License

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
