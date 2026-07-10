# @vcjdeboer/session-patch

**Seal a lab protocol's scientific intent into a canonical, citable identity — then
lower that one sealed intent onto two PyLabRobot drivers so the same intent produces
device-appropriate calls.**

session-patch brings the **Patch** protocol to
[swamp](https://github.com/swamp-club/swamp). A Patch is a sealed statement of intent
at the protocol / instruction layer, content-addressed by a sha256 — an **identity**
you can cite and a byte-exact record you can **reproduce**. Seal it once, lower it onto
any driver, and every run is recorded as swamp data. Three methods:

| Method | Does |
| --- | --- |
| `init` | scaffolds the content-addressed `.patch/` store (one-time), so `seal`/`run` have somewhere to write |
| `seal` | freezes a `.patch.yaml` into the store and records the **64-hex patch sha** (the identity) + its four sealed artifacts (`patch` / `ump` / `syx` / `manifest`) as a typed `patch` resource |
| `run` | lowers ONE sealed Patch (by sha or yaml path) through a chosen driver (`plr-legacy` or `plr-v1b1`) and records the run — status, invocation + call counts, and the full **NDJSON event stream** as a separate `events` blob |
| `resource_model` | captures a resource model (**deck layout**) — deck slots, the role → slot / name / labware maps, and its content-address — as a typed `resource_model` resource |

## Install

```sh
swamp extension pull @vcjdeboer/session-patch
swamp model create @vcjdeboer/session-patch patch
```

## Configuration

Set per instance with `--global-arg`; the published type ships generic defaults, so no
host path is baked into the shared type.

| Arg | Meaning |
| --- | --- |
| `engineCwd` | working directory the engine runs in |
| `repoDir` | directory that holds the `.patch/` store |
| `pythonBin` / `patchModule` | the engine command and module to invoke |

```sh
swamp model create @vcjdeboer/session-patch patch \
  --global-arg engineCwd=path/to/engine \
  --global-arg repoDir=path/to/workdir
```

## Methods

### `init`

```sh
swamp model method run patch init          # scaffolds <repoDir>/.patch/
swamp model method run patch init --input dir=path/to/dir
```

One-time. Records a `repo` resource; `seal`/`run` need this store to exist first.

### `seal`

```sh
swamp model method run patch seal \
  --input patchYaml=path/to/bca_standard_curve.patch.yaml
```

Records a `patch` resource: `{ sha, patchId, files:{patch,ump,syx,manifest},
sourceYaml, sealedAt }`. The 64-hex `sha` IS the patch identity — cite it, and re-run
it later against any driver.

### `run`

```sh
swamp model method run patch run \
  --input ref=<sha-or-yaml> \
  --input adapter=plr-legacy \
  --input innerBackend=recording \
  --input resourceModel=wur_flex_bca@1.0.0
```

Inputs: `ref` (a sealed sha or a `.patch.yaml` path), `adapter` (`plr-legacy` |
`plr-v1b1`), `innerBackend` (default `recording`), and optional `resourceModel`.

Records a `run` resource `{ ref, adapter, backend, status, invocations, plrCalls,
error, parseWarnings, stderr, eventsWritten }` plus a **separate** `events` NDJSON
file instance holding the verbatim event stream. A `run_failed` event is a **valid
data outcome** (recorded as `status: "failed"` with the failure payload); a run that
never reaches a terminal event (`run_completed` / `run_failed`) is surfaced as an
error, not recorded as a phantom success.

### `resource_model`

```sh
swamp model method run patch resource_model --input ref=wur_flex_bca@1.0.0
```

Records a `resource_model` resource `{ id, version, hashId, deckSlots, roles,
roleNames, roleConstraints }`, keyed by `id@version`. `hashId` is a content-address
for the deck layout — a citable identity, like the patch sha. This is the *what is on
the deck* provenance a `run` binds to via its `resourceModel` ref.

## Provenance captured

A sealed patch says *what motions happen*; the resource model says *what is on the
deck*. session-patch records both as swamp data, each content-addressed:

- **`patch`** — the sealed intent, keyed by its sha.
- **`resource_model`** — the deck layout (slots + role → labware bindings), keyed by
  its hash.

Together they make a run reproducible against a known deck. The reagent / experiment
layer — which standards, samples, and reagents map to which wells — is the next
provenance layer to capture.

## Same intent, two drivers

Seal once, then run the same sha through both drivers — all through swamp:

```sh
swamp model method run patch init
swamp model method run patch seal --input patchYaml=path/to/bca_standard_curve.patch.yaml
swamp model method run patch run  --input ref=<sha> --input adapter=plr-legacy --input resourceModel=wur_flex_bca@1.0.0
swamp model method run patch run  --input ref=<sha> --input adapter=plr-v1b1  --input resourceModel=wur_flex_bca@1.0.0
```

Both drivers produce the **same invocation and call counts** and both reach
`run_completed` — it is the same sealed sha, run twice. But the lowered device calls
**differ**:

```
                        ┌─ plr-legacy  →  resource = "role:2"              string role refs
  sha 406dbe7f…3f26b  ──┤
                        └─ plr-v1b1    →  resource = "RoleRef(role_id=2)"  typed role objects
```

That divergence **is the point**: the sealed Patch is the abstraction at the protocol
/ intent layer, and each driver transposes it into calls appropriate to its device —
while the identity (the sha), the provenance (the event stream), and the
reproducibility (the sealed bytes) are carried by swamp.

> `bca_standard_curve` runs on both drivers. `column_fill_demo` runs on `plr-legacy`
> only, so it does not show the two-driver contrast.

## Anatomy of a sealed Patch

A sealed Patch is a canonical **bytestring** — content-addressed, so its sha256 *is*
its identity. Here is a small one (`column_fill_demo`, 129 bytes), frame by frame:

```
header frame — patch.header
  70000000 00                        schema_id + instance
  0005                               schema_set_version = 5
  96a691f8477f1ac3b49cf526efd39133   patch_id_hash         (16 B)
  5ce30f9b36feccdab7a946cccc241f5a   resource_model_id     (16 B)
  00000000000000000000000000000000   derived_from = root   (16 B)
  0001                               patch_version = 1

invocation frame — PIP.transfer
  60005005 00                        schema_id + device_role
  080100ffff 02002a…2a02542a ff      source, 8 targets, per-well volumes  (30 B)

footer frame — patch.footer
  70000001 00                        schema_id + instance
  eaa251bd51ae9716…d569a67c804c64b3  sha256(header + invocations)  (32 B)

patch_id = sha256(all 129 bytes)
  = a8284a7c35a8be9bf47381542dbb3b576c277be684a92882a86701b6ab3efc3a
```

## Implementation

session-patch is written in TypeScript. A canonical byte codec (canonical / UMP /
SysEx1 frames) provides the sha256 **identity**; a schema-driven Player, per-capability
lowering, resource-model role resolution, and both driver adapters produce each run.

- **Identity is byte-exact.** `sha256(canonical) === patch_id`, verified against the
  sealed-byte fixtures; the UMP and SysEx1 wire encodings round-trip bit-for-bit.
- **The two-driver run is verified call-for-call.** The full event stream — 19 device
  calls per driver, both drivers, including the `role:N` vs `RoleRef(role_id=N)`
  transposition — is reproduced exactly.

## License

See [LICENSE.md](./LICENSE.md). MIT.
