import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLocalOnlyPlatform } from "./local-only.ts";
import { configurePlatformServices, getPlatformServices } from "./registry.ts";
import { PLATFORM_UNAVAILABLE, PlatformUnavailableError } from "./types.ts";
import { runLaunchGate } from "./launch-gate.ts";

test("local-only platform turns every capability off", () => {
  assert.deepEqual(createLocalOnlyPlatform().capabilities, {
    accountEnabled: false,
    requireAuthOnLaunch: false,
    cloudSyncEnabled: false,
    communityRemoteEnabled: false,
    spotlightOnboardingEnabled: false,
  });
});

test("local-only auth is a signed-out local guest", async () => {
  const { auth } = createLocalOnlyPlatform();
  assert.deepEqual(await auth.getSession(), { user: null, mode: "local_guest" });
  assert.equal(typeof auth.subscribe(() => {}), "function");
  await auth.logout();
});

test("local-only cloud sync reports disabled_phase1 and no preferences", async () => {
  const { cloudSync } = createLocalOnlyPlatform();
  assert.equal((await cloudSync.getStatus()).state, "disabled_phase1");
  assert.deepEqual(await cloudSync.getPreferences(), { syncAiConfig: false, syncResumeAndApplications: false });
});

test("local-only onboarding never runs a tour", async () => {
  const { onboarding } = createLocalOnlyPlatform();
  assert.equal(await onboarding.shouldRunSpotlightTour(), false);
  assert.deepEqual(onboarding.getSpotlightSteps(), []);
  await onboarding.completeTour();
  await onboarding.replayTour();
});

test("everything that needs a server rejects with PlatformUnavailableError", async () => {
  const { auth, cloudSync, community } = createLocalOnlyPlatform();
  const calls: Array<() => Promise<unknown>> = [
    () => auth.loginWithEmailOtp("a@example.com", "000000"),
    () => auth.updateCareerStatus("applying"),
    () => cloudSync.updatePreferences({ syncAiConfig: true }),
    () => cloudSync.unlockVault("x"),
    () => cloudSync.triggerSyncNow(),
    () => community.listFeed({ channel: "all" }),
    () => community.createPost({ content: "x", visibility: "public" }),
    () => community.castPollVote("p", "o"),
    () => community.toggleReaction("p", "like"),
    () => community.listComments("p"),
    () => community.createComment("p", "x"),
    () => community.getHotTopics(),
    () => community.getDailyTeaPoll(),
    () => community.previewDesensitizedNote("n"),
    () => community.publishDesensitizedNote({ originalNoteId: "n", maskedTitle: "", maskedBody: "", redactedItems: [] }),
  ];
  for (const call of calls) {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof PlatformUnavailableError);
      assert.equal((error as PlatformUnavailableError).code, PLATFORM_UNAVAILABLE);
      return true;
    });
  }
});

test("registry defaults to the local-only platform and can be swapped", () => {
  const original = getPlatformServices();
  assert.equal(original.capabilities.accountEnabled, false);
  const fake = { ...createLocalOnlyPlatform(), capabilities: { ...original.capabilities, accountEnabled: true } };
  configurePlatformServices(fake);
  assert.equal(getPlatformServices(), fake);
  configurePlatformServices(original);
  assert.equal(getPlatformServices(), original);
});

test("the launch gate returns straight away when login is not required", async () => {
  await runLaunchGate(createLocalOnlyPlatform());
});

test("index.html: every [data-platform] element ships with data-platform-off", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const offenders = (html.match(/<[a-zA-Z][^<>]*\sdata-platform(?:=|\s|>|\/)[^<>]*>/g) ?? []).filter(
    (tag) => !/\sdata-platform-off(?:[\s=>/])/.test(tag),
  );
  assert.deepEqual(offenders, [], "平台入口必须默认带 data-platform-off，避免启动时闪现");
});
