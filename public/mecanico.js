const TOKEN_KEY = "taller_token_v1";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function apiFetch(path, token, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  headers["Authorization"] = `Bearer ${token}`;
  return fetch(path, { ...options, headers });
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
}

function setMsg(kind, text) {
  const el = document.getElementById("modalMsg");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = kind === "error" ? "#fecaca" : "#bbf7d0";
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("show");
}

function openModal(item) {
  document.getElementById("modalOverlay").classList.add("show");
  document.getElementById("modalTitle").textContent = "Editar trabajo";
  document.getElementById("modalInfo").textContent = `Trabajo #${item.id}`;

  const form = document.getElementById("jobForm");
  form.innerHTML = "";

  // Estado
  const estadoWrap = document.createElement("div");
  estadoWrap.className = "field";
  const estadoLabel = document.createElement("label");
  estadoLabel.textContent = "Estado";
  estadoWrap.appendChild(estadoLabel);
  const estadoSel = document.createElement("select");
  estadoSel.name = "estado";
  for (const opt of ["Abierta", "En progreso", "Cerrada"]) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    if (String(item.estado) === opt) o.selected = true;
    estadoSel.appendChild(o);
  }
  estadoWrap.appendChild(estadoSel);
  form.appendChild(estadoWrap);

  // Reparación realizada
  const repWrap = document.createElement("div");
  repWrap.className = "field";
  const repLabel = document.createElement("label");
  repLabel.textContent = "Reparación realizada";
  repWrap.appendChild(repLabel);
  const repArea = document.createElement("textarea");
  repArea.name = "reparacion_realizada";
  repArea.value = item.reparacion_realizada || "";
  repWrap.appendChild(repArea);
  form.appendChild(repWrap);

  // Fecha fin
  const finWrap = document.createElement("div");
  finWrap.className = "field";
  const finLabel = document.createElement("label");
  finLabel.textContent = "Fecha fin (opcional)";
  finWrap.appendChild(finLabel);
  const finInput = document.createElement("input");
  finInput.type = "date";
  finInput.name = "fecha_fin";
  finInput.value = item.fecha_fin || "";
  finWrap.appendChild(finInput);
  form.appendChild(finWrap);

  form.dataset.jobId = String(item.id);
  setMsg(null, "");
}

async function loadOptions(token) {
  const [clientesRes, vehiculosRes] = await Promise.all([
    apiFetch("/api/select/clientes", token),
    apiFetch("/api/select/vehiculos", token),
  ]);
  const clientesData = await clientesRes.json();
  const vehiculosData = await vehiculosRes.json();
  const clientesMap = new Map((clientesData.options || []).map((o) => [String(o.id), o.label]));
  const vehiculosMap = new Map((vehiculosData.options || []).map((o) => [String(o.id), o.label]));
  return { clientesMap, vehiculosMap };
}

async function loadJobs(token) {
  const r = await apiFetch("/api/reparaciones", token);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Error al cargar trabajos");
  return data.items || [];
}

async function render(token) {
  const [meRes, options, jobs] = await Promise.all([
    apiFetch("/api/auth/me", token),
    loadOptions(token),
    loadJobs(token),
  ]);
  const me = await meRes.json().catch(() => ({}));
  setText("userLabel", me?.user?.username ? `@${me.user.username}` : "");
  setText("subtitle", `Total: ${jobs.length}`);

  const content = document.getElementById("content");
  content.innerHTML = "";

  if (!jobs.length) {
    content.innerHTML = `<div class="errorBox">No tienes trabajos asignados.</div>`;
    return;
  }

  const table = document.createElement("table");
  const head = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const h of ["Cliente", "Vehículo", "Estado", "Costo", "Falla", "Acción"]) {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  }
  head.appendChild(hr);
  table.appendChild(head);

  const tbody = document.createElement("tbody");
  for (const job of jobs) {
    const tr = document.createElement("tr");

    const tdCliente = document.createElement("td");
    tdCliente.textContent = options.clientesMap.get(String(job.cliente_id)) || String(job.cliente_id || "");
    tr.appendChild(tdCliente);

    const tdVeh = document.createElement("td");
    tdVeh.textContent = options.vehiculosMap.get(String(job.vehiculo_id)) || String(job.vehiculo_id || "");
    tr.appendChild(tdVeh);

    const tdEstado = document.createElement("td");
    tdEstado.textContent = job.estado || "";
    tr.appendChild(tdEstado);

    const tdCosto = document.createElement("td");
    tdCosto.textContent = job.costo_total != null ? String(job.costo_total) : "";
    tr.appendChild(tdCosto);

    const tdFalla = document.createElement("td");
    tdFalla.textContent = job.descripcion_falla || "";
    tr.appendChild(tdFalla);

    const tdAction = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = "Editar";
    btn.addEventListener("click", () => openModal(job));
    tdAction.appendChild(btn);
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  content.appendChild(table);
}

async function saveJob(token) {
  const form = document.getElementById("jobForm");
  const id = form.dataset.jobId;
  const fd = new FormData(form);
  const payload = Object.fromEntries(fd.entries());

  // payload: { estado, reparacion_realizada, fecha_fin }
  // Dejar fecha_fin como null si viene vacío.
  if (payload.fecha_fin === "") payload.fecha_fin = null;

  const r = await apiFetch(`/api/reparaciones/${encodeURIComponent(id)}`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Error al guardar");

  closeModal();
  await render(token);
}

async function init() {
  const token = getToken();
  if (!token) {
    window.location.href = "/login.html";
    return;
  }

  const me = await apiFetch("/api/auth/me", token).then((r) => r.json()).catch(() => null);
  if (!me?.ok && !me?.user) {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = "/login.html";
    return;
  }

  document.getElementById("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = "/login.html";
  });
  document.getElementById("refreshBtn").addEventListener("click", () => render(token));
  document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target && e.target.id === "modalOverlay") closeModal();
  });
  document.getElementById("jobForm").addEventListener("submit", async (e) => {
    e.preventDefault();
  });
  document.getElementById("saveBtn").addEventListener("click", async (e) => {
    e.preventDefault();
    const form = document.getElementById("jobForm");
    if (!form || !form.dataset.jobId) return;
    setMsg(null, "Guardando...");
    try {
      await saveJob(token);
    } catch (err) {
      setMsg("error", err.message || String(err));
    }
  });

  await render(token);
}

init().catch((err) => {
  const content = document.getElementById("content");
  content.innerHTML = `<div class="errorBox">${String(err.message || err)}</div>`;
});

