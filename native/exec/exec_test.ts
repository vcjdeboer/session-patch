// exec_test.ts — self-contained verification of the Patch execution core.
//
// Fixtures (exec/testdata/) are the sealed BCA patch bytes and the two golden
// NDJSON streams for the plr-legacy:recording and plr-v1b1:recording backends.
// The core must match them call-for-call.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  adapterFor,
  legacyAdapter,
  loadResourceModel,
  neutralAdapter,
  runPatch,
  v1b1Adapter,
} from "./run.ts";
import { MT19937, round4 } from "./mt19937.ts";
import { scaleLinear, scaleLog, decodeWell } from "./codec_scale.ts";

const HERE = new URL(".", import.meta.url).pathname;

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return await Deno.readFile(`${HERE}testdata/${name}`);
}
async function fixtureText(name: string): Promise<string> {
  return await Deno.readTextFile(`${HERE}testdata/${name}`);
}
async function rm() {
  return loadResourceModel(JSON.parse(await fixtureText("wur_flex_bca.rm.json")));
}

Deno.test("scale formulas reproduce the golden byte→float values", () => {
  assertEquals(scaleLog(144, 1.0, 300.0), 25.052146565571594);
  assertEquals(scaleLog(237, 1.0, 300.0), 200.56984401090483);
  assertEquals(scaleLog(128, 1.0, 300.0), 17.51530595265795);
  assertEquals(scaleLinear(37, 0.0, 100.0), 14.50980392156863);
  assertEquals(decodeWell(11), [0, 11]);
  assertEquals(decodeWell(0), [0, 0]);
});

Deno.test("MT19937 reproduces the recording-path _returned values", () => {
  // Seeds are sha256(repr(sorted kwargs))[:4] big-endian.
  assertEquals(round4(new MT19937(2095970540).uniform(0.1, 1.5)), 0.528); // v1b1
  assertEquals(round4(new MT19937(303934515).uniform(0.1, 1.5)), 1.3379); // legacy
});

Deno.test("legacy adapter matches the golden NDJSON call-for-call", async () => {
  const bytes = await fixtureBytes("bca_standard_curve.patch");
  const got = await runPatch(bytes, legacyAdapter, await rm());
  const want = (await fixtureText("bca_legacy.jsonl")).split("\n").filter((l) => l.length);
  assertEquals(got, want);
  assertEquals(got.length, 79);
  assertEquals(got.filter((l) => l.includes('"invocation_started"')).length, 20);
  assertEquals(got.filter((l) => l.includes('"plr_call_dispatched"')).length, 19);
});

Deno.test("v1b1 adapter matches the golden NDJSON call-for-call", async () => {
  const bytes = await fixtureBytes("bca_standard_curve.patch");
  const got = await runPatch(bytes, v1b1Adapter, await rm());
  const want = (await fixtureText("bca_v1b1.jsonl")).split("\n").filter((l) => l.length);
  assertEquals(got, want);
});

Deno.test("neutral adapter yields 20 invocations / 19 plr calls with plausible methods", async () => {
  const bytes = await fixtureBytes("bca_standard_curve.patch");
  const got = await runPatch(bytes, neutralAdapter, await rm());
  const dispatched = got.filter((l) => l.includes('"plr_call_dispatched"'));
  assertEquals(got.filter((l) => l.includes('"invocation_started"')).length, 20);
  assertEquals(dispatched.length, 19);
  const methods = new Set(dispatched.map((l) => JSON.parse(l).payload.call.method_name));
  for (const m of ["pick_up_tips", "aspirate", "dispense", "drop_tips", "set_temperature", "deactivate", "move_resource", "read"]) {
    assert(methods.has(m), `expected method ${m}`);
  }
});

Deno.test("adapterFor resolves recording backend strings", () => {
  assertEquals(adapterFor("plr-legacy:recording").name, "plr-legacy");
  assertEquals(adapterFor("plr-v1b1:recording").name, "plr-v1b1");
  assertEquals(adapterFor("neutral").name, "neutral");
});
