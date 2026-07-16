/**
 * @vcjdeboer/session-patch — a thin swamp wrapper around the PyLabRobot "Patch"
 * engine.
 *
 * A Patch is a sealed, canonical, citable statement of scientific INTENT at the
 * protocol/instruction layer — content-addressed by a sha256 so it is an IDENTITY
 * you can cite and reproduce. This model does two things and only two:
 *
 *   `seal` — freeze a `.patch.yaml` into the engine's content-addressed store and
 *            record the 64-hex patch SHA + the four sealed artifacts
 *            (patch / ump / syx / manifest) as a typed `patch` resource.
 *   `run`  — lower ONE sealed intent through a chosen PLR adapter (`plr-legacy`
 *            or `plr-v1b1`) and record the run outcome (invocations, plr calls,
 *            status) plus the full NDJSON event stream as a blob.
 *
 * The thesis: the SAME sealed sha, run through both adapters, lowers to
 * DEVICE-APPROPRIATE calls that differ (e.g. `RoleRef(role_id=4)` under v1b1 vs
 * `role:4` under legacy). Abstraction at the protocol/intent layer, transposed
 * per device — provenance and reproducibility carried by the sealed bytes.
 *
 * This is a THIN WRAPPER: it shells the engine's CLI
 * (`<pythonBin> -m plr_v4.patch.presentation.cli ...`) with an argv array (never a
 * shell string) and records typed swamp resources. The published TYPE ships
 * generic defaults (`python3`, cwd `.`); machine-specific paths (the venv python,
 * the engine cwd, the repo dir) are pinned at model-INSTANCE creation.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  /** Python interpreter that has the Patch engine installed. Generic default; the instance pins the venv python. */
  pythonBin: z.string().default("python3"),
  /** Python module path of the Patch CLI. */
  patchModule: z.string().default("plr_v4.patch.presentation.cli"),
  /** Directory to run python from (the PLR / titronic root). Generic default; pinned at instance creation. */
  engineCwd: z.string().default("."),
  /** Directory that CONTAINS the engine's `.patch/` store. Generic default; pinned at instance creation. */
  repoDir: z.string().default("."),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SealArgsSchema = z.object({
  /** Path to a `.patch.yaml` to seal (relative to engineCwd, or absolute). */
  patchYaml: z.string().min(1),
});

const RunArgsSchema = z.object({
  /** The patch to run: a sealed 64-hex sha, or a path to a `.patch.yaml`. */
  ref: z.string().min(1),
  /** Which PLR adapter lowers the sealed intent to device calls. */
  adapter: z.enum(["plr-legacy", "plr-v1b1"]).default("plr-legacy"),
  /** The adapter's inner backend (e.g. "recording"). Backend arg is `<adapter>:<innerBackend>`. */
  innerBackend: z.string().default("recording"),
  /** Optional resource model to bind (e.g. "wur_flex_bca@1.0.0"); empty => omit `--rm`. */
  resourceModel: z.string().default(""),
});

const InitArgsSchema = z.object({
  /** Directory to scaffold the engine's `.patch/` store in; empty => repoDir. */
  dir: z.string().default(""),
});

const SealedFilesSchema = z.object({
  patch: z.string(),
  ump: z.string(),
  syx: z.string(),
  manifest: z.string(),
});

const PatchSchema = z.object({
  /** The 64-hex content-address SHA that IS the patch identity. */
  sha: z.string(),
  /** patch_id read from the manifest.json, when available. */
  patchId: z.string().default(""),
  /** The four sealed artifact paths the engine wrote (repo-relative). */
  files: SealedFilesSchema,
  /** The source .patch.yaml this seal was taken from. */
  sourceYaml: z.string(),
  sealedAt: z.string(),
  sealer: z.string().default("session-patch"),
});

const RunSchema = z.object({
  /** The ref requested (sha or yaml path). */
  ref: z.string(),
  adapter: z.string(),
  /** The full `<adapter>:<innerBackend>` backend arg passed to the engine. */
  backend: z.string(),
  resourceModel: z.string().default(""),
  /** "completed" | "failed" | "unknown". A `run_failed` event is a VALID data outcome. */
  status: z.string(),
  invocations: z.number().int(),
  plrCalls: z.number().int(),
  /** The `run_failed` payload when status === "failed", else null. */
  error: z.unknown().nullable().default(null),
  /** NDJSON lines that failed to JSON.parse (does not abort the run). */
  parseWarnings: z.number().int().default(0),
  /** Clipped engine stderr, retained for diagnosis when status !== "completed". */
  stderr: z.string().default(""),
  /** Whether the NDJSON event stream was offloaded to the `events` file. */
  eventsWritten: z.boolean().default(true),
  ranAt: z.string(),
  runner: z.string().default("session-patch"),
});

const RepoSchema = z.object({
  /** The directory that now contains a `.patch/` store. */
  dir: z.string(),
  initializedAt: z.string(),
  output: z.string().default(""),
  initializer: z.string().default("session-patch"),
});

const ResourceModelArgsSchema = z.object({
  /** The resource model to capture: `id@version` (e.g. "wur_flex_bca@1.0.0") or `sha256:<hex>`. */
  ref: z.string().min(1),
});

const ResourceModelSchema = z.object({
  /** The resource model id (e.g. "wur_flex_bca"). */
  id: z.string(),
  /** The resource model version (e.g. "1.0.0"). */
  version: z.string().default(""),
  /** The engine's content-address for this deck layout (`sha256:<hex>`) — its identity. */
  hashId: z.string().default(""),
  /** deck slot -> labware definition. */
  deckSlots: z.record(z.string(), z.string()).default({}),
  /** role index -> deck slot. */
  roles: z.record(z.string(), z.string()).default({}),
  /** role index -> human name (e.g. "2" -> "dest_plate"). */
  roleNames: z.record(z.string(), z.string()).default({}),
  /** role index -> required labware definition. */
  roleConstraints: z.record(z.string(), z.string()).default({}),
  capturedAt: z.string(),
  capturer: z.string().default("session-patch"),
});

/** Sanitize an arbitrary ref into a swamp instance name. */
export function safeName(s: string): string {
  return (s || "patch").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "patch";
}

// --- PURE PARSING HELPERS (unit-tested without spawning python) -------------

/** The sha + four artifact paths parsed out of the engine's `seal` stdout. */
export interface SealResult {
  /** The 64-hex content-address sha that IS the sealed patch's identity. */
  sha: string;
  /** The four sealed artifact paths (repo-relative) the engine reported. */
  files: { patch: string; ump: string; syx: string; manifest: string };
}

/**
 * Parse the engine's `seal` stdout into the patch sha + the four artifact paths.
 * The engine prints:
 *   Sealed: <yaml>
 *     patch:    .patch/patches/<64hex>.patch
 *     ump:      .patch/patches/<sha>.ump
 *     syx:      .patch/patches/<sha>.syx
 *     manifest: .patch/patches/<sha>.manifest.json
 * The 64-hex basename of the `.patch` path IS the identity. Pure over its input;
 * returns null if the output is not a recognizable seal (caller throws).
 */
export function parseSealOutput(stdout: string): SealResult | null {
  if (!/(^|\n)\s*Sealed:/.test(stdout)) return null;
  const field = (label: string): string => {
    const m = stdout.match(
      new RegExp(`(?:^|\\n)\\s*${label}:\\s*(\\S+)`),
    );
    return m ? m[1] : "";
  };
  const patch = field("patch");
  const ump = field("ump");
  const syx = field("syx");
  const manifest = field("manifest");
  // The sha is the 64-hex basename of the patch artifact.
  const shaMatch = patch.match(/([0-9a-f]{64})\.patch$/);
  const sha = shaMatch ? shaMatch[1] : "";
  if (!sha || !patch) return null;
  return { sha, files: { patch, ump, syx, manifest } };
}

/** Run counts + terminal status derived from a run's NDJSON event stream. */
export interface EventSummary {
  /** Count of `invocation_completed` events. */
  invocations: number;
  /** Count of `plr_call_dispatched` events. */
  plrCalls: number;
  /** "completed" (run_completed), "failed" (run_failed), or "unknown" (no terminal event). */
  status: "completed" | "failed" | "unknown";
  /** The `run_failed` event payload when status === "failed", else null. */
  error: unknown | null;
}

/**
 * Summarize an array of parsed NDJSON events into run counts + status.
 *   invocations = count(event === "invocation_completed")
 *   plrCalls    = count(event === "plr_call_dispatched")
 *   status      = "failed" if any run_failed, else "completed" if any
 *                 run_completed, else "unknown".
 * A `run_failed` event is a VALID outcome (its payload becomes `error`). Pure.
 */
export function summarizeEvents(
  events: Array<Record<string, unknown>>,
): EventSummary {
  let invocations = 0;
  let plrCalls = 0;
  let completed = false;
  let error: unknown | null = null;
  for (const e of events) {
    const ev = e && typeof e === "object" ? e["event"] : undefined;
    if (ev === "invocation_completed") invocations++;
    else if (ev === "plr_call_dispatched") plrCalls++;
    else if (ev === "run_completed") completed = true;
    else if (ev === "run_failed") error = e;
  }
  const status: EventSummary["status"] = error
    ? "failed"
    : completed
    ? "completed"
    : "unknown";
  return { invocations, plrCalls, status, error };
}

/** Split raw NDJSON stdout into parsed objects, counting (not throwing on) bad lines. */
export function parseNdjson(
  stdout: string,
): { events: Array<Record<string, unknown>>; parseWarnings: number } {
  const events: Array<Record<string, unknown>> = [];
  let parseWarnings = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object") {
        events.push(obj as Record<string, unknown>);
      } else {
        parseWarnings++;
      }
    } catch {
      parseWarnings++;
    }
  }
  return { events, parseWarnings };
}

/** The typed fields extracted from a resource model. */
export interface ResourceModelFields {
  /** The resource model id, e.g. "wur_flex_bca". */
  id: string;
  /** The resource model version, e.g. "1.0.0". */
  version: string;
  /** The engine content-address (`sha256:<hex>`). */
  hashId: string;
  /** deck slot -> labware definition. */
  deckSlots: Record<string, string>;
  /** role index -> deck slot. */
  roles: Record<string, string>;
  /** role index -> human name. */
  roleNames: Record<string, string>;
  /** role index -> required labware definition. */
  roleConstraints: Record<string, string>;
}

/**
 * Parse the engine's `resource-model show` JSON into typed fields. The engine
 * dumps `{ id, version, hash_id, deck_slots, roles, role_names, role_constraints }`;
 * missing keys default to empty. Pure over its input; returns null if the input
 * is not a JSON object.
 */
export function parseResourceModel(stdout: string): ResourceModelFields | null {
  let obj: unknown;
  try {
    obj = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const rec = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = typeof val === "string" ? val : String(val);
      }
    }
    return out;
  };
  const result = {
    id: str(o["id"]),
    version: str(o["version"]),
    hashId: str(o["hash_id"]),
    deckSlots: rec(o["deck_slots"]),
    roles: rec(o["roles"]),
    roleNames: rec(o["role_names"]),
    roleConstraints: rec(o["role_constraints"]),
  };
  // Reject a JSON object that carries neither an id nor a hash — it is not a
  // resource model, so the caller should treat it as a failure, not record it.
  if (!result.id && !result.hashId) return null;
  return result;
}

// --- swamp model plumbing ---------------------------------------------------

interface PatchContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    instanceName: string,
    data: unknown,
  ) => Promise<{ version: number }>;
  createFileWriter: (
    specName: string,
    instanceName: string,
    overrides?: { contentType?: string },
  ) => { writeAll: (content: Uint8Array) => Promise<unknown> };
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
}

/** Spawn the Patch CLI with an argv ARRAY (never a shell string; injection-safe). */
async function runCli(
  g: GlobalArgs,
  cliArgs: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command(g.pythonBin, {
    args: ["-m", g.patchModule, ...cliArgs],
    cwd: g.engineCwd,
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject() },
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Best-effort read of `<sha>.manifest.json` to pull patch_id; tolerates absence. */
async function readPatchId(
  g: GlobalArgs,
  manifestPath: string,
): Promise<string> {
  // manifestPath comes from the engine's own stdout; guard against a buggy or
  // hostile value escaping the repo before we read it.
  if (!manifestPath || manifestPath.includes("..")) return "";
  const abs = manifestPath.startsWith("/")
    ? manifestPath
    : `${g.repoDir}/${manifestPath}`;
  try {
    const text = await Deno.readTextFile(abs);
    const obj = JSON.parse(text) as Record<string, unknown>;
    const id = obj["patch_id"] ?? obj["patchId"];
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

/** Clip captured child output before embedding it in an error/log message. */
function clip(s: string, max = 2000): string {
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

/**
 * A stable, collision-resistant instance token for a run's ref. A 64-hex sha is
 * already an identity (use its first 16 hex); any other ref (a yaml path) is
 * hashed, so two distinct paths sharing a prefix never collide onto one
 * instance name.
 */
async function refToken(ref: string): Promise<string> {
  if (/^[0-9a-f]{64}$/.test(ref)) return ref.slice(0, 16);
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ref),
  );
  return Array.from(new Uint8Array(d)).slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The session-patch model definition. */
export const model = {
  type: "@vcjdeboer/session-patch",
  version: "2026.07.16.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "patch": {
      description:
        "A sealed Patch: the 64-hex content-address sha that IS the patch identity, plus the four engine artifacts (patch/ump/syx/manifest) and the source .patch.yaml. The canonical, citable statement of scientific intent.",
      schema: PatchSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    "run": {
      description:
        "The outcome of lowering one sealed Patch through a PLR adapter (plr-legacy | plr-v1b1): status, invocation + plr-call counts, the run_failed payload if any. The full NDJSON event stream is offloaded to the `events` file.",
      schema: RunSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    "repo": {
      description:
        "A scaffolded engine `.patch/` store (the content-addressed Patch repository) created by `init` — the one-time home for sealed patches and runs.",
      schema: RepoSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    "resource_model": {
      description:
        "A captured resource model (deck layout): the deck slots, the role -> slot / name / labware-constraint maps, and the engine's content-address (hash_id). The 'what is on the deck' provenance a `run` binds to via its resourceModel ref.",
      schema: ResourceModelSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
  },
  files: {
    "events": {
      description:
        "The full raw NDJSON event stream (one JSON object per line) the engine emitted for a `run` — invocation_started, plr_call_dispatched, plr_call_completed, invocation_completed, run_completed/run_failed. The verbatim record behind a run's summary.",
      contentType: "application/x-ndjson",
      lifetime: "infinite",
      garbageCollection: 100,
    },
  },
  methods: {
    init: {
      description:
        "Scaffold the engine's content-addressed `.patch/` store (one-time). Wraps `patch init <dir>` so the whole flow — init, seal, run — is swamp-native with no drop to the raw CLI.",
      arguments: InitArgsSchema,
      execute: async (
        args: z.infer<typeof InitArgsSchema>,
        context: PatchContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs;
        const dir = args.dir || g.repoDir;
        const { code, stdout, stderr } = await runCli(g, ["init", dir]);
        if (code !== 0) {
          throw new Error(
            `init failed (exit ${code}) for ${dir}: ` +
              clip(stderr.trim() || stdout.trim() || "no output"),
          );
        }
        const handle = await context.writeResource("repo", safeName(dir), {
          dir,
          initializedAt: new Date().toISOString(),
          output: stdout.trim(),
          initializer: "session-patch",
        });
        context.logger.info("Initialized .patch store at {dir}", { dir });
        return { dataHandles: [handle] };
      },
    },
    resource_model: {
      description:
        "Capture a resource model (deck layout) as a typed `resource_model` resource — the deck slots + role maps + content-address a `run` binds to. Wraps `resource-model show <ref>`.",
      arguments: ResourceModelArgsSchema,
      execute: async (
        args: z.infer<typeof ResourceModelArgsSchema>,
        context: PatchContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs;
        const { code, stdout, stderr } = await runCli(g, [
          "resource-model",
          "show",
          args.ref,
        ]);
        const rm = parseResourceModel(stdout);
        if (code !== 0 || !rm) {
          throw new Error(
            `resource-model show failed (exit ${code}) for ${args.ref}: ` +
              clip(stderr.trim() || stdout.trim() || "no JSON returned"),
          );
        }
        // Key by the content-address (the engine's hash_id) — collision-resistant
        // and the identity the schema advertises — with a readable id prefix. Fall
        // back to id@version, then the ref, only when no hash is present.
        const hashHex = rm.hashId.replace(/^sha256:/, "");
        const instance = safeName(
          hashHex
            ? (rm.id ? `${rm.id}-${hashHex.slice(0, 12)}` : hashHex)
            : (rm.id ? `${rm.id}-${rm.version}` : args.ref),
        );
        const handle = await context.writeResource("resource_model", instance, {
          id: rm.id,
          version: rm.version,
          hashId: rm.hashId,
          deckSlots: rm.deckSlots,
          roles: rm.roles,
          roleNames: rm.roleNames,
          roleConstraints: rm.roleConstraints,
          capturedAt: new Date().toISOString(),
          capturer: "session-patch",
        });
        context.logger.info(
          "Captured resource model {id} ({slots} slots, {roles} roles) {hash}",
          {
            id: rm.id || args.ref,
            slots: Object.keys(rm.deckSlots).length,
            roles: Object.keys(rm.roles).length,
            hash: rm.hashId.slice(0, 20),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    seal: {
      description:
        "Seal a .patch.yaml into the engine's content-addressed store and record the 64-hex patch sha + the four sealed artifacts as a typed `patch` resource.",
      arguments: SealArgsSchema,
      execute: async (
        args: z.infer<typeof SealArgsSchema>,
        context: PatchContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs;
        const { code, stdout, stderr } = await runCli(g, [
          "seal",
          args.patchYaml,
          "--repo-dir",
          g.repoDir,
        ]);
        const parsed = parseSealOutput(stdout);
        if (code !== 0 || !parsed) {
          throw new Error(
            `seal failed (exit ${code}) for ${args.patchYaml}: ` +
              clip(
                stderr.trim() || stdout.trim() || "no 'Sealed:' line in output",
              ),
          );
        }
        const patchId = await readPatchId(g, parsed.files.manifest);
        const handle = await context.writeResource(
          "patch",
          safeName(parsed.sha.slice(0, 16)),
          {
            sha: parsed.sha,
            patchId,
            files: parsed.files,
            sourceYaml: args.patchYaml,
            sealedAt: new Date().toISOString(),
            sealer: "session-patch",
          },
        );
        context.logger.info(
          "Sealed patch {sha} from {yaml}",
          { sha: parsed.sha.slice(0, 12), yaml: args.patchYaml },
        );
        return { dataHandles: [handle] };
      },
    },
    run: {
      description:
        "Lower ONE sealed Patch (by sha or yaml path) through a PLR adapter and record the run: status, invocations, plr calls, plus the full NDJSON event stream as an `events` blob. The SAME sealed sha under plr-legacy vs plr-v1b1 lowers to device-appropriate calls that differ.",
      arguments: RunArgsSchema,
      execute: async (
        args: z.infer<typeof RunArgsSchema>,
        context: PatchContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs;
        const backend = `${args.adapter}:${args.innerBackend}`;
        const cliArgs = [
          "run",
          args.ref,
          "--backend",
          backend,
          "--repo-dir",
          g.repoDir,
          "--json",
        ];
        if (args.resourceModel) {
          cliArgs.push("--rm", args.resourceModel);
        }
        const { code, stdout, stderr } = await runCli(g, cliArgs);

        const { events, parseWarnings } = parseNdjson(stdout);
        const summary = summarizeEvents(events);

        // Every run must reach a terminal event (run_completed or run_failed).
        // A run_failed IS a valid data outcome. But a non-terminal run — status
        // "unknown", or a non-zero exit without a run_failed — is an engine
        // crash: surface it (with stderr) rather than record a phantom success.
        if (
          summary.status === "unknown" ||
          (code !== 0 && summary.status !== "failed")
        ) {
          throw new Error(
            `run did not reach a terminal event (exit ${code}) for ${args.ref} ` +
              `on ${backend}: ` +
              clip(
                stderr.trim() || stdout.trim() ||
                  "no run_completed/run_failed emitted",
              ),
          );
        }

        const base = `${await refToken(args.ref)}-${args.adapter}`;
        const instance = safeName(base);
        // The events blob gets its OWN instance name; sharing `instance` with the
        // `run` resource would collide them into two versions of one instance
        // (the run summary shadowing the NDJSON) instead of two retrievable
        // resources.
        const eventsInstance = safeName(`${base}-events`);

        // Offload the verbatim NDJSON stream to a content-typed file resource.
        // Best-effort: the durable outcome is the `run` summary, so a blob-write
        // failure is recorded (eventsWritten=false), never fatal to the outcome.
        let eventsWritten = true;
        try {
          await context.createFileWriter(
            "events",
            eventsInstance,
            { contentType: "application/x-ndjson" },
          ).writeAll(new TextEncoder().encode(stdout));
        } catch (e) {
          eventsWritten = false;
          context.logger.info(
            "events blob write failed for {instance}: {err}",
            { instance, err: clip(String(e)) },
          );
        }

        const runHandle = await context.writeResource("run", instance, {
          ref: args.ref,
          adapter: args.adapter,
          backend,
          resourceModel: args.resourceModel,
          status: summary.status,
          invocations: summary.invocations,
          plrCalls: summary.plrCalls,
          error: summary.error,
          parseWarnings,
          stderr: summary.status === "completed" ? "" : clip(stderr.trim()),
          eventsWritten,
          ranAt: new Date().toISOString(),
          runner: "session-patch",
        });

        context.logger.info(
          "Ran patch {ref} on {backend}: status={status}, invocations={inv}, plrCalls={plr}",
          {
            ref: args.ref.slice(0, 12),
            backend,
            status: summary.status,
            inv: summary.invocations,
            plr: summary.plrCalls,
          },
        );
        return { dataHandles: [runHandle] };
      },
    },
  },
};
