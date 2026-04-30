// Página pública de presupuesto (cliente)
const SUPABASE_URL = 'https://wiumymxzwswrzlgqypsl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpdW15bXh6d3N3cnpsZ3F5cHNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NzkyMzIsImV4cCI6MjA5MDA1NTIzMn0.en_UhyUM3cv-hV_Yx_tet5q_r2yrCXslDtt-SstBNNw';

const supabaseCliente = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (id) => document.getElementById(id);

function esUUID(valor) {
  if (typeof valor !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valor.trim());
}

function clp(n) {
  const v = Number(n || 0);
  return '$' + Math.round(v).toLocaleString('es-CL');
}

function setLoading(msg) {
  const el = $('estadoCarga');
  if (!el) return;
  el.querySelector('p').textContent = msg;
  el.classList.remove('hidden');
  $('contenido')?.classList.add('hidden');
}

function setError(msg) {
  const el = $('estadoCarga');
  if (!el) return;
  el.innerHTML = `
    <i class="fas fa-exclamation-triangle"></i>
    <p>${msg}</p>
  `;
  el.classList.remove('hidden');
  $('contenido')?.classList.add('hidden');
}

function setReady() {
  $('estadoCarga')?.classList.add('hidden');
  $('contenido')?.classList.remove('hidden');
}

function ocultarResultado() {
  $('resultado')?.classList.add('hidden');
}

function mostrarResultado(tipo, titulo, detalle) {
  const box = $('resultado');
  const t = $('resultadoTitulo');
  const d = $('resultadoDetalle');
  if (!box || !t || !d) return;

  t.textContent = titulo || '';
  d.textContent = detalle || '';

  const isOk = tipo === 'success';
  box.style.background = isOk ? 'rgba(0,255,136,.08)' : 'rgba(239,68,68,.10)';
  box.style.borderColor = isOk ? 'rgba(0,255,136,.25)' : 'rgba(239,68,68,.28)';
  t.style.color = isOk ? '#00ff88' : '#f87171';

  box.classList.remove('hidden');
}

function getToken() {
  const u = new URL(window.location.href);
  return (u.searchParams.get('t') || '').trim();
}

function supabaseErrorMessage(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (e?.message) return e.message;
  try { return JSON.stringify(e); } catch (_) { return String(e); }
}

async function cargarPresupuesto() {
  if (!supabaseCliente) {
    setError('No se pudo iniciar conexión. Intenta nuevamente.');
    return;
  }

  const token = getToken();
  if (!token || !esUUID(token)) {
    setError('Link inválido. Revisa que el link termine en `?t=...`.');
    return;
  }

  setLoading('Cargando…');

  try {
    const { data, error } = await supabaseCliente.rpc('get_presupuesto_por_token', { p_token: token });
    if (error) throw error;

    const vehiculo = data?.vehiculo || {};
    const cliente = data?.cliente || {};
    const estado = (data?.estado_presupuesto || 'pendiente').toString();

    $('chipPatente').textContent = vehiculo?.patente || '—';
    $('vehiculo').textContent = [vehiculo?.marca, vehiculo?.patente].filter(Boolean).join(' • ') || '—';
    $('cliente').textContent = cliente?.nombre || '—';
    $('telefono').textContent = cliente?.telefono || '—';
    $('monto').textContent = data?.presupuesto ? clp(data.presupuesto) : 'Sin monto';
    $('falla').textContent = data?.falla_declarada || '—';

    const rep = (data?.repuestos_usados || '').toString().trim();
    if (rep) {
      $('repuestosBox')?.classList.remove('hidden');
      $('repuestos').textContent = rep;
    } else {
      $('repuestosBox')?.classList.add('hidden');
    }

    const estadoEl = $('estadoPresupuesto');
    if (estadoEl) {
      const map = { pendiente: 'Pendiente', aprobado: 'Aprobado', rechazado: 'Rechazado' };
      estadoEl.textContent = map[estado] || estado;
      estadoEl.style.color = estado === 'aprobado' ? '#00ff88' : estado === 'rechazado' ? '#f87171' : '#fbbf24';
    }

    // Si ya fue procesado, deshabilitar botones
    const procesado = estado !== 'pendiente';
    $('btnAceptar').disabled = procesado;
    $('btnRechazar').disabled = procesado;

    $('btnAceptar').onclick = () => aceptar(token);
    $('btnRechazar').onclick = () => rechazar(token);

    // Mensaje cuando ya está procesado
    if (estado === 'aprobado') {
      mostrarResultado('success', 'Presupuesto aceptado', 'Gracias. Ya quedó registrado.');
    } else if (estado === 'rechazado') {
      mostrarResultado('error', 'Presupuesto rechazado', 'Listo. Ya quedó registrado.');
    } else {
      ocultarResultado();
    }

    setReady();
  } catch (e) {
    console.error(e);
    const msg = supabaseErrorMessage(e);
    setError(msg || 'Link inválido o expirado.');
  }
}

async function aceptar(token) {
  if (!confirm('¿Confirmas que aceptas el presupuesto?')) return;
  $('btnAceptar').disabled = true;
  $('btnRechazar').disabled = true;
  // Mantener contenido visible y mostrar confirmación
  mostrarResultado('success', 'Registrando aceptación…', 'Espera un momento.');

  try {
    const { error } = await supabaseCliente.rpc('cliente_acepta_presupuesto', { p_token: token });
    if (error) throw error;
    mostrarResultado('success', 'Presupuesto aceptado', 'Gracias. Ya quedó registrado.');
    // Refrescar estado; si algo falla, igual dejamos el mensaje mostrado.
    try { await cargarPresupuesto(); } catch (_) {}
  } catch (e) {
    console.error(e);
    setError(supabaseErrorMessage(e) || 'No se pudo registrar. Intenta nuevamente.');
  }
}

async function rechazar(token) {
  if (!confirm('¿Confirmas que rechazas el presupuesto?')) return;
  $('btnAceptar').disabled = true;
  $('btnRechazar').disabled = true;
  // Mantener contenido visible y mostrar confirmación
  mostrarResultado('error', 'Registrando rechazo…', 'Espera un momento.');

  try {
    const { error } = await supabaseCliente.rpc('cliente_rechaza_presupuesto', { p_token: token });
    if (error) throw error;
    mostrarResultado('error', 'Presupuesto rechazado', 'Listo. Ya quedó registrado.');
    // Refrescar estado; si algo falla, igual dejamos el mensaje mostrado.
    try { await cargarPresupuesto(); } catch (_) {}
  } catch (e) {
    console.error(e);
    setError(supabaseErrorMessage(e) || 'No se pudo registrar. Intenta nuevamente.');
  }
}

document.addEventListener('DOMContentLoaded', cargarPresupuesto);

