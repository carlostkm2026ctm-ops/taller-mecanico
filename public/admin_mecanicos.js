const TOKEN_KEY = "taller_token_v1";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function apiFetch(path, token, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  headers["Authorization"] = `Bearer ${token}`;
  return fetch(path, { ...options, headers });
}

function setMsg(text, kind) {
  const el = document.getElementById("msg");
  if (!el) return;
  el.innerHTML = "";
  if (!text) return;
  const div = document.createElement("div");
  div.className = kind === "error" ? "errorBox" : "successBox";
  div.textContent = text;
  el.appendChild(div);
}

function formToPayload(form) {
  const fd = new FormData(form);
  return Object.fromEntries(fd.entries());
}

async function init() {
  const token = getToken();
  if (!token) {
    window.location.href = "/login.html";
    return;
  }

  const meRes = await apiFetch("/api/auth/me", token);
  const me = await meRes.json().catch(() => ({}));
  if (!meRes.ok || me?.user?.role !== "admin") {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = "/login.html";
    return;
  }
  document.getElementById("userLabel").textContent = me?.user?.username ? `@${me.user.username}` : "";

  document.getElementById("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = "/login.html";
  });

  document.getElementById("backBtn").addEventListener("click", () => {
    window.location.href = "/app.html";
  });

  const form = document.getElementById("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMsg("", "");
    const payload = formToPayload(form);
    try {
      const r = await apiFetch("/api/admin/mecanicos", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Error al crear mecánico");
      setMsg("Mecánico creado. Ya puede entrar con su usuario.", "ok");
      form.reset();
    } catch (err) {
      setMsg(err.message || String(err), "error");
    }
  });
}

init().catch((e) => {
  setMsg(e?.message ? String(e.message) : String(e), "error");
});

