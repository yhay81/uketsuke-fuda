import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { app, scheduled, type Bindings } from "../src/worker";

const migrationPath = fileURLToPath(new URL("../migrations/0001_events.sql", import.meta.url));
const appScriptPath = fileURLToPath(new URL("../public/app.js", import.meta.url));
const eventScriptPath = fileURLToPath(new URL("../public/event.js", import.meta.url));
const ogPath = fileURLToPath(new URL("../public/og.svg", import.meta.url));
const stylesPath = fileURLToPath(new URL("../public/styles.css", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const origin = "http://localhost";
const sessions = [
  "a2d0e2f2-66fd-4fd4-8e87-b0ef67ad194a",
  "b3d0e2f2-66fd-4fd4-8e87-b0ef67ad194b",
  "c4d0e2f2-66fd-4fd4-8e87-b0ef67ad194c",
  "d5d0e2f2-66fd-4fd4-8e87-b0ef67ad194d",
];

let miniflare: Miniflare;
let bindings: Bindings;

const headers = (session = sessions[0], key = "", qa = false) => ({
  "content-type": "application/json",
  origin,
  "x-uketsuke-key": key,
  "x-uketsuke-qa": qa ? "1" : "0",
  "x-uketsuke-session": session,
});
const validEvent = (overrides: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    capacity: 6,
    doorsAt: now + 3600,
    kind: "live",
    maxPerReservation: 4,
    note: "受付で予約名をお伝えください",
    priceNote: "2,500円 + 1D",
    routes: ["出演者A", "主催"],
    startsAt: now + 5400,
    title: "夜の小箱 vol.3",
    venue: "小箱ホール",
    website: "",
    ...overrides,
  };
};
const validReservation = (overrides: Record<string, unknown> = {}) => ({
  displayName: "青木",
  note: "開演前に着きます",
  quantity: 2,
  routeName: "出演者A",
  website: "",
  ...overrides,
});
const keyFromUrl = (url: string) =>
  new URLSearchParams(new URL(url, origin).hash.slice(1)).get("key") ?? "";
const createEvent = async (overrides: Record<string, unknown> = {}, qa = false) => {
  const response = await app.request(
    "/api/events",
    {
      body: JSON.stringify(validEvent(overrides)),
      headers: headers(sessions[0], "", qa),
      method: "POST",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ id: string; manageUrl: string; publicUrl: string }>();
  return { ...body, key: keyFromUrl(body.manageUrl) };
};
const createReservation = async (
  eventId: string,
  overrides: Record<string, unknown> = {},
  session = sessions[1],
) => {
  const response = await app.request(
    `/api/events/${eventId}/reservations`,
    {
      body: JSON.stringify(validReservation(overrides)),
      headers: headers(session),
      method: "POST",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ id: string; manageUrl: string }>();
  return { ...body, key: keyFromUrl(body.manageUrl) };
};

beforeEach(async () => {
  miniflare = new Miniflare({
    workers: [
      {
        config: {
          name: "",
          compatibilityDate: "2026-07-27",
          env: { DB: { type: "d1", id: "uketsuke-fuda-test" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                type: "esm",
                contents: "export default { fetch() { return new Response('test') } }",
              },
            },
          },
        },
      },
    ],
  });
  const database = await miniflare.getD1Database("DB");
  const migration = await readFile(migrationPath, "utf8");
  for (const statement of migration
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean))
    await database.prepare(statement).run();
  bindings = {
    ASSETS: { fetch: async () => new Response("asset", { status: 404 }) } as unknown as Fetcher,
    DB: database as unknown as D1Database,
  };
});

afterEach(async () => miniflare.dispose());

describe("public surfaces", () => {
  it.each([
    ["/", 'class="ticket-visual"', "https://uketsuke-fuda.yhay81.com/"],
    ["/guide", 'class="guide-cards"', "https://uketsuke-fuda.yhay81.com/guide"],
    ["/safety", 'class="data-grid"', "https://uketsuke-fuda.yhay81.com/safety"],
    ["/privacy", 'class="privacy-roster"', "https://uketsuke-fuda.yhay81.com/privacy"],
  ])("%s is a product surface", async (path, marker, canonical) => {
    const response = await app.request(path, undefined, bindings);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(marker);
    expect(html).toContain(`href="${canonical}" rel="canonical"`);
    expect(html).toContain("受付札");
    expect(html).not.toMatch(/仮説|成功条件|市場スコア|移行候補|実験/u);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("indexes four stable pages and no private event pages", async () => {
    const xml = await (await app.request("/sitemap.xml", undefined, bindings)).text();
    expect(xml.match(/<loc>/gu)).toHaveLength(4);
    expect(xml).not.toMatch(/\/e\/|\/m\/|\/r\//u);
    expect(await (await app.request("/health", undefined, bindings)).json()).toEqual({
      ok: true,
      service: "uketsuke-fuda",
    });
    const event = await createEvent();
    for (const path of [`/e/${event.id}`, `/m/${event.id}`])
      expect(await (await app.request(path, undefined, bindings)).text()).toContain(
        'content="noindex,nofollow" name="robots"',
      );
  });
});

describe("event and reservations", () => {
  it("creates an event without leaking the manager key", async () => {
    const event = await createEvent();
    const publicText = await (
      await app.request(`/api/events/${event.id}`, undefined, bindings)
    ).text();
    expect(publicText).not.toContain(event.key);
    expect(publicText).not.toContain("manager_token_hash");
    expect(
      (await app.request(`/api/events/${event.id}/manage`, { headers: headers() }, bindings))
        .status,
    ).toBe(403);
    expect(
      (
        await app.request(
          `/api/events/${event.id}/manage`,
          { headers: headers(sessions[0], event.key) },
          bindings,
        )
      ).status,
    ).toBe(200);
  });

  it.each([
    [{ note: "https://example.com" }, "unsafe_note"],
    [{ routes: ["出演者A", "出演者A"] }, "invalid_routes"],
    [{ routes: Array.from({ length: 9 }, (_, index) => `出演者${index}`) }, "invalid_routes"],
    [{ startsAt: Math.floor(Date.now() / 1000) + 60 }, "invalid_schedule"],
    [{ website: "filled" }, "invalid_request"],
  ])("rejects invalid event input %#", async (overrides, error) => {
    const response = await app.request(
      "/api/events",
      { body: JSON.stringify(validEvent(overrides)), headers: headers(), method: "POST" },
      bindings,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error });
  });

  it("keeps reservation names private and enforces capacity", async () => {
    const event = await createEvent({ capacity: 3 });
    const reservation = await createReservation(event.id);
    const publicText = await (
      await app.request(`/api/events/${event.id}`, undefined, bindings)
    ).text();
    expect(publicText).not.toContain("青木");
    expect(publicText).toContain('"reserved":2');
    const overflow = await app.request(
      `/api/events/${event.id}/reservations`,
      {
        body: JSON.stringify(validReservation({ displayName: "佐藤", quantity: 2 })),
        headers: headers(sessions[2]),
        method: "POST",
      },
      bindings,
    );
    expect(overflow.status).toBe(409);
    expect(await overflow.json()).toMatchObject({ error: "capacity_reached" });
    const own = await app.request(
      `/api/reservations/${reservation.id}`,
      { headers: headers(sessions[1], reservation.key) },
      bindings,
    );
    expect(await own.text()).toContain("青木");
  });

  it("lets a reservation holder cancel and restore", async () => {
    const event = await createEvent();
    const reservation = await createReservation(event.id);
    for (const status of ["cancelled", "reserved"]) {
      const response = await app.request(
        `/api/reservations/${reservation.id}`,
        {
          body: JSON.stringify({ status }),
          headers: headers(sessions[1], reservation.key),
          method: "PATCH",
        },
        bindings,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status });
    }
  });

  it("supports proxy booking, check-in, cancellation, and CSV", async () => {
    const event = await createEvent();
    const proxy = await app.request(
      `/api/events/${event.id}/manage/reservations`,
      {
        body: JSON.stringify(validReservation({ displayName: "口頭予約", quantity: 1 })),
        headers: headers(sessions[0], event.key),
        method: "POST",
      },
      bindings,
    );
    expect(proxy.status).toBe(201);
    const proxyBody = await proxy.json<{ id: string; manageUrl: string }>();
    expect(proxyBody.manageUrl).toBe("");
    const checkin = await app.request(
      `/api/events/${event.id}/manage/reservations/${proxyBody.id}`,
      {
        body: JSON.stringify({ status: "checked_in" }),
        headers: headers(sessions[0], event.key),
        method: "PATCH",
      },
      bindings,
    );
    expect(checkin.status).toBe(200);
    const manager = await app.request(
      `/api/events/${event.id}/manage`,
      { headers: headers(sessions[0], event.key) },
      bindings,
    );
    expect(await manager.text()).toContain("口頭予約");
    const csv = await app.request(
      `/api/events/${event.id}/manage/csv`,
      { headers: headers(sessions[0], event.key) },
      bindings,
    );
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("口頭予約");
  });

  it("closes, reopens, and deletes through the event capability", async () => {
    const event = await createEvent();
    const close = await app.request(
      `/api/events/${event.id}/manage`,
      {
        body: JSON.stringify({ status: "closed" }),
        headers: headers(sessions[0], event.key),
        method: "PATCH",
      },
      bindings,
    );
    expect(close.status).toBe(200);
    expect((await app.request(`/api/events/${event.id}`, undefined, bindings)).status).toBe(404);
    const reopen = await app.request(
      `/api/events/${event.id}/manage`,
      {
        body: JSON.stringify({ status: "open" }),
        headers: headers(sessions[0], event.key),
        method: "PATCH",
      },
      bindings,
    );
    expect(reopen.status).toBe(200);
    const deletion = await app.request(
      `/api/events/${event.id}`,
      { body: "{}", headers: headers(sessions[0], event.key), method: "DELETE" },
      bindings,
    );
    expect(deletion.status).toBe(200);
    expect(
      (
        await app.request(
          `/api/events/${event.id}/manage`,
          { headers: headers(sessions[0], event.key) },
          bindings,
        )
      ).status,
    ).toBe(404);
  });
});

describe("abuse and retention", () => {
  it("hides an event after three distinct reports", async () => {
    const event = await createEvent();
    for (let index = 0; index < 3; index += 1) {
      const response = await app.request(
        `/api/events/${event.id}/report`,
        {
          body: JSON.stringify({ reason: "unsafe" }),
          headers: headers(sessions[index + 1]),
          method: "POST",
        },
        bindings,
      );
      expect(response.status).toBe(202);
    }
    expect((await app.request(`/api/events/${event.id}`, undefined, bindings)).status).toBe(404);
    expect(
      (
        await app.request(
          `/api/events/${event.id}/manage`,
          { headers: headers(sessions[0], event.key) },
          bindings,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `/api/events/${event.id}/manage`,
          {
            body: JSON.stringify({ status: "open" }),
            headers: headers(sessions[0], event.key),
            method: "PATCH",
          },
          bindings,
        )
      ).status,
    ).toBe(404);
  });

  it("labels QA events and scheduled cleanup removes expired rows", async () => {
    const event = await createEvent({}, true);
    const qa = await bindings.DB.prepare("SELECT is_qa FROM product_events WHERE event_id = ?")
      .bind(event.id)
      .first<{ is_qa: number }>();
    expect(qa?.is_qa).toBe(1);
    await bindings.DB.prepare("UPDATE events SET expires_at = 1 WHERE id = ?").bind(event.id).run();
    await scheduled({} as ScheduledEvent, bindings, {} as ExecutionContext);
    expect(
      await bindings.DB.prepare("SELECT id FROM events WHERE id = ?").bind(event.id).first(),
    ).toBeNull();
  });
});

describe("release assets", () => {
  it("ships substantial scripts, a visual card, and no gradients", async () => {
    expect((await stat(appScriptPath)).size).toBeGreaterThan(2500);
    expect((await stat(eventScriptPath)).size).toBeGreaterThan(10000);
    expect((await stat(ogPath)).size).toBeGreaterThan(1500);
    const styles = await readFile(stylesPath, "utf8");
    expect(styles).not.toMatch(/gradient\s*\(/iu);
    expect(styles).toContain(".ticket-stub");
  });

  it("keeps the production domain, daily cleanup, and D1 binding configured", async () => {
    const wrangler = await readFile(wranglerPath, "utf8");
    expect(wrangler).toContain("uketsuke-fuda.yhay81.com");
    expect(wrangler).toContain('"crons"');
    expect(wrangler).toContain('"binding": "DB"');
  });
});
