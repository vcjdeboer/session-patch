import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  parseNdjson,
  parseResourceModel,
  parseSealOutput,
  safeName,
  summarizeEvents,
} from "./session_patch.ts";

// --- parseSealOutput --------------------------------------------------------

const SHA = "a".repeat(64);
const SEAL_STDOUT = [
  "Sealed: examples/bca_standard_curve.patch.yaml",
  `  patch:    .patch/patches/${SHA}.patch`,
  `  ump:      .patch/patches/${SHA}.ump`,
  `  syx:      .patch/patches/${SHA}.syx`,
  `  manifest: .patch/patches/${SHA}.manifest.json`,
  "",
].join("\n");

Deno.test("parseSealOutput extracts the 64-hex sha and all four artifact paths", () => {
  const r = parseSealOutput(SEAL_STDOUT);
  assert(r !== null);
  assertEquals(r!.sha, SHA);
  assertEquals(r!.files.patch, `.patch/patches/${SHA}.patch`);
  assertEquals(r!.files.ump, `.patch/patches/${SHA}.ump`);
  assertEquals(r!.files.syx, `.patch/patches/${SHA}.syx`);
  assertEquals(r!.files.manifest, `.patch/patches/${SHA}.manifest.json`);
});

Deno.test("parseSealOutput returns null when there is no Sealed: line", () => {
  assertEquals(parseSealOutput("some other output\nno seal here"), null);
});

Deno.test("parseSealOutput returns null when the sha basename is absent", () => {
  const bad = "Sealed: x.yaml\n  patch:    .patch/patches/notasha.patch\n";
  assertEquals(parseSealOutput(bad), null);
});

// --- summarizeEvents --------------------------------------------------------

function ev(event: string, extra: Record<string, unknown> = {}) {
  return { event, ...extra };
}

Deno.test("summarizeEvents counts invocations + plr calls and reports completed", () => {
  const events = [
    ev("invocation_started"),
    ev("plr_call_dispatched"),
    ev("plr_call_completed"),
    ev("invocation_completed"),
    ev("plr_call_dispatched"),
    ev("invocation_completed"),
    ev("run_completed"),
  ];
  const s = summarizeEvents(events);
  assertEquals(s.invocations, 2);
  assertEquals(s.plrCalls, 2);
  assertEquals(s.status, "completed");
  assertEquals(s.error, null);
});

Deno.test("summarizeEvents surfaces a run_failed payload as a valid failed outcome", () => {
  const failPayload = ev("run_failed", {
    error: "boom",
    error_type: "SchemaError",
    schema_id: "some_schema",
  });
  const s = summarizeEvents([
    ev("invocation_started"),
    ev("plr_call_dispatched"),
    failPayload,
  ]);
  assertEquals(s.status, "failed");
  assertEquals(s.plrCalls, 1);
  assertEquals(s.invocations, 0);
  assertEquals((s.error as Record<string, unknown>).error, "boom");
});

Deno.test("summarizeEvents reports unknown when neither run_completed nor run_failed appear", () => {
  const s = summarizeEvents([ev("invocation_started"), ev("plr_call_dispatched")]);
  assertEquals(s.status, "unknown");
});

// --- parseNdjson ------------------------------------------------------------

Deno.test("parseNdjson parses non-empty lines and counts unparseable ones", () => {
  const raw = [
    JSON.stringify(ev("invocation_started")),
    "",
    "not json at all",
    JSON.stringify(ev("run_completed")),
    "   ",
  ].join("\n");
  const { events, parseWarnings } = parseNdjson(raw);
  assertEquals(events.length, 2);
  assertEquals(parseWarnings, 1);
});

Deno.test("parseNdjson + summarizeEvents compose into a run summary (money-shot shape)", () => {
  // 19 plr_call_dispatched + 20 invocation_completed + run_completed (the bca case).
  const lines: string[] = [];
  for (let i = 0; i < 19; i++) lines.push(JSON.stringify(ev("plr_call_dispatched")));
  for (let i = 0; i < 20; i++) lines.push(JSON.stringify(ev("invocation_completed")));
  lines.push(JSON.stringify(ev("run_completed")));
  const { events, parseWarnings } = parseNdjson(lines.join("\n"));
  const s = summarizeEvents(events);
  assertEquals(parseWarnings, 0);
  assertEquals(s.plrCalls, 19);
  assertEquals(s.invocations, 20);
  assertEquals(s.status, "completed");
});

// --- safeName ---------------------------------------------------------------

Deno.test("safeName sanitizes a ref into a swamp instance name", () => {
  assertEquals(safeName("plr-v1b1"), "plr-v1b1");
  assertEquals(safeName("a/b:c.yaml"), "a_b_c_yaml");
  assertEquals(safeName(""), "patch");
});

// --- parseResourceModel -----------------------------------------------------

Deno.test("parseResourceModel extracts deck slots, roles, names, and hash", () => {
  const stdout = JSON.stringify({
    id: "wur_flex_bca",
    version: "1.0.0",
    hash_id: "sha256:aff3f51d72a2f7b719e23fdd4a3bd004",
    deck_slots: { B2: "corning_96_wellplate_360ul_flat" },
    roles: { "2": "B2" },
    role_names: { "2": "dest_plate" },
    role_constraints: { "2": "corning_96_wellplate_360ul_flat" },
  });
  const rm = parseResourceModel(stdout);
  assert(rm !== null);
  assertEquals(rm!.id, "wur_flex_bca");
  assertEquals(rm!.version, "1.0.0");
  assertEquals(rm!.hashId, "sha256:aff3f51d72a2f7b719e23fdd4a3bd004");
  assertEquals(rm!.roleNames["2"], "dest_plate");
  assertEquals(rm!.deckSlots["B2"], "corning_96_wellplate_360ul_flat");
});

Deno.test("parseResourceModel returns null for non-JSON-object input", () => {
  assertEquals(parseResourceModel("not json"), null);
  assertEquals(parseResourceModel("[1,2,3]"), null);
});

Deno.test("parseResourceModel rejects a JSON object with neither id nor hash", () => {
  assertEquals(parseResourceModel("{}"), null);
  assertEquals(parseResourceModel('{"deck_slots":{"B2":"plate"}}'), null);
});
