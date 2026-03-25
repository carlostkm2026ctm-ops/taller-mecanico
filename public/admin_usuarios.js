const TOKEN_KEY = "taller_token_v1";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function apiFetch(path, token, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  headers["Authorization"] = `Bearer ${token}`;
  return fetch(path, { ...options, headers });
}

function setUserText() {
  const el = document.getElementById("userLabel");
  if (el) el.textContent = "";
}

function setMsg(text, kind) {
  const el = document.getElementById("modalMsg");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = kind === "error" ? "#fecaca" : "#bbf7d0";
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("show");
}

function openModalEdit(user) {
  document.getElementById("modalOverlay").classList.add("show");
  document.getElementById("modalTitle").textContent = "Editar usuario";
  setMsg("", "");

  const form = document.getElementById("userForm");
  form.innerHTML = "";
  form.dataset.userId = String(user.id);

  // Username
  const uWrap = document.createElement("div");
  uWrap.className = "field";
  const uLabel = document.createElement("label");
  uLabel.textContent = "Username";
  const uInput = document.createElement("input");
  uInput.name = "username";
  uInput.value = user.username || "";
  uWrap.appendChild(uLabel);
  uWrap.appendChild(uInput);
  form.appendChild(uWrap);

  // Password (opcional)
  const pWrap = document.createElement("div");
  pWrap.className = "field";
  const pLabel = document.createElement("label");
  pLabel.textContent = "Nueva contraseña (opcional)";
  const pInput = document.createElement("input");
  pInput.type = "password";
  pInput.name = "password";
  pInput.placeholder = "Deja vacío para no cambiar";
  pWrap.appendChild(pLabel);
  pWrap.appendChild(pInput);
  form.appendChild(pWrap);

  if (user.role === "mecanico") {
    const nWrap = document.createElement("div");
    nWrap.className = "field";
    const nLabel = document.createElement("label");
    nLabel.textContent = "Nombre (empleado)";
    const nInput = document.createElement("input");
    nInput.name = "nombre";
    nInput.value = user.empleado_nombre || "";
    nWrap.appendChild(nLabel);
    nWrap.appendChild(nInput);
    form.appendChild(nWrap);

    const tWrap = document.createElement("div");
    tWrap.className = "field";
    const tLabel = document.createElement("label");
    tLabel.textContent = "Teléfono (opcional)";
    const tInput = document.createElement("input");
    tInput.name = "telefono";
    tInput.value = user.empleado_telefono || "";
    tWrap.appendChild(tLabel);
    tWrap.appendChild(tInput);
    form.appendChild(tWrap);

    const puWrap = document.createElement("div");
    puWrap.className = "field";
    const puLabel = document.createElement("label");
    puLabel.textContent = "Puesto (opcional)";
    const puInput = document.createElement("input");
    puInput.name = "puesto";
    puInput.value = user.empleado_puesto || "";
    puWrap.appendChild(puLabel);
    puWrap.appendChild(puInput);
    form.appendChild(puWrap);
  }
}

async function loadUsers(token) {
  const r = await apiFetch("/api/admin/users", token);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Error al cargar usuarios");
  return data.users || [];
}

function render(users) {
  const content = document.getElementById("content");
  content.innerHTML = "";

  const table = document.createElement("table");
  const head = document.createElement("thead");
  const trH = document.createElement("tr");
  const headers = ["ID", "Rol", "Username", "Empleado", "Teléfono", "Puesto", "Acciones"];
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    trH.appendChild(th);
  }
  head.appendChild(trH);
  table.appendChild(head);

  const tbody = document.createElement("tbody");
  for (const u of users) {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    tdId.textContent = String(u.id);
    tr.appendChild(tdId);

    const tdRol = document.createElement("td");
    tdRol.textContent = u.role;
    tr.appendChild(tdRol);

    const tdUser = document.createElement("td");
    tdUser.textContent = u.username;
    tr.appendChild(tdUser);

    const tdEmp = document.createElement("td");
    tdEmp.textContent = u.role === "mecanico" ? (u.empleado_nombre || "") : "";
    tr.appendChild(tdEmp);

    const tdTel = document.createElement("td");
    tdTel.textContent = u.role === "mecanico" ? (u.empleado_telefono || "") : "";
    tr.appendChild(tdTel);

    const tdP = document.createElement("td");
    tdP.textContent = u.role === "mecanico" ? (u.empleado_puesto || "") : "";
    tr.appendChild(tdP);

    const tdA = document.createElement("td");

    const editBtn = document.createElement("button");
    editBtn.className = "btn";
    editBtn.type = "button";
    editBtn.textContent = "Editar";
    editBtn.addEventListener("click", () => openModalEdit(u));
    tdA.appendChild(editBtn);

    const space = document.createElement("span");
    space.style.display = "inline-block";
    space.style.width = "8px";
    tdA.appendChild(space);

    const delBtn = document.createElement("button");
    delBtn.className = "btn danger";
    delBtn.type = "button";
    delBtn.textContent = "Eliminar";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`¿Eliminar a ${u.username}?`)) return;
      try {
        const tokenNow = getToken();
        const r = await apiFetch(`/api/admin/users/${encodeURIComponent(u.id)}`, tokenNow, {
          method: "DELETE",
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "Error al eliminar");
        closeModal();
        const fresh = await loadUsers(tokenNow);
        render(fresh);
      } catch (err) {
        alert(err.message || String(err));
      }
    });
    tdA.appendChild(delBtn);

    tr.appendChild(tdA);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  content.appendChild(table);
}

function setCreateFieldsVisibility() {
  const roleEl = document.getElementById("createRole");
  const wrap = document.getElementById("mecanicoFields");
  if (!roleEl || !wrap) return;
  const role = roleEl.value;
  wrap.style.display = role === "mecanico" ? "" : "none";
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
  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const users = await loadUsers(token);
    render(users);
  });

  document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target && e.target.id === "modalOverlay") closeModal();
  });

  document.getElementById("userForm").addEventListener("submit", async (e) => {
    e.preventDefault();
  });

  document.getElementById("saveBtn").addEventListener("click", async () => {
    const form = document.getElementById("userForm");
    const userId = form.dataset.userId;
    if (!userId) return;
    const payload = Object.fromEntries(new FormData(form).entries());

    // Si la contraseña viene vacía, no la mandamos.
    if (!payload.password) delete payload.password;

    setMsg("Guardando...", null);
    try {
      const r = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Error al guardar");
      closeModal();
      const fresh = await loadUsers(token);
      render(fresh);
    } catch (err) {
      setMsg(err.message || String(err), "error");
    }
  });

  const createRoleEl = document.getElementById("createRole");
  const createForm = document.getElementById("createUserForm");
  if (createRoleEl && createForm) {
    createRoleEl.addEventListener("change", setCreateFieldsVisibility);
    setCreateFieldsVisibility();

    createForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const createMsg = document.getElementById("createMsg");
      if (createMsg) createMsg.textContent = "Creando...";

      const fd = new FormData(createForm);
      const payload = Object.fromEntries(fd.entries());

      // Normaliza vacío a null.
      if (!payload.telefono) payload.telefono = null;
      if (!payload.puesto) payload.puesto = null;
      if (!payload.nombre) payload.nombre = null;

      try {
        const role = payload.role;
        if (role === "admin") {
          delete payload.nombre;
          delete payload.telefono;
          delete payload.puesto;
        } else {
          if (!payload.nombre) throw new Error("Nombre del mecánico es requerido");
        }

        const r = await apiFetch("/api/admin/users", token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "Error al crear usuario");

        if (createMsg) createMsg.textContent = "Usuario creado.";
        const fresh = await loadUsers(token);
        render(fresh);
        createForm.reset();
        setCreateFieldsVisibility();
      } catch (err) {
        if (createMsg) createMsg.textContent = err.message || String(err);
      }
    });
  }

  const users = await loadUsers(token);
  render(users);
}

init().catch((e) => {
  const content = document.getElementById("content");
  if (content) content.innerHTML = `<div class="errorBox">${String(e.message || e)}</div>`;
});

