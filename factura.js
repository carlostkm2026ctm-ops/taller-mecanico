const SUPABASE_URL = 'https://wiumymxzwswrzlgqypsl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpdW15bXh6d3N3cnpsZ3F5cHNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NzkyMzIsImV4cCI6MjA5MDA1NTIzMn0.en_UhyUM3cv-hV_Yx_tet5q_r2yrCXslDtt-SstBNNw';

const supabaseCliente = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

function esUUID(valor) {
  if (typeof valor !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valor.trim());
}

function getToken() {
  const u = new URL(window.location.href);
  return (u.searchParams.get('t') || '').trim();
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

function escaparHtml(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generarHTMLDocumento(data) {
  const tipo = (data?.tipo || 'cotizacion').toString();
  const fecha = new Date().toLocaleString('es-CL');
  const folio = String(data?.orden_id || '').slice(0, 8).toUpperCase();

  const cliente = data?.cliente || {};
  const vehiculo = data?.vehiculo || {};
  const falla = data?.falla_declarada || '';
  const trabajos = data?.repuestos_usados || '';

  const presupuesto = Number(data?.presupuesto || 0);
  const repuestos = Number(data?.costo_repuestos || 0);
  const totalCalculado = presupuesto + repuestos;
  const total = Number(data?.monto_total_cobrado || 0) > 0 ? Number(data.monto_total_cobrado) : totalCalculado;

  const titulo = tipo === 'entrega' ? 'Comprobante de Entrega' : (tipo === 'recepcion' ? 'Acta de Recepción' : 'Cotización');
  const subtitulo = tipo === 'cotizacion' ? 'Cotización' : (tipo === 'recepcion' ? 'Recepción' : 'Entrega');

  const firmaRecep = data?.firma_recepcion_data || '';
  const firmaRecepFecha = data?.firma_recepcion_fecha ? new Date(data.firma_recepcion_fecha).toLocaleString('es-CL') : '';
  const firmaEnt = data?.firma_entrega_data || '';
  const firmaEntFecha = data?.firma_entrega_fecha ? new Date(data.firma_entrega_fecha).toLocaleString('es-CL') : '';

  const clp = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('es-CL');

  const firmaBlock = (() => {
    if (tipo === 'recepcion') {
      return `
        <div class="sig">
          <div class="sig-title">Firma Recepción</div>
          ${firmaRecep ? `<img src="${firmaRecep}" alt="firma recepción" />` : `<div class="sig-miss">Sin firma</div>`}
          ${firmaRecepFecha ? `<div class="sig-date">${escaparHtml(firmaRecepFecha)}</div>` : ``}
        </div>
      `;
    }
    if (tipo === 'entrega') {
      return `
        <div class="sig">
          <div class="sig-title">Firma Entrega</div>
          ${firmaEnt ? `<img src="${firmaEnt}" alt="firma entrega" />` : `<div class="sig-miss">Sin firma</div>`}
          ${firmaEntFecha ? `<div class="sig-date">${escaparHtml(firmaEntFecha)}</div>` : ``}
        </div>
      `;
    }
    // cotizacion: mostrar ambas si existen (opcional)
    const any = !!firmaRecep || !!firmaEnt;
    if (!any) return '';
    return `
      <div class="sig-row">
        <div class="sig">
          <div class="sig-title">Firma Recepción</div>
          ${firmaRecep ? `<img src="${firmaRecep}" alt="firma recepción" />` : `<div class="sig-miss">—</div>`}
          ${firmaRecepFecha ? `<div class="sig-date">${escaparHtml(firmaRecepFecha)}</div>` : ``}
        </div>
        <div class="sig">
          <div class="sig-title">Firma Entrega</div>
          ${firmaEnt ? `<img src="${firmaEnt}" alt="firma entrega" />` : `<div class="sig-miss">—</div>`}
          ${firmaEntFecha ? `<div class="sig-date">${escaparHtml(firmaEntFecha)}</div>` : ``}
        </div>
      </div>
    `;
  })();

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escaparHtml(titulo)} ${escaparHtml(folio)}</title>
  <style>
    :root { --accent:#ff2d2d; --muted:#6b7280; --border:#e5e7eb; }
    *{ box-sizing:border-box; }
    body{ font-family: Inter, system-ui, -apple-system, Segoe UI, Arial; margin:0; padding:28px; color:#111827; background:#fff; }
    .top{ display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
    .brand h1{ margin:0; font-size:20px; letter-spacing:.02em; }
    .brand small{ color:var(--muted); }
    .meta{ text-align:right; }
    .chip{ display:inline-block; padding:6px 10px; border:1px solid var(--border); border-radius:999px; font-weight:800; }
    .grid{ display:grid; grid-template-columns: 1fr 1fr; gap:14px; margin-top:18px; }
    .box{ border:1px solid var(--border); border-radius:12px; padding:14px; }
    .box h3{ margin:0 0 8px 0; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
    .row{ display:flex; justify-content:space-between; gap:10px; margin:6px 0; }
    .row b{ font-weight:900; }
    table{ width:100%; border-collapse:collapse; margin-top:16px; }
    th,td{ padding:10px 8px; border-bottom:1px solid var(--border); text-align:left; }
    th{ font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
    .total{ display:flex; justify-content:flex-end; margin-top:14px; }
    .total .sum{ min-width:320px; border:1px solid var(--border); border-radius:12px; padding:14px; }
    .total .sum .row{ margin:8px 0; }
    .total .sum .row.grand{ font-size:18px; }
    .total .sum .row.grand b{ color:var(--accent); }
    .notes{ margin-top:18px; color:#374151; font-size:12px; }
    .sig-row{ display:grid; grid-template-columns: 1fr 1fr; gap:14px; margin-top:18px; }
    .sig{ border:1px dashed var(--border); border-radius:12px; padding:12px; }
    .sig-title{ font-size:12px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:8px; }
    .sig img{ width:100%; max-height:160px; object-fit:contain; display:block; background:#f9fafb; border-radius:10px; border:1px solid var(--border); filter: contrast(1.15) drop-shadow(0 0 1px rgba(0,0,0,.65)) drop-shadow(0 0 6px rgba(0,0,0,.12)); }
    .sig-miss{ padding:24px 12px; text-align:center; color:var(--muted); border:1px solid var(--border); border-radius:10px; background:#f9fafb; }
    .sig-date{ margin-top:8px; font-size:12px; color:var(--muted); }
    @media print { body{ padding:0; } }
  </style>
</head>
<body>
  <div class="top">
    <div class="brand">
      <h1>Taller Pro</h1>
      <small>${escaparHtml(subtitulo)}</small>
    </div>
    <div class="meta">
      <div class="chip">Folio: ${escaparHtml(folio)}</div>
      <div style="margin-top:6px; color:var(--muted); font-size:12px;">${escaparHtml(fecha)}</div>
    </div>
  </div>

  <div class="grid">
    <div class="box">
      <h3>Cliente</h3>
      <div class="row"><span>Nombre</span><b>${escaparHtml(cliente?.nombre || '')}</b></div>
      <div class="row"><span>Teléfono</span><b>${escaparHtml(cliente?.telefono || '')}</b></div>
      ${cliente?.rut ? `<div class="row"><span>RUT</span><b>${escaparHtml(cliente.rut)}</b></div>` : ``}
    </div>
    <div class="box">
      <h3>Vehículo</h3>
      <div class="row"><span>Patente</span><b>${escaparHtml(vehiculo?.patente || '')}</b></div>
      <div class="row"><span>Marca/Modelo</span><b>${escaparHtml(vehiculo?.marca || '')}</b></div>
    </div>
  </div>

  <div class="box" style="margin-top:14px;">
    <h3>Detalle</h3>
    <div style="font-size:13px; line-height:1.45;">
      <b>Problema:</b> ${escaparHtml(falla)}<br/>
      ${trabajos ? `<b>Trabajo/Repuestos:</b> ${escaparHtml(trabajos)}` : `<b>Trabajo/Repuestos:</b> -`}
    </div>
  </div>

  <table>
    <thead><tr><th>Ítem</th><th>Monto</th></tr></thead>
    <tbody>
      <tr><td>Servicio</td><td>${clp(presupuesto)}</td></tr>
      <tr><td>Repuestos</td><td>${clp(repuestos)}</td></tr>
    </tbody>
  </table>

  <div class="total">
    <div class="sum">
      <div class="row"><span>Subtotal</span><b>${clp(totalCalculado)}</b></div>
      <div class="row grand"><span>Total</span><b>${clp(total)}</b></div>
    </div>
  </div>

  ${firmaBlock ? `<div style="margin-top:18px;">${firmaBlock}</div>` : ``}

  <div class="notes">
    Este documento es un respaldo digital del servicio.
  </div>
</body>
</html>`;
}

async function cargar() {
  if (!supabaseCliente) return setError('No se pudo iniciar conexión.');
  const token = getToken();
  if (!token || !esUUID(token)) return setError('Link inválido.');

  setLoading('Cargando…');
  try {
    const { data, error } = await supabaseCliente.rpc('get_factura_por_token', { p_token: token });
    if (error) throw error;

    const tipo = (data?.tipo || 'cotizacion').toString();
    const labels = { cotizacion: 'Cotización', recepcion: 'Recepción', entrega: 'Entrega' };
    $('chipTipo').textContent = labels[tipo] || tipo;

    const html = generarHTMLDocumento(data);
    const iframe = $('docIframe');
    iframe.srcdoc = html;

    $('btnImprimir').onclick = () => {
      try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch (_) {}
    };
    $('btnCopiar').onclick = async () => {
      try { await navigator.clipboard.writeText(window.location.href); } catch (_) {}
    };

    setReady();
  } catch (e) {
    console.error(e);
    setError('Link inválido o expirado.');
  }
}

document.addEventListener('DOMContentLoaded', cargar);

