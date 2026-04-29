import express from "express";
import cors from "cors";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { Pool } from "pg";
import Redis from "ioredis";
import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

const port = Number(process.env.PORT || 4000);
const databaseUrl = process.env.DATABASE_URL || "postgres://airops:airops@postgres:5432/airops";
const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const s3Endpoint = process.env.S3_ENDPOINT || "http://minio:9000";
const s3Bucket = process.env.S3_BUCKET || "flight-data";
const adminToken = process.env.ADMIN_TOKEN || "air-ops-admin";
const labOperators = JSON.parse(process.env.LAB_OPERATORS || "[]");

const pool = new Pool({ connectionString: databaseUrl });
const redis = new Redis(redisUrl);
const s3 = new S3Client({
  region: "us-east-1",
  endpoint: s3Endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "minioadmin",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "minioadmin"
  }
});

function requestLog(req, event, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level: "info",
    service: "airops-api",
    event,
    requestId: req.headers["x-request-id"] || randomUUID(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    userAgent: req.headers["user-agent"],
    path: req.path,
    method: req.method,
    actor: actorFromRequest(req),
    ...extra
  };
  console.log(JSON.stringify(entry));
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS operators (
      id SERIAL PRIMARY KEY,
      callsign TEXT NOT NULL,
      role TEXT NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS flights (
      id SERIAL PRIMARY KEY,
      flight_no TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      status TEXT NOT NULL,
      altitude INTEGER NOT NULL,
      owner_callsign TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      latitude DOUBLE PRECISION NOT NULL DEFAULT 0,
      longitude DOUBLE PRECISION NOT NULL DEFAULT 0,
      heading INTEGER NOT NULL DEFAULT 0,
      speed INTEGER NOT NULL DEFAULT 0,
      vertical_rate INTEGER NOT NULL DEFAULT 0,
      aircraft_type TEXT NOT NULL DEFAULT '',
      registration TEXT NOT NULL DEFAULT '',
      squawk TEXT NOT NULL DEFAULT '',
      sector TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS clearances (
      id SERIAL PRIMARY KEY,
      flight_id INTEGER REFERENCES flights(id),
      route TEXT NOT NULL,
      shared_with TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS weather_forecasts (
      id SERIAL PRIMARY KEY,
      airport TEXT NOT NULL,
      valid_from TIMESTAMPTZ NOT NULL,
      valid_to TIMESTAMPTZ NOT NULL,
      summary TEXT NOT NULL,
      wind TEXT NOT NULL,
      visibility TEXT NOT NULL,
      ceiling TEXT NOT NULL,
      risk TEXT NOT NULL
    );
  `);

  await pool.query(`
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
    CREATE UNIQUE INDEX IF NOT EXISTS operators_callsign_idx ON operators (callsign);
    ALTER TABLE flights ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE flights ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE flights ADD COLUMN IF NOT EXISTS heading INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE flights ADD COLUMN IF NOT EXISTS speed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE flights ADD COLUMN IF NOT EXISTS vertical_rate INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE flights ADD COLUMN IF NOT EXISTS aircraft_type TEXT NOT NULL DEFAULT '';
    ALTER TABLE flights ADD COLUMN IF NOT EXISTS registration TEXT NOT NULL DEFAULT '';
    ALTER TABLE flights ADD COLUMN IF NOT EXISTS squawk TEXT NOT NULL DEFAULT '';
    ALTER TABLE flights ADD COLUMN IF NOT EXISTS sector TEXT NOT NULL DEFAULT '';
    ALTER TABLE flights ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS weather_forecasts_airport_idx ON weather_forecasts (airport, valid_from);
  `);

  const defaultOperators = labOperators.length > 0 ? labOperators : [
    { callsign: "maverick", displayName: "Pete \"Maverick\" Mitchell", role: "admin", password: "dangerzone", email: "maverick@topgun.local" },
    { callsign: "goose", displayName: "Nick \"Goose\" Bradshaw", role: "controller", password: "talktomegoose", email: "goose@topgun.local" },
    { callsign: "iceman", displayName: "Tom \"Iceman\" Kazansky", role: "controller", password: "icecold", email: "iceman@topgun.local" },
    { callsign: "charlie", displayName: "Charlotte \"Charlie\" Blackwood", role: "analyst", password: "migdata", email: "charlie@topgun.local" }
  ];

  for (const operator of defaultOperators) {
    await pool.query(
      `INSERT INTO operators (callsign, role, password, display_name, email)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (callsign)
       DO UPDATE SET role = EXCLUDED.role, display_name = EXCLUDED.display_name, email = EXCLUDED.email`,
      [operator.callsign, operator.role, operator.password, operator.displayName || operator.callsign, operator.email || `${operator.callsign}@topgun.local`]
    );
  }

  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM flights");
  if (rows[0].count === 0) {
    await pool.query(`
      INSERT INTO flights (flight_no, origin, destination, status, altitude, owner_callsign, notes, latitude, longitude, heading, speed, vertical_rate, aircraft_type, registration, squawk, sector) VALUES
        ('AFR431', 'LFPG', 'LFMN', 'ENROUTE', 31000, 'maverick', 'VIP passenger manifest in S3 object manifests/afr431.csv', 46.18, 3.12, 152, 456, 0, 'A320', 'F-HBND', '4212', 'PARIS-SE'),
        ('DLH220', 'EDDF', 'LFPG', 'DESCENT', 18000, 'iceman', 'Medical cargo priority', 49.02, 4.40, 246, 388, -1400, 'A321', 'D-AISX', '5261', 'REIMS-HI'),
        ('BOX808', 'LFBO', 'EGLL', 'ENROUTE', 26000, 'goose', 'Partner cargo flight', 47.92, 0.62, 338, 412, 300, 'B738', 'G-BOXA', '6314', 'BREST-NE'),
        ('NAVY86', 'LFRJ', 'LFMI', 'TACTICAL', 22000, 'phoenix', 'Training package rerouted through coastal corridor', 45.02, -0.88, 128, 430, 0, 'F18', 'NAVY086', '7001', 'AQUITAINE'),
        ('TOP114', 'LFLY', 'LFBD', 'HOLDING', 14000, 'hangman', 'Restricted exercise track', 45.33, 2.25, 242, 265, 0, 'PC21', 'F-RSDI', '7044', 'MASSIF');
      INSERT INTO clearances (flight_id, route, shared_with) VALUES
        (1, 'LGL UM733 KOK UT27 DVR', 'maverick'),
        (2, 'ROLIS T116 BANOX', 'iceman'),
        (3, 'AGN UT10 KOVAK', 'goose'),
        (4, 'MZB JLI PMD', 'phoenix'),
        (5, 'NTD R-2508 SILENT', 'hangman');
    `);
  }

  await pool.query(`
    UPDATE flights SET origin = 'LFPG', destination = 'LFMN', status = 'ENROUTE', altitude = 31000, notes = 'VIP passenger manifest in S3 object manifests/afr431.csv', latitude = 46.18, longitude = 3.12, heading = 152, speed = 456, vertical_rate = 0, aircraft_type = 'A320', registration = 'F-HBND', squawk = '4212', sector = 'PARIS-SE', updated_at = now() WHERE flight_no = 'AFR431';
    UPDATE flights SET origin = 'EDDF', destination = 'LFPG', status = 'DESCENT', altitude = 18000, notes = 'Medical cargo priority', latitude = 49.02, longitude = 4.40, heading = 246, speed = 388, vertical_rate = -1400, aircraft_type = 'A321', registration = 'D-AISX', squawk = '5261', sector = 'REIMS-HI', updated_at = now() WHERE flight_no = 'DLH220';
    UPDATE flights SET origin = 'LFBO', destination = 'EGLL', status = 'ENROUTE', altitude = 26000, notes = 'Partner cargo flight', latitude = 47.92, longitude = 0.62, heading = 338, speed = 412, vertical_rate = 300, aircraft_type = 'B738', registration = 'G-BOXA', squawk = '6314', sector = 'BREST-NE', updated_at = now() WHERE flight_no = 'BOX808';
    UPDATE flights SET origin = 'LFRJ', destination = 'LFMI', status = 'TACTICAL', altitude = 22000, notes = 'Training package rerouted through coastal corridor', latitude = 45.02, longitude = -0.88, heading = 128, speed = 430, vertical_rate = 0, aircraft_type = 'F18', registration = 'NAVY086', squawk = '7001', sector = 'AQUITAINE', updated_at = now() WHERE flight_no = 'NAVY86';
    UPDATE flights SET origin = 'LFLY', destination = 'LFBD', status = 'HOLDING', altitude = 14000, notes = 'Restricted exercise track', latitude = 45.33, longitude = 2.25, heading = 242, speed = 265, vertical_rate = 0, aircraft_type = 'PC21', registration = 'F-RSDI', squawk = '7044', sector = 'MASSIF', updated_at = now() WHERE flight_no = 'TOP114';
  `);

  const weather = await pool.query("SELECT COUNT(*)::int AS count FROM weather_forecasts");
  if (weather.rows[0].count === 0) {
    await pool.query(`
      INSERT INTO weather_forecasts (airport, valid_from, valid_to, summary, wind, visibility, ceiling, risk) VALUES
        ('LFPG', now(), now() + interval '6 hours', 'Bancs de pluie faibles au nord du terrain', '240/14KT rafales 22KT', '8 km', 'BKN022', 'crosswind'),
        ('LFPG', now() + interval '6 hours', now() + interval '12 hours', 'Amelioration progressive, averses residuelles', '260/10KT', '10 km', 'SCT030', 'nominal'),
        ('EGLL', now(), now() + interval '6 hours', 'Brume matinale puis ciel fragmente', '210/08KT', '6 km', 'BKN018', 'low-ceiling'),
        ('EGLL', now() + interval '6 hours', now() + interval '12 hours', 'Visibilite en hausse sur approche ouest', '230/12KT', '10 km', 'SCT025', 'nominal'),
        ('KJFK', now(), now() + interval '6 hours', 'Front orageux au large, cisaillement possible', '190/18KT rafales 28KT', '9 km', 'BKN035 CB', 'storm-cell'),
        ('KJFK', now() + interval '6 hours', now() + interval '12 hours', 'Cellules isolees en evacuation est', '220/15KT', '10 km', 'SCT040', 'watch'),
        ('EDDF', now(), now() + interval '6 hours', 'Plafond bas et bruine intermittente', '270/09KT', '5 km', 'OVC014', 'ifr'),
        ('KNUQ', now(), now() + interval '6 hours', 'Couche marine sur baie, dissipation lente', '300/11KT', '7 km', 'BKN020', 'coastal-layer'),
        ('KNID', now(), now() + interval '6 hours', 'Air sec et thermiques fortes sur desert', '080/16KT', '10 km', 'CLR', 'turbulence');
    `);
  }
}

const typeDefs = `#graphql
  type Flight {
    id: ID!
    flightNo: String!
    origin: String!
    destination: String!
    status: String!
    altitude: Int!
    ownerCallsign: String!
    notes: String!
    latitude: Float!
    longitude: Float!
    heading: Int!
    speed: Int!
    verticalRate: Int!
    aircraftType: String!
    registration: String!
    squawk: String!
    sector: String!
    updatedAt: String!
  }

  type Operator {
    callsign: String!
    displayName: String!
    email: String!
    role: String!
  }

  type Session {
    token: String!
    operator: Operator!
  }

  type Clearance {
    id: ID!
    flightId: ID!
    flightNo: String!
    origin: String!
    destination: String!
    status: String!
    route: String!
    sharedWith: String!
  }

  type ObjectInfo {
    key: String!
    size: Int
  }

  type WeatherForecast {
    id: ID!
    airport: String!
    validFrom: String!
    validTo: String!
    summary: String!
    wind: String!
    visibility: String!
    ceiling: String!
    risk: String!
  }

  type Query {
    flights(search: String): [Flight!]!
    flight(id: ID!): Flight
    currentOperator: Operator!
    clearances(search: String): [Clearance!]!
    clearance(id: ID!): Clearance
    s3Objects(prefix: String): [ObjectInfo!]!
    weatherForecast(airport: String, hours: Int): [WeatherForecast!]!
    fetchMetar(url: String!): String!
  }

  type Mutation {
    login(callsign: String!, password: String!): String!
    loginSession(callsign: String!, password: String!): Session!
    register(callsign: String!, password: String!, displayName: String, email: String): Session!
    updateFlightStatus(id: ID!, status: String!): Flight!
    updateFlightPosition(flightNo: String!, latitude: Float!, longitude: Float!, altitude: Int, heading: Int, speed: Int, verticalRate: Int, status: String): Flight!
    uploadReport(filename: String!, content: String!): String!
  }
`;

const resolvers = {
  Query: {
    flights: async (_, { search = "" }, { req }) => {
      // LAB VULN: SQL injection by design for blue-team detection.
      const sql = `SELECT * FROM flights WHERE flight_no ILIKE '%${search}%' OR origin ILIKE '%${search}%' ORDER BY id`;
      requestLog(req, "flight.search", { search, sql });
      const { rows } = await pool.query(sql);
      return rows.map(mapFlight);
    },
    flight: async (_, { id }, { req }) => {
      requestLog(req, "flight.read", { flightId: id });
      const { rows } = await pool.query("SELECT * FROM flights WHERE id = $1", [id]);
      return rows[0] ? mapFlight(rows[0]) : null;
    },
    currentOperator: async (_, __, { req }) => {
      return await findOperator(actorFromRequest(req));
    },
    clearances: async (_, { search = "" }, { req }) => {
      // LAB VULN: shared operational list exposes clearance metadata broadly.
      requestLog(req, "clearance.search", { search, warning: "broad-clearance-list" });
      const { rows } = await pool.query(
        `SELECT c.*, f.flight_no, f.origin, f.destination, f.status
         FROM clearances c
         JOIN flights f ON f.id = c.flight_id
         WHERE f.flight_no ILIKE $1 OR f.origin ILIKE $1 OR f.destination ILIKE $1 OR c.shared_with ILIKE $1
         ORDER BY c.id`,
        [`%${search}%`]
      );
      return rows.map(mapClearance);
    },
    clearance: async (_, { id }, { req }) => {
      // LAB VULN: IDOR. No authorization check on clearance ownership.
      requestLog(req, "clearance.read", { clearanceId: id, warning: "idor_lab_endpoint" });
      const { rows } = await pool.query(
        `SELECT c.*, f.flight_no, f.origin, f.destination, f.status
         FROM clearances c
         JOIN flights f ON f.id = c.flight_id
         WHERE c.id = $1`,
        [id]
      );
      return rows[0] ? mapClearance(rows[0]) : null;
    },
    s3Objects: async (_, { prefix = "" }, { req }) => {
      requestLog(req, "s3.list", { bucket: s3Bucket, prefix });
      const result = await s3.send(new ListObjectsV2Command({ Bucket: s3Bucket, Prefix: prefix }));
      return (result.Contents || []).map((item) => ({ key: item.Key, size: item.Size || 0 }));
    },
    weatherForecast: async (_, { airport = "", hours = 12 }, { req }) => {
      const normalized = airport.trim().toUpperCase();
      requestLog(req, "weather.forecast", { airport: normalized || "*", hours });
      const params = [Math.max(1, Math.min(Number(hours) || 12, 48))];
      let where = "valid_from <= now() + ($1::int * interval '1 hour')";
      if (normalized) {
        params.push(normalized);
        where += " AND airport = $2";
      }
      const { rows } = await pool.query(
        `SELECT * FROM weather_forecasts WHERE ${where} ORDER BY airport, valid_from`,
        params
      );
      return rows.map(mapWeatherForecast);
    },
    fetchMetar: async (_, { url }, { req }) => {
      // LAB VULN: SSRF-style URL fetcher for investigation scenarios.
      requestLog(req, "weather.fetch", { url, warning: "ssrf_lab_endpoint" });
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return await response.text();
    }
  },
  Mutation: {
    login: async (_, { callsign, password }, { req }) => {
      return (await loginOperator(callsign, password, req)).token;
    },
    loginSession: async (_, { callsign, password }, { req }) => {
      return await loginOperator(callsign, password, req);
    },
    register: async (_, { callsign, password, displayName = "", email = "" }, { req }) => {
      const normalized = callsign.toLowerCase().replace(/[^a-z0-9-]/g, "");
      if (normalized.length < 3) throw new Error("callsign too short");
      if (password.length < 6) throw new Error("password too short");
      const { rows } = await pool.query(
        `INSERT INTO operators (callsign, role, password, display_name, email)
         VALUES ($1, 'viewer', $2, $3, $4)
         RETURNING *`,
        [normalized, password, displayName || normalized, email || `${normalized}@self.local`]
      );
      requestLog(req, "auth.register", { callsign: normalized, role: "viewer", warning: "self_service_viewer_lab" });
      return await createSession(rows[0]);
    },
    updateFlightStatus: async (_, { id, status }, { req }) => {
      // LAB VULN: weak auth. Any caller with x-operator can update operational state.
      requestLog(req, "flight.status.update", { flightId: id, status, token: req.headers.authorization || null });
      const { rows } = await pool.query("UPDATE flights SET status = $1 WHERE id = $2 RETURNING *", [status, id]);
      if (!rows[0]) throw new Error("flight not found");
      return mapFlight(rows[0]);
    },
    updateFlightPosition: async (_, args, { req }) => {
      return await updateFlightPosition(args, req, "graphql");
    },
    uploadReport: async (_, { filename, content }, { req }) => {
      // LAB VULN: no file type validation and predictable object path.
      const key = `reports/${filename}`;
      requestLog(req, "s3.upload", { bucket: s3Bucket, key, bytes: content.length });
      await s3.send(new PutObjectCommand({ Bucket: s3Bucket, Key: key, Body: content }));
      return key;
    }
  }
};

async function loginOperator(callsign, password, req) {
  const { rows } = await pool.query("SELECT * FROM operators WHERE callsign = $1 AND password = $2", [callsign, password]);
  const ok = rows.length > 0;
  requestLog(req, "auth.login", { callsign, ok });
  if (!ok) throw new Error("invalid credentials");
  return await createSession(rows[0]);
}

async function createSession(row) {
  const token = Buffer.from(`${row.callsign}:${row.role}:${adminToken}`).toString("base64");
  await redis.set(`session:${row.callsign}`, token, "EX", 3600);
  return { token, operator: mapOperator(row) };
}

function actorFromRequest(req) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (bearer) {
    try {
      return Buffer.from(bearer, "base64").toString("utf8").split(":")[0] || "anonymous";
    } catch {
      return "anonymous";
    }
  }
  // LAB VULN: callers can impersonate an operator by setting x-operator.
  return req.headers["x-operator"] || "anonymous";
}

async function findOperator(callsign) {
  const { rows } = await pool.query("SELECT * FROM operators WHERE callsign = $1", [callsign]);
  if (rows[0]) return mapOperator(rows[0]);
  return { callsign, displayName: callsign, email: "", role: "anonymous" };
}

function mapOperator(row) {
  return {
    callsign: row.callsign,
    displayName: row.display_name || row.callsign,
    email: row.email || "",
    role: row.role
  };
}

function mapFlight(row) {
  return {
    id: row.id,
    flightNo: row.flight_no,
    origin: row.origin,
    destination: row.destination,
    status: row.status,
    altitude: row.altitude,
    ownerCallsign: row.owner_callsign,
    notes: row.notes,
    latitude: row.latitude,
    longitude: row.longitude,
    heading: row.heading,
    speed: row.speed,
    verticalRate: row.vertical_rate,
    aircraftType: row.aircraft_type,
    registration: row.registration,
    squawk: row.squawk,
    sector: row.sector,
    updatedAt: row.updated_at.toISOString()
  };
}

function mapClearance(row) {
  return {
    id: row.id,
    flightId: row.flight_id,
    flightNo: row.flight_no || "",
    origin: row.origin || "",
    destination: row.destination || "",
    status: row.status || "",
    route: row.route,
    sharedWith: row.shared_with
  };
}

function mapWeatherForecast(row) {
  return {
    id: row.id,
    airport: row.airport,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to.toISOString(),
    summary: row.summary,
    wind: row.wind,
    visibility: row.visibility,
    ceiling: row.ceiling,
    risk: row.risk
  };
}

async function updateFlightPosition({ flightNo, latitude, longitude, altitude = null, heading = null, speed = null, verticalRate = null, status = null }, req, source) {
  // LAB VULN: telemetry accepts weak bearer token or spoofable x-operator header.
  const actor = actorFromRequest(req);
  requestLog(req, "flight.position.update", {
    source,
    flightNo,
    actor,
    latitude,
    longitude,
    altitude,
    heading,
    speed,
    verticalRate,
    status,
    warning: "weak-telemetry-auth"
  });
  const { rows } = await pool.query(
    `UPDATE flights
     SET latitude = $2,
         longitude = $3,
         altitude = COALESCE($4, altitude),
         heading = COALESCE($5, heading),
         speed = COALESCE($6, speed),
         vertical_rate = COALESCE($7, vertical_rate),
         status = COALESCE($8, status),
         updated_at = now()
     WHERE flight_no = $1
     RETURNING *`,
    [flightNo.toUpperCase(), latitude, longitude, altitude, heading, speed, verticalRate, status]
  );
  if (!rows[0]) throw new Error("flight not found");
  await redis.set(`telemetry:${flightNo.toUpperCase()}:last`, JSON.stringify({
    actor,
    latitude,
    longitude,
    altitude,
    heading,
    speed,
    verticalRate,
    status,
    ts: new Date().toISOString()
  }), "EX", 600);
  return mapFlight(rows[0]);
}

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_, res) => res.json({ ok: true }));
  app.get("/api/footer", (_, res) => res.json({
    service: "AirOps API",
    stack: "GraphQL / Telemetry / Operational Data",
    environment: "Training Control Network",
    version: "0.1.0"
  }));
  app.get("/readyz", async (_, res) => {
    await pool.query("SELECT 1");
    await redis.ping();
    res.json({ ok: true });
  });

  app.post("/api/flights/:flightNo/position", async (req, res) => {
    try {
      const result = await updateFlightPosition({ flightNo: req.params.flightNo, ...req.body }, req, "rest");
      res.json({ ok: true, flight: result });
    } catch (error) {
      res.status(error.message === "flight not found" ? 404 : 400).json({ ok: false, error: error.message });
    }
  });

  const apollo = new ApolloServer({ typeDefs, resolvers, introspection: true });
  await apollo.start();
  app.use("/graphql", expressMiddleware(apollo, { context: async ({ req }) => ({ req }) }));

  app.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), service: "airops-api", event: "server.start", port }));
  });
}

main().catch((error) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), service: "airops-api", event: "server.crash", error: error.message }));
  process.exit(1);
});
