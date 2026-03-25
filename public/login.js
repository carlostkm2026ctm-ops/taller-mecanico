const TOKEN_KEY = "taller_token_v1";

function setMsg(kind, text) {
  const el = document.getElementById("msg");
  el.innerHTML = "";
  if (!text) return;
  const div = document.createElement("div");
  div.className = kind === "error" ? "errorBox" : "successBox";
  div.textContent = text;
  el.appendChild(div);
}

function getFormData(form) {
  const fd = new FormData(form);
  return Object.fromEntries(fd.entries());
}

async function login(payload) {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Error al iniciar sesión");
  return data;
}

function wireForms() {
  const loginForm = document.getElementById("loginForm");
  const submitBtn = loginForm.querySelector('button[type="submit"]');
  const originalText = submitBtn.innerHTML;

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMsg(null, "");
    
    // Deshabilitar botón durante el login
    submitBtn.disabled = true;
    submitBtn.innerHTML = "<span>Cargando...</span>";
    
    const payload = getFormData(loginForm);
    
    try {
      const data = await login(payload);
      
      // Guardar token
      localStorage.setItem(TOKEN_KEY, data.token);
      
      // Redirección simple
      window.location.href = "/app.html";
      
    } catch (err) {
      setMsg("error", err.message || "Error de conexión");
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  });
}

wireForms();

