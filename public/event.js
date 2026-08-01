const sessionKey = "uketsuke-fuda-session";
const session = (() => {
  try {
    const existing = localStorage.getItem(sessionKey);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(sessionKey, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
})();
const key = new URLSearchParams(location.hash.slice(1)).get("key") || "";
const root = document.querySelector(".event-shell");
const id = root?.dataset.eventId || "";
const pathMode = location.pathname.startsWith("/m/")
  ? "manager"
  : location.pathname.startsWith("/r/")
    ? "reservation"
    : "public";
const baseHeaders = (withKey = false) => ({
  "content-type": "application/json",
  ...(withKey ? { "x-uketsuke-key": key } : {}),
  "x-uketsuke-qa": new URLSearchParams(location.search).get("qa") === "1" ? "1" : "0",
  "x-uketsuke-session": session,
});
const request = async (url, options = {}, withKey = false) => {
  const response = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(withKey), ...options.headers },
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data.error || "request_failed");
  return data;
};
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const formatDate = (seconds) =>
  new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(seconds * 1000),
  );
const statusLabels = { cancelled: "取消", checked_in: "来場", reserved: "予約" };
const messageFor = (error) => {
  const messages = {
    capacity_reached: "残席が足りません。枚数を減らしてもう一度お試しください。",
    invalid_capability: "管理URLが正しくありません。作成時のURLを開いてください。",
    not_found: "この受付は終了したか、見つかりません。",
    reservation_rate_limited: "短時間の予約上限に達しました。しばらくしてからお試しください。",
    reservations_closed: "この受付は終了しています。",
  };
  return messages[error] || "操作を完了できませんでした。もう一度お試しください。";
};

const eventCard = (event, compact = false) => {
  const card = node("section", compact ? "event-card compact" : "event-card");
  const top = node("div", "event-card-top");
  const date = node("span", "event-date");
  const dateValue = new Date(event.startsAt * 1000);
  date.append(
    node("b", "", String(dateValue.getDate()).padStart(2, "0")),
    node("i", "", dateValue.toLocaleDateString("en", { month: "short" }).toUpperCase()),
  );
  const copy = node("div", "event-card-copy");
  copy.append(
    node("small", "kind-chip", event.kindLabel),
    node("h1", "", event.title),
    node("p", "", `${formatDate(event.startsAt)} · ${event.venue}`),
  );
  top.append(date, copy);
  const facts = node("div", "event-facts");
  facts.append(node("span", "", `開場 ${formatDate(event.doorsAt).split(" ").at(-1)}`));
  if (event.priceNote) facts.append(node("span", "", event.priceNote));
  if (event.capacity > 0) facts.append(node("span", "", `残り ${event.seatsRemaining}席`));
  else facts.append(node("span", "", `${event.reserved}席 受付済み`));
  card.append(top, facts);
  if (event.note) card.append(node("p", "event-note", event.note));
  return card;
};

const renderPublic = async () => {
  const event = await request(`/api/events/${id}`);
  root.replaceChildren();
  root.append(eventCard(event));
  const panel = node("section", "reservation-panel");
  const heading = node("div", "panel-heading");
  heading.append(node("span", "panel-ticket", "＋"));
  const headingCopy = node("div");
  headingCopy.append(
    node("p", "eyebrow", "RESERVE"),
    node(
      "h2",
      "",
      event.status === "open" && !event.isPast ? "取り置きを申し込む" : "受付は終了しました",
    ),
  );
  heading.append(headingCopy);
  panel.append(heading);
  if (event.status === "open" && !event.isPast) {
    const form = node("form", "reservation-form");
    const grid = node("div", "form-grid");
    const nameLabel = node("label", "field");
    nameLabel.append(
      "予約名",
      Object.assign(node("input"), {
        maxLength: 30,
        name: "displayName",
        placeholder: "受付で伝える名前",
        required: true,
      }),
    );
    const quantityLabel = node("label", "field");
    const quantity = Object.assign(node("input"), {
      max: String(event.maxPerReservation),
      min: "1",
      name: "quantity",
      required: true,
      type: "number",
      value: "1",
    });
    quantityLabel.append("枚数", quantity);
    grid.append(nameLabel, quantityLabel);
    if (event.routes.length) {
      const routeLabel = node("label", "field field-wide");
      routeLabel.append("お目当て・受付経路");
      const select = Object.assign(node("select"), { name: "routeName" });
      select.append(node("option", "", "選択なし"));
      for (const route of event.routes)
        select.append(Object.assign(node("option", "", route), { value: route }));
      const desired = new URLSearchParams(location.search).get("route");
      if (desired && event.routes.includes(desired)) select.value = desired;
      routeLabel.append(select);
      grid.append(routeLabel);
    }
    const noteLabel = node("label", "field field-wide");
    const note = Object.assign(node("textarea"), {
      maxLength: 80,
      name: "note",
      placeholder: "主催者への短いメモ（任意）",
      rows: 2,
    });
    noteLabel.append("メモ", note);
    const honeypot = Object.assign(node("input"), { name: "website", tabIndex: -1 });
    const hiddenLabel = node("label", "honeypot");
    hiddenLabel.append("Webサイト", honeypot);
    grid.append(noteLabel, hiddenLabel);
    const message = node("p", "form-message");
    message.setAttribute("aria-live", "polite");
    form.append(
      grid,
      node("p", "privacy-inline", "予約名は主催者だけに表示され、開演7日後に削除されます。"),
      Object.assign(node("button", "primary", "この内容で取り置く"), { type: "submit" }),
      message,
    );
    form.addEventListener("submit", async (submitEvent) => {
      submitEvent.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      message.textContent = "予約を名簿へ追加しています…";
      const data = new FormData(form);
      try {
        const result = await request(`/api/events/${id}/reservations`, {
          body: JSON.stringify({
            displayName: data.get("displayName"),
            note: data.get("note"),
            quantity: Number(data.get("quantity")),
            routeName: data.get("routeName") || "",
            website: data.get("website"),
          }),
          method: "POST",
        });
        root.replaceChildren();
        const done = node("section", "done-card");
        done.append(
          node("span", "done-check", "✓"),
          node("h1", "", "取り置きました"),
          node(
            "p",
            "",
            "当日は受付で予約名をお伝えください。変更・取消URLはこの端末へ保存してください。",
          ),
        );
        const link = Object.assign(node("a", "primary", "予約を確認する"), {
          href: result.manageUrl,
        });
        done.append(link);
        root.append(done, eventCard(event, true));
      } catch (error) {
        message.textContent = messageFor(error.message);
        button.disabled = false;
      }
    });
    panel.append(form);
  }
  const report = node("details", "report-panel");
  report.append(node("summary", "", "このイベントを通報"));
  const reportForm = node("form");
  const select = node("select");
  for (const [value, label] of [
    ["misleading", "内容が誤解を招く"],
    ["unsafe", "安全上の問題"],
    ["spam", "スパム"],
    ["other", "その他"],
  ])
    select.append(Object.assign(node("option", "", label), { value }));
  const reportMessage = node("p", "form-message");
  reportForm.append(
    select,
    Object.assign(node("button", "secondary", "通報する"), { type: "submit" }),
    reportMessage,
  );
  reportForm.addEventListener("submit", async (reportEvent) => {
    reportEvent.preventDefault();
    try {
      await request(`/api/events/${id}/report`, {
        body: JSON.stringify({ reason: select.value }),
        method: "POST",
      });
      reportMessage.textContent = "通報を受け付けました。";
    } catch (error) {
      reportMessage.textContent = messageFor(error.message);
    }
  });
  report.append(reportForm);
  root.append(panel, report);
};

const renderReservation = async () => {
  if (!key) throw new Error("invalid_capability");
  const data = await request(`/api/reservations/${id}`, {}, true);
  root.replaceChildren();
  const booking = node("section", "booking-card");
  booking.append(
    node("p", "eyebrow", "YOUR RESERVATION"),
    node("h1", "", `${data.reservation.displayName} · ${data.reservation.quantity}枚`),
  );
  const status = node(
    "span",
    `status-chip ${data.reservation.status}`,
    statusLabels[data.reservation.status],
  );
  booking.append(status);
  if (data.reservation.routeName)
    booking.append(node("p", "", `受付経路：${data.reservation.routeName}`));
  const button = Object.assign(
    node(
      "button",
      data.reservation.status === "cancelled" ? "primary" : "danger",
      data.reservation.status === "cancelled" ? "予約を戻す" : "予約を取り消す",
    ),
    { type: "button" },
  );
  const message = node("p", "form-message");
  button.addEventListener("click", async () => {
    try {
      const next = data.reservation.status === "cancelled" ? "reserved" : "cancelled";
      await request(
        `/api/reservations/${id}`,
        { body: JSON.stringify({ status: next }), method: "PATCH" },
        true,
      );
      location.reload();
    } catch (error) {
      message.textContent = messageFor(error.message);
    }
  });
  booking.append(button, message);
  root.append(eventCard(data.event, true), booking);
};

const renderManager = async () => {
  if (!key) throw new Error("invalid_capability");
  const data = await request(`/api/events/${id}/manage`, {}, true);
  root.replaceChildren();
  const manager = node("section", "manager-panel");
  const heading = node("div", "manager-heading");
  const headingCopy = node("div");
  headingCopy.append(
    node("p", "eyebrow", "DOOR DESK"),
    node(
      "h1",
      "",
      `${data.reserved}席 · ${data.reservations.filter((item) => item.status === "checked_in").reduce((sum, item) => sum + item.quantity, 0)}名来場`,
    ),
  );
  const actions = node("div", "manager-actions");
  const publicLink = Object.assign(node("a", "primary", "予約ページを開く"), {
    href: `/e/${id}`,
    target: "_blank",
  });
  const copyButton = Object.assign(node("button", "secondary", "URLをコピー"), { type: "button" });
  copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(`${location.origin}/e/${id}`);
    copyButton.textContent = "コピーしました";
  });
  const csvButton = Object.assign(node("button", "secondary", "CSV"), { type: "button" });
  csvButton.addEventListener("click", async () => {
    const response = await fetch(`/api/events/${id}/manage/csv`, { headers: baseHeaders(true) });
    if (!response.ok) return;
    const url = URL.createObjectURL(await response.blob());
    const link = Object.assign(document.createElement("a"), {
      download: `uketsuke-${id}.csv`,
      href: url,
    });
    link.click();
    URL.revokeObjectURL(url);
  });
  const printButton = Object.assign(node("button", "secondary", "印刷"), { type: "button" });
  printButton.addEventListener("click", () => print());
  actions.append(publicLink, copyButton, csvButton, printButton);
  heading.append(headingCopy, actions);
  manager.append(heading);

  const routeTotals = new Map();
  for (const reservation of data.reservations.filter((item) => item.status !== "cancelled"))
    routeTotals.set(
      reservation.route_name || "経路なし",
      (routeTotals.get(reservation.route_name || "経路なし") || 0) + reservation.quantity,
    );
  const routeStrip = node("div", "route-totals");
  for (const [route, count] of routeTotals) {
    const item = node("span");
    item.append(node("b", "", String(count)), document.createTextNode(route));
    routeStrip.append(item);
  }
  if (routeTotals.size) manager.append(routeStrip);

  const add = node("details", "proxy-panel");
  add.append(node("summary", "", "DM・口頭の予約を追加"));
  const addForm = node("form", "proxy-form");
  const addName = Object.assign(node("input"), {
    maxLength: 30,
    name: "displayName",
    placeholder: "予約名",
    required: true,
  });
  const addQuantity = Object.assign(node("input"), {
    max: String(data.maxPerReservation),
    min: "1",
    name: "quantity",
    type: "number",
    value: "1",
  });
  const addRoute = Object.assign(node("select"), { name: "routeName" });
  addRoute.append(node("option", "", "受付経路なし"));
  for (const route of data.routes)
    addRoute.append(Object.assign(node("option", "", route), { value: route }));
  const addNote = Object.assign(node("input"), {
    maxLength: 80,
    name: "note",
    placeholder: "メモ（任意）",
  });
  const addMessage = node("p", "form-message");
  addForm.append(
    addName,
    addQuantity,
    addRoute,
    addNote,
    Object.assign(node("button", "primary", "名簿へ追加"), { type: "submit" }),
    addMessage,
  );
  addForm.addEventListener("submit", async (submitEvent) => {
    submitEvent.preventDefault();
    const values = new FormData(addForm);
    try {
      await request(
        `/api/events/${id}/manage/reservations`,
        {
          body: JSON.stringify({
            displayName: values.get("displayName"),
            note: values.get("note"),
            quantity: Number(values.get("quantity")),
            routeName: values.get("routeName"),
            website: "",
          }),
          method: "POST",
        },
        true,
      );
      location.reload();
    } catch (error) {
      addMessage.textContent = messageFor(error.message);
    }
  });
  add.append(addForm);
  manager.append(add);

  const roster = node("div", "roster");
  const rosterHead = node("div", "roster-title");
  rosterHead.append(
    node("h2", "", "当日受付名簿"),
    node("span", "", `${data.reservations.length}件`),
  );
  roster.append(rosterHead);
  for (const reservation of data.reservations) {
    const row = node("article", `roster-row ${reservation.status}`);
    const check = Object.assign(
      node(
        "button",
        `arrival-check ${reservation.status === "checked_in" ? "checked" : ""}`,
        reservation.status === "checked_in" ? "✓" : "",
      ),
      { ariaLabel: "来場を切り替える", type: "button" },
    );
    const copy = node("div", "roster-copy");
    copy.append(
      node("b", "", reservation.display_name),
      node(
        "span",
        "",
        `${reservation.quantity}枚${reservation.route_name ? ` · ${reservation.route_name}` : ""}`,
      ),
    );
    if (reservation.note) copy.append(node("small", "", reservation.note));
    const cancel = Object.assign(
      node("button", "row-action", reservation.status === "cancelled" ? "戻す" : "取消"),
      { type: "button" },
    );
    const change = async (status) => {
      await request(
        `/api/events/${id}/manage/reservations/${reservation.id}`,
        { body: JSON.stringify({ status }), method: "PATCH" },
        true,
      );
      location.reload();
    };
    check.addEventListener("click", () =>
      change(reservation.status === "checked_in" ? "reserved" : "checked_in").catch(() => {}),
    );
    cancel.addEventListener("click", () =>
      change(reservation.status === "cancelled" ? "reserved" : "cancelled").catch(() => {}),
    );
    row.append(check, copy, cancel);
    roster.append(row);
  }
  if (!data.reservations.length)
    roster.append(node("p", "empty-roster", "予約が入ると、ここが当日の名簿になります。"));
  manager.append(roster);

  const settings = node("details", "danger-zone");
  settings.append(node("summary", "", "受付の状態と削除"));
  const statusButton = Object.assign(
    node("button", "secondary", data.status === "open" ? "受付を閉じる" : "受付を再開"),
    { type: "button" },
  );
  statusButton.addEventListener("click", async () => {
    await request(
      `/api/events/${id}/manage`,
      {
        body: JSON.stringify({ status: data.status === "open" ? "closed" : "open" }),
        method: "PATCH",
      },
      true,
    );
    location.reload();
  });
  const deleteButton = Object.assign(node("button", "danger", "イベントと名簿を削除"), {
    type: "button",
  });
  deleteButton.addEventListener("click", async () => {
    if (!confirm("予約名を含むイベントデータを削除します。元に戻せません。")) return;
    await request(`/api/events/${id}`, { body: "{}", method: "DELETE" }, true);
    location.assign("/");
  });
  settings.append(statusButton, deleteButton);
  manager.append(settings);
  root.append(eventCard(data, true), manager);
};

void (async () => {
  try {
    if (!root) return;
    if (pathMode === "manager") await renderManager();
    else if (pathMode === "reservation") await renderReservation();
    else await renderPublic();
  } catch (error) {
    root.replaceChildren();
    const panel = node("section", "error-card");
    panel.append(
      node("h1", "", "受付を開けません"),
      node("p", "", messageFor(error.message)),
      Object.assign(node("a", "primary", "ホームへ戻る"), { href: "/" }),
    );
    root.append(panel);
  }
})();
