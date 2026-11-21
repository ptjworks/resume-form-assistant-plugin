import { afterEach, expect, test } from "vitest";
import { bootPlatform } from "./boot";
import { createLocalOnlyPlatform } from "./local-only";
import { configurePlatformServices, getPlatformServices } from "./registry";
import type { PlatformServices } from "./registry";
import { applyPlatformVisibility } from "./visibility";

const original = getPlatformServices();
afterEach(() => configurePlatformServices(original));

const ALL_AREAS = ["auth", "cloud-sync", "community-remote", "onboarding"] as const;
function page() {
  document.body.innerHTML = ALL_AREAS.map((area) => `<div data-platform="${area}" data-platform-off></div>`).join("")
    + `<div data-platform="bogus" data-platform-off></div><div id="plain" hidden></div>`;
  return Array.from(document.querySelectorAll<HTMLElement>("[data-platform]"));
}

/** 所有开关为 true、每个方法都记一笔调用的假平台。 */
function recordingPlatform(allOn: boolean) {
  const calls: string[] = [];
  const wrap = <T extends object>(name: string, target: T): T =>
    new Proxy(target, {
      get(obj, key) {
        const value = (obj as Record<string | symbol, unknown>)[key];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(`${name}.${String(key)}`);
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      },
    });
  const local = createLocalOnlyPlatform();
  const platform: PlatformServices = {
    capabilities: {
      accountEnabled: allOn,
      requireAuthOnLaunch: false,
      cloudSyncEnabled: allOn,
      communityRemoteEnabled: allOn,
      spotlightOnboardingEnabled: allOn,
    },
    auth: wrap("auth", local.auth),
    cloudSync: wrap("cloudSync", local.cloudSync),
    community: wrap("community", local.community),
    onboarding: wrap("onboarding", local.onboarding),
  };
  return { platform, calls };
}

test("local-only capabilities keep every platform entry switched off", () => {
  const nodes = page();
  applyPlatformVisibility(document, getPlatformServices().capabilities);
  for (const node of nodes) expect(node.hasAttribute("data-platform-off")).toBe(true);
});

test("a platform with every capability on shows the entries it knows about", () => {
  const nodes = page();
  applyPlatformVisibility(document, recordingPlatform(true).platform.capabilities);
  const states = Object.fromEntries(nodes.map((n) => [n.dataset.platform, n.hasAttribute("data-platform-off")]));
  expect(states).toEqual({ auth: false, "cloud-sync": false, "community-remote": false, onboarding: false, bogus: true });
});

test("each area follows its own capability and can switch back off", () => {
  const nodes = page();
  const base = recordingPlatform(false).platform.capabilities;
  applyPlatformVisibility(document, { ...base, accountEnabled: true });
  expect(nodes.filter((n) => !n.hasAttribute("data-platform-off")).map((n) => n.dataset.platform)).toEqual(["auth"]);
  applyPlatformVisibility(document, base);
  expect(nodes.every((n) => n.hasAttribute("data-platform-off"))).toBe(true);
});

test("visibility never touches the hidden attribute", () => {
  page();
  document.querySelector("[data-platform=auth]")!.setAttribute("hidden", "");
  applyPlatformVisibility(document, recordingPlatform(true).platform.capabilities);
  expect(document.querySelector("[data-platform=auth]")!.hasAttribute("hidden")).toBe(true);
  expect(document.getElementById("plain")!.hasAttribute("hidden")).toBe(true);
});

test("booting with local-only capabilities calls no platform interface", async () => {
  const nodes = page();
  const { platform, calls } = recordingPlatform(false);
  configurePlatformServices(platform);
  const booted = await bootPlatform(document);
  expect(booted).toBe(platform);
  expect(calls).toEqual([]);
  expect(nodes.every((n) => n.hasAttribute("data-platform-off"))).toBe(true);
});

test("booting with every capability on shows the entries without calling any service on its own", async () => {
  const nodes = page();
  const { platform, calls } = recordingPlatform(true);
  configurePlatformServices(platform);
  await bootPlatform(document);
  expect(calls).toEqual([]);
  expect(nodes.filter((n) => n.dataset.platform !== "bogus").every((n) => !n.hasAttribute("data-platform-off"))).toBe(true);
});
