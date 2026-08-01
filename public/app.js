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

const headers = () => ({
  "content-type": "application/json",
  "x-uketsuke-qa": new URLSearchParams(location.search).get("qa") === "1" ? "1" : "0",
  "x-uketsuke-session": session,
});

const messageFor = (error) => {
  const messages = {
    create_rate_limited: "短時間に作れる受付の上限に達しました。少し時間を空けてください。",
    invalid_schedule: "開場・開演日時を確認してください。開演は15分後から120日以内です。",
    invalid_routes: "出演者・受付経路は一行40文字、最大8件までです。",
    unsafe_note: "案内にはURLや連絡先を入れられません。",
    unsafe_priceNote: "料金メモにはURLや連絡先を入れられません。",
  };
  return messages[error] || "受付を作れませんでした。入力内容を確認してください。";
};

const toSeconds = (value) => Math.floor(new Date(value).getTime() / 1000);
const localDatetime = (date) => {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
};

const form = document.querySelector("[data-create-form]");
if (form) {
  const now = new Date();
  const doors = new Date(now.getTime() + 7 * 86400000);
  doors.setHours(18, 30, 0, 0);
  const starts = new Date(doors.getTime() + 30 * 60000);
  form.elements.doorsAt.value = localDatetime(doors);
  form.elements.startsAt.value = localDatetime(starts);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = form.querySelector("[data-form-message]");
    const button = form.querySelector("button[type=submit]");
    message.textContent = "受付を用意しています…";
    button.disabled = true;
    const data = new FormData(form);
    const routeLines = data.get("routes");
    const payload = {
      capacity: Number(data.get("capacity")),
      doorsAt: toSeconds(data.get("doorsAt")),
      kind: data.get("kind"),
      maxPerReservation: Number(data.get("maxPerReservation")),
      note: data.get("note"),
      priceNote: data.get("priceNote"),
      routes: (typeof routeLines === "string" ? routeLines : "")
        .split(/\r?\n/u)
        .map((route) => route.trim())
        .filter(Boolean),
      startsAt: toSeconds(data.get("startsAt")),
      title: data.get("title"),
      venue: data.get("venue"),
      website: data.get("website"),
    };
    try {
      const response = await fetch("/api/events", {
        body: JSON.stringify(payload),
        headers: headers(),
        method: "POST",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "unknown");
      try {
        localStorage.setItem(`uketsuke-manage-${result.id}`, result.manageUrl);
      } catch {
        // The returned URL is still shown after navigation.
      }
      location.assign(result.manageUrl);
    } catch (error) {
      message.textContent = messageFor(error.message);
      button.disabled = false;
    }
  });
}

const visitedBefore = (() => {
  try {
    const key = "uketsuke-fuda-visited";
    const seen = localStorage.getItem(key);
    localStorage.setItem(key, new Date().toISOString().slice(0, 10));
    return Boolean(seen && seen !== new Date().toISOString().slice(0, 10));
  } catch {
    return false;
  }
})();

fetch("/api/telemetry", {
  body: JSON.stringify({ name: visitedBefore ? "returned" : "visited" }),
  headers: headers(),
  method: "POST",
}).catch(() => {});
