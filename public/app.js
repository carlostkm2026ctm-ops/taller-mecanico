const TOKEN_KEY = "taller_token_v1";

let meta = null;
let currentEntityKey = null;
let currentEditingId = null;
const selectCache = {};

function invalidateSelectCache() {
  for (const k of Object.keys(selectCache)) delete selectCache[k];
}

function apiFetch(path, token, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  headers["Authorization"] = `Bearer ${token}`;
  return fetch(path, { ...options, headers });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getToken() {
  // Intentar localStorage primero, luego sessionStorage
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
}

function setDisabled(el, disabled) {
  if (!el) return;
  el.disabled = !!disabled;
}

function setMsg(text, kind) {
  const el = document.getElementById("modalMsg");
  el.innerHTML = "";
  if (!text) return;
  el.textContent = text;
  el.style.color = kind === "error" ? "#fecaca" : "#bbf7d0";
}

function findField(entityKey, key) {
  const ent = meta.entities[entityKey];
  return ent.fields.find((f) => f.key === key);
}

async function ensureSelectOptions(refEntityKey, token) {
  if (selectCache[refEntityKey]) return selectCache[refEntityKey];
  const r = await apiFetch(`/api/select/${encodeURIComponent(refEntityKey)}`, token);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Error al cargar opciones");
  selectCache[refEntityKey] = new Map(data.options.map((o) => [o.id, o.label]));
  return selectCache[refEntityKey];
}

async function sendCotizacionWhatsApp(token, quoteId) {
  const r = await apiFetch(`/api/cotizaciones/${encodeURIComponent(quoteId)}/whatsapp`, token);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    setMsg(data.error || "Error al generar WhatsApp", "error");
    return;
  }
  if (!data.waUrl) {
    setMsg("El cliente no tiene teléfono válido para WhatsApp.", "error");
    return;
  }
  window.open(data.waUrl, "_blank");
}

async function renderTable(entityKey, items, token) {
  const ent = meta.entities[entityKey];
  const columns = ent.tableColumns || [];

  // Preload ref labels used in the columns.
  const refKeysToFetch = new Set();
  for (const colKey of columns) {
    const field = ent.fields.find((f) => f.key === colKey);
    if (field && field.type === "ref") refKeysToFetch.add(field.ref);
  }
  await Promise.all([...refKeysToFetch].map((rk) => ensureSelectOptions(rk, token)));

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");

  for (const colKey of columns) {
    const field = ent.fields.find((f) => f.key === colKey);
    const label = field?.label || colKey;
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }

  const thAction = document.createElement("th");
  thAction.textContent = "Acción";
  headRow.appendChild(thAction);
  thead.appendChild(headRow);

  const tbody = document.createElement("tbody");
  for (const item of items) {
    const tr = document.createElement("tr");

    for (const colKey of columns) {
      const field = ent.fields.find((f) => f.key === colKey);
      let value = item[colKey];
      if (field?.type === "ref") {
        const map = selectCache[field.ref] || new Map();
        value = map.get(value) || value || "";
      }
      const td = document.createElement("td");
      td.textContent = value ?? "";
      tr.appendChild(td);
    }

    const tdAction = document.createElement("td");
    tdAction.style.display = "flex";
    tdAction.style.gap = "8px";

    if (entityKey === "cotizaciones") {
      const waBtn = document.createElement("button");
      waBtn.className = "btn btn-primary";
      waBtn.type = "button";
      waBtn.textContent = "WhatsApp";
      waBtn.dataset.action = "whatsapp";
      waBtn.dataset.id = item.id;
      if (String(item.estado) !== "Pendiente") waBtn.disabled = true;
      tdAction.appendChild(waBtn);
    }
    
    // Botón Cobrar y Cerrar para reparaciones abiertas
    if (entityKey === "reparaciones" && String(item.estado) !== "Cerrada") {
      const cobrarBtn = document.createElement("button");
      cobrarBtn.className = "btn btn-success";
      cobrarBtn.type = "button";
      cobrarBtn.textContent = "💰 Cobrar";
      cobrarBtn.dataset.action = "cobrar";
      cobrarBtn.dataset.id = item.id;
      cobrarBtn.title = "Cobrar y cerrar reparación - Se registrará el ingreso automáticamente";
      tdAction.appendChild(cobrarBtn);
    }

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = "Editar";
    btn.dataset.action = "edit";
    btn.dataset.id = item.id;
    tdAction.appendChild(btn);
    tr.appendChild(tdAction);
    tbody.appendChild(tr);
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

async function cobrarYcerrarReparacion(token, id) {
  if (!confirm("¿Confirmas que recibiste el pago y deseas cerrar esta reparación?\n\nSe registrará el ingreso automáticamente.")) return;
  
  const r = await apiFetch(`/api/reparaciones/${encodeURIComponent(id)}`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ estado: "Cerrada" }),
  });
  
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(data.error || "Error al cerrar la reparación");
    return;
  }
  
  alert("✅ Reparación cerrada e ingreso registrado correctamente");
  await loadCurrentList(token);
}

function createInputForField(field, value = null) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";

  const label = document.createElement("label");
  label.textContent = field.label || field.key;
  wrapper.appendChild(label);

  const name = field.key;
  let input;

  if (field.type === "textarea") {
    input = document.createElement("textarea");
    input.name = name;
    input.value = value ?? "";
  } else if (field.type === "select") {
    input = document.createElement("select");
    input.name = name;
    for (const opt of field.options || []) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (String(value) === String(opt)) o.selected = true;
      input.appendChild(o);
    }
  } else if (field.type === "checkbox") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.checked = value === 1 || value === true || String(value) === "1";
  } else if (field.type === "datetime") {
    input = document.createElement("input");
    input.type = "datetime-local";
    input.name = name;
    input.value = value ?? "";
  } else if (field.type === "date") {
    input = document.createElement("input");
    input.type = "date";
    input.name = name;
    input.value = value ?? "";
  } else if (field.type === "number") {
    input = document.createElement("input");
    input.type = "number";
    input.name = name;
    if (value !== null && typeof value !== "undefined") input.value = value;
  } else if (field.type === "ref") {
    input = document.createElement("select");
    input.name = name;
    // Options injected later (cuando abrimos el modal).
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.name = name;
    input.value = value ?? "";
  }

  if (field.required && field.type !== "checkbox") input.required = true;
  if (field.required && field.type === "checkbox") input.dataset.required = "1";

  wrapper.appendChild(input);
  return { wrapper, input };
}

async function fillRefSelect(field, selectEl, token) {
  const options = await ensureSelectOptions(field.ref, token);
  selectEl.innerHTML = "";

  // Placeholder.
  const first = document.createElement("option");
  first.value = "";
  first.textContent = "-- Seleccionar --";
  selectEl.appendChild(first);

  for (const [id, label] of options.entries()) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = label;
    selectEl.appendChild(o);
  }
}

function resetModalState() {
  currentEditingId = null;
  document.getElementById("deleteBtn").style.display = "none";
  document.getElementById("modalTitle").textContent = "Crear";
  setMsg("", "ok");
}

async function openModal(entityKey, token, mode, item = null) {
  const overlay = document.getElementById("modalOverlay");
  const ent = meta.entities[entityKey];

  resetModalState();
  currentEntityKey = entityKey;

  const form = document.getElementById("entityForm");
  form.innerHTML = "";
  document.getElementById("modalTitle").textContent = mode === "edit" ? "Editar" : `Crear`;

  for (const field of ent.fields) {
    const inputValue = item
      ? item[field.key]
      : Object.prototype.hasOwnProperty.call(field, "default")
        ? field.default
        : null;
    const { wrapper, input } = createInputForField(field, inputValue);

    if (field.type === "ref") {
      await fillRefSelect(field, input, token);
      // Select current value if editing.
      if (mode === "edit" && item && item[field.key] !== null && typeof item[field.key] !== "undefined") {
        input.value = String(item[field.key]);
      }
    } else if (mode === "edit" && field.type === "checkbox") {
      // handled in createInputForField
    }

    // Add data attribute for required checkbox.
    if (field.type === "checkbox") input.dataset.fieldType = "checkbox";

    form.appendChild(wrapper);
  }

  // Configure save/delete.
  const deleteBtn = document.getElementById("deleteBtn");
  if (mode === "edit") {
    currentEditingId = item.id;
    deleteBtn.style.display = "";
  }

  overlay.classList.add("show");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("show");
}

function collectFormPayload(form, ent) {
  const payload = {};
  for (const field of ent.fields) {
    if (field.type === "checkbox") {
      const el = form.elements[field.key];
      payload[field.key] = el && el.checked ? 1 : 0;
    } else if (field.type === "number") {
      const el = form.elements[field.key];
      const v = el ? el.value : "";
      payload[field.key] = v === "" ? null : Number(v);
    } else {
      const el = form.elements[field.key];
      payload[field.key] = el ? el.value : null;
    }
  }
  return payload;
}

async function saveEntity(token, mode) {
  const form = document.getElementById("entityForm");
  const ent = meta.entities[currentEntityKey];
  const payload = collectFormPayload(form, ent);

  const msg = document.getElementById("modalMsg");
  msg.textContent = "Guardando...";

  const r =
    mode === "edit"
      ? await apiFetch(`/api/${encodeURIComponent(currentEntityKey)}/${encodeURIComponent(currentEditingId)}`, token, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      : await apiFetch(`/api/${encodeURIComponent(currentEntityKey)}`, token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    setMsg(data.error || "Error al guardar", "error");
    return;
  }

  closeModal();
  // Asegura que selects (clientes/vehículos) reflejen datos recién creados.
  invalidateSelectCache();
  await loadCurrentList(token);
}

async function deleteEntity(token) {
  if (!currentEditingId) return;
  const entKey = currentEntityKey;
  if (!confirm("¿Eliminar este registro?")) return;

  const r = await apiFetch(`/api/${encodeURIComponent(entKey)}/${encodeURIComponent(currentEditingId)}`, token, {
    method: "DELETE",
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    setMsg(data.error || "Error al eliminar", "error");
    return;
  }

  closeModal();
  // Asegura que selects (clientes/vehículos) reflejen datos recién eliminados.
  invalidateSelectCache();
  await loadCurrentList(token);
}

async function loadCurrentList(token) {
  if (!currentEntityKey) return;
  const entKey = currentEntityKey;
  const r = await apiFetch(`/api/${encodeURIComponent(entKey)}`, token);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Error al cargar datos");
  const items = data.items || [];

  const content = document.getElementById("content");
  content.innerHTML = "";

  const table = await renderTable(entKey, items, token);
  content.appendChild(table);
}

async function init() {
  const token = getToken();
  if (!token) {
    window.location.href = "/login.html";
    return;
  }

  // Verify token
  const me = await apiFetch("/api/auth/me", token).catch(() => null);
  if (!me || !me.ok) {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = "/login.html";
    return;
  }
  const meData = await me.json().catch(() => ({}));
  const role = meData?.user?.role || "admin";
  if (role === "mecanico") {
    window.location.href = "/mecanico.html";
    return;
  }
  document.getElementById("userLabel").textContent = meData?.user?.username ? `@${meData.user.username}` : "";
  const manageBtn = document.getElementById("manageMechanicsBtn");
  if (manageBtn) manageBtn.style.display = role === "admin" ? "" : "none";

  const manageUsersBtn = document.getElementById("manageUsersBtn");
  if (manageUsersBtn) manageUsersBtn.style.display = role === "admin" ? "" : "none";

  const metaRes = await apiFetch("/api/entities", token);
  const metaData = await metaRes.json();
  if (!metaRes.ok) throw new Error(metaData.error || "Error al cargar entidades");

  meta = metaData;
  const menu = document.getElementById("menu");
  menu.innerHTML = "";

  // Iconos para cada apartado
  const icons = {
    clientes: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
    vehiculos: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 16H9m10 0h3v-3.15a1 1 0 0 0-.84-.99L16 11l-2.7-3.6a1 1 0 0 0-.8-.4H5.24a2 2 0 0 0-1.8 1.1l-.8 1.63A6 6 0 0 0 2 12.42V16h2"></path><circle cx="6.5" cy="16.5" r="2.5"></circle><circle cx="16.5" cy="16.5" r="2.5"></circle></svg>',
    servicios: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
    turnos: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>',
    empleados: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    inventario: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>',
    reparaciones: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
    cotizaciones: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>',
    ingresos_gastos: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>'
  };

  const keys = Object.keys(meta.entities);
  keys.forEach((key) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menuBtn";
    btn.style.cssText = "width:100%;display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:6px;font-size:14px;font-weight:500;color:var(--text-secondary);background:transparent;border:1px solid transparent;border-radius:10px;cursor:pointer;transition:all 0.2s ease;text-align:left;";
    btn.innerHTML = `${icons[key] || ''}<span>${key.replaceAll("_", " ")}</span>`;
    btn.dataset.entity = key;
    btn.addEventListener("click", async () => {
      // Toggle active
      for (const b of menu.querySelectorAll(".menuBtn")) {
        b.classList.remove("active");
        b.style.cssText = "width:100%;display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:6px;font-size:14px;font-weight:500;color:var(--text-secondary);background:transparent;border:1px solid transparent;border-radius:10px;cursor:pointer;transition:all 0.2s ease;text-align:left;";
      }
      btn.classList.add("active");
      btn.style.cssText = "width:100%;display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:6px;font-size:14px;font-weight:600;color:var(--accent-secondary);background:linear-gradient(135deg,rgba(6,182,212,0.15),rgba(34,211,238,0.08));border:1px solid rgba(6,182,212,0.4);border-radius:10px;cursor:pointer;transition:all 0.2s ease;text-align:left;box-shadow:0 4px 12px rgba(6,182,212,0.15);";

      currentEntityKey = key;
      document.getElementById("sectionTitle").textContent = key.replaceAll("_", " ");
      document.getElementById("sectionSubtitle").textContent = "Listar / crear / editar registros";

      setDisabled(document.getElementById("createBtn"), false);
      setDisabled(document.getElementById("refreshBtn"), false);

      document.getElementById("content").innerHTML = "Cargando...";
      await loadCurrentList(token);
    });
    menu.appendChild(btn);
  });

  document.getElementById("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    window.location.href = "/login.html";
  });

  if (manageBtn) {
    manageBtn.addEventListener("click", () => {
      window.location.href = "/admin_mecanicos.html";
    });
  }

  const manageUsersBtnEl = document.getElementById("manageUsersBtn");
  if (manageUsersBtnEl) {
    manageUsersBtnEl.addEventListener("click", () => {
      window.location.href = "/admin_usuarios.html";
    });
  }

  document.getElementById("createBtn").addEventListener("click", async () => {
    if (!currentEntityKey) return;
    await openModal(currentEntityKey, token, "create", null);
  });

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    if (!currentEntityKey) return;
    await loadCurrentList(token);
  });

  // Modal wiring
  document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target && e.target.id === "modalOverlay") closeModal();
  });

  document.getElementById("saveBtn").addEventListener("click", async (e) => {
    e.preventDefault();
    const mode = currentEditingId ? "edit" : "create";
    await saveEntity(token, mode);
  });

  document.getElementById("entityForm").addEventListener("submit", async (e) => {
    e.preventDefault();
  });

  document.getElementById("deleteBtn").addEventListener("click", async () => {
    await deleteEntity(token);
  });

  // Table delegation for edit buttons
  document.getElementById("content").addEventListener("click", async (e) => {
    const waBtn = e.target && e.target.closest && e.target.closest("[data-action='whatsapp']");
    if (waBtn && waBtn.dataset && waBtn.dataset.id) {
      if (String(waBtn.disabled) !== "true") {
        await sendCotizacionWhatsApp(getToken(), waBtn.dataset.id);
      }
      return;
    }
    
    // Botón Cobrar
    const cobrarBtn = e.target && e.target.closest && e.target.closest("[data-action='cobrar']");
    if (cobrarBtn && cobrarBtn.dataset && cobrarBtn.dataset.id) {
      await cobrarYcerrarReparacion(token, cobrarBtn.dataset.id);
      return;
    }

    const btn = e.target && e.target.closest && e.target.closest("[data-action='edit']");
    if (!btn) return;
    const id = btn.dataset.id;
    const entKey = currentEntityKey;
    if (!entKey || !id) return;

    // Load item list (small). Better: GET by ID; but we keep minimal endpoints.
    const r = await apiFetch(`/api/${encodeURIComponent(entKey)}`, token);
    const data = await r.json();
    const item = (data.items || []).find((x) => String(x.id) === String(id));
    if (!item) return;

    await openModal(entKey, token, "edit", item);
  });

  // Cargar dashboard inicial
  await loadDashboard(token);
  
  // Configurar evento de expandir/colapsar dashboard
  const dashboardHeader = document.getElementById("dashboardHeader");
  const dashboardContent = document.getElementById("dashboardContent");
  const dashboardArrow = document.getElementById("dashboardArrow");
  let isExpanded = false;
  
  if (dashboardHeader && dashboardContent) {
    dashboardHeader.addEventListener("click", () => {
      isExpanded = !isExpanded;
      if (isExpanded) {
        dashboardContent.style.maxHeight = dashboardContent.scrollHeight + "px";
        dashboardArrow.style.transform = "rotate(180deg)";
      } else {
        dashboardContent.style.maxHeight = "0";
        dashboardArrow.style.transform = "rotate(0deg)";
      }
    });
  }
  
  document.getElementById("content").innerHTML = "";
}

let dashboardData = {
  ingresos: [],
  reparaciones: []
};

async function loadDashboard(token) {
  try {
    // Cargar ingresos_gastos para calcular estadísticas
    const ingresosRes = await apiFetch("/api/ingresos_gastos", token);
    const ingresosData = await ingresosRes.json();
    
    // Cargar reparaciones para contar abiertas
    const reparacionesRes = await apiFetch("/api/reparaciones", token);
    const reparacionesData = await reparacionesRes.json();
    
    if (!ingresosRes.ok || !reparacionesRes.ok) return;
    
    const ingresos = (ingresosData.items || []).filter(i => i.tipo === "Ingreso");
    const reparaciones = reparacionesData.items || [];
    
    dashboardData.ingresos = ingresos;
    dashboardData.reparaciones = reparaciones;
    
    // Calcular estadísticas
    const today = new Date().toISOString().slice(0, 10);
    const currentMonth = today.slice(0, 7); // YYYY-MM
    
    const ingresosHoy = ingresos
      .filter(i => i.fecha === today)
      .reduce((sum, i) => sum + (Number(i.monto) || 0), 0);
    
    const ingresosMes = ingresos
      .filter(i => i.fecha && i.fecha.startsWith(currentMonth))
      .reduce((sum, i) => sum + (Number(i.monto) || 0), 0);
    
    const ingresosTotal = ingresos
      .reduce((sum, i) => sum + (Number(i.monto) || 0), 0);
    
    const reparacionesAbiertas = reparaciones
      .filter(r => r.estado !== "Cerrada").length;
    
    // Últimos 5 ingresos
    const ultimosIngresos = ingresos
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
      .slice(0, 5);
    
    const formatMoney = (n) => "$" + Number(n).toLocaleString("es-CL");
    
    // Actualizar preview en la barra
    document.getElementById("previewHoy").textContent = formatMoney(ingresosHoy);
    document.getElementById("previewMes").textContent = formatMoney(ingresosMes);
    document.getElementById("previewTotal").textContent = formatMoney(ingresosTotal);
    
    // Actualizar detalles expandibles
    document.getElementById("ingresosHoy").textContent = formatMoney(ingresosHoy);
    document.getElementById("ingresosMes").textContent = formatMoney(ingresosMes);
    document.getElementById("ingresosTotal").textContent = formatMoney(ingresosTotal);
    document.getElementById("reparacionesAbiertas").textContent = reparacionesAbiertas;
    
    // Mostrar últimos ingresos
    const ultimosContainer = document.getElementById("ultimosIngresosContainer");
    const ultimosList = document.getElementById("ultimosIngresosList");
    
    if (ultimosIngresos.length > 0) {
      ultimosContainer.style.display = "block";
      ultimosList.innerHTML = ultimosIngresos.map(ing => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid var(--border-color);">
          <div>
            <div style="font-weight:500;">${ing.concepto || 'Sin concepto'}</div>
            <div style="font-size:12px;color:var(--text-muted);">${ing.fecha}</div>
          </div>
          <div style="font-weight:700;color:#34d399;">${formatMoney(ing.monto)}</div>
        </div>
      `).join("");
    } else {
      ultimosContainer.style.display = "none";
    }
    
  } catch (e) {
    console.error("Error cargando dashboard:", e);
  }
}

init().catch((err) => {
  const content = document.getElementById("content");
  content.innerHTML = "";
  const box = document.createElement("div");
  box.className = "errorBox";
  box.textContent = err?.message ? String(err.message) : String(err);
  content.appendChild(box);
});

