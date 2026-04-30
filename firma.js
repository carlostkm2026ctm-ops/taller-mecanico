const SUPABASE_URL = 'https://wiumymxzwswrzlgqypsl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpdW15bXh6d3N3cnpsZ3F5cHNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NzkyMzIsImV4cCI6MjA5MDA1NTIzMn0.en_UhyUM3cv-hV_Yx_tet5q_r2yrCXslDtt-SstBNNw';

const supabaseCliente = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

function esUUID(valor) {
  if (typeof valor !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valor.trim());
}

function supabaseErrorMessage(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (e?.message) return e.message;
  try { return JSON.stringify(e); } catch (_) { return String(e); }
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
  el.innerHTML = `<i class="fas fa-exclamation-triangle"></i><p>${msg}</p>`;
  el.classList.remove('hidden');
  $('contenido')?.classList.add('hidden');
}

function setReady() {
  $('estadoCarga')?.classList.add('hidden');
  $('contenido')?.classList.remove('hidden');
}

function mostrarResultado(tipo, titulo, detalle) {
  const box = $('resultado');
  const t = $('resultadoTitulo');
  const d = $('resultadoDetalle');
  if (!box || !t || !d) return;

  t.textContent = titulo || '';
  d.textContent = detalle || '';
  const ok = tipo === 'success';
  box.style.background = ok ? 'rgba(0,255,136,.08)' : 'rgba(239,68,68,.10)';
  box.style.borderColor = ok ? 'rgba(0,255,136,.25)' : 'rgba(239,68,68,.28)';
  t.style.color = ok ? '#00ff88' : '#f87171';
  box.classList.remove('hidden');
}

function ocultarResultado() {
  $('resultado')?.classList.add('hidden');
}

function getToken() {
  const u = new URL(window.location.href);
  return (u.searchParams.get('t') || '').trim();
}

// ===== Canvas firma =====
let isDrawing = false;
let last = null;
let hasInk = false;

function setupCanvas() {
  const canvas = $('canvasFirma');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Importante: la firma debe verse en documentos blancos (factura).
  // Usamos tinta oscura y exportamos con fondo blanco.
  ctx.strokeStyle = '#111827';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const getPos = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = evt.touches?.[0]?.clientX ?? evt.clientX;
    const clientY = evt.touches?.[0]?.clientY ?? evt.clientY;
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const y = (clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  };

  const start = (evt) => {
    evt.preventDefault();
    isDrawing = true;
    last = getPos(evt);
  };

  const move = (evt) => {
    if (!isDrawing) return;
    evt.preventDefault();
    const p = getPos(evt);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    hasInk = true;
  };

  const end = (evt) => {
    evt?.preventDefault?.();
    isDrawing = false;
    last = null;
  };

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', end, { passive: false });
}

function limpiarCanvas() {
  const canvas = $('canvasFirma');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  hasInk = false;
  ocultarResultado();
}

function dataUrlFirma() {
  const canvas = $('canvasFirma');
  if (!canvas) return '';
  // Exportar SIEMPRE con fondo blanco para impresión.
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext('2d');
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(canvas, 0, 0);
  return out.toDataURL('image/png');
}

function verFirma() {
  const url = dataUrlFirma();
  if (!url) return;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<title>Firma</title><img src="${url}" style="max-width:100%;height:auto;display:block;margin:0 auto;background:#111;" />`);
  w.document.close();
}

async function cargarInfo() {
  if (!supabaseCliente) {
    setError('No se pudo iniciar conexión. Intenta nuevamente.');
    return;
  }
  const token = getToken();
  if (!token || !esUUID(token)) {
    setError('Link inválido.');
    return;
  }

  setLoading('Cargando…');

  try {
    const { data, error } = await supabaseCliente.rpc('get_firma_por_token', { p_token: token });
    if (error) throw error;

    const tipo = (data?.tipo || 'recepcion').toString();
    const vehiculo = data?.vehiculo || {};
    const cliente = data?.cliente || {};
    const yaFirmado = !!data?.ya_firmado;
    const usedAt = data?.token?.used_at;

    $('chipPatente').textContent = vehiculo?.patente || '—';
    $('tituloTipo').textContent = tipo === 'entrega' ? 'Firma de Entrega' : 'Firma de Recepción';
    $('subInfo').textContent = `${cliente?.nombre || 'Cliente'} • ${vehiculo?.marca || 'Vehículo'} ${vehiculo?.patente || ''}`.trim();

    const estadoEl = $('estadoFirma');
    if (estadoEl) {
      if (yaFirmado || usedAt) {
        estadoEl.textContent = 'FIRMADA';
        estadoEl.style.color = '#00ff88';
      } else {
        estadoEl.textContent = 'PENDIENTE';
        estadoEl.style.color = '#fbbf24';
      }
    }

    $('btnLimpiar').onclick = limpiarCanvas;
    $('btnVer').onclick = verFirma;

    $('btnGuardar').onclick = async () => {
      if (!hasInk) {
        mostrarResultado('error', 'Firma vacía', 'Por favor firma dentro del recuadro.');
        return;
      }
      $('btnGuardar').disabled = true;
      mostrarResultado('success', 'Guardando…', 'Espera un momento.');
      try {
        const url = dataUrlFirma();
        const { error: e2 } = await supabaseCliente.rpc('cliente_firma', { p_token: token, p_data_url: url });
        if (e2) throw e2;
        mostrarResultado('success', 'Firma guardada', 'Gracias. Ya quedó registrada.');
        $('btnLimpiar').disabled = true;
        $('btnVer').disabled = false;
      } catch (e) {
        console.error(e);
        $('btnGuardar').disabled = false;
        mostrarResultado('error', 'No se pudo guardar', supabaseErrorMessage(e) || 'Intenta nuevamente.');
      }
    };

    if (yaFirmado || usedAt) {
      $('btnGuardar').disabled = true;
      $('btnLimpiar').disabled = true;
      mostrarResultado('success', 'Firma ya registrada', 'Este link ya fue usado.');
    } else {
      $('btnGuardar').disabled = false;
      $('btnLimpiar').disabled = false;
      ocultarResultado();
    }

    setReady();
  } catch (e) {
    console.error(e);
    setError(supabaseErrorMessage(e) || 'Link inválido o expirado.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setupCanvas();
  cargarInfo();
});

