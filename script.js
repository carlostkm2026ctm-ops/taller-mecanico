/**
 * ============================================
 * TALLER MECÁNICO PRO - SISTEMA CON AUTENTICACIÓN
 * ============================================
 * 
 * CONFIGURACIÓN DE SUPABASE:
 * Reemplaza las siguientes variables con tus credenciales de Supabase
 */

// ============================================
// CONFIGURACIÓN DE SUPABASE
// ============================================
const SUPABASE_URL = 'https://wiumymxzwswrzlgqypsl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpdW15bXh6d3N3cnpsZ3F5cHNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NzkyMzIsImV4cCI6MjA5MDA1NTIzMn0.en_UhyUM3cv-hV_Yx_tet5q_r2yrCXslDtt-SstBNNw';

// ============================================
// INICIALIZACIÓN DE SUPABASE
// ============================================
// El SDK de Supabase se carga desde el HTML, creamos el cliente aquí
let supabaseCliente = null;

try {
    if (window.supabase && SUPABASE_URL && SUPABASE_KEY) {
        supabaseCliente = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
} catch (error) {
    console.error('Error al inicializar Supabase:', error);
}

// ============================================
// VARIABLES GLOBALES
// ============================================
let ordenes = [];
let ordenesPrevById = new Map(); // para detectar cambios (realtime)
const askedAprobadoRecep = new Set();
const askedFirmaRecep = new Set();
const askedFirmaEntrega = new Set();
// Por defecto: no abrir confirmaciones automáticas (solo botones manuales)
const AUTO_SUGERIR_ENVIO_WHATSAPP = false;
let ordenActual = null;
let usuarioActual = null;
let usuariosSistema = [];
let mecanicosLista = []; // Lista de mecánicos para asignación
let inventario = [];
let clientesData = [];

// ============================================
// PERFORMANCE: CACHES + CONTROL DE CARGAS
// ============================================
const CACHE_TTL_MS = {
    mecanicos: 60_000, // 1 min
};

const inFlight = {
    cargarMecanicos: null,
    cargarEquipoTrabajo: null,
};

const cacheTs = {
    mecanicos: 0,
};

// ============================================
// REALTIME (Supabase)
// ============================================
let realtimeChannel = null;
let realtimeDebounceTimer = null;

function detenerRealtime() {
    try {
        if (realtimeDebounceTimer) {
            clearTimeout(realtimeDebounceTimer);
            realtimeDebounceTimer = null;
        }
        if (supabaseCliente && realtimeChannel) {
            supabaseCliente.removeChannel(realtimeChannel);
        }
    } catch (_) {
        // ignore
    } finally {
        realtimeChannel = null;
    }
}

function iniciarRealtime() {
    if (!supabaseCliente) return;
    if (!usuarioActual) return;

    // Evitar duplicados
    if (realtimeChannel) return;

    const scheduleRefresh = (tabla) => {
        if (realtimeDebounceTimer) clearTimeout(realtimeDebounceTimer);
        realtimeDebounceTimer = setTimeout(async () => {
            try {
                const ok = await requerirSesionSupabase();
                if (!ok) return;

                const activeId = document.querySelector('.section.active')?.id || '';

                if (tabla === 'ordenes') {
                    await cargarOrdenes({ source: 'realtime' });
                    if (activeId === 'equipo') await cargarEquipoTrabajo();
                    if (activeId === 'ingresos') await cargarIngresosDashboard();
                    return;
                }

                if (tabla === 'gastos') {
                    await cargarGastos();
                    if (activeId === 'dashboard' || activeId === 'ingresos') {
                        actualizarDashboardGastos();
                    }
                    return;
                }

                if (tabla === 'agenda') {
                    if (activeId === 'agenda') {
                        const f = document.getElementById('agendaFiltroFecha')?.value;
                        if (f) await cargarAgenda(f);
                    }
                    return;
                }

                if (tabla === 'ingresos') {
                    if (activeId === 'ingresos' || activeId === 'dashboard') {
                        await cargarIngresosDashboard();
                    }
                    return;
                }
            } catch (e) {
                console.error('Realtime refresh error:', e);
            }
        }, 600);
    };

    realtimeChannel = supabaseCliente
        .channel('taller-realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ordenes' }, () => scheduleRefresh('ordenes'))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'gastos' }, () => scheduleRefresh('gastos'))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'agenda' }, () => scheduleRefresh('agenda'))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ingresos' }, () => scheduleRefresh('ingresos'))
        .subscribe();
}

// ============================================
// HELPERS
// ============================================
function esUUID(valor) {
    if (typeof valor !== 'string') return false;
    // UUID v1-v5 (incluye el formato típico de Supabase auth.users.id)
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valor);
}

function obtenerUsuarioUuidO_null() {
    const id = usuarioActual?.id;
    return esUUID(id) ? id : null;
}

async function requerirSesionSupabase() {
    if (!supabaseCliente) return true;
    try {
        const { data: { session } } = await supabaseCliente.auth.getSession();
        if (!session) throw new Error('No hay sesión activa');

        // Validación real contra el servidor (evita quedarse con sesión "fantasma"
        // y terminar enviando requests como rol anon -> 403 por RLS).
        const { data: userData, error: userError } = await supabaseCliente.auth.getUser();
        if (userError || !userData?.user) {
            try { await supabaseCliente.auth.signOut(); } catch (_) {}
            throw new Error('Sesión inválida o expirada');
        }

        // Si el token está por expirar, intentamos refrescarlo antes de mutaciones.
        const expMs = (session.expires_at ? session.expires_at * 1000 : 0);
        if (expMs && expMs - Date.now() < 60_000) {
            try { await supabaseCliente.auth.refreshSession(); } catch (_) {}
        }

        return true;
    } catch (_) {
        // ignore
    }
    mostrarToast('Sesión expirada. Inicia sesión nuevamente.', 'error');
    // Si se perdió la sesión, detenemos realtime para evitar loops
    detenerRealtime();
    mostrarLogin();
    return false;
}

// ============================================
// DEFINICIÓN DE ROLES Y PERMISOS
// ============================================
const ROLES = {
    ADMIN: 'admin',
    JEFE: 'jefe',
    MECANICO: 'mecanico'
};

const PERMISOS = {
    [ROLES.ADMIN]: {
        puedeCrearOrdenes: true,
        puedeEditarTodasLasOrdenes: true,
        puedeEliminarOrdenes: true,
        puedeCrearUsuarios: true,
        puedeEliminarUsuarios: true,
        puedeEliminarMecanicos: true,
        puedeVerReportes: true,
        puedeVerTodasLasOrdenes: true,
        puedeAsignarMecanicos: true,
        puedeVerPresupuestos: true,
        label: 'Administrador'
    },
    [ROLES.JEFE]: {
        puedeCrearOrdenes: true,
        puedeEditarTodasLasOrdenes: true,
        puedeEliminarOrdenes: true,
        puedeCrearUsuarios: false,
        puedeEliminarUsuarios: false,
        puedeEliminarMecanicos: true,
        puedeVerReportes: true,
        puedeVerTodasLasOrdenes: true,
        puedeAsignarMecanicos: true,
        puedeVerPresupuestos: true,
        label: 'Jefe de Taller'
    },
    // Soporte para rol femenino
    'jefa': {
        puedeCrearOrdenes: true,
        puedeEditarTodasLasOrdenes: true,
        puedeEliminarOrdenes: true,
        puedeCrearUsuarios: false,
        puedeEliminarUsuarios: false,
        puedeEliminarMecanicos: true,
        puedeVerReportes: true,
        puedeVerTodasLasOrdenes: true,
        puedeAsignarMecanicos: true,
        puedeVerPresupuestos: true,
        label: 'Jefa de Taller'
    },
    [ROLES.MECANICO]: {
        puedeCrearOrdenes: false,
        puedeEditarTodasLasOrdenes: false,
        puedeEliminarOrdenes: false,
        puedeCrearUsuarios: false,
        puedeEliminarUsuarios: false,
        puedeEliminarMecanicos: false,
        puedeVerReportes: false,
        puedeVerTodasLasOrdenes: false,
        puedeAsignarMecanicos: false,
        puedeVerPresupuestos: false,
        label: 'Mecánico'
    }
};

// ============================================
// INICIALIZACIÓN DE LA APLICACIÓN
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    inicializarApp();
});

async function inicializarApp() {
    // Configurar fecha actual por defecto
    const fechaInput = document.getElementById('fechaIngreso');
    if (fechaInput) fechaInput.valueAsDate = new Date();
    
    // Verificar sesión existente
    await verificarSesion();

    // Cargar lista de mecánicos en background (no bloquea UI)
    // Evita esperas al entrar a Equipo/Asignación.
    cargarMecanicos().catch(() => {});
    
    // Configurar event listeners
    configurarEventListeners();
    
    // Inicializar buscador inteligente por patente
    inicializarBuscadorPatente();
}

// ============================================
// SISTEMA DE AUTENTICACIÓN
// ============================================

async function verificarSesion() {
    try {
        // Verificar si hay sesión en Supabase
        if (supabaseCliente) {
            const { data: { session }, error } = await supabaseCliente.auth.getSession();
            if (session) {
                await cargarUsuarioActual(session.user);
                mostrarApp();
                return;
            }

            // Con RLS activado, NO podemos aceptar una “sesión” local si Supabase no tiene sesión real.
            // Si no hay session, obligamos a login para evitar 403 por rol anon.
            mostrarLogin();
            return;
        }
        
        // Fallback: verificar sesión en localStorage (solo modo sin Supabase)
        const sesionGuardada = localStorage.getItem('taller_sesion');
        if (sesionGuardada) {
            const sesion = JSON.parse(sesionGuardada);
            // Verificar que la sesión no haya expirado
            if (sesion.expires_at && new Date(sesion.expires_at) > new Date()) {
                usuarioActual = sesion.usuario;
                mostrarApp();
                return;
            } else {
                localStorage.removeItem('taller_sesion');
            }
        }
        
        mostrarLogin();
    } catch (error) {
        console.error('Error al verificar sesión:', error);
        mostrarLogin();
    }
}

async function cargarUsuarioActual(authUser) {
    try {
        if (supabaseCliente) {
            // Asegurar que exista el perfil (para que RLS funcione)
            await supabaseCliente.rpc('ensure_profile');

            // Cargar perfil desde Supabase
            const { data: profile, error } = await supabaseCliente
                .from('profiles')
                .select('*')
                .eq('id', authUser.id)
                .single();
            
            if (error) throw error;
            
            usuarioActual = {
                id: authUser.id,
                email: authUser.email,
                nombre: profile.nombre,
                rol: profile.rol
            };
        }
    } catch (error) {
        console.error('Error al cargar usuario:', error);
        // Fallback: crear usuario básico
        usuarioActual = {
            id: authUser.id,
            email: authUser.email,
            nombre: authUser.email.split('@')[0],
            rol: ROLES.MECANICO
        };
    }
}

async function iniciarSesion(e) {
    e.preventDefault();
    
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    
    try {
        if (supabaseCliente) {
            // Autenticar con Supabase Auth
            const { data, error } = await supabaseCliente.auth.signInWithPassword({
                email,
                password
            });
            
            if (error) throw error;
            
            await cargarUsuarioActual(data.user);
            
            // Guardar sesión en localStorage para persistencia
            guardarSesionLocal(data.session);
        } else {
            // Modo demo: crear sesión local
            await simularLogin(email);
        }
        
        mostrarToast('Sesión iniciada correctamente', 'success');
        mostrarApp();
        
    } catch (error) {
        console.error('Error al iniciar sesión:', error);
        mostrarToast('Credenciales incorrectas', 'error');
    }
}

async function simularLogin(email) {
    // Simulación para modo demo sin Supabase
    const rol = email.includes('admin') ? ROLES.ADMIN : 
                email.includes('jefe') ? ROLES.JEFE : ROLES.MECANICO;
    
    usuarioActual = {
        id: 'demo-' + Date.now(),
        email: email,
        nombre: email.split('@')[0],
        rol: rol
    };
    
    guardarSesionLocal({
        access_token: 'demo-token',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
}

function guardarSesionLocal(session) {
    const sesionData = {
        access_token: session.access_token,
        expires_at: session.expires_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        usuario: usuarioActual
    };
    localStorage.setItem('taller_sesion', JSON.stringify(sesionData));
}

async function cerrarSesion() {
    try {
        if (supabaseCliente) {
            await supabaseCliente.auth.signOut();
        }

        // Detener realtime
        detenerRealtime();
        
        localStorage.removeItem('taller_sesion');
        usuarioActual = null;
        
        mostrarToast('Sesión cerrada', 'info');
        mostrarLogin();
    } catch (error) {
        console.error('Error al cerrar sesión:', error);
    }
}

// ============================================
// CREAR NUEVO USUARIO (SOLO ADMIN)
// ============================================
async function crearNuevoUsuario(e) {
    e.preventDefault();
    
    if (!tienePermiso('puedeCrearUsuarios')) {
        mostrarToast('No tienes permiso para crear usuarios', 'error');
        return;
    }
    
    const nombre = document.getElementById('newUserNombre').value.trim();
    const email = document.getElementById('newUserEmail').value.trim();
    const password = document.getElementById('newUserPassword').value;
    const rol = document.getElementById('newUserRol').value;
    
    try {
        if (supabaseCliente) {
            // Crear usuario en Supabase Auth
            const { data: authData, error: authError } = await supabaseCliente.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        nombre: nombre,
                        rol: rol
                    }
                }
            });
            
            if (authError) throw authError;
            
            // Crear perfil en tabla profiles
            const { error: profileError } = await supabaseCliente
                .from('profiles')
                .insert([{
                    id: authData.user.id,
                    nombre: nombre,
                    email: email,
                    rol: rol,
                    created_at: new Date().toISOString()
                }]);
            
            if (profileError) throw profileError;
        } else {
            // Modo demo: agregar a lista local
            const nuevoUsuario = {
                id: 'user-' + Date.now(),
                nombre: nombre,
                email: email,
                rol: rol,
                created_at: new Date().toISOString()
            };
            usuariosSistema.push(nuevoUsuario);
            guardarUsuariosLocal();
        }
        
        mostrarToast('Usuario creado correctamente', 'success');
        cerrarModalUsuario();
        cargarUsuarios();
        
    } catch (error) {
        console.error('Error al crear usuario:', error);
        mostrarToast('Error al crear usuario: ' + error.message, 'error');
    }
}

async function eliminarUsuario(userId) {
    if (!tienePermiso('puedeEliminarUsuarios')) {
        mostrarToast('No tienes permiso para eliminar usuarios', 'error');
        return;
    }
    
    if (!confirm('¿Estás seguro de eliminar este usuario?')) return;
    
    try {
        if (supabaseCliente) {
            // Eliminar de Supabase Auth (requiere función RPC o admin)
            const { error } = await supabaseCliente
                .from('profiles')
                .delete()
                .eq('id', userId);
            
            if (error) throw error;
        } else {
            // Modo demo
            usuariosSistema = usuariosSistema.filter(u => u.id !== userId);
            guardarUsuariosLocal();
        }
        
        mostrarToast('Usuario eliminado', 'success');
        cargarUsuarios();
        
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        mostrarToast('Error al eliminar usuario', 'error');
    }
}

async function cargarUsuarios() {
    if (!tienePermiso('puedeCrearUsuarios')) return;
    
    try {
        if (supabaseCliente) {
            const { data, error } = await supabaseCliente
                .from('profiles')
                .select('*')
                .eq('activo', true)
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            usuariosSistema = data || [];
        } else {
            // Cargar desde localStorage
            const guardados = localStorage.getItem('taller_usuarios');
            const todos = guardados ? JSON.parse(guardados) : [];
            usuariosSistema = (todos || []).filter(u => u.activo !== false);
        }
        
        renderizarUsuarios();
    } catch (error) {
        console.error('Error al cargar usuarios:', error);
    }
}

// Función para crear usuario desde el panel de administración
async function crearUsuarioDesdeAdmin(e) {
    e.preventDefault();
    
    if (!tienePermiso('puedeCrearUsuarios')) {
        mostrarToast('No tienes permiso para crear usuarios', 'error');
        return;
    }
    
    const nombre = document.getElementById('adminNombre').value.trim();
    const email = document.getElementById('adminEmail').value.trim();
    const password = document.getElementById('adminPassword').value;
    const rol = document.getElementById('adminRol').value;
    
    if (!nombre || !email || !password || !rol) {
        mostrarToast('Por favor complete todos los campos', 'error');
        return;
    }
    
    try {
        if (supabaseCliente) {
            // Crear usuario en Supabase Auth
            const { data: authData, error: authError } = await supabaseCliente.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        nombre: nombre,
                        rol: rol
                    }
                }
            });
            
            if (authError) throw authError;
            
            mostrarToast('Usuario creado correctamente en Supabase', 'success');
        } else {
            // Modo demo: agregar a lista local
            const nuevoUsuario = {
                id: 'user-' + Date.now(),
                nombre: nombre,
                email: email,
                rol: rol,
                created_at: new Date().toISOString()
            };
            usuariosSistema.push(nuevoUsuario);
            localStorage.setItem('taller_usuarios', JSON.stringify(usuariosSistema));
            
            mostrarToast('Usuario creado correctamente (modo local)', 'success');
        }
        
        // Limpiar formulario
        document.getElementById('formCrearUsuario').reset();
        
        // Recargar lista de usuarios
        cargarUsuarios();
        
    } catch (error) {
        console.error('Error al crear usuario:', error);
        mostrarToast('Error: ' + error.message, 'error');
    }
}

// Función para filtrar clientes en la sección de clientes
function filtrarClientesAdmin(e) {
    const busqueda = e.target.value.toLowerCase();
    const filas = document.querySelectorAll('#clientes tbody tr');
    
    filas.forEach(fila => {
        const texto = fila.textContent.toLowerCase();
        fila.style.display = texto.includes(busqueda) ? '' : 'none';
    });
}

function guardarUsuariosLocal() {
    localStorage.setItem('taller_usuarios', JSON.stringify(usuariosSistema));
}

// ============================================
// CONTROL DE VISIBILIDAD POR ROLES
// ============================================
function tienePermiso(permiso) {
    if (!usuarioActual) return false;
    return PERMISOS[usuarioActual.rol]?.[permiso] || false;
}

function aplicarPermisosUI() {
    if (!usuarioActual) return;
    
    const permisos = PERMISOS[usuarioActual.rol];
    const esMecanico = usuarioActual.rol === ROLES.MECANICO;
    
    console.log('Aplicando permisos para rol:', usuarioActual.rol, 'puedeCrearOrdenes:', permisos?.puedeCrearOrdenes);
    console.log('Usuario actual:', usuarioActual);
    console.log('Permisos:', permisos);
    
    // Mostrar/ocultar menú Nueva Orden (tanto el li como el enlace)
    const navNuevaOrden = document.getElementById('navNuevaOrden');
    const menuNuevaOrden = document.getElementById('menuNuevaOrden');
    if (navNuevaOrden) {
        if (permisos.puedeCrearOrdenes) {
            navNuevaOrden.style.display = '';
            navNuevaOrden.classList.remove('hidden');
        } else {
            navNuevaOrden.style.display = 'none';
        }
    }
    if (menuNuevaOrden) {
        menuNuevaOrden.style.display = permisos.puedeCrearOrdenes ? 'flex' : 'none';
    }
    
    // Mostrar/ocultar botón "Nueva Orden" en dashboard
    const btnNuevaOrdenDashboard = document.querySelector('.btn-large[onclick*="nueva-orden"]');
    if (btnNuevaOrdenDashboard) {
        btnNuevaOrdenDashboard.style.display = permisos.puedeCrearOrdenes ? 'flex' : 'none';
    }
    
    // Mostrar/ocultar secciones de Admin
    document.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', !permisos.puedeCrearUsuarios);
    });
    
    // Mostrar/ocultar secciones para Admin y Jefe (Ingresos, Equipo, Clientes)
    document.querySelectorAll('.admin-jefe-only').forEach(el => {
        el.classList.toggle('hidden', !permisos.puedeVerReportes);
    });
    
    // Mostrar/ocultar botón eliminar en modal
    const btnEliminar = document.getElementById('btnEliminarOrden');
    if (btnEliminar) {
        btnEliminar.classList.toggle('hidden', !permisos.puedeEliminarOrdenes);
    }
    
    // Restricciones específicas para Mecánico
    if (esMecanico) {
        // Ocultar sección completa de Nueva Orden
        const seccionNuevaOrden = document.getElementById('nueva-orden');
        if (seccionNuevaOrden) {
            seccionNuevaOrden.classList.add('hidden');
        }
        
        // Ocultar selector de asignación de mecánicos (no necesita asignarse a sí mismo)
        document.querySelectorAll('.orden-asignacion').forEach(el => {
            el.style.display = 'none';
        });
        
        // En las tarjetas de órdenes, solo mostrar botón editar en las asignadas al mecánico
        document.querySelectorAll('.orden-card').forEach(card => {
            const btnEditar = card.querySelector('.btn-editar');
            if (btnEditar) {
                const ordenId = btnEditar.dataset.id;
                const orden = ordenes.find(o => o.id === ordenId);
                if (orden && orden.mecanico_asignado !== usuarioActual?.id) {
                    btnEditar.style.display = 'none';
                }
            }
        });

        // Ocultar presupuestos y montos del cliente para mecánicos (privacidad)
        ocultarPresupuestosParaMecanico();
        ocultarMontosClienteParaMecanico();
    }
    
    // Actualizar info de usuario en menú
    document.getElementById('userName').textContent = usuarioActual.nombre;
    document.getElementById('userRole').textContent = permisos.label;
}

function filtrarOrdenesPorRol(ordenes) {
    if (!usuarioActual) return [];
    
    const permisos = PERMISOS[usuarioActual.rol];
    
    // Admin y Jefe ven todas las órdenes
    if (permisos.puedeVerTodasLasOrdenes) {
        return ordenes;
    }
    
    // Mecánico solo ve órdenes asignadas a él
    return ordenes.filter(o => o.mecanico_asignado === usuarioActual.id);
}

function ocultarPresupuestosParaMecanico() {
    if (!usuarioActual || usuarioActual.rol !== ROLES.MECANICO) return;
    
    // Ocultar columnas de presupuesto en tablas
    document.querySelectorAll('.presupuesto-col').forEach(el => el.classList.add('hidden'));
    
    // Ocultar campos de presupuesto en formularios
    const presupuestoInput = document.getElementById('presupuesto');
    if (presupuestoInput) {
        presupuestoInput.closest('.input-group')?.classList.add('hidden');
    }
}

function ocultarMontosClienteParaMecanico() {
    if (!usuarioActual || usuarioActual.rol !== ROLES.MECANICO) return;
    // Seguridad UI: el mecánico no debe ver montos cobrados al cliente.
    // (La protección real debe ser RLS en Supabase; aquí reforzamos la vista).
    document.querySelectorAll('.monto-cliente-col, .monto-cliente-only').forEach(el => el.classList.add('hidden'));
}

// ============================================
// NAVEGACIÓN Y UI
// ============================================
function mostrarLogin() {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
}

function mostrarApp() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    
    // Aplicar permisos según rol
    aplicarPermisosUI();
    
    // Cargar datos
    cargarOrdenes();
    actualizarDashboard();
    
    // Si es admin, cargar datos adicionales
    if (tienePermiso('puedeCrearUsuarios')) {
        cargarUsuarios();
        cargarDashboardAdmin();
    }
    
    // Cargar gastos (para calcular utilidad real)
    cargarGastos();

    // Activar actualizaciones en tiempo real
    iniciarRealtime();
}

function showSection(sectionId) {
    // Ocultar todas las secciones
    document.querySelectorAll('.section').forEach(section => {
        section.classList.remove('active');
    });
    
    // Mostrar la sección seleccionada con animación
    const section = document.getElementById(sectionId);
    if (section) {
        section.classList.add('active');
        // Scroll al inicio
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    
    // Acciones específicas por sección
    switch(sectionId) {
        case 'ordenes':
            renderizarOrdenes('todos');
            break;
        case 'dashboard':
            actualizarDashboard();
            if (tienePermiso('puedeVerReportes')) {
                cargarDashboardAdmin();
            }
            break;
        case 'ingresos':
            if (tienePermiso('puedeVerReportes')) cargarIngresosDashboard();
            break;
        case 'equipo':
            if (tienePermiso('puedeVerReportes')) cargarEquipoTrabajo();
            break;
        case 'clientes':
            if (tienePermiso('puedeVerReportes')) cargarClientes();
            break;
        case 'agenda': {
            if (tienePermiso('puedeVerReportes')) {
                const hoy = new Date();
                const yyyy = hoy.getFullYear();
                const mm = String(hoy.getMonth() + 1).padStart(2, '0');
                const dd = String(hoy.getDate()).padStart(2, '0');
                const fechaHoy = `${yyyy}-${mm}-${dd}`;
                const filtro = document.getElementById('agendaFiltroFecha');
                if (filtro && !filtro.value) filtro.value = fechaHoy;
                const fecha = (filtro?.value || fechaHoy);
                cargarAgenda(fecha);
            }
            break;
        }
        case 'admin':
            if (tienePermiso('puedeCrearUsuarios')) cargarUsuarios();
            break;
    }
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('active');
}

function cerrarSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.remove('active');
}

// ============================================
// EVENT LISTENERS
// ============================================
function configurarEventListeners() {
    // Login
    document.getElementById('loginForm')?.addEventListener('submit', iniciarSesion);
    document.getElementById('btnTogglePassword')?.addEventListener('click', togglePasswordVisibility);
    
    // Logout
    document.getElementById('btnLogout')?.addEventListener('click', cerrarSesion);
    
    // Menú móvil
    document.getElementById('btnMenu')?.addEventListener('click', toggleSidebar);
    
    // Cerrar sidebar al hacer clic fuera (en móvil)
    document.addEventListener('click', (e) => {
        const sidebar = document.getElementById('sidebar');
        const btnMenu = document.getElementById('btnMenu');
        if (window.innerWidth <= 768 && 
            sidebar?.classList.contains('active') &&
            !sidebar.contains(e.target) && 
            !btnMenu.contains(e.target)) {
            cerrarSidebar();
        }
    });
    
    // Navegación del sidebar
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const section = link.dataset.section;
            showSection(section);
            
            // Actualizar active en sidebar
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            
            // Cerrar sidebar en móvil
            if (window.innerWidth <= 768) {
                cerrarSidebar();
            }
        });
    });
    
    // Formulario nueva orden
    document.getElementById('formNuevaOrden')?.addEventListener('submit', guardarNuevaOrden);
    
    // Formulario de gastos
    document.getElementById('formGasto')?.addEventListener('submit', guardarGasto);
    
    // Filtros de órdenes
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderizarOrdenes(btn.dataset.filter);
        });
    });
    
    // Buscador de historial
    document.getElementById('btnBuscar')?.addEventListener('click', buscarHistorial);
    document.getElementById('searchPatente')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') buscarHistorial();
    });
    
    // Modal editar orden
    document.getElementById('btnCloseModal')?.addEventListener('click', cerrarModal);
    document.getElementById('btnCancelarEditarOrden')?.addEventListener('click', cerrarModal);
    document.getElementById('btnImprimirFactura')?.addEventListener('click', () => {
        const id = document.getElementById('editId')?.value;
        if (id) abrirFacturaOrden(id);
    });
    document.getElementById('btnEnviarFacturaWA')?.addEventListener('click', async () => {
        const id = document.getElementById('editId')?.value;
        if (!id) return;
        const sel = (prompt(
            '¿Qué quieres enviar?\n\n1) Cotización\n2) Acta de recepción (firma recepción)\n3) Documento de entrega (firma entrega)\n\nEscribe 1, 2 o 3:',
            '1'
        ) || '').toString().trim();
        const tipo = sel === '2' ? 'recepcion' : sel === '3' ? 'entrega' : 'cotizacion';
        await enviarFacturaPorWhatsApp(id, tipo);
    });
    document.getElementById('btnLinkFirmaRecepcion')?.addEventListener('click', () => {
        const id = document.getElementById('editId')?.value;
        if (id) generarLinkFirmaCliente(id, 'recepcion');
    });
    document.getElementById('btnLinkFirmaEntrega')?.addEventListener('click', () => {
        const id = document.getElementById('editId')?.value;
        if (id) generarLinkFirmaCliente(id, 'entrega');
    });
    document.getElementById('formEditarOrden')?.addEventListener('submit', guardarEdicionOrden);
    document.getElementById('btnEliminarOrden')?.addEventListener('click', eliminarOrden);

    // Ver firmas desde el modal
    document.getElementById('btnVerFirmaRecepcion')?.addEventListener('click', () => {
        if (ordenActual?.firma_recepcion_data) abrirFirmaEnVentana(ordenActual.firma_recepcion_data, 'Firma Recepción');
        else mostrarToast('Aún no hay firma de recepción', 'info');
    });
    document.getElementById('btnVerFirmaEntrega')?.addEventListener('click', () => {
        if (ordenActual?.firma_entrega_data) abrirFirmaEnVentana(ordenActual.firma_entrega_data, 'Firma Entrega');
        else mostrarToast('Aún no hay firma de entrega', 'info');
    });
    
    // Selector de estado en modal
    document.querySelectorAll('.estado-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.estado-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('editEstado').value = btn.dataset.estado;
        });
    });
    
    // Formulario de administración - Crear usuario
    document.getElementById('formCrearUsuario')?.addEventListener('submit', crearUsuarioDesdeAdmin);
    
    // Buscador de clientes
    document.getElementById('buscarCliente')?.addEventListener('input', filtrarClientesAdmin);
    
    // Modal repuesto
    document.getElementById('btnAddRepuesto')?.addEventListener('click', abrirModalRepuesto);
    document.getElementById('btnCloseModalRepuesto')?.addEventListener('click', cerrarModalRepuesto);
    document.getElementById('btnCancelarRepuesto')?.addEventListener('click', cerrarModalRepuesto);
    document.getElementById('formRepuesto')?.addEventListener('submit', guardarRepuesto);
    
    // Buscador de clientes
    document.getElementById('searchClientes')?.addEventListener('input', filtrarClientes);
    
    // Formatear patente
    document.getElementById('vehiculoPatente')?.addEventListener('input', formatearPatente);
    document.getElementById('searchPatente')?.addEventListener('input', formatearPatenteInput);

    // Agenda
    document.getElementById('formAgenda')?.addEventListener('submit', guardarCitaAgenda);
    document.getElementById('agendaFiltroFecha')?.addEventListener('change', () => {
        const f = document.getElementById('agendaFiltroFecha')?.value;
        if (f) cargarAgenda(f);
    });
}

function abrirFirmaEnVentana(dataUrl, titulo = 'Firma') {
    if (!dataUrl) return;
    const w = window.open('', '_blank');
    if (!w) return;
    const safeTitle = String(titulo || 'Firma').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${safeTitle}</title></head><body style="margin:0;background:#0b0f14;color:#fff;font-family:Inter,system-ui,Segoe UI,Arial;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px;box-sizing:border-box;"><div style="max-width:920px;width:100%;"><h2 style="margin:0 0 12px 0;font-size:18px;">${safeTitle}</h2><div style="border:1px solid rgba(255,255,255,.12);border-radius:14px;overflow:hidden;background:#111;"><img src="${dataUrl}" alt="firma" style="display:block;width:100%;height:auto;"/></div></div></body></html>`);
    w.document.close();
}

async function generarLinkFirmaCliente(ordenId, tipo) {
    if (!tienePermiso('puedeVerPresupuestos')) {
        mostrarToast('No tienes permiso para generar links', 'error');
        return;
    }
    if (!(await requerirSesionSupabase())) return;

    const orden = ordenes.find(o => o.id === ordenId);
    if (!orden) {
        mostrarToast('Orden no encontrada', 'error');
        return;
    }

    const t = (tipo || 'recepcion').toString().toLowerCase();
    if (!['recepcion', 'entrega'].includes(t)) {
        mostrarToast('Tipo de firma inválido', 'error');
        return;
    }

    try {
        if (supabaseCliente) {
            try { await supabaseCliente.auth.refreshSession(); } catch (_) {}
        }

        const { data: token, error } = await supabaseCliente.rpc('create_firma_token', {
            p_orden_id: ordenId,
            p_tipo: t
        });
        if (error) throw error;

        const base = (window.location.origin && window.location.origin !== 'null')
            ? window.location.origin
            : window.location.href.replace(/\/[^\/]*$/, '');
        const link = `${base}/firma.html?t=${encodeURIComponent(token)}`;

        try {
            await navigator.clipboard.writeText(link);
            mostrarToast('Link copiado. Se abrirá WhatsApp.', 'success');
        } catch (_) {
            mostrarToast('Link generado. Copia manualmente si no se copió.', 'info');
        }

        const telefono = (orden.cliente?.telefono || '').toString().trim();
        const vehiculoTxt = `${orden.vehiculo?.marca || 'Vehículo'} ${orden.vehiculo?.patente || ''}`.trim();
        const titulo = t === 'entrega' ? 'FIRMA DE ENTREGA' : 'FIRMA DE RECEPCIÓN';
        const msg = `Hola ${orden.cliente?.nombre || ''}. Te enviamos el link para ${titulo} de ${vehiculoTxt}.\n\nPor favor firma aquí:\n${link}`;

        if (telefono) {
            const wa = `https://wa.me/${telefono.replace(/[^\d]/g, '')}?text=${encodeURIComponent(msg)}`;
            window.open(wa, '_blank');
        } else {
            window.prompt('Link de firma para enviar al cliente:', link);
        }
    } catch (e) {
        console.error('Error al generar link de firma:', e);
        mostrarToast('Error al generar link de firma: ' + (e?.message || ''), 'error');
    }
}

async function enviarFacturaPorWhatsApp(ordenId, tipo = 'cotizacion') {
    if (!tienePermiso('puedeVerPresupuestos') && !tienePermiso('puedeVerReportes')) {
        mostrarToast('No tienes permiso para enviar documentos', 'error');
        return;
    }
    if (!(await requerirSesionSupabase())) return;

    const orden = ordenes.find(o => o.id === ordenId);
    if (!orden) {
        mostrarToast('Orden no encontrada', 'error');
        return;
    }

    const t = String(tipo || 'cotizacion').toLowerCase();
    const docTipo = ['cotizacion', 'recepcion', 'entrega'].includes(t) ? t : 'cotizacion';

    try {
        try { await supabaseCliente.auth.refreshSession(); } catch (_) {}
        const { data: token, error } = await supabaseCliente.rpc('create_factura_token', { p_orden_id: ordenId, p_tipo: docTipo });
        if (error) throw error;

        const base = (window.location.origin && window.location.origin !== 'null')
            ? window.location.origin
            : window.location.href.replace(/\/[^\/]*$/, '');
        const link = `${base}/factura.html?t=${encodeURIComponent(token)}`;

        const telefono = (orden.cliente?.telefono || '').toString().trim();
        const vehiculoTxt = `${orden.vehiculo?.marca || 'Vehículo'} ${orden.vehiculo?.patente || ''}`.trim();
        const label = docTipo === 'entrega' ? 'DOCUMENTO DE ENTREGA' : (docTipo === 'recepcion' ? 'ACTA DE RECEPCIÓN' : 'COTIZACIÓN');
        const msg = `Hola ${orden.cliente?.nombre || ''}. Te enviamos ${label} de ${vehiculoTxt}.\n\nVer/Imprimir:\n${link}`;

        if (telefono) {
            const wa = `https://wa.me/${telefono.replace(/[^\d]/g, '')}?text=${encodeURIComponent(msg)}`;
            window.open(wa, '_blank');
        } else {
            window.prompt('Link de documento para enviar al cliente:', link);
        }
    } catch (e) {
        console.error('Error al enviar documento:', e);
        mostrarToast('Error al generar documento: ' + (e?.message || ''), 'error');
    }
}

function escaparHtml(texto) {
    return String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function generarFacturaHTML(orden) {
    const fecha = new Date().toLocaleString('es-CL');
    const folio = String(orden.id || '').slice(0, 8).toUpperCase();
    const patente = orden.vehiculo?.patente || '';
    const vehiculo = orden.vehiculo?.marca || '';
    const cliente = orden.cliente?.nombre || '';
    const telefono = orden.cliente?.telefono || '';
    const rut = orden.cliente?.rut || '';
    const falla = orden.falla_declarada || '';
    const trabajos = orden.repuestos_usados || '';
    const presupuesto = Number(orden.presupuesto || 0);
    const repuestos = Number(orden.costo_repuestos || 0);
    const total = Number(orden.monto_total_cobrado || 0) > 0 ? Number(orden.monto_total_cobrado) : (presupuesto + repuestos);

    const clp = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('es-CL');

    const firmaRecep = orden.firma_recepcion_data || '';
    const firmaRecepFecha = orden.firma_recepcion_fecha ? new Date(orden.firma_recepcion_fecha).toLocaleString('es-CL') : '';
    const firmaEnt = orden.firma_entrega_data || '';
    const firmaEntFecha = orden.firma_entrega_fecha ? new Date(orden.firma_entrega_fecha).toLocaleString('es-CL') : '';

    const firmasHtml = (firmaRecep || firmaEnt) ? `
  <div style="margin-top:18px; display:grid; grid-template-columns: 1fr 1fr; gap:14px;">
    <div style="border:1px dashed var(--border); border-radius:12px; padding:12px;">
      <div style="font-size:12px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:8px;">Firma Recepción</div>
      ${firmaRecep ? `<img src="${firmaRecep}" style="width:100%; max-height:160px; object-fit:contain; display:block; background:#f9fafb; border-radius:10px; border:1px solid var(--border); filter: contrast(1.15) drop-shadow(0 0 1px rgba(0,0,0,.65)) drop-shadow(0 0 6px rgba(0,0,0,.12));" />` : `<div style="padding:24px 12px; text-align:center; color:var(--muted); border:1px solid var(--border); border-radius:10px; background:#f9fafb;">—</div>`}
      ${firmaRecepFecha ? `<div style="margin-top:8px; font-size:12px; color:var(--muted);">${escaparHtml(firmaRecepFecha)}</div>` : ``}
    </div>
    <div style="border:1px dashed var(--border); border-radius:12px; padding:12px;">
      <div style="font-size:12px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:8px;">Firma Entrega</div>
      ${firmaEnt ? `<img src="${firmaEnt}" style="width:100%; max-height:160px; object-fit:contain; display:block; background:#f9fafb; border-radius:10px; border:1px solid var(--border); filter: contrast(1.15) drop-shadow(0 0 1px rgba(0,0,0,.65)) drop-shadow(0 0 6px rgba(0,0,0,.12));" />` : `<div style="padding:24px 12px; text-align:center; color:var(--muted); border:1px solid var(--border); border-radius:10px; background:#f9fafb;">—</div>`}
      ${firmaEntFecha ? `<div style="margin-top:8px; font-size:12px; color:var(--muted);">${escaparHtml(firmaEntFecha)}</div>` : ``}
    </div>
  </div>
    ` : '';

    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Factura / Cotización ${escaparHtml(folio)}</title>
  <style>
    :root { --accent:#ff2d2d; --muted:#6b7280; --border:#e5e7eb; }
    *{ box-sizing:border-box; }
    body{ font-family: Inter, system-ui, -apple-system, Segoe UI, Arial; margin:0; padding:28px; color:#111827; }
    .top{ display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
    .brand h1{ margin:0; font-size:20px; letter-spacing:.02em; }
    .brand small{ color:var(--muted); }
    .meta{ text-align:right; }
    .chip{ display:inline-block; padding:6px 10px; border:1px solid var(--border); border-radius:999px; font-weight:700; }
    .grid{ display:grid; grid-template-columns: 1fr 1fr; gap:14px; margin-top:18px; }
    .box{ border:1px solid var(--border); border-radius:12px; padding:14px; }
    .box h3{ margin:0 0 8px 0; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
    .row{ display:flex; justify-content:space-between; gap:10px; margin:6px 0; }
    .row b{ font-weight:800; }
    table{ width:100%; border-collapse:collapse; margin-top:16px; }
    th,td{ padding:10px 8px; border-bottom:1px solid var(--border); text-align:left; }
    th{ font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
    .total{ display:flex; justify-content:flex-end; margin-top:14px; }
    .total .sum{ min-width:320px; border:1px solid var(--border); border-radius:12px; padding:14px; }
    .total .sum .row{ margin:8px 0; }
    .total .sum .row.grand{ font-size:18px; }
    .total .sum .row.grand b{ color:var(--accent); }
    .notes{ margin-top:18px; color:#374151; font-size:12px; }
    .actions{ margin-top:18px; display:flex; gap:10px; }
    .btn{ border:1px solid var(--border); background:#fff; padding:10px 14px; border-radius:12px; cursor:pointer; font-weight:800; }
    .btn.primary{ background:var(--accent); color:#fff; border-color:var(--accent); }
    @media print { .actions{ display:none; } body{ padding:0; } }
  </style>
</head>
<body>
  <div class="top">
    <div class="brand">
      <h1>Taller Pro</h1>
      <small>Factura / Cotización</small>
    </div>
    <div class="meta">
      <div class="chip">Folio: ${escaparHtml(folio)}</div>
      <div style="margin-top:6px; color:var(--muted); font-size:12px;">${escaparHtml(fecha)}</div>
    </div>
  </div>

  <div class="grid">
    <div class="box">
      <h3>Cliente</h3>
      <div class="row"><span>Nombre</span><b>${escaparHtml(cliente)}</b></div>
      <div class="row"><span>Teléfono</span><b>${escaparHtml(telefono)}</b></div>
      ${rut ? `<div class="row"><span>RUT</span><b>${escaparHtml(rut)}</b></div>` : ``}
    </div>
    <div class="box">
      <h3>Vehículo</h3>
      <div class="row"><span>Patente</span><b>${escaparHtml(patente)}</b></div>
      <div class="row"><span>Marca/Modelo</span><b>${escaparHtml(vehiculo)}</b></div>
    </div>
  </div>

  <div class="box" style="margin-top:14px;">
    <h3>Detalle</h3>
    <div style="font-size:13px; line-height:1.45;">
      <b>Problema:</b> ${escaparHtml(falla)}<br/>
      ${trabajos ? `<b>Trabajo/Repuestos usados:</b> ${escaparHtml(trabajos)}` : `<b>Trabajo/Repuestos usados:</b> -`}
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Ítem</th><th>Monto</th></tr>
    </thead>
    <tbody>
      <tr><td>Servicio</td><td>${clp(presupuesto)}</td></tr>
      <tr><td>Repuestos</td><td>${clp(repuestos)}</td></tr>
    </tbody>
  </table>

  <div class="total">
    <div class="sum">
      <div class="row"><span>Subtotal</span><b>${clp(presupuesto + repuestos)}</b></div>
      <div class="row grand"><span>Total</span><b>${clp(total)}</b></div>
    </div>
  </div>

  <div class="notes">
    Esta cotización es referencial y puede ajustarse según evaluación final.
  </div>
  ${firmasHtml}

  <div class="actions">
    <button class="btn primary" onclick="window.print()">Imprimir</button>
    <button class="btn" onclick="window.close()">Cerrar</button>
  </div>
</body>
</html>`;
}

function abrirFacturaOrden(ordenId) {
    if (!tienePermiso('puedeVerPresupuestos') && !tienePermiso('puedeVerReportes')) {
        mostrarToast('No tienes permiso para ver/imprimir facturas', 'error');
        return;
    }
    const orden = ordenes.find(o => o.id === ordenId);
    if (!orden) {
        mostrarToast('Orden no encontrada', 'error');
        return;
    }
    const html = generarFacturaHTML(orden);

    // Guardar copia en Supabase (admin/jefe) para reimpresión
    if (supabaseCliente && tienePermiso('puedeVerReportes')) {
        supabaseCliente
            .from('facturas')
            .insert([{
                orden_id: ordenId,
                tipo: 'cotizacion',
                html,
                generado_por: obtenerUsuarioUuidO_null()
            }])
            .then(({ error }) => {
                if (error) console.warn('No se pudo guardar factura en Supabase:', error);
            });
    }

    const w = window.open('', '_blank');
    if (!w) {
        mostrarToast('Bloqueador de popups: permite abrir la factura', 'warning');
        return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
}

async function preguntarSalidaCotizacion(ordenId, datosWhatsApp) {
    // Pregunta simple (sin UI extra): WhatsApp o Factura
    const enviar = confirm('¿Enviar cotización por WhatsApp?\n\nAceptar: WhatsApp\nCancelar: Factura imprimible');
    if (enviar) {
        enviarWhatsApp(datosWhatsApp);
        mostrarToast('Abriendo WhatsApp para enviar cotización...', 'info');
    } else {
        abrirFacturaOrden(ordenId);
    }
}

function togglePasswordVisibility() {
    const input = document.getElementById('loginPassword');
    const btn = document.getElementById('btnTogglePassword');
    const icon = btn.querySelector('i');
    
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    }
}

// ============================================
// FORMATEO DE PATENTE
// ============================================
function formatearPatente(e) {
    let valor = e.target.value.toUpperCase();
    
    // Permitir letras, números, guiones y espacios
    // Formatos aceptados: AB-CD-12, AB CD 12, ABCD12, etc.
    valor = valor.replace(/[^A-Z0-9\-\s]/g, '');
    
    e.target.value = valor;
}

function validarPatente(patente) {
    // Validación para patentes chilenas
    // Formato nuevo: AB-CD-12 (2 letras + 2 letras + 2 números)
    // Formato antiguo: AB-12-34 (2 letras + 2 números + 2 números) - solo 2 letras al inicio
    // Formato motos: A-BC-12 (1 letra + 2 letras + 2 números)
    
    const patronNuevo = /^[A-Z]{2}[-\s]?[A-Z]{2}[-\s]?[0-9]{2}$/i;  // AB-CD-12
    const patronAntiguo = /^[A-Z]{2}[-\s]?[0-9]{2}[-\s]?[0-9]{2}$/i; // AB-12-34
    const patronMoto = /^[A-Z][-\s]?[A-Z]{2}[-\s]?[0-9]{2}$/i;       // A-BC-12
    
    const p = patente.trim().toUpperCase();
    return patronNuevo.test(p) || patronAntiguo.test(p) || patronMoto.test(p);
}

function formatearPatenteInput(e) {
    e.target.value = e.target.value.toUpperCase();
}

// ============================================
// GESTIÓN DE MECÁNICOS
// ============================================

/**
 * Carga la lista de mecánicos desde Supabase
 */
async function cargarMecanicos(opciones = {}) {
    const { force = false } = opciones;
    try {
        // Solo admin/jefe necesitan listar mecánicos (asignación/equipo). Para mecánico, no consultamos.
        if (usuarioActual && !tienePermiso('puedeAsignarMecanicos') && !tienePermiso('puedeVerReportes')) {
            mecanicosLista = [];
            return;
        }

        // Cache: si está fresco, no refetch
        if (!force && mecanicosLista.length > 0 && (Date.now() - cacheTs.mecanicos) < CACHE_TTL_MS.mecanicos) {
            return;
        }

        // Evitar cargas duplicadas concurrentes
        if (inFlight.cargarMecanicos) {
            await inFlight.cargarMecanicos;
            return;
        }

        // Si hay Supabase, exigimos sesión antes de leer profiles
        if (supabaseCliente) {
            const ok = await requerirSesionSupabase();
            if (!ok) {
                mecanicosLista = [];
                return;
            }
        }

        inFlight.cargarMecanicos = (async () => {
            if (supabaseCliente) {
                const { data, error } = await supabaseCliente
                    .from('profiles')
                    .select('id, nombre, rol, activo')
                    .in('rol', ['mecanico', 'jefe'])
                    .eq('activo', true)
                    .order('nombre');
                
                if (error) {
                    console.error('Error Supabase al cargar mecánicos:', error);
                    throw error;
                }
                mecanicosLista = data || [];
                cacheTs.mecanicos = Date.now();
                console.log('Mecánicos cargados:', mecanicosLista.length);
            } else {
                // Datos de ejemplo para modo offline
                mecanicosLista = [
                    { id: '1', nombre: 'Juan Pérez', rol: 'mecanico' },
                    { id: '2', nombre: 'María González', rol: 'mecanico' },
                    { id: '3', nombre: 'Carlos Rodríguez', rol: 'mecanico' }
                ];
                cacheTs.mecanicos = Date.now();
            }
        })();

        await inFlight.cargarMecanicos;
    } catch (error) {
        console.error('Error al cargar mecánicos:', error);
        mecanicosLista = [];
    } finally {
        inFlight.cargarMecanicos = null;
    }
}

/**
 * Carga y muestra el equipo de trabajo en la sección correspondiente
 */
async function cargarEquipoTrabajo(opciones = {}) {
    const container = document.getElementById('equipoGrid');
    if (!container) return;
    
    try {
        // Pintar loading inmediato para que no parezca "pegado"
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-spinner fa-spin"></i>
                <p>Cargando equipo de trabajo...</p>
            </div>
        `;

        // Evitar renders duplicados si el usuario cambia rápido de pestaña
        if (inFlight.cargarEquipoTrabajo) {
            await inFlight.cargarEquipoTrabajo;
            return;
        }

        inFlight.cargarEquipoTrabajo = (async () => {
        // Asegurar que tenemos los mecánicos cargados
        if (mecanicosLista.length === 0) {
            await cargarMecanicos({ force: false });
        }
        
        if (mecanicosLista.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-users-slash"></i>
                    <p>No hay mecánicos registrados en el sistema</p>
                </div>
            `;
            return;
        }

        // Dejar respirar al navegador antes de construir HTML grande (mejor UX)
        await new Promise(requestAnimationFrame);
        
        // Contar órdenes por mecánico
        const ordenesPorMecanico = {};
        ordenes.forEach(o => {
            if (!o.mecanico_asignado) return;
            if (!ordenesPorMecanico[o.mecanico_asignado]) {
                ordenesPorMecanico[o.mecanico_asignado] = [];
            }
            ordenesPorMecanico[o.mecanico_asignado].push(o);
        });

        const estadoLabels = {
            ingresado: 'Ingresado',
            reparacion: 'En Reparación',
            espera: 'Esperando Repuestos',
            listo: 'Listo para Entrega',
            entregado: 'Entregado'
        };
        
        container.innerHTML = mecanicosLista.map(mecanico => {
            const iniciales = mecanico.nombre.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
            const ordenesAsignadas = ordenesPorMecanico[mecanico.id] || [];
            const cantidadOrdenes = ordenesAsignadas.length;
            const rolLabel = mecanico.rol === 'jefe' ? 'Jefe de Taller' : 'Mecánico';
            const puedeEliminar = tienePermiso('puedeEliminarMecanicos');
            const botonEliminar = puedeEliminar ? `
                <button class="btn-eliminar-mecanico" onclick="eliminarMecanico('${mecanico.id}', '${mecanico.nombre}')" title="Eliminar mecánico">
                    <i class="fas fa-trash"></i>
                </button>
            ` : '';

            const autosAsignadosHTML = cantidadOrdenes === 0 ? `
                <div class="mecanico-autos-vacio">Sin autos asignados</div>
            ` : `
                <div class="mecanico-autos">
                    ${ordenesAsignadas.map(o => {
                        const patente = (o.vehiculo?.patente || o.vehiculo_patente || 'SIN PATENTE').toString();
                        const marcaModelo = (o.vehiculo?.marca || o.vehiculo_marca || '').toString();
                        const estado = (o.estado || o.estado_orden || 'ingresado').toString();
                        const estadoLabel = estadoLabels[estado] || estado;
                        return `
                            <div class="auto-chip">
                                <div class="auto-chip-top">
                                    <span class="auto-chip-patente">${patente}</span>
                                    <span class="auto-chip-estado estado-${estado}">${estadoLabel}</span>
                                </div>
                                <div class="auto-chip-modelo">${marcaModelo || 'Modelo no especificado'}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
            
            return `
                <div class="mecanico-card">
                    <div class="mecanico-header">
                        <div class="mecanico-avatar">${iniciales}</div>
                        <div class="mecanico-info">
                            <h3>${mecanico.nombre}</h3>
                            <span class="mecanico-especialidad">${rolLabel}</span>
                        </div>
                        <span class="estado-trabajador activo">Activo</span>
                        ${botonEliminar}
                    </div>
                    <div class="mecanico-body">
                        <div class="mecanico-stat">
                            <i class="fas fa-car"></i>
                            <span>${cantidadOrdenes} ${cantidadOrdenes === 1 ? 'orden asignada' : 'órdenes asignadas'}</span>
                        </div>
                        ${autosAsignadosHTML}
                    </div>
                </div>
            `;
        }).join('');
        })();

        await inFlight.cargarEquipoTrabajo;
        
    } catch (error) {
        console.error('Error al cargar equipo:', error);
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Error al cargar el equipo de trabajo</p>
            </div>
        `;
    } finally {
        inFlight.cargarEquipoTrabajo = null;
    }
}

/**
 * Elimina un mecánico del sistema
 * @param {string} mecanicoId - ID del mecánico a eliminar
 * @param {string} mecanicoNombre - Nombre del mecánico (para confirmación)
 */
async function eliminarMecanico(mecanicoId, mecanicoNombre) {
    // Verificar permisos
    if (!tienePermiso('puedeEliminarMecanicos')) {
        mostrarToast('No tienes permiso para eliminar miembros del equipo', 'error');
        return;
    }
    
    // Confirmar desactivación (soft delete para no romper órdenes históricas)
    if (!confirm(`¿Desactivar a ${mecanicoNombre} del equipo de trabajo?\n\nNo se borrarán sus órdenes antiguas.`)) {
        return;
    }
    
    try {
        if (supabaseCliente) {
            // Soft delete: desactivar perfil para evitar conflictos por llaves foráneas
            const { error } = await supabaseCliente
                .from('profiles')
                .update({ activo: false, updated_at: new Date().toISOString() })
                .eq('id', mecanicoId);
            
            if (error) throw error;
        } else {
            // Modo demo - eliminar del array local
            usuariosSistema = usuariosSistema.filter(u => u.id !== mecanicoId);
            guardarUsuariosLocal();
            
            // También actualizar lista de mecánicos
            mecanicosLista = mecanicosLista.filter(m => m.id !== mecanicoId);
        }
        
        mostrarToast(`${mecanicoNombre} desactivado correctamente`, 'success');
        
        // Recargar la lista de equipo
        await cargarEquipoTrabajo();
        
        // Si existe la función cargarMecanicos, recargarla también
        if (typeof cargarMecanicos === 'function') {
            await cargarMecanicos();
        }
        
    } catch (error) {
        console.error('Error al eliminar mecánico:', error);
        mostrarToast('Error al eliminar mecánico. Verifica tu conexión o intenta nuevamente.', 'error');
    }
}

/**
 * Carga y muestra los clientes desde la tabla clientes
 */
async function cargarClientes() {
    const tbody = document.getElementById('clientesTableBody');
    const totalClientesEl = document.getElementById('totalClientes');
    const clientesFrecuentesEl = document.getElementById('clientesFrecuentes');
    
    if (!tbody) return;
    
    try {
        let clientes = [];
        
        if (supabaseCliente) {
            // Cargar desde la tabla clientes
            const { data, error } = await supabaseCliente
                .from('clientes')
                .select('*')
                .order('ultima_visita', { ascending: false });
            
            if (error) {
                console.error('Error Supabase al cargar clientes:', error);
                throw error;
            }
            clientes = data || [];
            console.log('Clientes cargados desde tabla clientes:', clientes.length);
        } else {
            // Modo offline: cargar desde localStorage
            clientes = JSON.parse(localStorage.getItem('taller_clientes') || '[]');
        }
        
        // Actualizar estadísticas
        if (totalClientesEl) totalClientesEl.textContent = clientes.length;
        if (clientesFrecuentesEl) clientesFrecuentesEl.textContent = Math.floor(clientes.length * 0.3); // 30% son frecuentes
        
        if (clientes.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="text-center">
                        <div class="empty-state" style="padding: 2rem;">
                            <i class="fas fa-users-slash"></i>
                            <p>No hay clientes registrados</p>
                            <small>Los clientes se agregarán automáticamente al crear órdenes</small>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }
        
        tbody.innerHTML = clientes.map(cliente => {
            const iniciales = cliente.nombre.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
            const fechaUltimaVisita = cliente.ultima_visita 
                ? new Date(cliente.ultima_visita).toLocaleDateString('es-CL')
                : 'Sin visitas';
            
            // Calcular si necesita mantención (>6 meses sin visitar)
            const necesitaMantencion = cliente.ultima_visita && 
                (new Date() - new Date(cliente.ultima_visita)) > (180 * 24 * 60 * 60 * 1000);
            
            return `
                <tr>
                    <td>
                        <div class="cliente-cell">
                            <div class="cliente-avatar-sm">${iniciales}</div>
                            <span>${cliente.nombre}</span>
                        </div>
                    </td>
                    <td>${cliente.telefono}</td>
                    <td>${cliente.patente || '-'}</td>
                    <td>${cliente.marca || '-'}</td>
                    <td>${fechaUltimaVisita}</td>
                    <td>
                        <div class="cliente-acciones">
                            <button class="btn btn-small btn-primary btn-nueva-orden-cliente" 
                                    data-cliente-id="${cliente.id}"
                                    data-nombre="${cliente.nombre}"
                                    data-telefono="${cliente.telefono}"
                                    data-rut="${cliente.rut || ''}"
                                    data-patente="${cliente.patente || ''}"
                                    data-marca="${cliente.marca || ''}">
                                <i class="fas fa-plus-circle"></i> Nueva Orden
                            </button>
                            <button class="btn btn-small btn-secondary btn-ver-historial" 
                                    data-cliente-id="${cliente.id}"
                                    data-nombre="${cliente.nombre}"
                                    data-telefono="${cliente.telefono}"
                                    data-patente="${cliente.patente || ''}">
                                <i class="fas fa-history"></i> Historial
                            </button>
                            ${necesitaMantencion ? `
                            <button class="btn btn-small btn-warning btn-recordatorio-mantencion" 
                                    data-nombre="${cliente.nombre}"
                                    data-telefono="${cliente.telefono}"
                                    data-patente="${cliente.patente || ''}">
                                <i class="fas fa-bell"></i> Mantención
                            </button>
                            ` : ''}
                            <button class="btn btn-small btn-danger btn-eliminar-cliente" 
                                    data-cliente-id="${cliente.id}"
                                    data-nombre="${cliente.nombre}">
                                <i class="fas fa-trash"></i> Eliminar
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        
        // Agregar event listeners a los botones
        document.querySelectorAll('.btn-nueva-orden-cliente').forEach(btn => {
            btn.addEventListener('click', () => {
                const datosCliente = {
                    id: btn.dataset.clienteId,
                    nombre: btn.dataset.nombre,
                    telefono: btn.dataset.telefono,
                    rut: btn.dataset.rut,
                    patente: btn.dataset.patente,
                    marca: btn.dataset.marca
                };
                reingresoRapido(datosCliente);
            });
        });
        
        document.querySelectorAll('.btn-ver-historial').forEach(btn => {
            btn.addEventListener('click', () => {
                const nombre = btn.dataset.nombre;
                const telefono = btn.dataset.telefono;
                const patente = btn.dataset.patente;
                verHistorialCliente(nombre, telefono, patente);
            });
        });
        
        // Event listeners para botón de recordatorio de mantención
        document.querySelectorAll('.btn-recordatorio-mantencion').forEach(btn => {
            btn.addEventListener('click', () => {
                const nombre = btn.dataset.nombre;
                const telefono = btn.dataset.telefono;
                const patente = btn.dataset.patente;
                enviarRecordatorioMantencion(nombre, telefono, patente);
            });
        });
        
        // Event listener para botón de eliminar cliente
        document.querySelectorAll('.btn-eliminar-cliente').forEach(btn => {
            btn.addEventListener('click', () => {
                const clienteId = btn.dataset.clienteId;
                const clienteNombre = btn.dataset.nombre;
                eliminarCliente(clienteId, clienteNombre);
            });
        });
        
    } catch (error) {
        console.error('Error al cargar clientes:', error);
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="text-center">
                    <div class="empty-state" style="padding: 2rem;">
                        <i class="fas fa-exclamation-triangle"></i>
                        <p>Error al cargar clientes</p>
                    </div>
                </td>
            </tr>
        `;
    }
}

/**
 * Re-Ingreso Rápido: Redirige a Nueva Orden con datos del cliente prellenados
 */
function reingresoRapido(datosCliente) {
    // Guardar datos del cliente en sessionStorage para usarlos en Nueva Orden
    sessionStorage.setItem('reingreso_cliente', JSON.stringify(datosCliente));
    
    // Redirigir a la sección de Nueva Orden
    showSection('nueva-orden');
    
    // Actualizar navegación activa
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    const navNuevaOrden = document.querySelector('.nav-link[data-section="nueva-orden"]');
    if (navNuevaOrden) navNuevaOrden.classList.add('active');
    
    // Prellenar el formulario
    setTimeout(() => {
        prellenarFormularioReingreso(datosCliente);
    }, 100);
    
    mostrarToast('Formulario completado con datos del cliente. Ingrese la nueva falla.', 'info');
}

/**
 * Prellena el formulario de Nueva Orden con datos del cliente
 */
function prellenarFormularioReingreso(datosCliente) {
    // Datos del cliente
    const nombreInput = document.getElementById('clienteNombre');
    const telefonoInput = document.getElementById('clienteTelefono');
    const rutInput = document.getElementById('clienteRut');
    const patenteInput = document.getElementById('vehiculoPatente');
    const marcaInput = document.getElementById('vehiculoMarca');
    
    if (nombreInput) nombreInput.value = datosCliente.nombre || '';
    if (telefonoInput) telefonoInput.value = datosCliente.telefono || '';
    if (rutInput) rutInput.value = datosCliente.rut || '';
    if (patenteInput) patenteInput.value = datosCliente.patente || '';
    if (marcaInput) marcaInput.value = datosCliente.marca || '';
    
    // Guardar el ID del cliente para vincular la orden
    if (datosCliente.id) {
        sessionStorage.setItem('reingreso_cliente_id', datosCliente.id);
    }
    
    // Limpiar campos que deben estar vacíos para nueva orden
    const fallaInput = document.getElementById('fallaDeclarada');
    const repuestosInput = document.getElementById('repuestosUsados');
    const presupuestoInput = document.getElementById('presupuesto');
    const tiempoInput = document.getElementById('tiempoEntrega');
    
    if (fallaInput) fallaInput.value = '';
    if (repuestosInput) repuestosInput.value = '';
    if (presupuestoInput) presupuestoInput.value = '';
    if (tiempoInput) tiempoInput.value = '';
    
    // Enfocar el campo de falla para que el usuario empiece a escribir
    if (fallaInput) fallaInput.focus();
}

/**
 * Muestra el historial de órdenes de un cliente
 */
async function verHistorialCliente(nombreCliente, telefono, patente) {
    // Buscar órdenes que coincidan con el teléfono o patente del cliente
    const ordenesCliente = ordenes.filter(o => 
        o.cliente.telefono === telefono || 
        o.vehiculo.patente === patente
    );
    
    // Ordenar por fecha descendente
    ordenesCliente.sort((a, b) => new Date(b.fecha_ingreso) - new Date(a.fecha_ingreso));
    
    // Crear modal de historial
    mostrarModalHistorial(nombreCliente, ordenesCliente);
}

/**
 * Muestra un modal con el historial de órdenes del cliente
 */
function mostrarModalHistorial(nombreCliente, ordenes) {
    // Eliminar modal existente si hay
    const modalExistente = document.getElementById('modalHistorialCliente');
    if (modalExistente) modalExistente.remove();
    
    const estadoLabels = {
        ingresado: 'Ingresado',
        reparacion: 'En Reparación',
        espera: 'Esperando Repuestos',
        listo: 'Listo para Entrega',
        entregado: 'Entregado'
    };
    
    let contenidoOrdenes;
    if (ordenes.length === 0) {
        contenidoOrdenes = `
            <div class="empty-state" style="padding: 2rem;">
                <i class="fas fa-clipboard-list"></i>
                <p>No hay órdenes registradas para este cliente</p>
            </div>
        `;
    } else {
        contenidoOrdenes = ordenes.map(orden => {
            const fechaIngreso = new Date(orden.fecha_ingreso).toLocaleDateString('es-CL');
            const fechaEntrega = orden.fecha_entrega ? new Date(orden.fecha_entrega).toLocaleDateString('es-CL') : null;
            const estaEntregado = orden.estado === 'entregado';
            
            return `
            <div class="historial-orden-item ${orden.estado}">
                <div class="historial-orden-header">
                    <div class="historial-orden-vehiculo">
                        <i class="fas fa-car"></i>
                        <span>${orden.vehiculo.marca} - ${orden.vehiculo.patente}</span>
                    </div>
                    <span class="orden-estado estado-${orden.estado}">${estadoLabels[orden.estado]}</span>
                </div>
                
                <div class="historial-orden-fechas">
                    <div class="fecha-item">
                        <i class="fas fa-sign-in-alt"></i>
                        <span><strong>Llegada:</strong> ${fechaIngreso}</span>
                    </div>
                    ${fechaEntrega ? `
                    <div class="fecha-item">
                        <i class="fas fa-sign-out-alt"></i>
                        <span><strong>Entrega:</strong> ${fechaEntrega}</span>
                    </div>
                    ` : estaEntregado ? '<div class="fecha-item"><i class="fas fa-clock"></i><span><strong>Entrega:</strong> Pendiente de registro</span></div>' : ''}
                </div>
                
                <div class="historial-orden-detalles">
                    <div class="detalle-item">
                        <i class="fas fa-exclamation-triangle"></i>
                        <div>
                            <strong>Falla:</strong>
                            <p>${orden.falla_declarada || 'No especificada'}</p>
                        </div>
                    </div>
                    
                    ${orden.repuestos_usados ? `
                    <div class="detalle-item">
                        <i class="fas fa-tools"></i>
                        <div>
                            <strong>Repuestos Usados:</strong>
                            <p>${orden.repuestos_usados}</p>
                        </div>
                    </div>
                    ` : ''}
                    
                    ${orden.tiempo_entrega ? `
                    <div class="detalle-item">
                        <i class="fas fa-clock"></i>
                        <div>
                            <strong>Tiempo Estimado:</strong>
                            <p>${orden.tiempo_entrega}</p>
                        </div>
                    </div>
                    ` : ''}
                </div>
                
                ${(orden.nivel_combustible || orden.estado_exterior || orden.objetos_valor) ? `
                <div class="historial-orden-checklist">
                    <div class="checklist-header">
                        <i class="fas fa-clipboard-check"></i>
                        <strong>Check-list de Recepción</strong>
                    </div>
                    ${orden.nivel_combustible ? `
                    <div class="checklist-item">
                        <span class="checklist-label">Combustible:</span>
                        <span class="checklist-value combustible-${orden.nivel_combustible.replace('/', '-').toLowerCase()}">${orden.nivel_combustible}</span>
                    </div>
                    ` : ''}
                    ${orden.estado_exterior ? `
                    <div class="checklist-item">
                        <span class="checklist-label">Estado Exterior:</span>
                        <span class="checklist-value">${orden.estado_exterior}</span>
                    </div>
                    ` : ''}
                    ${orden.objetos_valor ? `
                    <div class="checklist-item">
                        <span class="checklist-label">Objetos de Valor:</span>
                        <span class="checklist-value">${orden.objetos_valor}</span>
                    </div>
                    ` : ''}
                </div>
                ` : ''}
                
                <div class="historial-orden-footer">
                    ${orden.presupuesto ? `
                    <div class="presupuesto-item">
                        <i class="fas fa-dollar-sign"></i>
                        <span><strong>Presupuesto:</strong> $${orden.presupuesto.toLocaleString('es-CL')}</span>
                    </div>
                    ` : ''}
                    ${orden.pagado ? `
                    <div class="pago-status pagado">
                        <i class="fas fa-check-circle"></i> Pagado
                    </div>
                    ` : orden.estado === 'entregado' ? `
                    <div class="pago-status pendiente">
                        <i class="fas fa-clock"></i> Pago Pendiente
                    </div>
                    ` : ''}
                </div>
            </div>
        `}).join('');
    }
    
    const modalHTML = `
        <div class="modal active" id="modalHistorialCliente">
            <div class="modal-content modal-historial">
                <div class="modal-header">
                    <h3><i class="fas fa-history"></i> Historial de ${nombreCliente}</h3>
                    <button class="btn-close" onclick="cerrarModalHistorial()"><i class="fas fa-times"></i></button>
                </div>
                <div class="modal-body historial-body">
                    <div class="historial-stats">
                        <span>Total de visitas: <strong>${ordenes.length}</strong></span>
                        <span>Entregados: <strong>${ordenes.filter(o => o.estado === 'entregado').length}</strong></span>
                    </div>
                    ${contenidoOrdenes}
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHTML);
    document.body.style.overflow = 'hidden';
}

/**
 * Cierra el modal de historial
 */
function cerrarModalHistorial() {
    const modal = document.getElementById('modalHistorialCliente');
    if (modal) {
        modal.remove();
        document.body.style.overflow = '';
    }
}

/**
 * Elimina un cliente del sistema (Supabase y localStorage)
 * Solo permite eliminar clientes sin órdenes asociadas
 */
async function eliminarCliente(clienteId, clienteNombre) {
    try {
        // Verificar permisos
        if (!tienePermiso('puedeVerReportes')) {
            mostrarToast('No tienes permiso para eliminar clientes', 'error');
            return;
        }
        
        // Obtener información completa del cliente desde la lista cargada
        const cliente = clientesData.find(c => c.id === clienteId);
        const clienteTelefono = cliente?.telefono || '';
        const clientePatente = cliente?.patente || '';
        
        // Verificar si el cliente tiene órdenes asociadas
        // Buscamos en todas las órdenes si hay alguna relacionada con este cliente
        const ordenesRelacionadas = ordenes.filter(o => {
            // Verificar por ID de cliente (esto es lo más importante - restricción FK)
            if (o.cliente_id === clienteId) {
                return true;
            }
            
            // Verificar por teléfono
            if (clienteTelefono && o.cliente?.telefono === clienteTelefono) {
                return true;
            }
            
            // Verificar por patente del vehículo
            if (clientePatente && o.vehiculo?.patente === clientePatente) {
                return true;
            }
            
            // Verificar por objeto cliente completo
            if (o.cliente?.id === clienteId) {
                return true;
            }
            
            return false;
        });
        
        const totalOrdenes = ordenesRelacionadas.length;
        
        // Si tiene órdenes, no permitir eliminar
        if (totalOrdenes > 0) {
            mostrarToast(
                `No se puede eliminar "${clienteNombre}" porque tiene ${totalOrdenes} orden(es) asociada(s). ` +
                'Los clientes con historial no pueden ser eliminados.',
                'error'
            );
            return;
        }
        
        // Confirmar eliminación
        if (!confirm(`¿Estás seguro de eliminar al cliente "${clienteNombre}"?\n\nEsta acción no se puede deshacer.`)) {
            return;
        }
        
        if (supabaseCliente) {
            // Primero verificar en Supabase si hay órdenes vinculadas
            const { data: ordenesExistentes, error: errorCheck } = await supabaseCliente
                .from('ordenes')
                .select('id')
                .eq('cliente_id', clienteId)
                .limit(1);
            
            if (errorCheck) throw errorCheck;
            
            if (ordenesExistentes && ordenesExistentes.length > 0) {
                mostrarToast(
                    `No se puede eliminar "${clienteNombre}" porque tiene órdenes asociadas en la base de datos.`,
                    'error'
                );
                return;
            }
            
            // Eliminar desde Supabase
            const { error } = await supabaseCliente
                .from('clientes')
                .delete()
                .eq('id', clienteId);
            
            if (error) throw error;
            
            console.log('Cliente eliminado de Supabase:', clienteId);
        } else {
            // Modo offline: eliminar de localStorage
            let clientes = JSON.parse(localStorage.getItem('taller_clientes') || '[]');
            clientes = clientes.filter(c => c.id !== clienteId);
            localStorage.setItem('taller_clientes', JSON.stringify(clientes));
            console.log('Cliente eliminado de localStorage:', clienteId);
        }
        
        mostrarToast('Cliente eliminado correctamente', 'success');
        
        // Recargar lista de clientes
        await cargarClientes();
        
    } catch (error) {
        console.error('Error al eliminar cliente:', error);
        
        // Manejo especial para errores de clave foránea
        if (error.code === '23503') {
            mostrarToast(
                `No se puede eliminar "${clienteNombre}" porque tiene órdenes asociadas en la base de datos. ` +
                'Primero elimina las órdenes relacionadas o usa un cliente genérico.',
                'error'
            );
        } else {
            mostrarToast('Error al eliminar cliente: ' + error.message, 'error');
        }
    }
}

/**
 * Genera el HTML del selector de mecánicos
 */
function generarSelectorMecanicos(ordenId, mecanicoAsignado) {
    if (mecanicosLista.length === 0) {
        return '<span class="sin-mecanico">No hay mecánicos disponibles</span>';
    }
    
    const opciones = mecanicosLista.map(m => 
        `<option value="${m.id}" ${mecanicoAsignado === m.id ? 'selected' : ''}>${m.nombre}</option>`
    ).join('');
    
    return `
        <select class="select-mecanico" data-orden-id="${ordenId}">
            <option value="">Seleccionar mecánico...</option>
            ${opciones}
        </select>
        <button class="btn-asignar-mecanico" data-orden-id="${ordenId}">
            <i class="fas fa-user-check"></i> Asignar
        </button>
    `;
}

/**
 * Asigna un mecánico a una orden
 */
async function asignarMecanico(ordenId, mecanicoId) {
    if (!mecanicoId) {
        mostrarToast('Seleccione un mecánico', 'warning');
        return;
    }
    
    try {
        if (supabaseCliente) {
            // Preferimos RPC con SECURITY DEFINER para evitar bloqueos por RLS.
            const { error: rpcError } = await supabaseCliente.rpc('asignar_mecanico', {
                p_orden_id: ordenId,
                p_mecanico_id: mecanicoId
            });
            if (rpcError) {
                // Fallback a update directo (por si el RPC no existe en algún entorno)
                const { error } = await supabaseCliente
                    .from('ordenes')
                    .update({ mecanico_asignado: mecanicoId })
                    .eq('id', ordenId);
                if (error) throw error;
            }
        }
        
        // Actualizar en memoria
        const orden = ordenes.find(o => o.id === ordenId);
        if (orden) {
            orden.mecanico_asignado = mecanicoId;
            const mecanico = mecanicosLista.find(m => m.id === mecanicoId);
            mostrarToast(`Mecánico ${mecanico?.nombre || ''} asignado correctamente`, 'success');
        }
        
        guardarEnLocalStorage();
        renderizarOrdenes('todos');
        actualizarDashboard();
        if (tienePermiso('puedeVerReportes')) {
            await cargarIngresosDashboard();
            actualizarDashboardGastos();
        }
        
    } catch (error) {
        console.error('Error al asignar mecánico:', error);
        mostrarToast('Error al asignar mecánico', 'error');
    }
}

// ============================================
// CRUD ÓRDENES
// ============================================
async function cargarOrdenes(opts = {}) {
    try {
        const source = opts?.source || 'manual';
        const prev = ordenesPrevById;
        if (supabaseCliente) {
            const esMecanico = usuarioActual?.rol === ROLES.MECANICO;
            // Seguridad BD: mecánico consulta vista segura sin montos del cliente
            const tabla = esMecanico ? 'ordenes_mecanico' : 'ordenes_admin';
            const { data, error } = await supabaseCliente
                .from(tabla)
                .select('*')
                .order('fecha_ingreso', { ascending: false });
            
            if (error) throw error;
            
            // Convertir cada orden al formato interno
            ordenes = (data || []).map(formatearOrdenDesdeSupabase);
        } else {
            const datosGuardados = localStorage.getItem('taller_ordenes');
            ordenes = datosGuardados ? JSON.parse(datosGuardados) : [];
        }

        // Detectar transiciones importantes (solo si se habilita explícitamente).
        try {
            if (
                AUTO_SUGERIR_ENVIO_WHATSAPP &&
                source === 'realtime' &&
                supabaseCliente &&
                (tienePermiso('puedeVerPresupuestos') || tienePermiso('puedeVerReportes'))
            ) {
                for (const o of ordenes) {
                    const p = prev.get(o.id);

                    // Cliente aprobó presupuesto -> sugerir envío firma recepción
                    const antesAprob = (p?.estado_presupuesto || 'pendiente') !== 'aprobado';
                    const ahoraAprob = (o?.estado_presupuesto || 'pendiente') === 'aprobado';
                    const sinFirmaRecep = !o?.firma_recepcion_fecha && !o?.firma_recepcion_data;
                    if (antesAprob && ahoraAprob && sinFirmaRecep) {
                        // Evitar spam: solo preguntar una vez por orden en esta sesión
                        if (!askedAprobadoRecep.has(o.id)) {
                            askedAprobadoRecep.add(o.id);
                            const ok = confirm(`El cliente ACEPTÓ la cotización (${o.vehiculo?.patente || ''}).\n\n¿Enviar link para firmar RECEPCIÓN ahora por WhatsApp?`);
                            if (ok) {
                                generarLinkFirmaCliente(o.id, 'recepcion');
                            }
                        }
                    }

                    // Firma recepción capturada -> sugerir envío acta/recepción por WhatsApp
                    const antesFirmaRecep = !p?.firma_recepcion_fecha && !p?.firma_recepcion_data;
                    const ahoraFirmaRecep = !!o?.firma_recepcion_fecha || !!o?.firma_recepcion_data;
                    if (antesFirmaRecep && ahoraFirmaRecep) {
                        if (!askedFirmaRecep.has(o.id)) {
                            askedFirmaRecep.add(o.id);
                            const ok = confirm(`Se guardó la FIRMA DE RECEPCIÓN (${o.vehiculo?.patente || ''}).\n\n¿Quieres enviar el ACTA DE RECEPCIÓN firmada por WhatsApp?`);
                            if (ok) enviarFacturaPorWhatsApp(o.id, 'recepcion');
                        }
                    }

                    // Firma entrega capturada -> sugerir envío documento entrega por WhatsApp
                    const antesFirmaEnt = !p?.firma_entrega_fecha && !p?.firma_entrega_data;
                    const ahoraFirmaEnt = !!o?.firma_entrega_fecha || !!o?.firma_entrega_data;
                    if (antesFirmaEnt && ahoraFirmaEnt) {
                        if (!askedFirmaEntrega.has(o.id)) {
                            askedFirmaEntrega.add(o.id);
                            const ok = confirm(`Se guardó la FIRMA DE ENTREGA (${o.vehiculo?.patente || ''}).\n\n¿Quieres enviar el DOCUMENTO DE ENTREGA firmado por WhatsApp?`);
                            if (ok) enviarFacturaPorWhatsApp(o.id, 'entrega');
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('No se pudo detectar transiciones:', e);
        }

        // Guardar snapshot para próxima comparación
        ordenesPrevById = new Map(ordenes.map(o => [o.id, {
            estado_presupuesto: o.estado_presupuesto,
            firma_recepcion_fecha: o.firma_recepcion_fecha,
            firma_recepcion_data: o.firma_recepcion_data,
            firma_entrega_fecha: o.firma_entrega_fecha,
            firma_entrega_data: o.firma_entrega_data
        }]));
        
        renderizarOrdenes('todos');
        actualizarDashboard();
        
    } catch (error) {
        console.error('Error al cargar órdenes:', error);
        mostrarToast('Error al cargar los datos', 'error');
    }
}

async function guardarNuevaOrden(e) {
    e.preventDefault();
    
    if (!tienePermiso('puedeCrearOrdenes')) {
        mostrarToast('No tienes permiso para crear órdenes', 'error');
        return;
    }
    
    // Obtener valores del formulario
    const clienteNombre = document.getElementById('clienteNombre').value.trim();
    const clienteRut = document.getElementById('clienteRut').value.trim();
    const clienteTelefono = document.getElementById('clienteTelefono').value.trim();
    const vehiculoPatente = document.getElementById('vehiculoPatente').value.toUpperCase().trim();
    const vehiculoMarca = document.getElementById('vehiculoMarca').value.trim();
    const vehiculoKilometraje = parseInt(document.getElementById('vehiculoKilometraje').value) || 0;
    
    // Validar patente
    if (!validarPatente(vehiculoPatente)) {
        mostrarToast('Formato de patente inválido. Use formato: AB-CD-12', 'error');
        return;
    }
    
    // Verificar si es un reingreso rápido (tiene cliente_id guardado)
    const clienteIdReingreso = sessionStorage.getItem('reingreso_cliente_id');
    
    // Crear objeto orden con estructura plana para Supabase
    const orden = {
        // Información del cliente (campos individuales)
        cliente_nombre: clienteNombre,
        cliente_telefono: clienteTelefono,
        cliente_rut: clienteRut || null,
        
        // Si es reingreso, vincular con el cliente existente
        cliente_id: clienteIdReingreso || null,
        
        // Información del vehículo (campos individuales)
        vehiculo_patente: vehiculoPatente,
        vehiculo_marca: vehiculoMarca,
        vehiculo_kilometraje: vehiculoKilometraje,
        
        // Detalles del servicio
        estado: document.getElementById('ordenEstado').value,
        estado_presupuesto: 'pendiente',
        falla_declarada: document.getElementById('fallaDeclarada').value.trim(),
        repuestos_usados: document.getElementById('repuestosUsados').value.trim() || null,
        tiempo_entrega: document.getElementById('tiempoEntrega').value.trim() || null,
        
        // Información financiera
        presupuesto: tienePermiso('puedeVerPresupuestos') ? 
            parseInt(document.getElementById('presupuesto').value) || 0 : 0,

        // Pago al mecánico (privado: solo Admin/Jefe)
        pago_mecanico: tienePermiso('puedeVerReportes') ?
            parseInt(document.getElementById('pagoMecanico')?.value) || 0 : 0,
        
        // Fechas
        fecha_ingreso: document.getElementById('fechaIngreso').value,
        
        // Check-list de Recepción (Inventario)
        nivel_combustible: document.getElementById('nivelCombustible').value || null,
        estado_exterior: document.getElementById('estadoExterior').value.trim() || null,
        objetos_valor: document.getElementById('objetosValor').value.trim() || null,
        
        // Auditoría
        creado_por: usuarioActual?.id || null
    };
    
    try {
        // PRIMERO: Sincronizar cliente en tabla clientes
        await sincronizarCliente({
            nombre: clienteNombre,
            rut: clienteRut,
            telefono: clienteTelefono,
            patente: vehiculoPatente,
            marca: vehiculoMarca
        });
        
        if (supabaseCliente) {
            const { error } = await supabaseCliente
                .from('ordenes')
                .insert([orden])
                ;
            
            if (error) {
                console.error('Error Supabase:', error);
                throw new Error(error.message || 'Error al guardar en la base de datos');
            }

            // Recargar desde Supabase (vistas seguras) para reflejar al tiro
            await cargarOrdenes();
        } else {
            // Modo localStorage - mantener estructura anidada para compatibilidad
            const ordenLocal = {
                id: Date.now().toString(),
                cliente: { nombre: clienteNombre, telefono: clienteTelefono, rut: clienteRut },
                vehiculo: { patente: vehiculoPatente, marca: vehiculoMarca, kilometraje: vehiculoKilometraje },
                estado: orden.estado,
                estado_presupuesto: 'pendiente',
                falla_declarada: orden.falla_declarada,
                repuestos_usados: orden.repuestos_usados,
                presupuesto: orden.presupuesto,
                pago_mecanico: orden.pago_mecanico,
                fecha_ingreso: orden.fecha_ingreso,
                fecha_creacion: new Date().toISOString(),
                creado_por: usuarioActual?.id
            };
            ordenes.unshift(ordenLocal);
            guardarEnLocalStorage();
        }
        
        mostrarToast('Orden guardada correctamente', 'success');
        // Ya no abrimos WhatsApp ni factura automáticamente al guardar.
        // Ahora se usa el botón "Link al Cliente" en la orden.
        
        document.getElementById('formNuevaOrden').reset();
        document.getElementById('fechaIngreso').valueAsDate = new Date();
        
        // Limpiar datos de reingreso del sessionStorage
        sessionStorage.removeItem('reingreso_cliente');
        sessionStorage.removeItem('reingreso_cliente_id');
        
        showSection('dashboard');
        actualizarDashboard();
        
    } catch (error) {
        console.error('Error al guardar:', error);
        mostrarToast('Error al guardar: ' + error.message, 'error');
    }
}

/**
 * Sincroniza un cliente en la tabla clientes
 * - Si no existe (por RUT o teléfono), lo crea
 * - Si existe, actualiza la última visita
 */
async function sincronizarCliente(datosCliente) {
    try {
        if (!supabaseCliente) {
            // Modo offline: guardar en localStorage
            sincronizarClienteLocal(datosCliente);
            return;
        }
        
        // Buscar cliente por RUT o teléfono
        let query = supabaseCliente.from('clientes').select('*');
        
        if (datosCliente.rut) {
            query = query.or(`rut.eq.${datosCliente.rut},telefono.eq.${datosCliente.telefono}`);
        } else {
            query = query.eq('telefono', datosCliente.telefono);
        }
        
        const { data: existentes, error: errorBusqueda } = await query;
        
        if (errorBusqueda) {
            console.error('Error buscando cliente:', errorBusqueda);
            return;
        }
        
        const fechaActual = new Date().toISOString();
        
        if (existentes && existentes.length > 0) {
            // Cliente existe - actualizar última visita y datos
            const clienteExistente = existentes[0];
            const { error: errorUpdate } = await supabaseCliente
                .from('clientes')
                .update({
                    nombre: datosCliente.nombre,
                    telefono: datosCliente.telefono,
                    patente: datosCliente.patente,
                    marca: datosCliente.marca,
                    ultima_visita: fechaActual,
                    updated_at: fechaActual
                })
                .eq('id', clienteExistente.id);
            
            if (errorUpdate) {
                console.error('Error actualizando cliente:', errorUpdate);
            } else {
                console.log('Cliente actualizado:', datosCliente.nombre);
            }
        } else {
            // Cliente no existe - crear nuevo
            const { error: errorInsert } = await supabaseCliente
                .from('clientes')
                .insert([{
                    nombre: datosCliente.nombre,
                    rut: datosCliente.rut || null,
                    telefono: datosCliente.telefono,
                    patente: datosCliente.patente,
                    marca: datosCliente.marca,
                    ultima_visita: fechaActual,
                    created_at: fechaActual,
                    updated_at: fechaActual
                }]);
            
            if (errorInsert) {
                console.error('Error creando cliente:', errorInsert);
            } else {
                console.log('Nuevo cliente creado:', datosCliente.nombre);
            }
        }
    } catch (error) {
        console.error('Error en sincronizarCliente:', error);
    }
}

/**
 * Sincroniza cliente en modo local (localStorage)
 */
function sincronizarClienteLocal(datosCliente) {
    let clientes = JSON.parse(localStorage.getItem('taller_clientes') || '[]');
    const fechaActual = new Date().toISOString();
    
    // Buscar por teléfono (en modo local no tenemos RUT necesariamente)
    const index = clientes.findIndex(c => c.telefono === datosCliente.telefono);
    
    if (index !== -1) {
        // Actualizar cliente existente
        clientes[index] = {
            ...clientes[index],
            nombre: datosCliente.nombre,
            patente: datosCliente.patente,
            marca: datosCliente.marca,
            ultima_visita: fechaActual
        };
    } else {
        // Crear nuevo cliente
        clientes.push({
            id: 'cliente-' + Date.now(),
            nombre: datosCliente.nombre,
            rut: datosCliente.rut || null,
            telefono: datosCliente.telefono,
            patente: datosCliente.patente,
            marca: datosCliente.marca,
            ultima_visita: fechaActual,
            created_at: fechaActual
        });
    }
    
    localStorage.setItem('taller_clientes', JSON.stringify(clientes));
}

/**
 * Convierte orden desde formato Supabase (plano) a formato interno (anidado)
 */
function formatearOrdenDesdeSupabase(ordenDB) {
    return {
        id: ordenDB.id,
        cliente: {
            nombre: ordenDB.cliente_nombre,
            telefono: ordenDB.cliente_telefono,
            rut: ordenDB.cliente_rut
        },
        vehiculo: {
            patente: ordenDB.vehiculo_patente,
            marca: ordenDB.vehiculo_marca,
            kilometraje: ordenDB.vehiculo_kilometraje
        },
        estado: ordenDB.estado,
        estado_presupuesto: ordenDB.estado_presupuesto,
        falla_declarada: ordenDB.falla_declarada,
        repuestos_usados: ordenDB.repuestos_usados,
        tiempo_entrega: ordenDB.tiempo_entrega,
        presupuesto: ordenDB.presupuesto,
        pago_mecanico: Number(ordenDB.pago_mecanico || 0),
        costo_repuestos: Number(ordenDB.costo_repuestos || 0),
        monto_total_cobrado: Number(ordenDB.monto_total_cobrado || 0),
        pago_mecanico_comision: Number(ordenDB.pago_mecanico_comision || 0),
        estado_pago: ordenDB.estado_pago,
        fecha_ingreso: ordenDB.fecha_ingreso,
        fecha_creacion: ordenDB.fecha_creacion,
        fecha_entrega: ordenDB.fecha_entrega,
        creado_por: ordenDB.creado_por,
        mecanico_asignado: ordenDB.mecanico_asignado,
        pagado: ordenDB.pagado,
        // Check-list de Recepción
        nivel_combustible: ordenDB.nivel_combustible,
        estado_exterior: ordenDB.estado_exterior,
        objetos_valor: ordenDB.objetos_valor,
        // Firmas (dataURL + fecha)
        firma_recepcion_data: ordenDB.firma_recepcion_data,
        firma_recepcion_fecha: ordenDB.firma_recepcion_fecha,
        firma_entrega_data: ordenDB.firma_entrega_data,
        firma_entrega_fecha: ordenDB.firma_entrega_fecha
    };
}

async function guardarEdicionOrden(e) {
    e.preventDefault();
    
    if (!ordenActual) return;
    if (!(await requerirSesionSupabase())) return;
    
    const esMecanico = usuarioActual?.rol === ROLES.MECANICO;
    const esSuOrden = ordenActual.mecanico_asignado === usuarioActual?.id;
    const estadoActual = ordenActual.estado;
    
    // Verificar permisos según rol
    if (esMecanico) {
        // Mecánico solo puede editar sus órdenes asignadas
        if (!esSuOrden) {
            mostrarToast('Solo puedes editar órdenes asignadas a ti', 'error');
            return;
        }
        
        // Mecánico no puede editar si la orden está "Listo" o "Entregado"
        if (estadoActual === 'listo' || estadoActual === 'entregado') {
            mostrarToast('No puedes editar una orden que ya está lista o entregada', 'error');
            return;
        }
    } else {
        // Admin/Jefe pueden editar todas (con permisos verificados)
        if (!tienePermiso('puedeEditarTodasLasOrdenes')) {
            mostrarToast('No tienes permiso para editar esta orden', 'error');
            return;
        }
    }
    
    // Preparar cambios según rol
    let cambios = {};
    const nuevoEstado = document.getElementById('editEstado').value;
    
    if (esMecanico) {
        // Mecánico solo puede cambiar estado y repuestos
        cambios = {
            estado: nuevoEstado,
            repuestos_usados: document.getElementById('editRepuestos').value.trim()
        };
        
        // Si marca como "listo", registrar quién lo hizo
        if (nuevoEstado === 'listo') {
            cambios.fecha_listo = new Date().toISOString();
        }
    } else {
        // Admin puede editar todo
        cambios = {
            estado: nuevoEstado,
            falla_declarada: document.getElementById('editFalla').value.trim(),
            repuestos_usados: document.getElementById('editRepuestos').value.trim(),
            presupuesto: parseInt(document.getElementById('editPresupuesto').value) || 0,
            pago_mecanico: parseInt(document.getElementById('editPagoMecanico')?.value) || 0,
            monto_total_cobrado: parseInt(document.getElementById('editMontoCliente')?.value) || 0,
            costo_repuestos: parseInt(document.getElementById('editCostoRepuestos')?.value) || 0,
            mecanico_asignado: document.getElementById('editMecanicoAsignado')?.value || null,
            actualizado_por: usuarioActual?.id
        };
        
        // Si admin marca como "entregado", registrar ingreso
        if (nuevoEstado === 'entregado' && estadoActual !== 'entregado') {
            cambios.fecha_entrega = new Date().toISOString();
            cambios.pagado = true;
            cambios.monto_total_cobrado = Number(ordenActual.monto_total_cobrado || 0) > 0
                ? Number(ordenActual.monto_total_cobrado)
                : Number(ordenActual.presupuesto || 0);
            cambios.estado_pago = 'pagado';
            
            // Registrar en ingresos si hay presupuesto
            if (ordenActual.presupuesto > 0) {
                await registrarIngresoDesdeOrden(ordenActual);
            }
        }
    }
    
    // Siempre actualizar fecha de actualización
    cambios.updated_at = new Date().toISOString();
    
    try {
        if (supabaseCliente) {
            if (esMecanico) {
                // Evitar 403 por RLS: el mecánico actualiza vía RPC validado en servidor
                const { error: rpcError } = await supabaseCliente.rpc('actualizar_orden_mecanico', {
                    p_orden_id: ordenActual.id,
                    p_estado: cambios.estado,
                    p_repuestos_usados: cambios.repuestos_usados ?? null
                });
                if (rpcError) throw rpcError;
            } else {
                // Asegurar token fresco antes de mutaciones (evita requests como anon -> 403)
                try { await supabaseCliente.auth.refreshSession(); } catch (_) {}
                const { error } = await supabaseCliente
                    .from('ordenes')
                    .update(cambios)
                    .eq('id', ordenActual.id);
                
                if (error) throw error;
            }
            // Recargar desde Supabase para evitar des-sync y respetar vistas por rol
            await cargarOrdenes();
        } else {
            const index = ordenes.findIndex(o => o.id === ordenActual.id);
            if (index !== -1) {
                ordenes[index] = { ...ordenes[index], ...cambios };
                guardarEnLocalStorage();
            }
        }
        
        mostrarToast('Orden actualizada correctamente', 'success');
        
        // Enviar notificación WhatsApp según el cambio de estado
        if (nuevoEstado === 'reparacion' && estadoActual !== 'reparacion') {
            // Cambió a "En Reparación"
            enviarWhatsAppEnReparacion(ordenActual);
            mostrarToast('Notificación de inicio de reparación enviada por WhatsApp', 'info');
        } else if (nuevoEstado === 'espera' && estadoActual !== 'espera') {
            // Cambió a "Esperando Repuestos"
            enviarWhatsAppEsperaRepuestos(ordenActual);
            mostrarToast('Notificación de espera enviada por WhatsApp', 'info');
        } else if (nuevoEstado === 'listo' && estadoActual !== 'listo') {
            // Cambió a "Listo para Entrega"
            enviarWhatsAppListoEntrega(ordenActual);
            mostrarToast('Notificación de entrega lista enviada por WhatsApp', 'info');
        }
        
        cerrarModal();
        renderizarOrdenes('todos');
        actualizarDashboard();
        // Refrescar módulos derivados sin reload
        if (tienePermiso('puedeVerReportes')) {
            cargarIngresosDashboard();
            actualizarDashboardGastos();
        }
        
    } catch (error) {
        console.error('Error al actualizar:', error);
        mostrarToast('Error al actualizar la orden', 'error');
    }
}

async function eliminarOrden() {
    if (!ordenActual) return;
    
    if (!tienePermiso('puedeEliminarOrdenes')) {
        mostrarToast('No tienes permiso para eliminar órdenes', 'error');
        return;
    }

    if (!(await requerirSesionSupabase())) return;
    
    if (!confirm('¿Estás seguro de que deseas eliminar esta orden?')) return;
    
    try {
        if (supabaseCliente) {
            // Asegurar token fresco antes de mutaciones (evita requests como anon -> 403)
            try { await supabaseCliente.auth.refreshSession(); } catch (_) {}

            // Preferimos RPC con SECURITY DEFINER para evitar bloqueos por RLS en DELETE.
            const { error: rpcError } = await supabaseCliente.rpc('eliminar_orden', {
                p_orden_id: ordenActual.id
            });

            if (rpcError) {
                // Fallback a delete directo (por si el RPC no existe en algún entorno)
                const { error } = await supabaseCliente
                    .from('ordenes')
                    .delete()
                    .eq('id', ordenActual.id);
                if (error) throw error;
            }

            // Sin recargar: eliminar también en memoria
            ordenes = ordenes.filter(o => o.id !== ordenActual.id);
        } else {
            ordenes = ordenes.filter(o => o.id !== ordenActual.id);
            guardarEnLocalStorage();
        }
        
        mostrarToast('Orden eliminada correctamente', 'success');
        cerrarModal();
        renderizarOrdenes('todos');
        actualizarDashboard();
        if (tienePermiso('puedeVerReportes')) {
            await cargarIngresosDashboard();
            actualizarDashboardGastos();
        }
        
    } catch (error) {
        console.error('Error al eliminar:', error);
        mostrarToast('Error al eliminar la orden', 'error');
    }
}

// ============================================
// RENDERIZADO
// ============================================
function renderizarOrdenes(filtro = 'todos') {
    const container = document.getElementById('ordenesList');
    if (!container) return;
    
    // Filtrar por rol del usuario
    let ordenesVisibles = filtrarOrdenesPorRol(ordenes);
    
    if (filtro !== 'todos') {
        ordenesVisibles = ordenesVisibles.filter(o => o.estado === filtro);
    }
    
    if (ordenesVisibles.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-clipboard-list"></i>
                <p>${filtro === 'todos' ? 'No hay órdenes activas' : 'No hay órdenes en este estado'}</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = ordenesVisibles.map(orden => crearCardOrden(orden)).join('');
    
    // Event listeners para botones de editar
    document.querySelectorAll('.btn-editar').forEach(btn => {
        btn.addEventListener('click', () => abrirModalEditar(btn.dataset.id));
    });
    
    // Event listeners para botones de asignar mecánico
    document.querySelectorAll('.btn-asignar-mecanico').forEach(btn => {
        btn.addEventListener('click', () => {
            const ordenId = btn.dataset.ordenId;
            const select = document.querySelector(`.select-mecanico[data-orden-id="${ordenId}"]`);
            const mecanicoId = select?.value;
            asignarMecanico(ordenId, mecanicoId);
        });
    });
    
    // Event listeners para botones de confirmar entrega y cobro
    document.querySelectorAll('.btn-confirmar-entrega').forEach(btn => {
        btn.addEventListener('click', () => {
            const ordenId = btn.dataset.ordenId;
            confirmarEntregaYCobro(ordenId);
        });
    });
    
    // Event listeners para botones de aprobar presupuesto
    document.querySelectorAll('.btn-aprobar-presupuesto').forEach(btn => {
        btn.addEventListener('click', () => {
            const ordenId = btn.dataset.ordenId;
            aprobarPresupuesto(ordenId);
        });
    });

    // Event listeners para botones de rechazar presupuesto (borra la orden)
    document.querySelectorAll('.btn-rechazar-presupuesto').forEach(btn => {
        btn.addEventListener('click', () => {
            const ordenId = btn.dataset.ordenId;
            rechazarPresupuesto(ordenId);
        });
    });

    // Event listeners para generar link al cliente
    document.querySelectorAll('.btn-link-presupuesto').forEach(btn => {
        btn.addEventListener('click', () => {
            const ordenId = btn.dataset.ordenId;
            generarLinkPresupuestoCliente(ordenId);
        });
    });

    // Event listeners para eliminar orden desde la tarjeta (presupuesto rechazado)
    document.querySelectorAll('.btn-eliminar-orden-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const ordenId = btn.dataset.ordenId;
            eliminarOrdenPorId(ordenId);
        });
    });

    // Enviar documento (recepción/entrega) desde la tarjeta, al lado de la firma
    document.querySelectorAll('.btn-enviar-firma-doc').forEach(btn => {
        btn.addEventListener('click', async () => {
            const ordenId = btn.dataset.ordenId;
            const tipo = btn.dataset.docTipo || 'recepcion';
            await enviarFacturaPorWhatsApp(ordenId, tipo);
        });
    });
}

async function eliminarOrdenPorId(ordenId) {
    if (!ordenId) return;

    if (!tienePermiso('puedeEliminarOrdenes')) {
        mostrarToast('No tienes permiso para eliminar órdenes', 'error');
        return;
    }
    if (!(await requerirSesionSupabase())) return;

    const orden = ordenes.find(o => o.id === ordenId);
    const desc = orden ? `${orden.vehiculo?.marca || ''} ${orden.vehiculo?.patente || ''}`.trim() : 'esta orden';
    if (!confirm(`¿Eliminar ${desc || 'esta orden'}?`)) return;

    try {
        if (supabaseCliente) {
            try { await supabaseCliente.auth.refreshSession(); } catch (_) {}

            const { error: rpcError } = await supabaseCliente.rpc('eliminar_orden', {
                p_orden_id: ordenId
            });

            if (rpcError) {
                const { error } = await supabaseCliente
                    .from('ordenes')
                    .delete()
                    .eq('id', ordenId);
                if (error) throw error;
            }
        }

        ordenes = ordenes.filter(o => o.id !== ordenId);
        guardarEnLocalStorage();

        mostrarToast('Orden eliminada correctamente', 'success');
        renderizarOrdenes('todos');
        actualizarDashboard();
        if (tienePermiso('puedeVerReportes')) {
            await cargarIngresosDashboard();
            actualizarDashboardGastos();
        }
    } catch (error) {
        console.error('Error al eliminar (card):', error);
        mostrarToast('Error al eliminar la orden', 'error');
    }
}

// ============================================
// AGENDA (Admin/Jefe)
// ============================================
let agendaCitas = [];

function escapeHtmlLite(texto) {
    return String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function cargarAgenda(fechaISO) {
    const container = document.getElementById('agendaLista');
    if (!container) return;

    if (!tienePermiso('puedeVerReportes')) return;
    if (!fechaISO) return;

    container.innerHTML = `
        <div class="empty-state" style="padding: 2rem;">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Cargando agenda...</p>
        </div>
    `;

    try {
        if (supabaseCliente) {
            if (!(await requerirSesionSupabase())) return;
            const { data, error } = await supabaseCliente
                .from('agenda')
                .select('*')
                .eq('fecha', fechaISO)
                .order('hora', { ascending: true });
            if (error) throw error;
            agendaCitas = data || [];
        } else {
            const all = JSON.parse(localStorage.getItem('taller_agenda') || '[]');
            agendaCitas = all.filter(c => c.fecha === fechaISO).sort((a, b) => String(a.hora).localeCompare(String(b.hora)));
        }

        renderAgenda(fechaISO);
    } catch (e) {
        console.error('Error al cargar agenda:', e);
        container.innerHTML = `
            <div class="empty-state" style="padding: 2rem;">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Error al cargar la agenda</p>
            </div>
        `;
    }
}

function renderAgenda(fechaISO) {
    const container = document.getElementById('agendaLista');
    if (!container) return;

    if (!agendaCitas || agendaCitas.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 2rem;">
                <i class="fas fa-calendar-check"></i>
                <p>No hay citas para esta fecha</p>
            </div>
        `;
        return;
    }

    const estadoLabels = {
        pendiente: 'Pendiente',
        confirmada: 'Confirmada',
        completada: 'Completada',
        cancelada: 'Cancelada',
    };

    container.innerHTML = agendaCitas.map(c => {
        const titulo = `${escapeHtmlLite(c.hora)} • ${escapeHtmlLite(c.cliente_nombre)}`;
        const sub = [
            c.vehiculo_patente ? `Patente: ${escapeHtmlLite(c.vehiculo_patente)}` : '',
            c.cliente_telefono ? `Tel: ${escapeHtmlLite(c.cliente_telefono)}` : ''
        ].filter(Boolean).join(' • ');
        const desc = (c.descripcion || '').toString().trim();
        const estado = (c.estado || 'pendiente').toString();

        return `
            <div class="agenda-item">
                <div class="agenda-left">
                    <div class="agenda-title">${titulo}</div>
                    ${sub ? `<div class="agenda-sub">${sub}</div>` : ``}
                    ${desc ? `<div class="agenda-desc">${escapeHtmlLite(desc)}</div>` : ``}
                </div>
                <div class="agenda-right">
                    <span class="agenda-badge agenda-${estado}">${estadoLabels[estado] || estado}</span>
                    <div class="agenda-actions">
                        <button class="btn btn-small btn-secondary" type="button" onclick="editarCitaAgenda('${c.id}')">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-small btn-danger" type="button" onclick="eliminarCitaAgenda('${c.id}', '${escapeHtmlLite(c.cliente_nombre)}', '${escapeHtmlLite(c.hora)}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

async function guardarCitaAgenda(e) {
    e.preventDefault();
    if (!tienePermiso('puedeVerReportes')) {
        mostrarToast('No tienes permiso para usar agenda', 'error');
        return;
    }

    const fecha = document.getElementById('agendaFecha')?.value;
    const hora = document.getElementById('agendaHora')?.value;
    const clienteNombre = document.getElementById('agendaCliente')?.value?.trim();
    const telefono = document.getElementById('agendaTelefono')?.value?.trim() || null;
    const patente = document.getElementById('agendaPatente')?.value?.trim()?.toUpperCase() || null;
    const descripcion = document.getElementById('agendaDescripcion')?.value?.trim() || null;
    const estado = document.getElementById('agendaEstado')?.value || 'pendiente';

    if (!fecha || !hora || !clienteNombre) {
        mostrarToast('Completa fecha, hora y cliente', 'error');
        return;
    }

    const payload = {
        fecha,
        hora,
        cliente_nombre: clienteNombre,
        cliente_telefono: telefono,
        vehiculo_patente: patente,
        descripcion,
        estado,
        creado_por: usuarioActual?.id || null
    };

    try {
        if (supabaseCliente) {
            if (!(await requerirSesionSupabase())) return;
            const editId = localStorage.getItem('agenda_edit_id');
            if (editId) {
                const { error } = await supabaseCliente.from('agenda').update(payload).eq('id', editId);
                if (error) throw error;
                localStorage.removeItem('agenda_edit_id');
            } else {
                const { error } = await supabaseCliente.from('agenda').insert([payload]);
                if (error) throw error;
            }
        } else {
            const all = JSON.parse(localStorage.getItem('taller_agenda') || '[]');
            const editId = localStorage.getItem('agenda_edit_id');
            if (editId) {
                const idx = all.findIndex(c => c.id === editId);
                if (idx !== -1) all[idx] = { ...all[idx], ...payload };
                localStorage.removeItem('agenda_edit_id');
            } else {
                all.push({ id: 'local-' + Date.now(), ...payload });
            }
            localStorage.setItem('taller_agenda', JSON.stringify(all));
        }

        mostrarToast('Cita guardada', 'success');
        document.getElementById('formAgenda')?.reset();

        // Mantener filtros en la fecha guardada
        const filtro = document.getElementById('agendaFiltroFecha');
        if (filtro) filtro.value = fecha;
        await cargarAgenda(fecha);
    } catch (err) {
        console.error('Error guardando cita:', err);
        mostrarToast('Error al guardar cita', 'error');
    }
}

function editarCitaAgenda(citaId) {
    const cita = agendaCitas.find(c => c.id === citaId);
    if (!cita) return;

    document.getElementById('agendaFecha').value = cita.fecha;
    document.getElementById('agendaHora').value = cita.hora;
    document.getElementById('agendaCliente').value = cita.cliente_nombre || '';
    document.getElementById('agendaTelefono').value = cita.cliente_telefono || '';
    document.getElementById('agendaPatente').value = cita.vehiculo_patente || '';
    document.getElementById('agendaDescripcion').value = cita.descripcion || '';
    document.getElementById('agendaEstado').value = cita.estado || 'pendiente';

    // Guardado rápido: eliminamos y luego insertamos al submit (simple)
    // Esto evita crear una UI extra de "modo edición".
    localStorage.setItem('agenda_edit_id', citaId);
    mostrarToast('Edita y vuelve a guardar (reemplazará la cita)', 'info');
}

async function eliminarCitaAgenda(citaId, nombre, hora) {
    if (!confirm(`¿Eliminar cita ${hora || ''} ${nombre || ''}?`)) return;
    const filtro = document.getElementById('agendaFiltroFecha')?.value;

    try {
        if (supabaseCliente) {
            if (!(await requerirSesionSupabase())) return;
            const { error } = await supabaseCliente.from('agenda').delete().eq('id', citaId);
            if (error) throw error;
        } else {
            const all = JSON.parse(localStorage.getItem('taller_agenda') || '[]');
            localStorage.setItem('taller_agenda', JSON.stringify(all.filter(c => c.id !== citaId)));
        }
        mostrarToast('Cita eliminada', 'success');
        if (filtro) await cargarAgenda(filtro);
    } catch (e) {
        console.error('Error eliminando cita:', e);
        mostrarToast('Error al eliminar cita', 'error');
    }
}

async function generarLinkPresupuestoCliente(ordenId) {
    if (!tienePermiso('puedeVerPresupuestos')) {
        mostrarToast('No tienes permiso para generar links', 'error');
        return;
    }
    if (!(await requerirSesionSupabase())) return;

    const orden = ordenes.find(o => o.id === ordenId);
    if (!orden) {
        mostrarToast('Orden no encontrada', 'error');
        return;
    }

    try {
        if (supabaseCliente) {
            try { await supabaseCliente.auth.refreshSession(); } catch (_) {}
        }

        const { data: token, error } = await supabaseCliente.rpc('create_presupuesto_token', { p_orden_id: ordenId });
        if (error) throw error;

        // Soporte si se abre desde file:// (origin puede ser "null")
        const base = (window.location.origin && window.location.origin !== 'null')
            ? window.location.origin
            : window.location.href.replace(/\/[^\/]*$/, '');
        const link = `${base}/presupuesto.html?t=${encodeURIComponent(token)}`;

        // Intentar copiar al portapapeles
        try {
            await navigator.clipboard.writeText(link);
            mostrarToast('Link copiado. Puedes pegarlo en WhatsApp.', 'success');
        } catch (_) {
            mostrarToast('Link generado. Copia manualmente si no se copió.', 'info');
        }

        const telefono = (orden.cliente?.telefono || '').toString().trim();
        const vehiculoTxt = `${orden.vehiculo?.marca || 'Vehículo'} ${orden.vehiculo?.patente || ''}`.trim();
        const montoTxt = orden.presupuesto ? `$${Number(orden.presupuesto).toLocaleString('es-CL')}` : 'sin monto';
        const msg = `Hola ${orden.cliente?.nombre || ''}. Te enviamos el presupuesto de ${vehiculoTxt} (${montoTxt}).\n\nPara ACEPTAR o RECHAZAR, entra aquí:\n${link}`;

        // Abrir WhatsApp si hay número (sino solo deja copiado)
        if (telefono) {
            const wa = `https://wa.me/${telefono.replace(/[^\d]/g, '')}?text=${encodeURIComponent(msg)}`;
            window.open(wa, '_blank');
        } else {
            // Fallback: mostrar en un prompt para copiar
            window.prompt('Link para enviar al cliente:', link);
        }
    } catch (e) {
        console.error('Error al generar link de presupuesto:', e);
        mostrarToast('Error al generar link: ' + (e?.message || ''), 'error');
    }
}

/**
 * Calcula el color del semaforo de urgencia basado en el tiempo de entrega
 * @returns {string} clase CSS: 'urgencia-verde', 'urgencia-amarillo', 'urgencia-rojo', 'urgencia-critico'
 */
function calcularUrgencia(tiempoEntrega, fechaIngreso) {
    if (!tiempoEntrega) return '';
    
    // Parsear tiempo de entrega (ej: "24 horas", "2 días", "2024-03-28")
    let fechaEntrega = null;
    
    // Si es una fecha específica (formato YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(tiempoEntrega)) {
        fechaEntrega = new Date(tiempoEntrega);
    } else {
        // Parsear "X horas" o "X días"
        const horasMatch = tiempoEntrega.match(/(\d+)\s*horas?/i);
        const diasMatch = tiempoEntrega.match(/(\d+)\s*d[ií]as?/i);
        
        const fechaBase = fechaIngreso ? new Date(fechaIngreso) : new Date();
        fechaEntrega = new Date(fechaBase);
        
        if (horasMatch) {
            fechaEntrega.setHours(fechaEntrega.getHours() + parseInt(horasMatch[1]));
        } else if (diasMatch) {
            fechaEntrega.setDate(fechaEntrega.getDate() + parseInt(diasMatch[1]));
        } else {
            return '';
        }
    }
    
    const ahora = new Date();
    const diferenciaMs = fechaEntrega - ahora;
    const diferenciaHoras = diferenciaMs / (1000 * 60 * 60);
    
    // Verde: más de 24 horas
    if (diferenciaHoras > 24) {
        return 'urgencia-verde';
    }
    // Amarillo: menos de 12 horas o es el día de entrega (0-24 horas)
    else if (diferenciaHoras > 0 && diferenciaHoras <= 24) {
        return 'urgencia-amarillo';
    }
    // Rojo: fecha vencida
    else {
        // CRITICO: Si está atrasada más de 24 horas
        if (diferenciaHoras < -24) {
            return 'urgencia-critico';
        }
        return 'urgencia-rojo';
    }
}

function crearCardOrden(orden) {
    const estadoLabels = {
        ingresado: 'Ingresado',
        reparacion: 'En Reparación',
        espera: 'Esperando Repuestos',
        listo: 'Listo para Entrega',
        entregado: 'Entregado'
    };
    
    const estadoPresupuestoLabels = {
        pendiente: 'Pendiente',
        aprobado: 'Aprobado',
        rechazado: 'Rechazado'
    };
    
    const estadoPresupuestoClass = {
        pendiente: 'presupuesto-pendiente',
        aprobado: 'presupuesto-aprobado',
        rechazado: 'presupuesto-rechazado'
    };
    
    const fecha = new Date(orden.fecha_ingreso).toLocaleDateString('es-CL');
    const puedeVerPresupuesto = tienePermiso('puedeVerPresupuestos');
    const esMecanico = usuarioActual?.rol === ROLES.MECANICO;
    const estadoPresupuesto = orden.estado_presupuesto || 'pendiente';
    const firmaRecepcionOK = !!orden.firma_recepcion_fecha;
    const firmaEntregaOK = !!orden.firma_entrega_fecha;
    
    // Calcular urgencia si tiene tiempo de entrega
    const claseUrgencia = calcularUrgencia(orden.tiempo_entrega, orden.fecha_ingreso);
    const urgenciaHTML = claseUrgencia ? `<div class="indicador-urgencia ${claseUrgencia}" title="Tiempo de entrega: ${orden.tiempo_entrega || 'No especificado'}"></div>` : '';
    
    return `
        <div class="orden-card ${claseUrgencia}">
            ${urgenciaHTML}
            <div class="orden-header">
                <div class="orden-vehiculo">
                    <i class="fas fa-car"></i>
                    <div>
                        <h4>${orden.vehiculo.marca}</h4>
                        <span>${orden.vehiculo.patente}</span>
                    </div>
                </div>
                <span class="orden-estado estado-${orden.estado}">${estadoLabels[orden.estado]}</span>
            </div>
            <div class="orden-body">
                <div class="orden-info">
                    <div class="info-item">
                        <span class="info-label">Cliente</span>
                        <span class="info-value">${orden.cliente.nombre}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Teléfono</span>
                        <span class="info-value">${orden.cliente.telefono}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Kilometraje</span>
                        <span class="info-value">${orden.vehiculo.kilometraje.toLocaleString('es-CL')} km</span>
                    </div>
                    ${puedeVerPresupuesto ? `
                    <div class="info-item">
                        <span class="info-label">Presupuesto</span>
                        <span class="info-value">${orden.presupuesto ? '$' + orden.presupuesto.toLocaleString('es-CL') : 'Sin presupuesto'}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Estado Presupuesto</span>
                        <span class="estado-presupuesto ${estadoPresupuestoClass[estadoPresupuesto]}">${estadoPresupuestoLabels[estadoPresupuesto]}</span>
                    </div>
                    ` : ''}

                    ${esMecanico ? `
                    <div class="info-item">
                        <span class="info-label">Tu pago</span>
                        <span class="info-value">${Number(orden.pago_mecanico || 0) > 0 ? '$' + Number(orden.pago_mecanico).toLocaleString('es-CL') : 'No definido'}</span>
                    </div>
                    ` : ''}
                </div>
                ${(firmaRecepcionOK || firmaEntregaOK) ? `
                <div class="orden-firmas-inline">
                    ${firmaRecepcionOK ? `
                      <div class="firma-inline-actions">
                        <span class="firma-chip firma-chip-ok"><i class="fas fa-pen-nib"></i> Recepción firmada</span>
                        <button class="btn btn-small btn-success btn-enviar-firma-doc" data-orden-id="${orden.id}" data-doc-tipo="recepcion" type="button" title="Enviar acta de recepción (link)">
                          <i class="fab fa-whatsapp"></i> Enviar
                        </button>
                      </div>
                    ` : ``}
                    ${firmaEntregaOK ? `
                      <div class="firma-inline-actions">
                        <span class="firma-chip firma-chip-ok"><i class="fas fa-pen-nib"></i> Entrega firmada</span>
                        <button class="btn btn-small btn-success btn-enviar-firma-doc" data-orden-id="${orden.id}" data-doc-tipo="entrega" type="button" title="Enviar documento de entrega (link)">
                          <i class="fab fa-whatsapp"></i> Enviar
                        </button>
                      </div>
                    ` : ``}
                </div>
                ` : ``}
                <div class="orden-falla">
                    <span class="info-label">Falla declarada:</span>
                    <p>${orden.falla_declarada}</p>
                </div>
                ${orden.repuestos_usados ? `
                <div class="orden-falla">
                    <span class="info-label">Repuestos:</span>
                    <p>${orden.repuestos_usados}</p>
                </div>
                ` : ''}
            </div>
            ${tienePermiso('puedeAsignarMecanicos') ? `
            <div class="orden-asignacion">
                <span class="info-label"><i class="fas fa-user-wrench"></i> Asignar Mecánico:</span>
                <div class="mecanico-selector-container">
                    ${generarSelectorMecanicos(orden.id, orden.mecanico_asignado)}
                </div>
            </div>
            ` : ''}
            
            ${tienePermiso('puedeVerPresupuestos') && orden.estado_presupuesto === 'pendiente' ? `
            <div class="orden-aprobacion">
                <span class="info-label"><i class="fas fa-file-invoice-dollar"></i> Aprobación Rápida:</span>
                <div class="presupuesto-actions">
                    <button class="btn-aprobar-presupuesto" data-orden-id="${orden.id}" type="button">
                        <i class="fas fa-check-circle"></i> Aprobar Presupuesto
                    </button>
                    <button class="btn-rechazar-presupuesto" data-orden-id="${orden.id}" type="button">
                        <i class="fas fa-times-circle"></i> Rechazar Presupuesto
                    </button>
                    <button class="btn-link-presupuesto" data-orden-id="${orden.id}" type="button" title="Genera un link para enviar por WhatsApp">
                        <i class="fas fa-link"></i> Link al Cliente
                    </button>
                </div>
            </div>
            ` : ''}

            ${tienePermiso('puedeVerPresupuestos') && orden.estado_presupuesto === 'rechazado' ? `
            <div class="orden-presupuesto-rechazado">
                <span class="info-label"><i class="fas fa-ban"></i> Presupuesto Rechazado</span>
                ${tienePermiso('puedeEliminarOrdenes') ? `
                <button class="btn-eliminar-orden-card" data-orden-id="${orden.id}" type="button">
                    <i class="fas fa-trash-alt"></i> Eliminar Orden
                </button>
                ` : `
                <div class="sin-mecanico">Solo un administrador puede eliminar esta orden.</div>
                `}
            </div>
            ` : ''}
            
            ${tienePermiso('puedeVerReportes') && orden.estado === 'listo' ? `
            <div class="orden-confirmar-entrega">
                <span class="info-label"><i class="fas fa-money-bill-wave"></i> Esperando Pago</span>
                <button class="btn-confirmar-entrega" data-orden-id="${orden.id}">
                    <i class="fas fa-check-double"></i> Confirmar Entrega y Cobro
                </button>
            </div>
            ` : ''}
            <div class="orden-footer">
                <span class="orden-fecha"><i class="fas fa-calendar"></i> ${fecha}</span>
                <div style="display:flex; gap: .5rem; align-items:center;">
                    ${tienePermiso('puedeVerPresupuestos') ? `
                    <button class="btn-factura" type="button" onclick="abrirFacturaOrden('${orden.id}')">
                        <i class="fas fa-print"></i> Factura
                    </button>
                    ` : ``}
                    <button class="btn-editar" data-id="${orden.id}">
                        <i class="fas fa-edit"></i> Editar
                    </button>
                </div>
            </div>
        </div>
    `;
}

function renderizarUsuarios() {
    // Renderizar en el contenedor de admin (usuarios-admin-list)
    const adminContainer = document.getElementById('usuariosAdminList');
    if (adminContainer) {
        renderizarUsuariosAdmin(adminContainer);
    }
    
    // Renderizar en el contenedor antiguo si existe (usersList)
    const container = document.getElementById('usersList');
    if (container) {
        renderizarUsuariosLegacy(container);
    }
}

/**
 * Renderiza usuarios en la sección de Administración con el formato usuario-admin-item
 */
function renderizarUsuariosAdmin(container) {
    if (usuariosSistema.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 2rem;">
                <i class="fas fa-users-slash"></i>
                <p>No hay usuarios registrados</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = usuariosSistema.map(user => {
        const iniciales = user.nombre.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 1);
        const rolLabels = {
            admin: 'Administrador',
            jefe: 'Jefe de Taller',
            mecanico: 'Mecánico'
        };
        
        return `
            <div class="usuario-admin-item">
                <div class="usuario-admin-avatar ${user.rol}">${iniciales}</div>
                <div class="usuario-admin-info">
                    <h4>${user.nombre}</h4>
                    <p>${user.email}</p>
                    <span class="rol-badge ${user.rol}">${rolLabels[user.rol] || user.rol}</span>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Renderiza usuarios en el formato legacy (user-card)
 */
function renderizarUsuariosLegacy(container) {
    if (usuariosSistema.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-users"></i>
                <p>No hay usuarios registrados</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = usuariosSistema.map(user => {
        const roleClass = `role-${user.rol}`;
        const roleLabel = PERMISOS[user.rol]?.label || user.rol;
        const iniciales = user.nombre.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
        
        return `
            <div class="user-card">
                <div class="user-info-card">
                    <div class="user-avatar">${iniciales}</div>
                    <div class="user-details">
                        <h4>${user.nombre}</h4>
                        <p>${user.email}</p>
                    </div>
                </div>
                <div class="user-actions">
                    <span class="user-role-badge ${roleClass}">${roleLabel}</span>
                    ${user.id !== usuarioActual?.id ? `
                    <button class="btn btn-danger btn-small" onclick="eliminarUsuario('${user.id}')">
                        <i class="fas fa-trash"></i>
                    </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function actualizarDashboard() {
    const ordenesVisibles = filtrarOrdenesPorRol(ordenes);
    
    // Conteos por estado
    const conteos = {
        ingresado: ordenesVisibles.filter(o => o.estado === 'ingresado').length,
        reparacion: ordenesVisibles.filter(o => o.estado === 'reparacion').length,
        espera: ordenesVisibles.filter(o => o.estado === 'espera').length,
        listo: ordenesVisibles.filter(o => o.estado === 'listo').length,
        entregado: ordenesVisibles.filter(o => o.estado === 'entregado').length
    };
    
    document.getElementById('countIngresado').textContent = conteos.ingresado;
    document.getElementById('countReparacion').textContent = conteos.reparacion;
    document.getElementById('countEspera').textContent = conteos.espera;
    document.getElementById('countListo').textContent = conteos.listo;
    document.getElementById('countEntregado').textContent = conteos.entregado;
    
    // Actualizar ingresos totales (SOLO órdenes con estado 'entregado' Y pagado = true)
    const ingresosTotales = ordenes
        .filter(o => o.estado === 'entregado' && o.pagado === true)
        .reduce((sum, o) => sum + (o.presupuesto || 0), 0);
    
    const ingresosEl = document.getElementById('ingresosTotal');
    if (ingresosEl) {
        ingresosEl.textContent = '$' + ingresosTotales.toLocaleString('es-CL');
    }
    
    // Actualizar dashboard de ingresos si existe
    actualizarDashboardIngresos();
}

function actualizarDashboardIngresos() {
    // Calcular ingresos del mes actual
    const hoy = new Date();
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const inicioSemana = new Date(hoy);
    inicioSemana.setDate(hoy.getDate() - hoy.getDay());
    
    // Inicio del día actual (para caja diaria)
    const inicioDia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    
    const ordenesEntregadas = ordenes.filter(o => o.estado === 'entregado' && o.pagado === true);
    
    const ingresosTotales = ordenesEntregadas.reduce((sum, o) => sum + (o.presupuesto || 0), 0);
    const ingresosMes = ordenesEntregadas
        .filter(o => new Date(o.fecha_entrega || o.updated_at) >= inicioMes)
        .reduce((sum, o) => sum + (o.presupuesto || 0), 0);
    const ingresosSemana = ordenesEntregadas
        .filter(o => new Date(o.fecha_entrega || o.updated_at) >= inicioSemana)
        .reduce((sum, o) => sum + (o.presupuesto || 0), 0);
    
    // Calcular ingresos del día (Caja Diaria)
    const ingresosDia = ordenesEntregadas
        .filter(o => {
            const fechaEntrega = new Date(o.fecha_entrega || o.updated_at);
            return fechaEntrega >= inicioDia && fechaEntrega < new Date(inicioDia.getTime() + 24 * 60 * 60 * 1000);
        })
        .reduce((sum, o) => sum + (o.presupuesto || 0), 0);
    
    // Actualizar elementos del dashboard
    const totalEl = document.getElementById('totalIngresos');
    const mesEl = document.getElementById('ingresosMes');
    const semanaEl = document.getElementById('ingresosSemana');
    const diaEl = document.getElementById('ingresosDia');
    
    if (totalEl) totalEl.textContent = '$' + ingresosTotales.toLocaleString('es-CL');
    if (mesEl) mesEl.textContent = '$' + ingresosMes.toLocaleString('es-CL');
    if (semanaEl) semanaEl.textContent = '$' + ingresosSemana.toLocaleString('es-CL');
    
    // Solo mostrar ingresos del día si es administrador o jefe
    if (diaEl) {
        if (usuarioActual && (usuarioActual.rol === 'admin' || usuarioActual.rol === 'jefe')) {
            diaEl.textContent = '$' + ingresosDia.toLocaleString('es-CL');
        } else {
            // Ocultar valor para mecánicos
            diaEl.textContent = '****';
        }
    }
}

// ============================================
// MODALES
// ============================================
function abrirModalEditar(id) {
    ordenActual = ordenes.find(o => o.id === id);
    if (!ordenActual) return;
    
    // Verificar permisos según rol
    const esMecanico = usuarioActual?.rol === ROLES.MECANICO;
    const esSuOrden = ordenActual.mecanico_asignado === usuarioActual?.id;
    const estadoActual = ordenActual.estado;
    
    // Mecánico solo puede editar sus órdenes asignadas
    if (esMecanico && !esSuOrden) {
        mostrarToast('Solo puedes editar las órdenes asignadas a ti', 'error');
        return;
    }
    
    // Mecánico no puede editar si la orden está "Listo" o "Entregado"
    if (esMecanico && (estadoActual === 'listo' || estadoActual === 'entregado')) {
        mostrarToast('Esta orden ya está lista. Solo el administrador puede hacer cambios.', 'info');
        return;
    }
    
    // Admin/Jefe pueden editar todas
    if (!esMecanico && !tienePermiso('puedeEditarTodasLasOrdenes')) {
        mostrarToast('No tienes permiso para editar esta orden', 'error');
        return;
    }
    
    document.getElementById('editId').value = ordenActual.id;
    document.getElementById('editFalla').value = ordenActual.falla_declarada || '';
    document.getElementById('editRepuestos').value = ordenActual.repuestos_usados || '';
    document.getElementById('editPresupuesto').value = ordenActual.presupuesto || '';
    const editPagoMecanico = document.getElementById('editPagoMecanico');
    if (editPagoMecanico) editPagoMecanico.value = ordenActual.pago_mecanico || '';
    const editMontoCliente = document.getElementById('editMontoCliente');
    if (editMontoCliente) editMontoCliente.value = ordenActual.monto_total_cobrado || '';
    const editCostoRepuestos = document.getElementById('editCostoRepuestos');
    if (editCostoRepuestos) editCostoRepuestos.value = ordenActual.costo_repuestos || '';

    const editPatente = document.getElementById('editVehiculoPatente');
    if (editPatente) editPatente.value = ordenActual.vehiculo?.patente || '';
    const marcaCompleta = (ordenActual.vehiculo?.marca || '').trim();
    const partesMarca = marcaCompleta.split(/\s+/).filter(Boolean);
    const marcaCorta = partesMarca[0] || '';
    const modeloResto = partesMarca.length > 1 ? partesMarca.slice(1).join(' ') : '';
    const editMarca = document.getElementById('editVehiculoMarca');
    if (editMarca) editMarca.value = marcaCorta;
    const editModelo = document.getElementById('editVehiculoModelo');
    if (editModelo) editModelo.value = modeloResto;

    const selectMecanico = document.getElementById('editMecanicoAsignado');
    if (selectMecanico) {
        const opciones = mecanicosLista.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
        selectMecanico.innerHTML = `<option value="">Sin asignar</option>${opciones}`;
        selectMecanico.value = ordenActual.mecanico_asignado || '';
    }
    document.getElementById('editEstado').value = ordenActual.estado;

    // Firmas: badges + fechas + habilitar ver
    const setFirmaUI = (tipo) => {
        const isRecep = tipo === 'recepcion';
        const data = isRecep ? ordenActual.firma_recepcion_data : ordenActual.firma_entrega_data;
        const fecha = isRecep ? ordenActual.firma_recepcion_fecha : ordenActual.firma_entrega_fecha;
        const badge = document.getElementById(isRecep ? 'badgeFirmaRecepcion' : 'badgeFirmaEntrega');
        const fechaEl = document.getElementById(isRecep ? 'fechaFirmaRecepcion' : 'fechaFirmaEntrega');
        const btnVer = document.getElementById(isRecep ? 'btnVerFirmaRecepcion' : 'btnVerFirmaEntrega');

        const firmada = !!(data && String(data).startsWith('data:image/')) || !!fecha;
        if (badge) {
            badge.textContent = firmada ? 'Firmada' : 'Pendiente';
            badge.classList.toggle('firmada', firmada);
        }
        if (fechaEl) {
            fechaEl.textContent = fecha ? new Date(fecha).toLocaleString('es-CL') : '—';
        }
        if (btnVer) {
            btnVer.disabled = !firmada;
        }
    };
    setFirmaUI('recepcion');
    setFirmaUI('entrega');

    // Autocalcular monto total: presupuesto + repuestos (si el usuario no lo edita manualmente)
    window.__montoClienteManual = false;
    const setMontoAuto = () => {
        if (window.__montoClienteManual) return;
        const presupuesto = parseInt(document.getElementById('editPresupuesto')?.value) || 0;
        const repuestos = parseInt(document.getElementById('editCostoRepuestos')?.value) || 0;
        const total = Math.max(0, presupuesto + repuestos);
        const el = document.getElementById('editMontoCliente');
        if (el) el.value = total;
    };
    document.getElementById('editPresupuesto')?.addEventListener('input', setMontoAuto);
    document.getElementById('editCostoRepuestos')?.addEventListener('input', setMontoAuto);
    document.getElementById('editMontoCliente')?.addEventListener('input', () => { window.__montoClienteManual = true; });
    // Si viene vacío o 0, autocompletar de inmediato
    const montoActual = parseInt(document.getElementById('editMontoCliente')?.value) || 0;
    if (montoActual === 0) setMontoAuto();
    
    // Aplicar restricciones de edición según rol
    aplicarRestriccionesModalEdicion(esMecanico);
    
    document.querySelectorAll('.estado-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.estado === ordenActual.estado) {
            btn.classList.add('active');
        }
    });
    
    document.getElementById('modalEditar').classList.add('active');
    document.body.style.overflow = 'hidden';
}

/**
 * Aplica restricciones al modal de edición según el rol
 */
function aplicarRestriccionesModalEdicion(esMecanico) {
    // Campos solo para admin
    document.querySelectorAll('.admin-edit-only').forEach(el => {
        el.style.display = esMecanico ? 'none' : 'block';
    });
    
    // Campos permitidos para mecánico
    document.querySelectorAll('.mecanico-edit-allowed').forEach(el => {
        el.style.display = 'block';
    });
    
    // El selector de estado siempre visible, pero con opciones limitadas para mecánico
    const estadoSelector = document.querySelector('.estado-selector');
    if (estadoSelector && esMecanico) {
        // Mecánico solo puede cambiar entre ciertos estados
        estadoSelector.querySelectorAll('.estado-btn').forEach(btn => {
            const estado = btn.dataset.estado;
            // Mecánico puede: reparacion, espera, listo
            const permitidos = ['reparacion', 'espera', 'listo'];
            btn.style.display = permitidos.includes(estado) ? 'flex' : 'none';
        });
    } else if (estadoSelector) {
        // Admin ve todos los estados
        estadoSelector.querySelectorAll('.estado-btn').forEach(btn => {
            btn.style.display = 'flex';
        });
    }
}

function cerrarModal() {
    document.getElementById('modalEditar').classList.remove('active');
    document.body.style.overflow = '';
    ordenActual = null;
}

function abrirModalUsuario() {
    if (!tienePermiso('puedeCrearUsuarios')) {
        mostrarToast('No tienes permiso para crear usuarios', 'error');
        return;
    }
    document.getElementById('modalNuevoUsuario').classList.add('active');
}

function cerrarModalUsuario() {
    document.getElementById('modalNuevoUsuario').classList.remove('active');
    document.getElementById('formNuevoUsuario').reset();
}

// ============================================
// BÚSQUEDA Y REPORTES
// ============================================
function buscarHistorial() {
    const patente = document.getElementById('searchPatente').value.toUpperCase().trim();
    const container = document.getElementById('historialResults');
    
    if (!patente) {
        mostrarToast('Ingrese una patente para buscar', 'info');
        return;
    }
    
    const ordenesVisibles = filtrarOrdenesPorRol(ordenes);
    const resultados = ordenesVisibles.filter(o => o.vehiculo.patente.includes(patente));
    
    if (resultados.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-search"></i>
                <p>No se encontraron registros para "${patente}"</p>
            </div>
        `;
        return;
    }
    
    const vehiculos = {};
    resultados.forEach(orden => {
        const key = `${orden.vehiculo.patente}-${orden.vehiculo.marca}`;
        if (!vehiculos[key]) {
            vehiculos[key] = { vehiculo: orden.vehiculo, cliente: orden.cliente, ordenes: [] };
        }
        vehiculos[key].ordenes.push(orden);
    });
    
    container.innerHTML = Object.values(vehiculos).map(v => crearCardHistorial(v)).join('');
}

function crearCardHistorial({ vehiculo, cliente, ordenes }) {
    const ordenesOrdenadas = ordenes.sort((a, b) => new Date(b.fecha_ingreso) - new Date(a.fecha_ingreso));
    const estadoLabels = { ingresado: 'Ingresado', reparacion: 'En Reparación', espera: 'Esperando', listo: 'Listo' };
    const puedeVerPresupuesto = tienePermiso('puedeVerPresupuestos');
    
    return `
        <div class="historial-card">
            <h4><i class="fas fa-car"></i> ${vehiculo.marca} - ${vehiculo.patente}</h4>
            <p style="color: var(--text-muted); margin-bottom: 1rem;">
                <i class="fas fa-user"></i> ${cliente.nombre}
            </p>
            <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                ${ordenesOrdenadas.map(o => `
                    <div style="background: var(--bg-tertiary); padding: 0.75rem; border-radius: 8px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                            <span style="font-size: 0.8rem; color: var(--text-muted);">
                                <i class="fas fa-calendar"></i> ${new Date(o.fecha_ingreso).toLocaleDateString('es-CL')}
                            </span>
                            <span class="orden-estado estado-${o.estado}" style="font-size: 0.7rem; padding: 0.25rem 0.5rem;">
                                ${estadoLabels[o.estado]}
                            </span>
                        </div>
                        <p style="font-size: 0.9rem; margin-bottom: 0.25rem;"><strong>Falla:</strong> ${o.falla_declarada}</p>
                        ${o.repuestos_usados ? `<p style="font-size: 0.85rem; color: var(--text-secondary);"><strong>Repuestos:</strong> ${o.repuestos_usados}</p>` : ''}
                        ${puedeVerPresupuesto && o.presupuesto ? `<p style="font-size: 0.85rem; color: var(--accent-secondary);"><strong>Presupuesto:</strong> $${o.presupuesto.toLocaleString('es-CL')}</p>` : ''}
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

async function cargarReportes() {
    if (!tienePermiso('puedeVerReportes')) return;
    
    const ordenesCompletadas = ordenes.filter(o => o.estado === 'listo');
    const ingresosTotales = ordenesCompletadas.reduce((sum, o) => sum + (o.presupuesto || 0), 0);
    const promedio = ordenesCompletadas.length > 0 ? ingresosTotales / ordenesCompletadas.length : 0;
    
    document.getElementById('reporteIngresosMes').textContent = '$' + ingresosTotales.toLocaleString('es-CL');
    document.getElementById('reporteOrdenesCompletadas').textContent = ordenesCompletadas.length;
    document.getElementById('reportePromedioOrden').textContent = '$' + Math.round(promedio).toLocaleString('es-CL');
    
    // Tabla de detalle
    const tbody = document.getElementById('tbodyIngresos');
    tbody.innerHTML = ordenesCompletadas.map(o => `
        <tr>
            <td>${new Date(o.fecha_ingreso).toLocaleDateString('es-CL')}</td>
            <td>${o.vehiculo.patente}</td>
            <td>${o.cliente.nombre}</td>
            <td>${o.falla_declarada.substring(0, 30)}...</td>
            <td>$${(o.presupuesto || 0).toLocaleString('es-CL')}</td>
        </tr>
    `).join('');
}

// ============================================
// CONFIRMAR ENTREGA Y COBRO (Admin/Jefe)
// ============================================

/**
 * Confirma la entrega y cobro de una orden (solo Admin/Jefe)
 * Cambia estado a 'entregado', marca como pagado y registra ingreso
 */
async function confirmarEntregaYCobro(ordenId) {
    if (!tienePermiso('puedeVerReportes')) {
        mostrarToast('No tienes permiso para confirmar entregas', 'error');
        return;
    }
    
    const orden = ordenes.find(o => o.id === ordenId);
    if (!orden) {
        mostrarToast('Orden no encontrada', 'error');
        return;
    }
    
    if (orden.estado !== 'listo') {
        mostrarToast('La orden debe estar "Listo para entregar" primero', 'warning');
        return;
    }
    
    const costoRepuestos = Number(orden.costo_repuestos || 0);
    const presupuestoBase = Number(orden.presupuesto || 0);
    const montoTotalCalculado = presupuestoBase + costoRepuestos;
    const montoMostrable = Number(orden.monto_total_cobrado || 0) > 0 ? Number(orden.monto_total_cobrado) : montoTotalCalculado;

    // Confirmar con el usuario (mostrar total real, incluyendo repuestos si aplica)
    if (!confirm(
        `¿Confirmar entrega y cobro de ${orden.vehiculo.marca} ${orden.vehiculo.patente}?\n\n` +
        `Monto total: $${montoMostrable.toLocaleString('es-CL')}` +
        (costoRepuestos > 0 ? `\n(Incluye repuestos: $${costoRepuestos.toLocaleString('es-CL')})` : '')
    )) {
        return;
    }

    // Elegir método de pago
    const metodoPagoInput = (prompt(
        'Método de pago:\n\n1) efectivo\n2) transferencia\n3) tarjeta\n4) otro\n\nEscribe el nombre (ej: efectivo) o el número (1-4):',
        'efectivo'
    ) || '').toString().trim().toLowerCase();

    const metodoPago = (() => {
        const map = { '1': 'efectivo', '2': 'transferencia', '3': 'tarjeta', '4': 'otro' };
        if (map[metodoPagoInput]) return map[metodoPagoInput];
        if (['efectivo', 'transferencia', 'tarjeta', 'otro'].includes(metodoPagoInput)) return metodoPagoInput;
        return 'efectivo';
    })();
    
    try {
        const montoCobrado = montoMostrable;

        const pagoMecanico = Number(orden.pago_mecanico || 0);
        
        if (supabaseCliente) {
            // Operación atómica en BD: INSERT en ingresos + UPDATE en ordenes
            const { error: rpcError } = await supabaseCliente.rpc('cobrar_orden', {
                p_orden_id: ordenId,
                p_monto_cobrado: montoCobrado,
                p_pago_mecanico: pagoMecanico,
                p_metodo_pago: metodoPago
            });
            if (rpcError) throw rpcError;
        }
        
        // Actualizar en memoria
        orden.estado = 'entregado';
        orden.pagado = true;
        orden.fecha_entrega = new Date().toISOString();
        orden.monto_total_cobrado = montoCobrado;
        orden.estado_pago = 'pagado';
        orden.metodo_pago = metodoPago;
        
        guardarEnLocalStorage();
        mostrarToast('Entrega y cobro confirmados. Ingreso registrado.', 'success');
        renderizarOrdenes('todos');
        actualizarDashboard();
        if (tienePermiso('puedeVerReportes')) {
            await cargarIngresosDashboard();
            actualizarDashboardGastos();
        }

        // Después de cobrar/entregar: sugerir enviar link firma entrega
        if (tienePermiso('puedeVerReportes')) {
            const ok = confirm('¿Enviar ahora el link para firmar ENTREGA por WhatsApp?');
            if (ok) {
                await generarLinkFirmaCliente(ordenId, 'entrega');
            }
        }
        
    } catch (error) {
        console.error('Error al confirmar entrega:', error);
        mostrarToast('Error al confirmar entrega: ' + error.message, 'error');
    }
}

// ============================================
// APROBAR PRESUPUESTO (Admin/Jefe)
// ============================================

/**
 * Aprueba el presupuesto de una orden
 * Cambia estado_presupuesto a 'aprobado' y estado del vehículo a 'espera' (En Espera de Reparación)
 */
async function aprobarPresupuesto(ordenId) {
    if (!tienePermiso('puedeVerPresupuestos')) {
        mostrarToast('No tienes permiso para aprobar presupuestos', 'error');
        return;
    }
    if (!(await requerirSesionSupabase())) return;
    
    const orden = ordenes.find(o => o.id === ordenId);
    if (!orden) {
        mostrarToast('Orden no encontrada', 'error');
        return;
    }
    
    if (orden.estado_presupuesto !== 'pendiente') {
        mostrarToast('El presupuesto ya ha sido procesado', 'warning');
        return;
    }
    
    // Confirmar con el usuario
    if (!confirm(`¿Aprobar presupuesto de ${orden.vehiculo.marca} ${orden.vehiculo.patente}?\n\nMonto: $${(orden.presupuesto || 0).toLocaleString('es-CL')}\n\nEl estado cambiará a "En Espera de Reparación"`)) {
        return;
    }
    
    try {
        // Asegurar token fresco antes de un UPDATE (evita 403 si el cliente cae a rol anon)
        if (supabaseCliente) {
            try { await supabaseCliente.auth.refreshSession(); } catch (_) {}
        }

        const cambios = {
            estado_presupuesto: 'aprobado',
            estado: 'espera', // En Espera de Reparación
            fecha_inicio_reparacion: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        
        if (supabaseCliente) {
            // Preferimos RPC con SECURITY DEFINER para evitar bloqueos por RLS en UPDATE.
            // Valida rol admin/jefe en servidor.
            const { error: rpcError } = await supabaseCliente.rpc('aprobar_presupuesto', {
                p_orden_id: ordenId
            });
            if (rpcError) {
                // Fallback a update directo (por si el RPC no existe en algún entorno)
                const { error } = await supabaseCliente
                    .from('ordenes')
                    .update(cambios)
                    .eq('id', ordenId);
                if (error) throw error;
            }
        }
        
        // Actualizar en memoria
        orden.estado_presupuesto = 'aprobado';
        orden.estado = 'espera';
        orden.fecha_inicio_reparacion = cambios.fecha_inicio_reparacion;
        
        guardarEnLocalStorage();
        mostrarToast('Presupuesto aprobado. El vehículo está en espera de reparación.', 'success');
        
        // Enviar notificación por WhatsApp al cliente
        setTimeout(() => {
            enviarWhatsAppEsperaRepuestos(orden);
        }, 500);
        
        renderizarOrdenes('todos');
        actualizarDashboard();
        if (tienePermiso('puedeVerReportes')) {
            await cargarIngresosDashboard();
            actualizarDashboardGastos();
        }
        
    } catch (error) {
        console.error('Error al aprobar presupuesto:', error);
        mostrarToast('Error al aprobar presupuesto: ' + error.message, 'error');
    }
}

/**
 * Rechaza el presupuesto eliminando la orden (UI + Supabase).
 * Esto se usa cuando el cliente no acepta el presupuesto.
 */
async function rechazarPresupuesto(ordenId) {
    if (!tienePermiso('puedeEliminarOrdenes')) {
        mostrarToast('No tienes permiso para rechazar/eliminar órdenes', 'error');
        return;
    }
    if (!(await requerirSesionSupabase())) return;

    const orden = ordenes.find(o => o.id === ordenId);
    if (!orden) {
        mostrarToast('Orden no encontrada', 'error');
        return;
    }

    if (!confirm(
        `¿Rechazar presupuesto y borrar la orden?\n\n` +
        `${orden.vehiculo.marca} ${orden.vehiculo.patente}\n` +
        `Cliente: ${orden.cliente.nombre}\n` +
        `Monto: $${(orden.presupuesto || 0).toLocaleString('es-CL')}\n\n` +
        `Esta acción eliminará la orden de Supabase y no se puede deshacer.`
    )) {
        return;
    }

    try {
        if (supabaseCliente) {
            // Asegurar token fresco antes de mutaciones (evita requests como anon -> 403)
            try { await supabaseCliente.auth.refreshSession(); } catch (_) {}

            // Preferimos RPC con SECURITY DEFINER para evitar bloqueos por RLS en DELETE.
            const { error: rpcError } = await supabaseCliente.rpc('rechazar_presupuesto', {
                p_orden_id: ordenId
            });

            if (rpcError) {
                // Fallback a delete directo (por si el RPC no existe en algún entorno)
                const { error } = await supabaseCliente
                    .from('ordenes')
                    .delete()
                    .eq('id', ordenId);
                if (error) throw error;
            }
        }

        // Actualizar memoria/local
        ordenes = ordenes.filter(o => o.id !== ordenId);
        guardarEnLocalStorage();

        // Si estaba abierto el modal de esa orden, cerrarlo
        if (ordenActual?.id === ordenId) {
            cerrarModal();
        }

        mostrarToast('Orden rechazada y eliminada correctamente', 'success');
        renderizarOrdenes('todos');
        actualizarDashboard();
        if (tienePermiso('puedeVerReportes')) {
            await cargarIngresosDashboard();
            actualizarDashboardGastos();
        }
    } catch (error) {
        console.error('Error al rechazar/eliminar orden:', error);
        mostrarToast('Error al rechazar/eliminar la orden: ' + (error?.message || 'desconocido'), 'error');
    }
}

// ============================================
// REGISTRO DE INGRESOS
// ============================================

/**
 * Registra un ingreso automático cuando una orden se marca como entregada/pagada
 */
async function registrarIngresoDesdeOrden(orden) {
    try {
        const ingreso = {
            orden_id: orden.id,
            monto: orden.presupuesto,
            concepto: `Servicio: ${orden.vehiculo.marca} ${orden.vehiculo.patente}`,
            descripcion: orden.falla_declarada,
            tipo_ingreso: 'servicio',
            metodo_pago: 'efectivo',
            estado_pago: 'pagado',
            fecha_pago: new Date().toISOString().split('T')[0],
            registrado_por: usuarioActual?.id
        };
        
        if (supabaseCliente) {
            // Los ingresos se calculan automáticamente desde las órdenes pagadas
            // No se guardan en tabla separada, se obtienen de ordenes.pagado = true
            console.log('Ingreso calculado desde ordenes:', ingreso.monto);
        } else {
            // Modo offline: guardar en localStorage con ID local
            const ingresoLocal = {
                id: 'ingreso-' + Date.now(),
                ...ingreso,
                created_at: new Date().toISOString()
            };
            let ingresos = JSON.parse(localStorage.getItem('taller_ingresos') || '[]');
            ingresos.unshift(ingresoLocal);
            localStorage.setItem('taller_ingresos', JSON.stringify(ingresos));
            console.log('Ingreso guardado localmente:', ingresoLocal.monto);
        }
    } catch (error) {
        console.error('Error en registrarIngresoDesdeOrden:', error);
    }
}

// ============================================
// NOTIFICACIÓN WHATSAPP
// ============================================

/**
 * Envía presupuesto detallado por WhatsApp al cliente
 * @param {Object} datos - Datos de la orden {clienteNombre, clienteTelefono, vehiculoMarca, vehiculoPatente, presupuesto, falla, repuestos, tiempoEntrega}
 */
/**
 * Envía mensaje de WhatsApp con formato de presupuesto
 * Formato exacto solicitado:
 * 'Hola [Nombre]. Equipo de Taller Pro.
 * Presupuesto para: [Vehículo] ([Patente])
 * Trabajos: [Detalle]
 * Repuestos: [Lista]
 * Entrega estimada: [Tiempo]
 * TOTAL: $[Monto]
 * Favor confirmar para iniciar.'
 */
function enviarWhatsApp(datos) {
    // Limpiar y formatear el número de teléfono
    let telefono = datos.clienteTelefono.replace(/\D/g, '');
    
    // Asegurar que tenga código de país (Chile +56)
    if (telefono.startsWith('56') && telefono.length > 10) {
        telefono = telefono;
    } else if (telefono.startsWith('9') && telefono.length === 9) {
        telefono = '56' + telefono;
    } else if (telefono.startsWith('0')) {
        telefono = '56' + telefono.substring(1);
    } else {
        telefono = '56' + telefono;
    }
    
    // Formatear el monto con separador de miles
    const montoFormateado = parseInt(datos.presupuesto || 0).toLocaleString('es-CL');
    
    // Preparar detalles
    const falla = datos.falla || 'No especificado';
    const repuestos = datos.repuestos || 'No se requieren repuestos';
    const tiempo = datos.tiempoEntrega || 'A coordinar';
    
    // Formato solicitado con negritas (*texto*)
    const mensaje = 'Hola ' + datos.clienteNombre + '! Le saluda el equipo de *Taller Pro.*\n\n' +
        'Hemos generado el presupuesto para su *' + datos.vehiculoMarca + '* patente *' + datos.vehiculoPatente + '*:\n\n' +
        '*Trabajos:* ' + falla + '\n' +
        '*Repuestos:* ' + repuestos + '\n' +
        '*Tiempo de entrega:* ' + tiempo + '\n' +
        '*Valor total:* $' + montoFormateado + '\n\n' +
        'Por favor, confirme por este medio para aprobar e iniciar los trabajos. Gracias!';
    
    // Codificar el mensaje para URL
    const mensajeCodificado = encodeURIComponent(mensaje);
    
    // Crear enlace de WhatsApp
    const urlWhatsApp = 'https://wa.me/' + telefono + '?text=' + mensajeCodificado;
    
    // Abrir WhatsApp en nueva pestaña
    window.open(urlWhatsApp, '_blank');
    
    return true;
}

/**
 * Envía notificación de cambio de estado a "Esperando Repuestos"
 * Formato exacto solicitado:
 * 'Estimado [Nombre], le informamos:
 * Estado Actual: Esperando Repuestos.
 * Su vehículo [Patente] se encuentra pausado hasta la llegada de los insumos necesarios. Le avisaremos apenas reanudemos.'
 */
function enviarWhatsAppEsperaRepuestos(orden) {
    let telefono = orden.cliente.telefono.replace(/\D/g, '');
    
    // Asegurar código de país
    if (telefono.startsWith('9') && telefono.length === 9) {
        telefono = '56' + telefono;
    } else if (!telefono.startsWith('56')) {
        telefono = '56' + telefono;
    }
    
    const mensaje = 'Estimado ' + orden.cliente.nombre + ', le informamos:\n\n' +
        '*Estado Actual:* Esperando Repuestos.\n\n' +
        'Su vehículo ' + orden.vehiculo.patente + ' se encuentra pausado hasta la llegada de los insumos necesarios. Le avisaremos apenas reanudemos.';
    
    const urlWhatsApp = 'https://wa.me/' + telefono + '?text=' + encodeURIComponent(mensaje);
    window.open(urlWhatsApp, '_blank');
    return true;
}

/**
 * Envía notificación de "Listo para Entrega"
 * Formato exacto solicitado:
 * 'Buenas noticias [Nombre]!
 * Estado: Listo para Entrega.
 * Su vehículo [Patente] ya está reparado. Puede pasar a retirarlo al taller.'
 */
function enviarWhatsAppListoEntrega(orden) {
    let telefono = orden.cliente.telefono.replace(/\D/g, '');
    
    // Asegurar código de país
    if (telefono.startsWith('9') && telefono.length === 9) {
        telefono = '56' + telefono;
    } else if (!telefono.startsWith('56')) {
        telefono = '56' + telefono;
    }
    
    const mensaje = 'Buenas noticias ' + orden.cliente.nombre + '!\n\n' +
        '*Estado:* Listo para Entrega.\n\n' +
        'Su vehículo ' + orden.vehiculo.patente + ' ya está reparado. Puede pasar a retirarlo al taller.';
    
    const urlWhatsApp = 'https://wa.me/' + telefono + '?text=' + encodeURIComponent(mensaje);
    window.open(urlWhatsApp, '_blank');
    return true;
}

/**
 * Envía recordatorio de mantención preventiva
 * Para clientes que no han venido en más de 6 meses
 */
function enviarRecordatorioMantencion(nombre, telefono, patente) {
    let numero = telefono.replace(/\D/g, '');
    
    // Asegurar código de país
    if (numero.startsWith('9') && numero.length === 9) {
        numero = '56' + numero;
    } else if (!numero.startsWith('56')) {
        numero = '56' + numero;
    }
    
    const mensaje = 'Estimado ' + nombre + ', le saluda el equipo de *Taller Pro.*\n\n' +
        'Notamos que su vehículo ' + (patente ? 'patente ' + patente + ' ' : '') + 'no ha tenido revisión en los últimos 6 meses.\n\n' +
        'Le recomendamos agendar una *revisión preventiva* para mantener su auto en óptimas condiciones.\n\n' +
        'Contáctenos para agendar una hora. ¡Le esperamos!';
    
    const urlWhatsApp = 'https://wa.me/' + numero + '?text=' + encodeURIComponent(mensaje);
    window.open(urlWhatsApp, '_blank');
    mostrarToast('Recordatorio de mantención enviado', 'success');
    return true;
}

/**
 * Envía notificación de "En Reparación"
 * Formato: Informa al cliente que se iniciaron los trabajos
 */
function enviarWhatsAppEnReparacion(orden) {
    let telefono = orden.cliente.telefono.replace(/\D/g, '');
    
    // Asegurar código de país
    if (telefono.startsWith('9') && telefono.length === 9) {
        telefono = '56' + telefono;
    } else if (!telefono.startsWith('56')) {
        telefono = '56' + telefono;
    }
    
    const mensaje = 'Estimado ' + orden.cliente.nombre + ', le informamos:\n\n' +
        '*Estado Actual:* En Reparación.\n\n' +
        'Su vehículo ' + orden.vehiculo.patente + ' está siendo atendido por nuestro equipo de mecánicos. Le mantendremos informado del avance.';
    
    const urlWhatsApp = 'https://wa.me/' + telefono + '?text=' + encodeURIComponent(mensaje);
    window.open(urlWhatsApp, '_blank');
    return true;
}

// ============================================
// BUSCADOR INTELIGENTE POR PATENTE
// ============================================

/**
 * Inicializa el buscador inteligente por patente en Nueva Orden
 */
function inicializarBuscadorPatente() {
    const inputBusqueda = document.getElementById('buscarPatenteNuevaOrden');
    const resultadoDiv = document.getElementById('resultadoBusquedaPatente');
    
    if (!inputBusqueda) return;
    
    inputBusqueda.addEventListener('input', (e) => {
        const patente = e.target.value.trim().toUpperCase();
        
        if (patente.length < 3) {
            resultadoDiv.innerHTML = '';
            resultadoDiv.classList.remove('activo');
            return;
        }
        
        // Buscar órdenes con esa patente
        const ordenesEncontradas = ordenes.filter(o => 
            o.vehiculo.patente.toUpperCase().includes(patente)
        );
        
        if (ordenesEncontradas.length > 0) {
            mostrarResultadosBusquedaPatente(ordenesEncontradas, patente, resultadoDiv);
        } else {
            resultadoDiv.innerHTML = '<div class="busqueda-sin-resultados">No se encontraron vehículos con esa patente</div>';
            resultadoDiv.classList.add('activo');
        }
    });
    
    // Cerrar resultados al hacer clic fuera
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.buscador-patente-container')) {
            resultadoDiv.innerHTML = '';
            resultadoDiv.classList.remove('activo');
        }
    });
}

/**
 * Muestra los resultados de búsqueda por patente
 */
function mostrarResultadosBusquedaPatente(ordenesEncontradas, patenteBuscada, contenedor) {
    // Tomar la orden más reciente para autocompletar
    const ordenMasReciente = ordenesEncontradas[0];
    
    // Calcular historial de reparaciones
    const historialHTML = ordenesEncontradas.map(orden => {
        const fecha = new Date(orden.fecha_ingreso).toLocaleDateString('es-CL');
        const monto = orden.presupuesto ? '$' + orden.presupuesto.toLocaleString('es-CL') : 'Sin presupuesto';
        return `
            <div class="historial-item">
                <span class="historial-fecha">${fecha}</span>
                <span class="historial-falla">${orden.falla_declarada.substring(0, 30)}${orden.falla_declarada.length > 30 ? '...' : ''}</span>
                <span class="historial-monto">${monto}</span>
            </div>
        `;
    }).join('');
    
    const totalGastado = ordenesEncontradas.reduce((sum, o) => sum + (o.presupuesto || 0), 0);
    
    contenedor.innerHTML = `
        <div class="resultado-busqueda-contenido">
            <div class="resultado-header">
                <h4>Vehículo encontrado: ${ordenMasReciente.vehiculo.patente}</h4>
                <button class="btn-autocompletar" onclick="autocompletarDesdePatente('${ordenMasReciente.vehiculo.patente}')">
                    <i class="fas fa-magic"></i> Autocompletar Datos
                </button>
            </div>
            <div class="resultado-info">
                <p><strong>Cliente:</strong> ${ordenMasReciente.cliente.nombre}</p>
                <p><strong>Teléfono:</strong> ${ordenMasReciente.cliente.telefono}</p>
                <p><strong>Vehículo:</strong> ${ordenMasReciente.vehiculo.marca}</p>
                <p><strong>Total visitas:</strong> ${ordenesEncontradas.length}</p>
                <p><strong>Total gastado:</strong> $${totalGastado.toLocaleString('es-CL')}</p>
            </div>
            <div class="resultado-historial">
                <h5>Historial de Reparaciones:</h5>
                ${historialHTML}
            </div>
        </div>
    `;
    contenedor.classList.add('activo');
}

/**
 * Autocompleta el formulario con datos de una patente existente
 */
function autocompletarDesdePatente(patente) {
    const orden = ordenes.find(o => o.vehiculo.patente.toUpperCase() === patente.toUpperCase());
    if (!orden) return;
    
    // Autocompletar datos del cliente
    document.getElementById('clienteNombre').value = orden.cliente.nombre || '';
    document.getElementById('clienteTelefono').value = orden.cliente.telefono || '';
    document.getElementById('clienteRut').value = orden.cliente.rut || '';
    
    // Autocompletar datos del vehículo
    document.getElementById('vehiculoPatente').value = orden.vehiculo.patente || '';
    document.getElementById('vehiculoMarca').value = orden.vehiculo.marca || '';
    
    // Limpiar resultado de búsqueda
    const resultadoDiv = document.getElementById('resultadoBusquedaPatente');
    if (resultadoDiv) {
        resultadoDiv.innerHTML = '';
        resultadoDiv.classList.remove('activo');
    }
    
    mostrarToast('Datos autocompletados. Complete la nueva falla.', 'success');
    
    // Enfocar el campo de falla
    const fallaInput = document.getElementById('fallaDeclarada');
    if (fallaInput) fallaInput.focus();
}

// ============================================
// UTILIDADES
// ============================================
function guardarEnLocalStorage() {
    localStorage.setItem('taller_ordenes', JSON.stringify(ordenes));
}

function mostrarToast(mensaje, tipo = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${tipo}`;
    
    const iconos = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
    
    toast.innerHTML = `<i class="fas ${iconos[tipo]}"></i><span>${mensaje}</span>`;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ============================================
// GASTOS DEL TALLER
// ============================================

let gastos = [];

/**
 * Abre el modal para agregar un nuevo gasto
 */
function abrirModalGasto() {
    if (!tienePermiso('puedeVerReportes')) {
        mostrarToast('No tienes permiso para registrar gastos', 'error');
        return;
    }
    
    // Establecer fecha actual por defecto
    const fechaInput = document.getElementById('gastoFecha');
    if (fechaInput) fechaInput.valueAsDate = new Date();
    
    document.getElementById('modalGasto').classList.add('active');
}

/**
 * Cierra el modal de gastos
 */
function cerrarModalGasto() {
    document.getElementById('modalGasto').classList.remove('active');
    document.getElementById('formGasto').reset();
}

/**
 * Guarda un nuevo gasto
 */
async function guardarGasto(e) {
    e.preventDefault();
    
    const descripcion = document.getElementById('gastoDescripcion').value.trim();
    const monto = parseInt(document.getElementById('gastoMonto').value) || 0;
    const categoria = document.getElementById('gastoCategoria').value;
    const fecha = document.getElementById('gastoFecha').value || new Date().toISOString().split('T')[0];
    
    // En Supabase, normalmente `id` (uuid) y `created_at` los genera la BD.
    // En modo local/demo seguimos generando un id simple.
    const gastoLocal = {
        id: Date.now().toString(),
        descripcion,
        monto,
        categoria,
        fecha,
        creado_por: usuarioActual?.id || null,
        created_at: new Date().toISOString()
    };
    
    try {
        if (supabaseCliente) {
            const gastoSupabase = {
                descripcion,
                monto,
                categoria,
                fecha,
                // Si vienes de una "sesión demo" guardada en localStorage,
                // ese id NO es UUID y rompe la columna uuid.
                creado_por: obtenerUsuarioUuidO_null()
            };
            const { data, error } = await supabaseCliente
                .from('gastos')
                .insert([gastoSupabase])
                .select();
            
            if (error) throw error;
            gastos.unshift(data[0]);
        } else {
            gastos.unshift(gastoLocal);
            localStorage.setItem('taller_gastos', JSON.stringify(gastos));
        }
        
        mostrarToast('Gasto registrado correctamente', 'success');
        cerrarModalGasto();
        actualizarDashboardGastos();
        
    } catch (error) {
        console.error('Error al guardar gasto:', error);
        mostrarToast('Error al guardar el gasto', 'error');
    }
}

/**
 * Carga los gastos desde Supabase o localStorage
 */
async function cargarGastos() {
    try {
        if (supabaseCliente) {
            const { data, error } = await supabaseCliente
                .from('gastos')
                .select('*')
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            gastos = data || [];
        } else {
            const guardados = localStorage.getItem('taller_gastos');
            gastos = guardados ? JSON.parse(guardados) : [];
        }
        
        actualizarDashboardGastos();
        
    } catch (error) {
        console.error('Error al cargar gastos:', error);
    }
}

/**
 * Actualiza el dashboard de gastos y calcula la utilidad real
 */
function actualizarDashboardGastos() {
    const hoy = new Date();
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const inicioDia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    
    // Calcular gastos del día
    const gastosDia = gastos
        .filter(g => {
            const fechaGasto = new Date(g.fecha);
            return fechaGasto >= inicioDia;
        })
        .reduce((sum, g) => sum + (g.monto || 0), 0);
    
    // Calcular gastos del mes
    const gastosMes = gastos
        .filter(g => new Date(g.fecha) >= inicioMes)
        .reduce((sum, g) => sum + (g.monto || 0), 0);
    
    // Calcular ingresos del día y mes (usa monto_total_cobrado si existe; fallback presupuesto)
    const ordenesEntregadas = ordenes.filter(o => o.estado === 'entregado' && o.pagado === true);

    const montoCobradoOrden = (o) => {
        const cobrado = Number(o.monto_total_cobrado || 0);
        if (cobrado > 0) return cobrado;
        return Number(o.presupuesto || 0);
    };

    const pagoMecanicoOrden = (o) => Number(o.pago_mecanico || 0);
    const fechaOrden = (o) => new Date(o.fecha_entrega || o.updated_at || o.created_at || o.fecha_ingreso);
    
    const ingresosDia = ordenesEntregadas
        .filter(o => fechaOrden(o) >= inicioDia)
        .reduce((sum, o) => sum + montoCobradoOrden(o), 0);
    
    const ingresosMes = ordenesEntregadas
        .filter(o => fechaOrden(o) >= inicioMes)
        .reduce((sum, o) => sum + montoCobradoOrden(o), 0);

    // Pagos mecánicos del día/mes (para descontar de utilidad si corresponde)
    const pagosMecanicosDia = ordenesEntregadas
        .filter(o => fechaOrden(o) >= inicioDia)
        .reduce((sum, o) => sum + pagoMecanicoOrden(o), 0);
    const pagosMecanicosMes = ordenesEntregadas
        .filter(o => fechaOrden(o) >= inicioMes)
        .reduce((sum, o) => sum + pagoMecanicoOrden(o), 0);
    
    // Calcular utilidad real (ingresos - gastos - pagos mecánicos)
    const utilidadDia = ingresosDia - gastosDia - pagosMecanicosDia;
    const utilidadMes = ingresosMes - gastosMes - pagosMecanicosMes;
    
    // Actualizar elementos del DOM
    const gastosDiaEl = document.getElementById('gastosDia');
    const gastosMesEl = document.getElementById('gastosMes');
    const utilidadEl = document.getElementById('utilidadReal');
    
    if (gastosDiaEl) gastosDiaEl.textContent = '$' + gastosDia.toLocaleString('es-CL');
    if (gastosMesEl) gastosMesEl.textContent = '$' + gastosMes.toLocaleString('es-CL');
    if (utilidadEl) {
        utilidadEl.textContent = '$' + utilidadMes.toLocaleString('es-CL');
        utilidadEl.className = 'utilidad-monto ' + (utilidadMes >= 0 ? 'positiva' : 'negativa');
    }

    // Breakdown del día: ganancias por auto y pagos a mecánicos
    const gananciasListaEl = document.getElementById('gananciasLista');
    const gananciasTotalEl = document.getElementById('gananciasTotal');
    const pagosListaEl = document.getElementById('pagosMecanicosLista');
    const pagosTotalEl = document.getElementById('pagosMecanicosTotal');

    if (gananciasListaEl && pagosListaEl) {
        const ordenesHoy = ordenesEntregadas
            .filter(o => fechaOrden(o) >= inicioDia)
            .sort((a, b) => fechaOrden(b) - fechaOrden(a));

        const gananciasTotal = ordenesHoy.reduce((sum, o) => sum + montoCobradoOrden(o), 0);
        const pagosTotal = ordenesHoy.reduce((sum, o) => sum + pagoMecanicoOrden(o), 0);

        if (gananciasTotalEl) gananciasTotalEl.textContent = '$' + gananciasTotal.toLocaleString('es-CL');
        if (pagosTotalEl) pagosTotalEl.textContent = '$' + pagosTotal.toLocaleString('es-CL');

        if (ordenesHoy.length === 0) {
            gananciasListaEl.innerHTML = '<p class="sin-gastos">Sin ingresos registrados hoy</p>';
            pagosListaEl.innerHTML = '<p class="sin-gastos">Sin pagos registrados hoy</p>';
        } else {
            gananciasListaEl.innerHTML = ordenesHoy.map(o => {
                const patente = o.vehiculo?.patente || o.vehiculo_patente || '-';
                const mecanicoId = o.mecanico_asignado || null;
                const mecanico = mecanicoId ? (mecanicosLista.find(m => m.id === mecanicoId) || usuariosSistema.find(u => u.id === mecanicoId)) : null;
                const mecanicoNombre = mecanico?.nombre || '-';
                return `
                    <div class="breakdown-item">
                        <div class="breakdown-left">
                            <span class="breakdown-patente">${patente}</span>
                            <span class="breakdown-sub">${mecanicoNombre}</span>
                        </div>
                        <span class="breakdown-amount positive">+$${montoCobradoOrden(o).toLocaleString('es-CL')}</span>
                    </div>
                `;
            }).join('');

            pagosListaEl.innerHTML = ordenesHoy.map(o => {
                const patente = o.vehiculo?.patente || o.vehiculo_patente || '-';
                const mecanicoId = o.mecanico_asignado || null;
                const mecanico = mecanicoId ? (mecanicosLista.find(m => m.id === mecanicoId) || usuariosSistema.find(u => u.id === mecanicoId)) : null;
                const mecanicoNombre = mecanico?.nombre || '-';
                const pago = pagoMecanicoOrden(o);
                return `
                    <div class="breakdown-item">
                        <div class="breakdown-left">
                            <span class="breakdown-patente">${patente}</span>
                            <span class="breakdown-sub">${mecanicoNombre}</span>
                        </div>
                        <span class="breakdown-amount negative">-$${pago.toLocaleString('es-CL')}</span>
                    </div>
                `;
            }).join('');
        }
    }
    
    // Actualizar lista de gastos recientes
    actualizarListaGastos();
}

/**
 * Actualiza la lista de gastos recientes en el dashboard
 */
function actualizarListaGastos() {
    const contenedor = document.getElementById('gastosLista');
    if (!contenedor) return;
    
    const gastosRecientes = gastos.slice(0, 5);
    
    if (gastosRecientes.length === 0) {
        contenedor.innerHTML = '<p class="sin-gastos">No hay gastos registrados recientemente</p>';
        return;
    }
    
    const categoriasLabels = {
        repuestos: 'Repuestos',
        aceite: 'Aceite y Lubricantes',
        herramientas: 'Herramientas',
        insumos: 'Insumos Taller',
        servicios: 'Servicios',
        otros: 'Otros'
    };
    
    contenedor.innerHTML = gastosRecientes.map(gasto => `
        <div class="gasto-lista-item" data-gasto-id="${gasto.id}">
            <div class="gasto-lista-info">
                <span class="gasto-lista-desc">${gasto.descripcion}</span>
                <span class="gasto-lista-cat">${categoriasLabels[gasto.categoria] || gasto.categoria}</span>
            </div>
            <div style="display:flex; align-items:center; gap: var(--spacing-sm);">
                <span class="gasto-lista-monto">-$${gasto.monto.toLocaleString('es-CL')}</span>
                <button class="btn-borrar-gasto" type="button" title="Borrar gasto" onclick="borrarGasto('${gasto.id}')">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

async function borrarGasto(gastoId) {
    if (!tienePermiso('puedeVerReportes')) {
        mostrarToast('No tienes permiso para borrar gastos', 'error');
        return;
    }
    if (!confirm('¿Borrar este gasto?')) return;

    try {
        if (supabaseCliente) {
            const { error } = await supabaseCliente
                .from('gastos')
                .delete()
                .eq('id', gastoId);
            if (error) throw error;
        }

        gastos = gastos.filter(g => g.id !== gastoId);
        localStorage.setItem('taller_gastos', JSON.stringify(gastos));
        mostrarToast('Gasto borrado', 'success');
        actualizarDashboardGastos();
    } catch (error) {
        console.error('Error al borrar gasto:', error);
        mostrarToast('Error al borrar gasto: ' + (error.message || ''), 'error');
    }
}

// ============================================
// DASHBOARD ADMIN - FUNCIONES
// ============================================

async function cargarDashboardAdmin() {
    if (!tienePermiso('puedeVerReportes')) return;
    
    // En paralelo para que la sección cargue más rápido
    await Promise.allSettled([
        cargarIngresosDashboard(),
        cargarTrabajadoresDashboard(),
        cargarClientesDashboard(),
        cargarInventarioDashboard()
    ]);
}

async function cargarIngresosDashboard() {
    try {
        const hoy = new Date();
        const inicioDia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
        const hace7Dias = new Date(inicioDia);
        hace7Dias.setDate(inicioDia.getDate() - 6); // últimos 7 días incluyendo hoy

        const ordenesPagadas = ordenes.filter(o => o.estado === 'entregado' && o.pagado === true);
        const ordenesPendientes = ordenes.filter(o => o.estado === 'listo' && o.pagado !== true);

        const montoOrden = (o) => {
            const cobrado = Number(o.monto_total_cobrado || 0);
            if (cobrado > 0) return cobrado;
            const presupuesto = Number(o.presupuesto || 0);
            return presupuesto > 0 ? presupuesto : 0;
        };

        const fechaTransaccion = (o) => new Date(o.fecha_entrega || o.updated_at || o.created_at || o.fecha_ingreso);

        const totalIngresos = ordenesPagadas.reduce((sum, o) => sum + montoOrden(o), 0);
        const ingresosDia = ordenesPagadas
            .filter(o => fechaTransaccion(o) >= inicioDia)
            .reduce((sum, o) => sum + montoOrden(o), 0);
        const ingresosSemana = ordenesPagadas
            .filter(o => fechaTransaccion(o) >= hace7Dias)
            .reduce((sum, o) => sum + montoOrden(o), 0);

        // Nómina pendiente: suma de comisiones/sueldos aún no liquidados
        const costoNominaPendiente = ordenesPagadas
            .filter(o => (o.estado_pago || 'pendiente') !== 'liquidado')
            .reduce((sum, o) => sum + Number(o.pago_mecanico || 0), 0);
        
        // Actualizar tarjetas de resumen
        const totalEl = document.getElementById('ingresosTotal');
        const semanaEl = document.getElementById('ingresosSemanaActual');
        const diaEl = document.getElementById('ingresosDia');
        const ordenesPagadasEl = document.getElementById('ordenesPagadas');
        const ordenesPendientesEl = document.getElementById('ordenesPendientes');
        const nominaEl = document.getElementById('costoNomina');
        
        if (totalEl) totalEl.textContent = '$' + totalIngresos.toLocaleString('es-CL');
        if (diaEl) diaEl.textContent = '$' + ingresosDia.toLocaleString('es-CL');
        if (semanaEl) semanaEl.textContent = '$' + ingresosSemana.toLocaleString('es-CL');
        if (ordenesPagadasEl) ordenesPagadasEl.textContent = ordenesPagadas.length;
        if (ordenesPendientesEl) ordenesPendientesEl.textContent = ordenesPendientes.length;
        if (nominaEl) nominaEl.textContent = '$' + costoNominaPendiente.toLocaleString('es-CL');
        
        // Actualizar tabla de detalle
        renderizarTablaIngresos([...ordenesPagadas, ...ordenesPendientes]);
        
    } catch (error) {
        console.error('Error en cargarIngresosDashboard:', error);
    }
}

/**
 * Renderiza la tabla de ingresos en la sección de Ingresos
 */
function renderizarTablaIngresos(ordenes) {
    const tbody = document.getElementById('ingresosTableBody');
    if (!tbody) return;
    
    if (ordenes.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" class="text-center">
                    <div class="empty-state" style="padding: 2rem;">
                        <i class="fas fa-receipt"></i>
                        <p>No hay ingresos registrados</p>
                        <small>Los ingresos se agregarán automáticamente al confirmar cobros</small>
                    </div>
                </td>
            </tr>
        `;
        return;
    }
    
    tbody.innerHTML = ordenes.map(orden => {
        const montoCobrado = Number(orden.monto_total_cobrado || 0) > 0
            ? Number(orden.monto_total_cobrado)
            : Number(orden.presupuesto || 0);
        const pagoMecanico = Number(orden.pago_mecanico || 0);
        const fecha = orden.fecha_entrega 
            ? new Date(orden.fecha_entrega).toLocaleDateString('es-CL')
            : new Date(orden.updated_at || orden.created_at).toLocaleDateString('es-CL');
        
        const patente = orden.vehiculo?.patente || orden.vehiculo_patente || '-';
        const servicio = (orden.falla_declarada || orden.falla_detalle || orden.descripcion || 'Servicio').toString();

        const mecanicoId = orden.mecanico_asignado || null;
        const mecanico = mecanicoId ? (mecanicosLista.find(m => m.id === mecanicoId) || usuariosSistema.find(u => u.id === mecanicoId)) : null;
        const mecanicoNombre = mecanico?.nombre || mecanico?.email || '-';

        const estadoPago = (orden.estado_pago || 'pendiente').toString();
        const liquidacion = (estadoPago === 'pagado' || estadoPago === 'liquidado') ? 'Pagado' : 'Pendiente';
        const liquidacionClass = (estadoPago === 'pagado' || estadoPago === 'liquidado') ? 'pagado' : 'pendiente';

        const metodoPago = (orden.metodo_pago || orden.metodoPago || 'efectivo').toString();
        const metodoLabels = {
            efectivo: 'Efectivo',
            transferencia: 'Transfer.',
            tarjeta: 'Tarjeta',
            otro: 'Otro'
        };
        
        return `
            <tr>
                <td>${fecha}</td>
                <td>${patente}</td>
                <td>${servicio}</td>
                <td>${mecanicoNombre}</td>
                <td>$${pagoMecanico.toLocaleString('es-CL')}</td>
                <td>$${montoCobrado.toLocaleString('es-CL')}</td>
                <td>${metodoLabels[metodoPago] || metodoPago}</td>
                <td><span class="estado-badge ${liquidacionClass}">${liquidacion}</span></td>
            </tr>
        `;
    }).join('');
}

function generarGraficoIngresos(ordenesEntregadas) {
    const container = document.getElementById('ingresosChart');
    if (!container) return;
    
    // Agrupar por semana (últimas 4 semanas)
    const semanas = [];
    const hoy = new Date();
    
    for (let i = 3; i >= 0; i--) {
        const inicioSemana = new Date(hoy);
        inicioSemana.setDate(hoy.getDate() - (hoy.getDay() + i * 7));
        const finSemana = new Date(inicioSemana);
        finSemana.setDate(inicioSemana.getDate() + 6);
        
        const ingresosSemana = ordenesEntregadas
            .filter(o => {
                const fecha = new Date(o.fecha_ingreso);
                return fecha >= inicioSemana && fecha <= finSemana;
            })
            .reduce((sum, o) => sum + (o.presupuesto || 0), 0);
        
        semanas.push({
            label: `S${4-i}`,
            valor: ingresosSemana,
            fecha: inicioSemana.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
        });
    }
    
    const maxValor = Math.max(...semanas.map(s => s.valor), 1);
    
    container.innerHTML = semanas.map(semana => {
        const altura = (semana.valor / maxValor) * 80;
        return `
            <div class="bar-item">
                <div class="bar" style="height: ${altura + 20}px;">
                    <span class="bar-value">$${(semana.valor / 1000).toFixed(0)}k</span>
                </div>
                <span class="bar-label">${semana.label}</span>
            </div>
        `;
    }).join('');
}

async function cargarTrabajadoresDashboard() {
    const container = document.getElementById('trabajadoresList');
    if (!container) return;
    
    // Filtrar solo mecánicos
    const mecanicos = usuariosSistema.filter(u => u.rol === ROLES.MECANICO);
    
    if (mecanicos.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding: var(--spacing-md);">
                <i class="fas fa-hard-hat" style="font-size: 2rem;"></i>
                <p style="font-size: 0.9rem;">No hay mecánicos registrados</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = mecanicos.map(mecanico => {
        // Contar órdenes asignadas a este mecánico
        const ordenesAsignadas = ordenes.filter(o => o.mecanico_asignado === mecanico.id).length;
        const iniciales = mecanico.nombre.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
        
        return `
            <div class="trabajador-item">
                <div class="trabajador-avatar">${iniciales}</div>
                <div class="trabajador-info">
                    <h4>${mecanico.nombre}</h4>
                    <p>Mecánico</p>
                </div>
                <div class="trabajador-stats">
                    <span class="numero">${ordenesAsignadas}</span>
                    <span class="label">Autos</span>
                </div>
            </div>
        `;
    }).join('');
}

async function cargarClientesDashboard() {
    // Agrupar órdenes por cliente
    const clientesMap = {};
    
    ordenes.forEach(orden => {
        const key = orden.cliente.telefono; // Usar teléfono como identificador único
        if (!clientesMap[key]) {
            clientesMap[key] = {
                nombre: orden.cliente.nombre,
                telefono: orden.cliente.telefono,
                visitas: 0,
                totalGastado: 0
            };
        }
        clientesMap[key].visitas++;
        clientesMap[key].totalGastado += orden.presupuesto || 0;
    });
    
    clientesData = Object.values(clientesMap).sort((a, b) => b.totalGastado - a.totalGastado);
    
    renderizarClientes(clientesData);
}

function renderizarClientes(clientes) {
    const container = document.getElementById('clientesList');
    if (!container) return;
    
    const clientesTop = clientes.slice(0, 5); // Mostrar top 5
    
    if (clientesTop.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding: var(--spacing-md);">
                <i class="fas fa-users" style="font-size: 2rem;"></i>
                <p style="font-size: 0.9rem;">No hay clientes registrados</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = clientesTop.map(cliente => {
        const iniciales = cliente.nombre.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
        
        return `
            <div class="cliente-item">
                <div class="cliente-icon">${iniciales}</div>
                <div class="cliente-info">
                    <h4>${cliente.nombre}</h4>
                    <p>${cliente.telefono}</p>
                </div>
                <div class="cliente-gasto">
                    <span class="monto">$${cliente.totalGastado.toLocaleString('es-CL')}</span>
                    <span class="visitas">${cliente.visitas} visitas</span>
                </div>
            </div>
        `;
    }).join('');
}

function filtrarClientes(e) {
    const busqueda = e.target.value.toLowerCase();
    const filtrados = clientesData.filter(c => 
        c.nombre.toLowerCase().includes(busqueda) || 
        c.telefono.includes(busqueda)
    );
    renderizarClientes(filtrados);
}

// ============================================
// INVENTARIO DE REPUESTOS
// ============================================

async function cargarInventarioDashboard() {
    // Cargar inventario desde localStorage (o Supabase si está configurado)
    const guardado = localStorage.getItem('taller_inventario');
    inventario = guardado ? JSON.parse(guardado) : [
        { id: 1, nombre: 'Aceite 10W-40', stock: 15, minimo: 5 },
        { id: 2, nombre: 'Filtro de Aceite', stock: 8, minimo: 10 },
        { id: 3, nombre: 'Pastillas de Freno', stock: 3, minimo: 5 },
        { id: 4, nombre: 'Filtro de Aire', stock: 12, minimo: 8 }
    ];
    
    renderizarInventario();
}

function renderizarInventario() {
    const tbody = document.getElementById('inventarioBody');
    const alertsContainer = document.getElementById('inventarioAlerts');
    
    if (!tbody) return;
    
    // Verificar alertas de stock bajo
    const alertas = inventario.filter(item => item.stock <= item.minimo);
    
    if (alertsContainer) {
        if (alertas.length > 0) {
            alertsContainer.innerHTML = alertas.map(item => {
                const nivel = item.stock === 0 ? 'crítico' : 'bajo';
                const icono = item.stock === 0 ? 'fa-exclamation-circle' : 'fa-exclamation-triangle';
                return `
                    <div class="alert-stock">
                        <i class="fas ${icono}"></i>
                        <span>Stock ${nivel}: ${item.nombre} (${item.stock} unidades)</span>
                    </div>
                `;
            }).join('');
        } else {
            alertsContainer.innerHTML = `
                <div class="alert-stock" style="background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.3); color: #34d399;">
                    <i class="fas fa-check-circle"></i>
                    <span>Todo el inventario está en niveles normales</span>
                </div>
            `;
        }
    }
    
    // Renderizar tabla
    tbody.innerHTML = inventario.map(item => {
        let estadoClass = 'stock-ok';
        let estadoText = 'OK';
        
        if (item.stock === 0) {
            estadoClass = 'stock-critico';
            estadoText = 'CRÍTICO';
        } else if (item.stock <= item.minimo) {
            estadoClass = 'stock-bajo';
            estadoText = 'BAJO';
        }
        
        return `
            <tr>
                <td>${item.nombre}</td>
                <td>${item.stock}</td>
                <td>${item.minimo}</td>
                <td><span class="stock-badge ${estadoClass}">${estadoText}</span></td>
            </tr>
        `;
    }).join('');
}

function abrirModalRepuesto() {
    if (!tienePermiso('puedeCrearUsuarios')) {
        mostrarToast('No tienes permiso para gestionar inventario', 'error');
        return;
    }
    document.getElementById('modalRepuesto').classList.add('active');
}

function cerrarModalRepuesto() {
    document.getElementById('modalRepuesto').classList.remove('active');
    document.getElementById('formRepuesto').reset();
}

function guardarRepuesto(e) {
    e.preventDefault();
    
    const nuevoRepuesto = {
        id: Date.now(),
        nombre: document.getElementById('repuestoNombre').value.trim(),
        stock: parseInt(document.getElementById('repuestoStock').value) || 0,
        minimo: parseInt(document.getElementById('repuestoMinimo').value) || 5
    };
    
    inventario.push(nuevoRepuesto);
    localStorage.setItem('taller_inventario', JSON.stringify(inventario));
    
    mostrarToast('Repuesto agregado correctamente', 'success');
    cerrarModalRepuesto();
    renderizarInventario();
}

/**
 * ============================================
 * CONFIGURACIÓN DE SUPABASE - INSTRUCCIONES
 * ============================================
 * 
 * 1. CREAR TABLA "profiles" EN SUPABASE:
 * 
 * CREATE TABLE profiles (
 *     id UUID REFERENCES auth.users(id) PRIMARY KEY,
 *     nombre TEXT NOT NULL,
 *     email TEXT NOT NULL UNIQUE,
 *     rol TEXT NOT NULL CHECK (rol IN ('admin', 'jefe', 'mecanico')),
 *     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 * );
 * 
 * 2. HABILITAR ROW LEVEL SECURITY (RLS):
 * 
 * ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
 * 
 * 3. CREAR POLÍTICAS DE SEGURIDAD:
 * 
 * -- Permitir lectura a usuarios autenticados
 * CREATE POLICY "Profiles are viewable by authenticated users"
 *     ON profiles FOR SELECT
 *     TO authenticated
 *     USING (true);
 * 
 * -- Permitir actualización solo del propio perfil
 * CREATE POLICY "Users can update own profile"
 *     ON profiles FOR UPDATE
 *     TO authenticated
 *     USING (auth.uid() = id);
 * 
 * -- Permitir inserción solo a admins
 * CREATE POLICY "Only admins can insert profiles"
 *     ON profiles FOR INSERT
 *     TO authenticated
 *     WITH CHECK (
 *         EXISTS (
 *             SELECT 1 FROM profiles 
 *             WHERE id = auth.uid() AND rol = 'admin'
 *         )
 *     );
 * 
 * 4. CREAR FUNCIÓN PARA NUEVO USUARIO:
 * 
 * CREATE OR REPLACE FUNCTION public.handle_new_user()
 * RETURNS TRIGGER AS $$
 * BEGIN
 *     INSERT INTO public.profiles (id, nombre, email, rol)
 *     VALUES (
 *         NEW.id,
 *         COALESCE(NEW.raw_user_meta_data->>'nombre', NEW.email),
 *         NEW.email,
 *         COALESCE(NEW.raw_user_meta_data->>'rol', 'mecanico')
 *     );
 *     RETURN NEW;
 * END;
 * $$ LANGUAGE plpgsql SECURITY DEFINER;
 * 
 * -- Trigger para crear perfil automáticamente
 * CREATE TRIGGER on_auth_user_created
 *     AFTER INSERT ON auth.users
 *     FOR EACH ROW
 *     EXECUTE FUNCTION public.handle_new_user();
 * 
 * 5. ACTUALIZAR TABLA "ordenes" PARA ASIGNACIÓN:
 * 
 * ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS creado_por UUID REFERENCES profiles(id);
 * ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS mecanico_asignado UUID REFERENCES profiles(id);
 * ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS actualizado_por UUID REFERENCES profiles(id);
 * 
 * ============================================
 * ROLES Y PERMISOS:
 * ============================================
 * 
 * ADMIN (Dueño):
 *   - Acceso total al sistema
 *   - Crear/eliminar usuarios
 *   - Ver reportes financieros
 *   - Editar/eliminar cualquier orden
 * 
 * JEFE (Jefe de Taller):
 *   - Crear órdenes
 *   - Asignar mecánicos
 *   - Cambiar estados
 *   - Ver todas las órdenes
 *   - Ver presupuestos
 * 
 * MECANICO:
 *   - Ver órdenes asignadas a él
 *   - Actualizar progreso
 *   - Agregar repuestos usados
 *   - NO ver presupuestos totales
 *   - NO eliminar órdenes
 */
