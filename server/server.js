const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const initSqlJs = require("sql.js");

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      imgSrc: ["'self'", "data:"],
    },
  },
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  originAgentCluster: false,
}));
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CAMBIAR_ME_POR_UNA_FRase_SEGURA";

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "taller.sqlite");
let db = null;
let SQL = null;

const ENTITIES = {
  clientes: {
    table: "clientes",
    display: (r) => `${r.nombre}${r.telefono ? " - " + r.telefono : ""}`,
    tableColumns: ["nombre", "telefono", "email"],
    fields: [
      { key: "nombre", label: "Nombre", type: "text", required: true },
      { key: "telefono", label: "Teléfono", type: "text" },
      { key: "email", label: "Email", type: "text" },
      { key: "direccion", label: "Dirección", type: "text" },
      { key: "notas", label: "Notas", type: "textarea" },
    ],
  },
  vehiculos: {
    table: "vehiculos",
    display: (r) => `${r.placa || "Sin placa"} - ${r.marca || ""} ${r.modelo || ""}`.trim(),
    tableColumns: ["placa", "marca", "modelo", "anio", "cliente_id"],
    fields: [
      { key: "cliente_id", label: "Cliente", type: "ref", ref: "clientes", required: true },
      { key: "marca", label: "Marca", type: "text" },
      { key: "modelo", label: "Modelo", type: "text" },
      { key: "anio", label: "Año", type: "number" },
      { key: "placa", label: "Placa", type: "text" },
      { key: "vin", label: "VIN", type: "text" },
      { key: "color", label: "Color", type: "text" },
    ],
  },
  servicios: {
    table: "servicios",
    display: (r) => `${r.nombre}`,
    tableColumns: ["nombre", "precio", "tiempo_estimado_min"],
    fields: [
      { key: "nombre", label: "Nombre", type: "text", required: true },
      { key: "descripcion", label: "Descripción", type: "textarea" },
      { key: "precio", label: "Precio", type: "number" },
      { key: "tiempo_estimado_min", label: "Tiempo (min)", type: "number" },
    ],
  },
  turnos: {
    table: "turnos",
    display: (r) => `${r.fecha_hora || ""} - ${r.estado || ""}`.trim(),
    tableColumns: ["fecha_hora", "estado", "cliente_id", "vehiculo_id", "servicio_id"],
    fields: [
      { key: "cliente_id", label: "Cliente", type: "ref", ref: "clientes", required: true },
      { key: "vehiculo_id", label: "Vehículo", type: "ref", ref: "vehiculos", required: true },
      { key: "servicio_id", label: "Servicio", type: "ref", ref: "servicios", required: true },
      { key: "fecha_hora", label: "Fecha y hora", type: "datetime", required: true },
      {
        key: "estado",
        label: "Estado",
        type: "select",
        required: true,
        options: ["Pendiente", "En progreso", "Completado", "Cancelado"],
      },
      { key: "notas", label: "Notas", type: "textarea" },
    ],
  },
  empleados: {
    table: "empleados",
    display: (r) => `${r.nombre}`,
    tableColumns: ["nombre", "puesto", "telefono", "activo"],
    fields: [
      { key: "nombre", label: "Nombre", type: "text", required: true },
      { key: "telefono", label: "Teléfono", type: "text" },
      { key: "puesto", label: "Puesto", type: "text" },
      { key: "activo", label: "Activo", type: "checkbox", default: 1 },
    ],
  },
  inventario: {
    table: "inventario",
    display: (r) => `${r.nombre} (${r.cantidad} ${r.unidad || ""})`.trim(),
    tableColumns: ["nombre", "categoria", "cantidad", "costo_unitario", "unidad"],
    fields: [
      { key: "nombre", label: "Nombre", type: "text", required: true },
      { key: "categoria", label: "Categoría", type: "text" },
      { key: "cantidad", label: "Cantidad", type: "number" },
      { key: "unidad", label: "Unidad", type: "text" },
      { key: "costo_unitario", label: "Costo unitario", type: "number" },
      { key: "ubicacion", label: "Ubicación", type: "text" },
    ],
  },
  reparaciones: {
    table: "reparaciones",
    display: (r) => `${r.fecha_inicio || ""} - ${r.estado || ""}`.trim(),
    tableColumns: ["fecha_inicio", "estado", "empleado_id", "cliente_id", "vehiculo_id", "costo_total"],
    fields: [
      { key: "cliente_id", label: "Cliente", type: "ref", ref: "clientes", required: true },
      { key: "vehiculo_id", label: "Vehículo", type: "ref", ref: "vehiculos", required: true },
      { key: "empleado_id", label: "Mecánico", type: "ref", ref: "empleados", required: true },
      { key: "descripcion_falla", label: "Descripción falla", type: "textarea" },
      { key: "reparacion_realizada", label: "Reparación realizada", type: "textarea" },
      { key: "fecha_inicio", label: "Fecha inicio", type: "date" },
      { key: "fecha_fin", label: "Fecha fin", type: "date" },
      {
        key: "estado",
        label: "Estado",
        type: "select",
        required: true,
        options: ["Abierta", "En progreso", "Terminada", "Cerrada"],
      },
      { key: "costo_total", label: "Costo total", type: "number" },
    ],
  },
  cotizaciones: {
    table: "cotizaciones",
    display: (r) => `${r.estado || ""} - ${r.costo_total || ""}`.trim(),
    tableColumns: ["created_at", "estado", "empleado_id", "cliente_id", "vehiculo_id", "costo_total"],
    fields: [
      { key: "cliente_id", label: "Cliente", type: "ref", ref: "clientes", required: true },
      { key: "vehiculo_id", label: "Vehículo", type: "ref", ref: "vehiculos", required: true },
      { key: "empleado_id", label: "Mecánico", type: "ref", ref: "empleados", required: true },
      { key: "recomendaciones", label: "Recomendaciones", type: "textarea", required: true },
      { key: "cambios", label: "Cambios sugeridos", type: "textarea", required: true },
      { key: "costo_total", label: "Costo total", type: "number", required: true },
    ],
  },
  ingresos_gastos: {
    table: "ingresos_gastos",
    display: (r) => `${r.tipo}: ${r.concepto}`.trim(),
    tableColumns: ["fecha", "tipo", "concepto", "monto"],
    fields: [
      { key: "tipo", label: "Tipo", type: "select", required: true, options: ["Ingreso", "Gasto"] },
      { key: "concepto", label: "Concepto", type: "text", required: true },
      { key: "monto", label: "Monto", type: "number", required: true },
      { key: "fecha", label: "Fecha", type: "date", required: true },
      { key: "nota", label: "Nota", type: "textarea" },
    ],
  },
};

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      empleado_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      telefono TEXT,
      email TEXT,
      direccion TEXT,
      notas TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vehiculos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL,
      marca TEXT,
      modelo TEXT,
      anio INTEGER,
      placa TEXT,
      vin TEXT,
      color TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS servicios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      descripcion TEXT,
      precio REAL,
      tiempo_estimado_min INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS turnos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL,
      vehiculo_id INTEGER NOT NULL,
      servicio_id INTEGER NOT NULL,
      fecha_hora TEXT NOT NULL,
      estado TEXT NOT NULL,
      notas TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
      FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE,
      FOREIGN KEY (servicio_id) REFERENCES servicios(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS empleados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      telefono TEXT,
      puesto TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventario (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      categoria TEXT,
      cantidad REAL,
      unidad TEXT,
      costo_unitario REAL,
      ubicacion TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reparaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL,
      vehiculo_id INTEGER NOT NULL,
      empleado_id INTEGER NOT NULL,
      descripcion_falla TEXT,
      reparacion_realizada TEXT,
      fecha_inicio TEXT,
      fecha_fin TEXT,
      estado TEXT NOT NULL,
      costo_total REAL,
      cotizacion_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
      FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE,
      FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cotizaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL,
      vehiculo_id INTEGER NOT NULL,
      empleado_id INTEGER NOT NULL,
      recomendaciones TEXT NOT NULL,
      cambios TEXT NOT NULL,
      costo_total REAL NOT NULL,
      estado TEXT NOT NULL DEFAULT 'Pendiente',
      approve_token TEXT NOT NULL UNIQUE,
      reject_token TEXT NOT NULL UNIQUE,
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
      FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE,
      FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ingresos_gastos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      concepto TEXT NOT NULL,
      monto REAL NOT NULL,
      fecha TEXT NOT NULL,
      nota TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function saveDb() {
  if (!db) return;
  const data = db.export(); // Uint8Array
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function rowsToObjects(result) {
  const cols = result.columns || [];
  const values = result.values || [];
  return values.map((row) => {
    const obj = {};
    cols.forEach((c, i) => {
      obj[c] = row[i];
    });
    return obj;
  });
}

function dbSelectAll(sqlQuery, params = []) {
  const res = db.exec(sqlQuery, params);
  if (!res || res.length === 0) return [];
  return rowsToObjects(res[0]);
}

function dbSelectOne(sqlQuery, params = []) {
  const all = dbSelectAll(sqlQuery, params);
  return all.length ? all[0] : null;
}

function getLastInsertId() {
  const res = db.exec("SELECT last_insert_rowid() AS id");
  if (!res || !res[0] || !res[0].values || !res[0].values.length) return null;
  return Number(res[0].values[0][0]);
}

function applyMigrations() {
  // sql.js throws on errors; we just ignore "already exists" failures.
  const statements = [
    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'",
    "ALTER TABLE users ADD COLUMN empleado_id INTEGER",
    "ALTER TABLE reparaciones ADD COLUMN empleado_id INTEGER",
    "ALTER TABLE reparaciones ADD COLUMN cotizacion_id INTEGER",
  ];
  for (const s of statements) {
    try {
      db.exec(s);
    } catch (e) {
      // Ignore if column/table already exists.
    }
  }
}

async function initSqlDb() {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, "node_modules", "sql.js", "dist", file),
  });

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(new Uint8Array(fileBuffer));
  } else {
    db = new SQL.Database();
  }

  initDb();
  applyMigrations();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor iniciado en puerto ${PORT}`);
    console.log(`URL: http://localhost:${PORT}`);
  });
}

initSqlDb().catch((e) => {
  console.error("Error iniciando BD:", e);
  process.exit(1);
});

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return res.status(401).json({ error: "No autorizado" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Token inválido" });
  }
}

function getEntityKeys() {
  return Object.keys(ENTITIES);
}

function sanitizeForClient(config) {
  // Removes backend-only functions from config.
  const out = {};
  for (const [key, val] of Object.entries(config)) {
    out[key] = {
      table: val.table,
      tableColumns: val.tableColumns,
      fields: val.fields.map((f) => {
        const copy = { ...f };
        delete copy.ref;
        // Keep select options for the UI.
        return copy;
      }),
      // We still keep the ref key in field definitions, because frontend needs it.
      fieldsWithRefs: val.fields.map((f) => ({ ...f })),
    };
  }
  return out;
}

function entityForApi() {
  const resObj = {};
  for (const [key, val] of Object.entries(ENTITIES)) {
    resObj[key] = {
      table: val.table,
      tableColumns: val.tableColumns,
      fields: val.fields.map((f) => ({ ...f })),
    };
  }
  return resObj;
}

app.get("/", (req, res) => res.redirect("/login.html"));

// Auth
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || typeof username !== "string" || username.trim().length < 3) {
    return res.status(400).json({ error: "Username inválido" });
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    return res.status(400).json({ error: "Password muy corta (mínimo 6)" });
  }

  const usernameTrim = username.trim();
  const hash = await bcrypt.hash(password, 10);
  try {
    db.run("INSERT INTO users (username, password_hash, role, empleado_id) VALUES (?, ?, 'admin', NULL)", [
      usernameTrim,
      hash,
    ]);
    const userId = getLastInsertId();
    saveDb();
    return res.json({ ok: true, userId, username: usernameTrim });
  } catch (e) {
    if (String(e && e.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "El usuario ya existe" });
    }
    return res.status(500).json({ error: "Error al registrar" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Datos faltantes" });

  const user = dbSelectOne("SELECT * FROM users WHERE username = ?", [String(username).trim()]);
  if (!user) return res.status(401).json({ error: "Credenciales inválidas" });

  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role || "admin", empleado_id: user.empleado_id || null },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
  return res.json({
    ok: true,
    token,
    username: user.username,
    role: user.role || "admin",
  });
});

app.get("/api/auth/me", authRequired, (req, res) => {
  return res.json({
    ok: true,
    user: { id: req.user.sub, username: req.user.username, role: req.user.role || "admin", empleado_id: req.user.empleado_id || null },
  });
});

// Entities meta
app.get("/api/entities", authRequired, (req, res) => {
  const obj = {};
  for (const [k, v] of Object.entries(ENTITIES)) {
    obj[k] = {
      table: v.table,
      tableColumns: v.tableColumns,
      fields: v.fields.map((f) => ({ ...f })),
    };
  }
  res.json({ ok: true, entities: obj });
});

app.get("/api/select/:entity", authRequired, (req, res) => {
  const entityKey = req.params.entity;
  const entity = ENTITIES[entityKey];
  if (!entity) return res.status(404).json({ error: "Entidad no existe" });

  const rows = dbSelectAll(`SELECT * FROM ${entity.table} ORDER BY id DESC`);
  const options = rows.map((r) => ({ id: r.id, label: entity.display(r) }));
  res.json({ ok: true, options });
});

function coerceInput(field, value) {
  if (field.type === "checkbox") {
    if (value === true || value === "true" || value === 1 || value === "1") return 1;
    return 0;
  }
  if (field.type === "ref") {
    if (value === "" || value === null || typeof value === "undefined") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (field.type === "number") {
    if (value === "" || value === null || typeof value === "undefined") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (field.type === "datetime" || field.type === "date") {
    // Keep as raw string to avoid timezone conversions.
    if (!value) return null;
    return String(value);
  }
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  return value === null ? null : String(value);
}

function buildInsert(entityKey, payload) {
  const entity = ENTITIES[entityKey];
  const fields = entity.fields;
  const allowedKeys = fields.map((f) => f.key);

  const values = [];
  const cols = [];
  for (const f of fields) {
    if (!allowedKeys.includes(f.key)) continue;
    // If missing: allow NULL unless required.
    let v = payload ? payload[f.key] : undefined;
    v = coerceInput(f, v);
    if (v === null && f.required) throw new Error(`Falta ${f.key}`);
    cols.push(f.key);
    values.push(v);
  }
  const placeholders = cols.map(() => "?").join(", ");
  const sql = `INSERT INTO ${entity.table} (${cols.join(", ")}) VALUES (${placeholders})`;
  return { sql, values };
}

function buildUpdate(entityKey, id, payload) {
  const entity = ENTITIES[entityKey];
  const fields = entity.fields;
  const sets = [];
  const values = [];
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload || {}, f.key)) continue;
    const v = coerceInput(f, payload[f.key]);
    if (v === null && f.required) throw new Error(`Falta ${f.key}`);
    sets.push(`${f.key} = ?`);
    values.push(v);
  }
  if (sets.length === 0) throw new Error("Nada que actualizar");
  const sql = `UPDATE ${entity.table} SET ${sets.join(", ")} WHERE id = ?`;
  values.push(Number(id));
  return { sql, values };
}

// CRUD for entities
app.get("/api/:entityKey", authRequired, (req, res) => {
  const entityKey = req.params.entityKey;
  const entity = ENTITIES[entityKey];
  if (!entity) return res.status(404).json({ error: "Entidad no existe" });

  const role = req.user.role || "admin";
  let rows = [];
  if (role === "mecanico") {
    if (entityKey !== "reparaciones") return res.status(403).json({ error: "No autorizado" });
    if (!req.user.empleado_id) return res.json({ ok: true, items: [] });
    rows = dbSelectAll(`SELECT * FROM ${entity.table} WHERE empleado_id = ? ORDER BY id DESC`, [
      req.user.empleado_id,
    ]);
  } else {
    rows = dbSelectAll(`SELECT * FROM ${entity.table} ORDER BY id DESC`);
  }
  res.json({ ok: true, items: rows });
});

app.post("/api/:entityKey", authRequired, (req, res) => {
  const entityKey = req.params.entityKey;
  const entity = ENTITIES[entityKey];
  if (!entity) return res.status(404).json({ error: "Entidad no existe" });

  const role = req.user.role || "admin";
  if (role !== "admin") return res.status(403).json({ error: "Solo el administrador puede crear" });

  const payload = req.body || {};
  try {
    if (entityKey === "cotizaciones") {
      // Inserción especial: generamos tokens y marcamos Pendiente.
      const {
        cliente_id,
        vehiculo_id,
        empleado_id,
        recomendaciones,
        cambios,
        costo_total,
      } = payload;

      if (!cliente_id || !vehiculo_id || !empleado_id || !recomendaciones || !cambios || costo_total === undefined) {
        return res.status(400).json({ error: "Faltan datos para la cotización" });
      }

      const approve_token = crypto.randomBytes(24).toString("hex");
      const reject_token = crypto.randomBytes(24).toString("hex");

      db.run(
        `INSERT INTO cotizaciones (cliente_id, vehiculo_id, empleado_id, recomendaciones, cambios, costo_total, estado, approve_token, reject_token)
         VALUES (?, ?, ?, ?, ?, ?, 'Pendiente', ?, ?)`,
        [cliente_id, vehiculo_id, empleado_id, recomendaciones, cambios, Number(costo_total), approve_token, reject_token]
      );

      const id = getLastInsertId();
      const row = dbSelectOne(`SELECT * FROM ${entity.table} WHERE id = ?`, [id]);
      saveDb();
      return res.json({ ok: true, item: row });
    }

    const { sql, values } = buildInsert(entityKey, payload);
    db.run(sql, values);
    const id = getLastInsertId();
    const row = dbSelectOne(`SELECT * FROM ${entity.table} WHERE id = ?`, [id]);
    saveDb();
    return res.json({ ok: true, item: row });
  } catch (e) {
    return res.status(400).json({ error: String(e && e.message ? e.message : e) });
  }
});

app.put("/api/:entityKey/:id", authRequired, (req, res) => {
  const entityKey = req.params.entityKey;
  const entity = ENTITIES[entityKey];
  if (!entity) return res.status(404).json({ error: "Entidad no existe" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const role = req.user.role || "admin";
  const payload = req.body || {};

  // Mecánico: solo actualiza reparaciones asignadas.
  if (role === "mecanico") {
    if (entityKey !== "reparaciones") return res.status(403).json({ error: "No autorizado" });
    const repair = dbSelectOne(`SELECT empleado_id FROM ${entity.table} WHERE id = ?`, [id]);
    if (!repair) return res.status(404).json({ error: "No encontrado" });
    if (String(repair.empleado_id) !== String(req.user.empleado_id)) return res.status(403).json({ error: "No autorizado" });

    const allowed = { estado: true, reparacion_realizada: true, fecha_fin: true };
    const filteredPayload = {};
    for (const k of Object.keys(payload)) {
      if (allowed[k]) filteredPayload[k] = payload[k];
    }

    try {
      const { sql, values } = buildUpdate(entityKey, id, filteredPayload);
      db.run(sql, values);
      const row = dbSelectOne(`SELECT * FROM ${entity.table} WHERE id = ?`, [id]);
      saveDb();
      return res.json({ ok: true, item: row });
    } catch (e) {
      return res.status(400).json({ error: String(e && e.message ? e.message : e) });
    }
  }

  // Admin: cotizaciones solo si aún están Pendiente.
  if (role === "admin" && entityKey === "cotizaciones") {
    const q = dbSelectOne(`SELECT estado FROM cotizaciones WHERE id = ?`, [id]);
    if (!q) return res.status(404).json({ error: "No encontrado" });
    if (q.estado !== "Pendiente") return res.status(400).json({ error: "La cotización ya no está pendiente" });
  }

  // Mecánico no puede cerrar reparaciones (solo admin puede cerrar)
  if (role === "mecanico" && entityKey === "reparaciones" && payload.estado === "Cerrada") {
    return res.status(403).json({ error: "Solo el administrador puede cerrar reparaciones" });
  }

  try {
    // Si es reparación y se está cerrando, registrar el ingreso automáticamente (solo admin)
    if (entityKey === "reparaciones" && payload.estado === "Cerrada") {
      const repBefore = dbSelectOne(`SELECT estado, costo_total, cliente_id, vehiculo_id FROM reparaciones WHERE id = ?`, [id]);
      if (repBefore && repBefore.estado !== "Cerrada" && repBefore.costo_total > 0) {
        // Registrar ingreso automático
        const cliente = dbSelectOne(`SELECT nombre FROM clientes WHERE id = ?`, [repBefore.cliente_id]);
        const vehiculo = dbSelectOne(`SELECT placa FROM vehiculos WHERE id = ?`, [repBefore.vehiculo_id]);
        const concepto = `Reparación - ${cliente?.nombre || 'Cliente'} - ${vehiculo?.placa || 'Sin placa'}`;
        const today = new Date().toISOString().slice(0, 10);
        
        db.run(
          `INSERT INTO ingresos_gastos (tipo, concepto, monto, fecha, nota) VALUES (?, ?, ?, ?, ?)`,
          ["Ingreso", concepto, repBefore.costo_total, today, `Reparación #${id} cerrada`]
        );
      }
    }

    const { sql, values } = buildUpdate(entityKey, id, payload);
    db.run(sql, values);
    const row = dbSelectOne(`SELECT * FROM ${entity.table} WHERE id = ?`, [id]);
    saveDb();
    return res.json({ ok: true, item: row });
  } catch (e) {
    return res.status(400).json({ error: String(e && e.message ? e.message : e) });
  }
});

app.delete("/api/:entityKey/:id", authRequired, (req, res) => {
  const entityKey = req.params.entityKey;
  const entity = ENTITIES[entityKey];
  if (!entity) return res.status(404).json({ error: "Entidad no existe" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const role = req.user.role || "admin";
  if (role !== "admin") return res.status(403).json({ error: "No autorizado" });

  const existed = dbSelectOne(`SELECT id FROM ${entity.table} WHERE id = ?`, [id]);
  if (!existed) return res.status(404).json({ error: "No encontrado" });
  db.run(`DELETE FROM ${entity.table} WHERE id = ?`, [id]);
  saveDb();
  return res.json({ ok: true });
});

function getOrigin(req) {
  const proto = req.protocol || "http";
  const host = req.get("host");
  return `${proto}://${host}`;
}

function normalizeChilePhoneToWaDigits(raw) {
  // WhatsApp usa números en formato: país + número SIN el signo +.
  // Asumimos Chile (+569) y aceptamos que el usuario guarde:
  // - solo el número con 9xxxxxxxx
  // - o que ya incluya 56/569.
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("569")) return digits;
  if (digits.startsWith("56")) return digits;
  if (digits.startsWith("9")) {
    // Común en Chile: 9 + 8 dígitos = 9 dígitos (sin prefijo +56)
    if (digits.length === 9) return `56${digits}`; // => 569xxxxxxxx
    if (digits.length === 8) return `569${digits}`; // fallback si faltó un dígito
    return `569${digits}`;
  }
  // último recurso
  if (digits.length === 8) return `569${digits}`;
  return `569${digits}`; // fallback
}

app.get("/api/cotizaciones/:id/whatsapp", authRequired, (req, res) => {
  const role = req.user.role || "admin";
  if (role !== "admin") return res.status(403).json({ error: "No autorizado" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const quote = dbSelectOne(`SELECT * FROM cotizaciones WHERE id = ?`, [id]);
  if (!quote) return res.status(404).json({ error: "No encontrado" });

  const cliente = dbSelectOne(`SELECT * FROM clientes WHERE id = ?`, [quote.cliente_id]);
  const vehiculo = dbSelectOne(`SELECT * FROM vehiculos WHERE id = ?`, [quote.vehiculo_id]);
  const empleado = dbSelectOne(`SELECT * FROM empleados WHERE id = ?`, [quote.empleado_id]);

  const origin = getOrigin(req);
  const approveUrl = `${origin}/quote/approve/${quote.approve_token}`;
  const rejectUrl = `${origin}/quote/reject/${quote.reject_token}`;

  const waDigits = normalizeChilePhoneToWaDigits(cliente?.telefono);
  const clienteNombre = cliente?.nombre ? String(cliente.nombre) : "cliente";
  const marca = vehiculo?.marca ? String(vehiculo.marca) : "";
  const modelo = vehiculo?.modelo ? String(vehiculo.modelo) : "";
  const anio = vehiculo?.anio ? String(vehiculo.anio) : "";
  const placa = vehiculo?.placa ? String(vehiculo.placa) : "";
  const vin = vehiculo?.vin ? String(vehiculo.vin) : "";
  const color = vehiculo?.color ? String(vehiculo.color) : "";
  const mecNombre = empleado?.nombre ? String(empleado.nombre) : "";

  const message =
    `Hola ${clienteNombre}! Tu vehículo (${marca} ${modelo} ${anio}). ` +
    `Placa: ${placa || "-"} | VIN: ${vin || "-"} | Color: ${color || "-"}. \n\n` +
    `Diagnóstico: ${quote.recomendaciones}\n` +
    `Recomendaciones (cambios sugeridos): ${quote.cambios}\n\n` +
    `Nosotros vamos a realizar esos cambios y repararlo. ` +
    `Costo total: $${quote.costo_total}.\n\n` +
    `Mecánico asignado: ${mecNombre || "-"}. \n\n` +
    `Si apruebas la cotización: ${approveUrl}\n` +
    `Si no apruebas: ${rejectUrl}`;

  const waUrl = waDigits ? `https://wa.me/${waDigits}?text=${encodeURIComponent(message)}` : null;
  return res.json({ ok: true, waUrl, message });
});

function finalizeQuoteDecision(token, decision) {
  const quote =
    decision === "Aprobada"
      ? dbSelectOne(`SELECT * FROM cotizaciones WHERE approve_token = ?`, [token])
      : dbSelectOne(`SELECT * FROM cotizaciones WHERE reject_token = ?`, [token]);
  if (!quote) return { ok: false, error: "Token inválido" };

  if (quote.estado === "Pendiente") {
    db.run(
      `UPDATE cotizaciones SET estado = ?, approved_at = datetime('now') WHERE id = ?`,
      [decision, quote.id]
    );

    if (decision === "Aprobada") {
      const existing = dbSelectOne(`SELECT id FROM reparaciones WHERE cotizacion_id = ?`, [quote.id]);
      if (!existing) {
        const today = new Date().toISOString().slice(0, 10);
        db.run(
          `INSERT INTO reparaciones (cliente_id, vehiculo_id, empleado_id, descripcion_falla, reparacion_realizada, fecha_inicio, fecha_fin, estado, costo_total, cotizacion_id)
           VALUES (?, ?, ?, ?, NULL, ?, NULL, 'Abierta', ?, ?)`,
          [
            quote.cliente_id,
            quote.vehiculo_id,
            quote.empleado_id,
            `${quote.recomendaciones}\nCambios sugeridos: ${quote.cambios}`,
            today,
            quote.costo_total,
            quote.id,
          ]
        );
      }
    }
  }

  saveDb();
  return { ok: true, quote };
}

app.get("/quote/approve/:token", (req, res) => {
  const { ok, error, quote } = finalizeQuoteDecision(req.params.token, "Aprobada");
  if (!ok) return res.status(400).send(`<h2>Error: ${error}</h2>`);
  return res.send(
    `<html><body style="font-family:system-ui; padding:16px;"><h2>¡Cotización aprobada!</h2><p>Se generó el trabajo para el mecánico asignado.</p><p>Estado: ${quote.estado}</p></body></html>`
  );
});

app.get("/quote/reject/:token", (req, res) => {
  const { ok, error, quote } = finalizeQuoteDecision(req.params.token, "Rechazada");
  if (!ok) return res.status(400).send(`<h2>Error: ${error}</h2>`);
  return res.send(
    `<html><body style="font-family:system-ui; padding:16px;"><h2>Cotización rechazada</h2><p>Queda registrada como Rechazada.</p><p>Estado: ${quote.estado}</p></body></html>`
  );
});

app.post("/api/admin/mecanicos", authRequired, (req, res) => {
  const role = req.user.role || "admin";
  if (role !== "admin") return res.status(403).json({ error: "No autorizado" });

  const {
    nombre,
    telefono,
    puesto,
    username,
    password,
  } = req.body || {};

  if (!nombre || !username || !password) return res.status(400).json({ error: "Datos faltantes" });
  if (String(username).trim().length < 3) return res.status(400).json({ error: "Username inválido" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password muy corta (mínimo 6)" });

  const empleado = dbSelectOne(
    `SELECT id FROM empleados WHERE nombre = ? ORDER BY id DESC LIMIT 1`,
    [nombre]
  );

  let empleadoId = empleado ? empleado.id : null;
  try {
    if (!empleadoId) {
      db.run(
        `INSERT INTO empleados (nombre, telefono, puesto, activo) VALUES (?, ?, ?, 1)`,
        [nombre, telefono || null, puesto || null]
      );
      empleadoId = getLastInsertId();
    }
    const hash = bcrypt.hashSync(String(password), 10);
    db.run(
      `INSERT INTO users (username, password_hash, role, empleado_id) VALUES (?, ?, 'mecanico', ?)`,
      [String(username).trim(), hash, empleadoId]
    );

    saveDb();
    return res.json({ ok: true, empleado_id: empleadoId, username: String(username).trim() });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes("UNIQUE")) return res.status(409).json({ error: "Username o empleado ya existe" });
    return res.status(500).json({ error: "Error al crear mecánico" });
  }
});

app.get("/api/admin/users", authRequired, (req, res) => {
  const role = req.user.role || "admin";
  if (role !== "admin") return res.status(403).json({ error: "No autorizado" });

  const users = dbSelectAll(
    `SELECT u.id, u.username, u.role, u.empleado_id,
            e.nombre AS empleado_nombre,
            e.telefono AS empleado_telefono,
            e.puesto AS empleado_puesto
     FROM users u
     LEFT JOIN empleados e ON e.id = u.empleado_id
     ORDER BY u.role, u.id DESC`
  );
  res.json({ ok: true, users });
});

app.post("/api/admin/users", authRequired, (req, res) => {
  const role = req.user.role || "admin";
  if (role !== "admin") return res.status(403).json({ error: "No autorizado" });

  const payload = req.body || {};
  const newRole = payload.role ? String(payload.role) : null;
  const username = payload.username ? String(payload.username).trim() : null;
  const password = payload.password ? String(payload.password) : null;

  const nombre = payload.nombre ? String(payload.nombre).trim() : null;
  const telefono = payload.telefono ? String(payload.telefono).trim() : null;
  const puesto = payload.puesto ? String(payload.puesto).trim() : null;

  if (!newRole || (newRole !== "admin" && newRole !== "mecanico")) return res.status(400).json({ error: "Rol inválido" });
  if (!username || username.length < 3) return res.status(400).json({ error: "Username inválido" });
  if (!password || password.length < 6) return res.status(400).json({ error: "Password muy corta (mínimo 6)" });

  try {
    if (newRole === "admin") {
      db.run(`INSERT INTO users (username, password_hash, role, empleado_id) VALUES (?, ?, 'admin', NULL)`, [
        username,
        bcrypt.hashSync(password, 10),
      ]);
      const id = getLastInsertId();
      saveDb();
      return res.json({ ok: true, user: { id, username, role: "admin" } });
    }

    if (!nombre) return res.status(400).json({ error: "Nombre del mecánico es requerido" });

    db.run(`INSERT INTO empleados (nombre, telefono, puesto, activo) VALUES (?, ?, ?, 1)`, [nombre, telefono || null, puesto || null]);
    const empleadoId = getLastInsertId();

    db.run(`INSERT INTO users (username, password_hash, role, empleado_id) VALUES (?, ?, 'mecanico', ?)`, [
      username,
      bcrypt.hashSync(password, 10),
      empleadoId,
    ]);
    const id = getLastInsertId();
    saveDb();
    return res.json({ ok: true, user: { id, username, role: "mecanico", empleado_id: empleadoId } });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes("UNIQUE")) return res.status(409).json({ error: "Username ya existe" });
    return res.status(500).json({ error: "Error al crear usuario" });
  }
});

app.put("/api/admin/users/:id", authRequired, (req, res) => {
  const role = req.user.role || "admin";
  if (role !== "admin") return res.status(403).json({ error: "No autorizado" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const payload = req.body || {};
  const username = payload.username ? String(payload.username).trim() : null;
  const password = payload.password ? String(payload.password) : null;
  const empleadoNombre = payload.nombre ? String(payload.nombre) : null;
  const empleadoTelefono = payload.telefono ? String(payload.telefono) : null;
  const empleadoPuesto = payload.puesto ? String(payload.puesto) : null;

  const user = dbSelectOne(`SELECT id, username, role, empleado_id FROM users WHERE id = ?`, [id]);
  if (!user) return res.status(404).json({ error: "No encontrado" });

  try {
    if (username) {
      db.run(`UPDATE users SET username = ? WHERE id = ?`, [username, id]);
    }

    if (password && password.length >= 6) {
      const hash = bcrypt.hashSync(password, 10);
      db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, id]);
    }

    if (user.role === "mecanico") {
      if (!user.empleado_id) return res.status(400).json({ error: "Mecánico sin empleado asociado" });
      if (empleadoNombre || empleadoTelefono || empleadoPuesto) {
        db.run(
          `UPDATE empleados SET nombre = COALESCE(?, nombre), telefono = COALESCE(?, telefono), puesto = COALESCE(?, puesto) WHERE id = ?`,
          [empleadoNombre, empleadoTelefono, empleadoPuesto, user.empleado_id]
        );
      }
    }

    saveDb();
    const updated = dbSelectAll(
      `SELECT u.id, u.username, u.role, u.empleado_id,
              e.nombre AS empleado_nombre,
              e.telefono AS empleado_telefono,
              e.puesto AS empleado_puesto
       FROM users u
       LEFT JOIN empleados e ON e.id = u.empleado_id
       WHERE u.id = ?`,
      [id]
    )[0];
    res.json({ ok: true, user: updated || null });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes("UNIQUE")) return res.status(409).json({ error: "Username ya existe" });
    return res.status(400).json({ error: msg });
  }
});

app.delete("/api/admin/users/:id", authRequired, (req, res) => {
  const role = req.user.role || "admin";
  if (role !== "admin") return res.status(403).json({ error: "No autorizado" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  if (String(req.user.sub) === String(id)) return res.status(400).json({ error: "No puedes eliminar tu propia cuenta" });

  const user = dbSelectOne(`SELECT id, username, role, empleado_id FROM users WHERE id = ?`, [id]);
  if (!user) return res.status(404).json({ error: "No encontrado" });

  try {
    if (user.role === "mecanico" && user.empleado_id) {
      const assignedRep = dbSelectOne(
        `SELECT COUNT(*) AS c FROM reparaciones WHERE empleado_id = ?`,
        [user.empleado_id]
      );
      const assignedQuotes = dbSelectOne(`SELECT COUNT(*) AS c FROM cotizaciones WHERE empleado_id = ?`, [
        user.empleado_id,
      ]);
      const repCount = assignedRep?.c ? Number(assignedRep.c) : 0;
      const quoteCount = assignedQuotes?.c ? Number(assignedQuotes.c) : 0;
      if (repCount > 0 || quoteCount > 0) {
        return res.status(409).json({ error: "Este mecánico tiene trabajos asignados. Reasigna antes de eliminar." });
      }
    }

    if (user.role === "admin") {
      const admins = dbSelectOne(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`);
      const count = admins?.c ? Number(admins.c) : 0;
      if (count <= 1) return res.status(409).json({ error: "Debe quedar al menos un admin." });
    }

    db.run(`DELETE FROM users WHERE id = ?`, [id]);
    saveDb();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: String(e && e.message ? e.message : e) });
  }
});

// Serve frontend
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Ruta específica para app.html
app.get('/app.html', (req, res) => {
  res.sendFile(path.join(publicDir, 'app.html'));
});

app.use((req, res) => res.status(404).send("Ruta no encontrada"));

