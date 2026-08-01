import { Hono } from "hono";
import type { Context } from "hono";
import { requestId } from "hono/request-id";

import {
  eventKinds,
  expiryForEvent,
  isEventKind,
  isEventStatus,
  isReservationStatus,
  parseRoutes,
  seatsRemaining,
  type EventKind,
  type EventStatus,
  type ReservationStatus,
} from "./domain/events";

export type Bindings = { ASSETS: Fetcher; DB: D1Database };
type Variables = { requestId: string };
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

type EventRow = {
  capacity: number;
  created_at: number;
  creator_session_id: string;
  doors_at: number;
  expires_at: number;
  id: string;
  kind: EventKind;
  manager_token_hash: string;
  max_per_reservation: number;
  note: string;
  price_note: string;
  reserved_count?: number;
  routes_json: string;
  starts_at: number;
  status: EventStatus;
  title: string;
  updated_at: number;
  venue: string;
};

type ReservationRow = {
  created_at: number;
  display_name: string;
  event_id: string;
  id: string;
  manager_token_hash: string;
  note: string;
  quantity: number;
  route_name: string;
  session_id: string;
  status: ReservationStatus;
  updated_at: number;
};

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 429,
  ) {
    super(code);
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const canonicalOrigin = "https://uketsuke-fuda.yhay81.com";
const idPattern = /^[0-9a-f]{32}$/u;
const tokenPattern = /^[0-9a-f]{64}$/u;
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const linkPattern = /(?:https?:\/\/|www\.|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/iu;
const reportReasons = new Set(["misleading", "unsafe", "spam", "other"]);
const telemetryNames = new Set([
  "visited",
  "event_created",
  "reservation_created",
  "event_managed",
  "reservation_managed",
  "roster_exported",
  "returned",
]);

const kindLabels: Record<EventKind, string> = {
  live: "ライブ",
  stage: "舞台・公演",
  talk: "トーク・交流",
  market: "展示・即売",
  other: "その他",
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const jstDay = (milliseconds = Date.now()) =>
  new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const randomHex = (length: number) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};
const enforceSameOrigin = (c: AppContext) => {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") throw new ApiError("cross_site_request", 403);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) throw new ApiError("cross_site_request", 403);
};
const parseJson = async (c: AppContext, maximumBytes = 8192) => {
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ApiError("unsupported_media_type", 415);
  }
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new ApiError("payload_too_large", 413);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("invalid_json", 400);
  }
};
const objectPayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("invalid_request", 400);
  }
  return payload as Record<string, unknown>;
};
const cleanText = (
  payload: Record<string, unknown>,
  key: string,
  maximum: number,
  options: { allowEmpty?: boolean; blockLinks?: boolean } = {},
) => {
  if (typeof payload[key] !== "string") throw new ApiError("invalid_" + key, 400);
  const value = payload[key].replace(/\r\n?/gu, "\n").trim();
  if ((!options.allowEmpty && !value) || value.length > maximum) {
    throw new ApiError("invalid_" + key, 400);
  }
  if (options.blockLinks && linkPattern.test(value)) throw new ApiError("unsafe_" + key, 400);
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if ((point < 32 && point !== 9 && point !== 10) || point === 127) {
      throw new ApiError("invalid_" + key, 400);
    }
  }
  return value;
};
const integerValue = (
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
) => {
  const value = payload[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ApiError("invalid_" + key, 400);
  }
  return value as number;
};
const validateId = (value: string) => {
  if (!idPattern.test(value)) throw new ApiError("not_found", 404);
  return value;
};
const sessionId = (c: AppContext) => {
  const value = c.req.header("x-uketsuke-session") ?? "";
  if (!sessionPattern.test(value)) throw new ApiError("invalid_session", 400);
  return value.toLowerCase();
};
const capability = (c: AppContext) => {
  const value = c.req.header("x-uketsuke-key") ?? "";
  if (!tokenPattern.test(value)) throw new ApiError("invalid_capability", 403);
  return value;
};
const routesFromPayload = (payload: Record<string, unknown>) => {
  if (!Array.isArray(payload.routes) || payload.routes.length > 8) {
    throw new ApiError("invalid_routes", 400);
  }
  const routes = payload.routes.map((route) => {
    if (typeof route !== "string") throw new ApiError("invalid_routes", 400);
    const clean = route.trim();
    if (!clean || clean.length > 40 || linkPattern.test(clean)) {
      throw new ApiError("invalid_routes", 400);
    }
    return clean;
  });
  if (new Set(routes).size !== routes.length) throw new ApiError("invalid_routes", 400);
  return routes;
};
const getEvent = async (database: D1Database, id: string, includeInactive = false) => {
  const event = await database
    .prepare("SELECT * FROM events WHERE id = ? AND expires_at > ?")
    .bind(id, nowSeconds())
    .first<EventRow>();
  if (!event || (!includeInactive && event.status !== "open")) {
    throw new ApiError("not_found", 404);
  }
  return event;
};
const eventManager = async (c: AppContext, id: string) => {
  const event = await getEvent(c.env.DB, id, true);
  const suppliedHash = await sha256(capability(c));
  if (!constantTimeEqual(event.manager_token_hash, suppliedHash)) {
    throw new ApiError("invalid_capability", 403);
  }
  return event;
};
const reservationManager = async (c: AppContext, id: string) => {
  const reservation = await c.env.DB.prepare("SELECT * FROM reservations WHERE id = ?")
    .bind(id)
    .first<ReservationRow>();
  if (!reservation) throw new ApiError("not_found", 404);
  const suppliedHash = await sha256(capability(c));
  if (!constantTimeEqual(reservation.manager_token_hash, suppliedHash)) {
    throw new ApiError("invalid_capability", 403);
  }
  return reservation;
};
const recordEvent = async (c: AppContext, name: string, eventId = "", actor?: string) => {
  if (!telemetryNames.has(name)) return;
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO product_events (name,session_id,event_id,day,created_at,is_qa) VALUES (?,?,?,?,?,?)",
  )
    .bind(
      name,
      actor ?? sessionId(c),
      eventId,
      jstDay(),
      nowSeconds(),
      c.req.header("x-uketsuke-qa") === "1" ? 1 : 0,
    )
    .run();
};
const reservationCount = async (database: D1Database, eventId: string) => {
  const row = await database
    .prepare(
      "SELECT COALESCE(SUM(quantity),0) AS count FROM reservations WHERE event_id = ? AND status IN ('reserved','checked_in')",
    )
    .bind(eventId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
};
const publicEvent = async (database: D1Database, event: EventRow) => {
  const reserved = event.reserved_count ?? (await reservationCount(database, event.id));
  return {
    capacity: event.capacity,
    doorsAt: event.doors_at,
    id: event.id,
    isPast: event.starts_at <= nowSeconds(),
    kind: event.kind,
    kindLabel: kindLabels[event.kind],
    maxPerReservation: event.max_per_reservation,
    note: event.note,
    priceNote: event.price_note,
    reserved,
    routes: parseRoutes(JSON.parse(event.routes_json).join("\n")),
    seatsRemaining: seatsRemaining(event.capacity, reserved),
    startsAt: event.starts_at,
    status: event.status,
    title: event.title,
    venue: event.venue,
  };
};
const managerEvent = async (database: D1Database, event: EventRow) => {
  const reservations = await database
    .prepare(
      "SELECT id,display_name,quantity,route_name,note,status,created_at,updated_at FROM reservations WHERE event_id = ? ORDER BY CASE status WHEN 'checked_in' THEN 0 WHEN 'reserved' THEN 1 ELSE 2 END, route_name, display_name",
    )
    .bind(event.id)
    .all<Omit<ReservationRow, "event_id" | "manager_token_hash" | "session_id">>();
  return { ...(await publicEvent(database, event)), reservations: reservations.results };
};

const Layout = ({
  canonical,
  children,
  description,
  noindex = false,
  script,
  title,
}: {
  canonical: string;
  children: unknown;
  description: string;
  noindex?: boolean;
  script?: string;
  title: string;
}) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta content="width=device-width, initial-scale=1" name="viewport" />
      <title>{title}</title>
      <meta content={description} name="description" />
      <link href={canonical} rel="canonical" />
      <meta content={noindex ? "noindex,nofollow" : "index,follow"} name="robots" />
      <meta content="website" property="og:type" />
      <meta content={title} property="og:title" />
      <meta content={description} property="og:description" />
      <meta content={canonical} property="og:url" />
      <meta content={canonicalOrigin + "/og.svg"} property="og:image" />
      <meta content="#17241f" name="theme-color" />
      <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
      <link href="/manifest.webmanifest" rel="manifest" />
      <link href="/styles.css" rel="stylesheet" />
      {script ? <script defer src={script}></script> : null}
    </head>
    <body>
      <a class="skip-link" href="#main">
        本文へ移動
      </a>
      <header class="site-header">
        <a aria-label="受付札 ホーム" class="brand" href="/">
          <span aria-hidden="true" class="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <b>受付札</b>
        </a>
        <nav aria-label="主なページ">
          <a href="/#create">受付を作る</a>
          <a href="/guide">使い方</a>
          <a href="/safety">安全</a>
          <a href="/privacy">データ</a>
        </nav>
      </header>
      {children}
      <footer>
        <p>予約の受付と当日名簿だけ。決済と連絡は扱いません。</p>
        <div>
          <a href="/safety">安全</a>
          <a href="/privacy">プライバシー</a>
          <a href="https://github.com/yhay81/uketsuke-fuda">GitHub</a>
        </div>
      </footer>
    </body>
  </html>
);

const TicketVisual = () => (
  <div aria-label="イベントの取り置き券と当日受付名簿" class="ticket-visual" role="img">
    <div class="ticket-stub">
      <span class="ticket-date">
        <b>08</b>
        <i>AUG</i>
      </span>
      <span class="ticket-event">
        <small>LIVE HOUSE</small>
        <b>夜の小箱</b>
        <i>OPEN 18:30</i>
      </span>
      <span class="ticket-count">
        <b>2</b>
        <i>枚</i>
      </span>
    </div>
    <div class="roster-preview">
      <span class="roster-head">
        <i />
        受付名簿 <b>12席</b>
      </span>
      <span>
        <i class="checked" />
        <b>青木</b>
        <em>2</em>
      </span>
      <span>
        <i />
        <b>みずき</b>
        <em>1</em>
      </span>
      <span>
        <i />
        <b>さくら</b>
        <em>2</em>
      </span>
    </div>
  </div>
);

const kindOptions = () =>
  eventKinds.map((kind) => <option value={kind}>{kindLabels[kind]}</option>);

const Home = () => (
  <Layout
    canonical={canonicalOrigin + "/"}
    description="ライブと小さなイベントの取り置き予約を一つのURLに集め、出演者別の集計と当日受付名簿へつなぎます。"
    script="/app.js"
    title="受付札｜取り置き予約を当日の名簿へ"
  >
    <main id="main">
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">RESERVE → DOOR</p>
          <h1>予約は一枚、当日は名簿。</h1>
          <p>
            DMや口頭の取り置きを同じ受付へ。予約者はアカウント不要、主催者はそのまま当日チェックできます。
          </p>
          <div class="hero-actions">
            <a class="primary" href="#create">
              受付を作る
            </a>
            <a class="secondary" href="/guide">
              流れを見る
            </a>
          </div>
        </div>
        <TicketVisual />
      </section>
      <section aria-label="受付札でできること" class="signal-strip">
        <article>
          <span class="stub-mark" />
          <b>予約URL</b>
          <small>客側は登録なし</small>
        </article>
        <article>
          <span class="route-mark">
            <i />
            <i />
            <i />
          </span>
          <b>出演者別</b>
          <small>入口ごとに集計</small>
        </article>
        <article>
          <span class="check-mark">✓</span>
          <b>当日受付</b>
          <small>印刷・CSVにも</small>
        </article>
      </section>
      <section class="create-panel" id="create">
        <div class="panel-heading">
          <span aria-hidden="true" class="panel-ticket">
            ＋
          </span>
          <div>
            <p class="eyebrow">OPEN A DESK</p>
            <h2>次の一公演を開く</h2>
          </div>
        </div>
        <form data-create-form>
          <div class="form-grid">
            <label class="field field-wide">
              イベント名
              <input maxlength={50} name="title" placeholder="夜の小箱 vol.3" required />
            </label>
            <label class="field">
              種類<select name="kind">{kindOptions()}</select>
            </label>
            <label class="field">
              会場
              <input maxlength={50} name="venue" placeholder="会場名" required />
            </label>
            <label class="field">
              開場
              <input name="doorsAt" required type="datetime-local" />
            </label>
            <label class="field">
              開演
              <input name="startsAt" required type="datetime-local" />
            </label>
            <label class="field">
              料金メモ
              <input maxlength={30} name="priceNote" placeholder="2,500円 + 1D" />
            </label>
            <label class="field">
              受付上限
              <input
                inputmode="numeric"
                max="500"
                min="0"
                name="capacity"
                type="number"
                value="0"
              />
              <small>0なら上限なし</small>
            </label>
            <label class="field">
              一予約の上限
              <input
                inputmode="numeric"
                max="10"
                min="1"
                name="maxPerReservation"
                type="number"
                value="4"
              />
            </label>
            <label class="field field-wide">
              出演者・受付経路
              <textarea
                maxlength={327}
                name="routes"
                placeholder={"出演者A\n出演者B\n主催"}
                rows={3}
              />
              <small>一行に一つ、最大8件。なくても使えます。</small>
            </label>
            <label class="field field-wide">
              案内
              <textarea
                maxlength={160}
                name="note"
                placeholder="受付で予約名をお伝えください。URLや連絡先は入力できません。"
                rows={3}
              />
            </label>
            <label aria-hidden="true" class="honeypot">
              Webサイト
              <input autocomplete="off" name="website" tabindex={-1} />
            </label>
          </div>
          <div class="safety-inline">
            <span class="shield-dot" />
            <p>予約名は主催者だけに表示します。メール、電話番号、決済情報は受け取りません。</p>
          </div>
          <button class="primary" type="submit">
            予約受付を開く
          </button>
          <p aria-live="polite" class="form-message" data-form-message />
        </form>
      </section>
      <section class="boundary-row">
        <div>
          <span class="boundary-icon link" />
          <b>URLを案内</b>
          <p>SNSやプロフィールに予約ページを置けます。</p>
        </div>
        <div>
          <span class="boundary-icon tally" />
          <b>口頭分も足す</b>
          <p>主催者が同じ名簿へ代理登録できます。</p>
        </div>
        <div>
          <span class="boundary-icon door" />
          <b>来場をチェック</b>
          <p>スマホでも印刷でも受付できます。</p>
        </div>
      </section>
    </main>
  </Layout>
);

const EventShell = ({ id, mode }: { id: string; mode: "manage" | "public" }) => (
  <Layout
    canonical={`${canonicalOrigin}/e/${id}`}
    description="イベントの取り置き予約ページ。予約者アカウントや事前決済なしで受付します。"
    noindex
    script="/event.js"
    title={mode === "manage" ? "受付を管理｜受付札" : "取り置き予約｜受付札"}
  >
    <main class="event-shell" data-event-id={id} data-mode={mode} id="main">
      <section class="loading-bay">
        <div class="ticket-loader">
          <i />
          <i />
          <i />
        </div>
        <p>受付を開いています</p>
      </section>
    </main>
  </Layout>
);

const Guide = () => (
  <Layout
    canonical={canonicalOrigin + "/guide"}
    description="予約受付を作り、案内し、当日名簿で来場を確認するまで。"
    title="使い方｜受付札"
  >
    <main class="info-page" id="main">
      <section class="info-heading">
        <div>
          <p class="eyebrow">ONE EVENT FLOW</p>
          <h1>受付を開き、名簿で迎える。</h1>
          <p>新しい公演を一つだけ試し、合わなければ元の方法へ戻せます。</p>
        </div>
        <TicketVisual />
      </section>
      <ol class="guide-cards">
        <li>
          <span>01</span>
          <div>
            <h2>公演と受付経路を作る</h2>
            <p>日時、会場、出演者名を固定項目へ入れます。</p>
          </div>
        </li>
        <li>
          <span>02</span>
          <div>
            <h2>予約URLを案内する</h2>
            <p>予約者は名前と枚数だけで取り置きできます。</p>
          </div>
        </li>
        <li>
          <span>03</span>
          <div>
            <h2>DM・口頭分も足す</h2>
            <p>主催者は管理画面から代理予約できます。</p>
          </div>
        </li>
        <li>
          <span>04</span>
          <div>
            <h2>来場をチェックする</h2>
            <p>受付順に確認し、必要なら印刷・CSVを使います。</p>
          </div>
        </li>
      </ol>
    </main>
  </Layout>
);

const Safety = () => (
  <Layout
    canonical={canonicalOrigin + "/safety"}
    description="受付札が扱う予約情報と、扱わない決済・連絡・本人確認の境界。"
    title="安全｜受付札"
  >
    <main class="info-page" id="main">
      <section class="safety-heading">
        <div class="safety-tickets">
          <i />
          <i />
          <i />
        </div>
        <div>
          <p class="eyebrow">EVENT BOUNDARY</p>
          <h1>受付に必要な分だけ。</h1>
          <p>予約名と枚数の外へ広げません。</p>
        </div>
      </section>
      <section class="data-grid">
        <article class="data-card keep">
          <h2>この場でできること</h2>
          <ul>
            <li>イベントごとの取り置き受付</li>
            <li>出演者別集計と代理登録</li>
            <li>当日チェック、印刷、CSV</li>
          </ul>
        </article>
        <article class="data-card never">
          <h2>この場でできないこと</h2>
          <ul>
            <li>事前決済、返金、発券</li>
            <li>メール送信、チャット、本人確認</li>
            <li>席指定、入場や開催の保証</li>
          </ul>
        </article>
      </section>
      <section class="source-card">
        <h2>公開ページの通報</h2>
        <p>
          異なる利用者から安全上の通報が3件届くと受付を非表示にします。開催内容、料金、入場条件は主催者の公式案内も確認してください。
        </p>
      </section>
    </main>
  </Layout>
);

const Privacy = () => (
  <Layout
    canonical={canonicalOrigin + "/privacy"}
    description="受付札が保存する予約名、匿名識別子、管理鍵と削除時期。"
    title="データ｜受付札"
  >
    <main class="info-page" id="main">
      <section class="privacy-heading">
        <div class="privacy-roster">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div>
          <p class="eyebrow">ROSTER SLOTS</p>
          <h1>名簿は主催者にだけ。</h1>
          <p>Cookieも予約者アカウントも作りません。</p>
        </div>
      </section>
      <section class="data-grid">
        <article class="data-card keep">
          <h2>保存するもの</h2>
          <ul>
            <li>イベント名、日時、会場、短い案内</li>
            <li>予約名、枚数、経路、短いメモ</li>
            <li>匿名のブラウザー識別子</li>
            <li>管理鍵を一方向に変換した値</li>
          </ul>
        </article>
        <article class="data-card never">
          <h2>保存しないもの</h2>
          <ul>
            <li>メール、電話番号、住所、SNS</li>
            <li>カード、銀行、決済情報</li>
            <li>画像、チャット、本人確認書類</li>
            <li>他サイトの閲覧情報</li>
          </ul>
        </article>
      </section>
      <p class="retention-note">
        イベントと予約名は開演7日後に削除します。行動集計は個人名を含まず、35日後に削除します。管理URLをなくすと再発行できません。
      </p>
    </main>
  </Layout>
);

app.use("*", requestId());
app.use("*", async (c, next) => {
  await next();
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
});

app.get("/", (c) => c.html(<Home />));
app.get("/guide", (c) => c.html(<Guide />));
app.get("/safety", (c) => c.html(<Safety />));
app.get("/privacy", (c) => c.html(<Privacy />));
app.get("/e/:id", (c) => c.html(<EventShell id={validateId(c.req.param("id"))} mode="public" />));
app.get("/m/:id", (c) => c.html(<EventShell id={validateId(c.req.param("id"))} mode="manage" />));
app.get("/health", (c) => c.json({ ok: true, service: "uketsuke-fuda" }));
app.get("/sitemap.xml", (c) => {
  const urls = ["/", "/guide", "/safety", "/privacy"];
  return c.text(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((path) => `<url><loc>${canonicalOrigin}${path}</loc></url>`).join("")}</urlset>`,
    200,
    { "Content-Type": "application/xml; charset=utf-8" },
  );
});

app.post("/api/events", async (c) => {
  enforceSameOrigin(c);
  const actor = sessionId(c);
  const payload = objectPayload(await parseJson(c));
  if (payload.website !== "") throw new ApiError("invalid_request", 400);
  const title = cleanText(payload, "title", 50, { blockLinks: true });
  const venue = cleanText(payload, "venue", 50, { blockLinks: true });
  const priceNote = cleanText(payload, "priceNote", 30, { allowEmpty: true, blockLinks: true });
  const note = cleanText(payload, "note", 160, { allowEmpty: true, blockLinks: true });
  const kindValue = payload.kind;
  if (typeof kindValue !== "string" || !isEventKind(kindValue))
    throw new ApiError("invalid_kind", 400);
  const startsAt = integerValue(payload, "startsAt", 0, 4_102_444_800);
  const doorsAt = integerValue(payload, "doorsAt", 0, 4_102_444_800);
  const capacity = integerValue(payload, "capacity", 0, 500);
  const maxPerReservation = integerValue(payload, "maxPerReservation", 1, 10);
  const routes = routesFromPayload(payload);
  const current = nowSeconds();
  if (
    startsAt < current + 900 ||
    startsAt > current + 120 * 86400 ||
    doorsAt > startsAt ||
    doorsAt < current
  ) {
    throw new ApiError("invalid_schedule", 400);
  }
  const rate = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE creator_session_id = ? AND created_at >= ?",
  )
    .bind(actor, current - 7 * 86400)
    .first<{ count: number }>();
  if ((rate?.count ?? 0) >= 5) throw new ApiError("create_rate_limited", 429);
  const id = randomHex(16);
  const token = randomHex(32);
  await c.env.DB.prepare(
    "INSERT INTO events (id,manager_token_hash,creator_session_id,title,kind,venue,starts_at,doors_at,price_note,capacity,max_per_reservation,routes_json,note,status,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)",
  )
    .bind(
      id,
      await sha256(token),
      actor,
      title,
      kindValue,
      venue,
      startsAt,
      doorsAt,
      priceNote,
      capacity,
      maxPerReservation,
      JSON.stringify(routes),
      note,
      current,
      current,
      expiryForEvent(startsAt),
    )
    .run();
  await recordEvent(c, "event_created", id, actor);
  return c.json(
    {
      id,
      publicUrl: `${canonicalOrigin}/e/${id}`,
      manageUrl: `${canonicalOrigin}/m/${id}#key=${token}`,
    },
    201,
  );
});

app.get("/api/events/:id", async (c) =>
  c.json(await publicEvent(c.env.DB, await getEvent(c.env.DB, validateId(c.req.param("id"))))),
);

const createReservation = async (c: AppContext, event: EventRow, organizer = false) => {
  const payload = objectPayload(await parseJson(c));
  if (payload.website !== "") throw new ApiError("invalid_request", 400);
  if (event.status !== "open" || event.starts_at <= nowSeconds())
    throw new ApiError("reservations_closed", 409);
  const displayName = cleanText(payload, "displayName", 30, { blockLinks: true });
  const note = cleanText(payload, "note", 80, { allowEmpty: true, blockLinks: true });
  const routeName = cleanText(payload, "routeName", 40, { allowEmpty: true, blockLinks: true });
  const quantity = integerValue(payload, "quantity", 1, event.max_per_reservation);
  const routes = JSON.parse(event.routes_json) as string[];
  if (routeName && !routes.includes(routeName)) throw new ApiError("invalid_routeName", 400);
  const actor = sessionId(c);
  const current = nowSeconds();
  if (!organizer) {
    const rate = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM reservations WHERE session_id = ? AND created_at >= ?",
    )
      .bind(actor, current - 86400)
      .first<{ count: number }>();
    if ((rate?.count ?? 0) >= 10) throw new ApiError("reservation_rate_limited", 429);
  }
  const reserved = await reservationCount(c.env.DB, event.id);
  if (event.capacity > 0 && reserved + quantity > event.capacity)
    throw new ApiError("capacity_reached", 409);
  const id = randomHex(16);
  const token = randomHex(32);
  await c.env.DB.prepare(
    "INSERT INTO reservations (id,event_id,manager_token_hash,session_id,display_name,quantity,route_name,note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'reserved',?,?)",
  )
    .bind(
      id,
      event.id,
      await sha256(token),
      actor,
      displayName,
      quantity,
      routeName,
      note,
      current,
      current,
    )
    .run();
  await recordEvent(c, "reservation_created", event.id, actor);
  return { id, manageUrl: organizer ? "" : `${canonicalOrigin}/r/${id}#key=${token}` };
};

app.post("/api/events/:id/reservations", async (c) => {
  enforceSameOrigin(c);
  const event = await getEvent(c.env.DB, validateId(c.req.param("id")));
  return c.json(await createReservation(c, event), 201);
});

app.get("/r/:id", (c) => c.html(<EventShell id={validateId(c.req.param("id"))} mode="public" />));
app.get("/api/reservations/:id", async (c) => {
  const reservation = await reservationManager(c, validateId(c.req.param("id")));
  const event = await getEvent(c.env.DB, reservation.event_id, true);
  return c.json({
    event: await publicEvent(c.env.DB, event),
    reservation: {
      displayName: reservation.display_name,
      id: reservation.id,
      note: reservation.note,
      quantity: reservation.quantity,
      routeName: reservation.route_name,
      status: reservation.status,
    },
  });
});

app.patch("/api/reservations/:id", async (c) => {
  enforceSameOrigin(c);
  const reservation = await reservationManager(c, validateId(c.req.param("id")));
  const event = await getEvent(c.env.DB, reservation.event_id, true);
  if (event.starts_at <= nowSeconds()) throw new ApiError("reservations_closed", 409);
  const payload = objectPayload(await parseJson(c));
  const status = payload.status;
  if (typeof status !== "string" || !new Set(["reserved", "cancelled"]).has(status))
    throw new ApiError("invalid_status", 400);
  if (status === "reserved" && reservation.status === "cancelled") {
    const reserved = await reservationCount(c.env.DB, event.id);
    if (event.capacity > 0 && reserved + reservation.quantity > event.capacity)
      throw new ApiError("capacity_reached", 409);
  }
  await c.env.DB.prepare("UPDATE reservations SET status = ?,updated_at = ? WHERE id = ?")
    .bind(status, nowSeconds(), reservation.id)
    .run();
  await recordEvent(c, "reservation_managed", event.id, reservation.session_id);
  return c.json({ status });
});

app.get("/api/events/:id/manage", async (c) =>
  c.json(await managerEvent(c.env.DB, await eventManager(c, validateId(c.req.param("id"))))),
);

app.post("/api/events/:id/manage/reservations", async (c) => {
  enforceSameOrigin(c);
  const event = await eventManager(c, validateId(c.req.param("id")));
  return c.json(await createReservation(c, event, true), 201);
});

app.patch("/api/events/:id/manage", async (c) => {
  enforceSameOrigin(c);
  const event = await eventManager(c, validateId(c.req.param("id")));
  const payload = objectPayload(await parseJson(c));
  if (event.status === "hidden") throw new ApiError("not_found", 404);
  if (
    typeof payload.status !== "string" ||
    !isEventStatus(payload.status) ||
    payload.status === "hidden"
  )
    throw new ApiError("invalid_status", 400);
  await c.env.DB.prepare("UPDATE events SET status = ?,updated_at = ? WHERE id = ?")
    .bind(payload.status, nowSeconds(), event.id)
    .run();
  await recordEvent(c, "event_managed", event.id, event.creator_session_id);
  return c.json({ status: payload.status });
});

app.patch("/api/events/:id/manage/reservations/:reservationId", async (c) => {
  enforceSameOrigin(c);
  const event = await eventManager(c, validateId(c.req.param("id")));
  const reservationId = validateId(c.req.param("reservationId"));
  const reservation = await c.env.DB.prepare(
    "SELECT * FROM reservations WHERE id = ? AND event_id = ?",
  )
    .bind(reservationId, event.id)
    .first<ReservationRow>();
  if (!reservation) throw new ApiError("not_found", 404);
  const payload = objectPayload(await parseJson(c));
  if (typeof payload.status !== "string" || !isReservationStatus(payload.status))
    throw new ApiError("invalid_status", 400);
  if (payload.status !== "cancelled" && reservation.status === "cancelled") {
    const reserved = await reservationCount(c.env.DB, event.id);
    if (event.capacity > 0 && reserved + reservation.quantity > event.capacity)
      throw new ApiError("capacity_reached", 409);
  }
  await c.env.DB.prepare("UPDATE reservations SET status = ?,updated_at = ? WHERE id = ?")
    .bind(payload.status, nowSeconds(), reservation.id)
    .run();
  await recordEvent(c, "reservation_managed", event.id, event.creator_session_id);
  return c.json({ status: payload.status });
});

app.get("/api/events/:id/manage/csv", async (c) => {
  const event = await eventManager(c, validateId(c.req.param("id")));
  const data = await managerEvent(c.env.DB, event);
  const escape = (value: string | number) => `"${String(value).replace(/"/gu, '""')}"`;
  const lines = [
    "状態,予約名,枚数,受付経路,メモ",
    ...data.reservations.map((r) =>
      [r.status, r.display_name, r.quantity, r.route_name, r.note].map(escape).join(","),
    ),
  ];
  await recordEvent(c, "roster_exported", event.id, event.creator_session_id);
  return c.body("\uFEFF" + lines.join("\r\n"), 200, {
    "Content-Disposition": `attachment; filename="uketsuke-${event.id}.csv"`,
    "Content-Type": "text/csv; charset=utf-8",
  });
});

app.delete("/api/events/:id", async (c) => {
  enforceSameOrigin(c);
  const event = await eventManager(c, validateId(c.req.param("id")));
  await c.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(event.id).run();
  return c.json({ deleted: true });
});

app.post("/api/events/:id/report", async (c) => {
  enforceSameOrigin(c);
  const actor = sessionId(c);
  const event = await getEvent(c.env.DB, validateId(c.req.param("id")), true);
  const payload = objectPayload(await parseJson(c));
  if (typeof payload.reason !== "string" || !reportReasons.has(payload.reason))
    throw new ApiError("invalid_reason", 400);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO content_reports (event_id,session_id,reason,created_at) VALUES (?,?,?,?)",
  )
    .bind(event.id, actor, payload.reason, nowSeconds())
    .run();
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM content_reports WHERE event_id = ?",
  )
    .bind(event.id)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= 3)
    await c.env.DB.prepare("UPDATE events SET status = 'hidden',updated_at = ? WHERE id = ?")
      .bind(nowSeconds(), event.id)
      .run();
  return c.json({ ok: true }, 202);
});

app.post("/api/telemetry", async (c) => {
  enforceSameOrigin(c);
  const payload = objectPayload(await parseJson(c));
  const name = payload.name;
  if (typeof name !== "string" || !new Set(["visited", "returned"]).has(name))
    throw new ApiError("invalid_event", 400);
  await recordEvent(c, name);
  return c.json({ ok: true }, 202);
});

app.onError((error, c) => {
  if (error instanceof ApiError)
    return c.json({ error: error.code, requestId: c.get("requestId") }, error.status);
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : "unknown",
      requestId: c.get("requestId"),
    }),
  );
  return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
});

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.status !== 404) return response;
  return c.html(
    <Layout
      canonical={canonicalOrigin + c.req.path}
      description="ページが見つかりません。"
      noindex
      title="見つかりません｜受付札"
    >
      <main class="not-found" id="main">
        <TicketVisual />
        <h1>受付が見つかりません</h1>
        <a class="primary" href="/">
          ホームへ戻る
        </a>
      </main>
    </Layout>,
    404,
  );
});

export const scheduled = async (
  _controller: ScheduledEvent,
  env: Bindings,
  _context: ExecutionContext,
) => {
  const current = nowSeconds();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE expires_at < ?").bind(current),
    env.DB.prepare("DELETE FROM product_events WHERE created_at < ?").bind(current - 35 * 86400),
  ]);
};

export { app };
export default { fetch: app.fetch, scheduled };
