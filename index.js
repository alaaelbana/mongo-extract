import express from "express";
import { MongoClient } from "mongodb";
import { EJSON } from "bson";
import open from "open";
import path from "path";
import { fileURLToPath } from "url";
import fs, { existsSync, mkdirSync } from "fs";
import mongoose from "mongoose";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const app = express();
const PORT = 4001;

app.use(express.json({ limit: "500mb" }));

// This ensures it looks for index.html inside the executable's virtual files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─── Helper ─────────────────────────────────────────────────────────────────

function getDataDir(dateFolder) {
  const dirPath = path.join(baseDir, "data", dateFolder);
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

// ─── List Collections ────────────────────────────────────────────────────────

app.post("/api/collections", async (req, res) => {
  const { uri } = req.body;
  let client;
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db();
    const [collections, dbStats] = await Promise.all([
      db.listCollections().toArray(),
      db.command({ dbStats: 1 }),
    ]);

    const names = collections
      .map((c) => c.name)
      .filter((n) => n !== "visitors" && !n.startsWith("system."))
      .sort();

    res.json({ success: true, collections: names, dbStats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  } finally {
    if (client) await client.close();
  }
});

// ─── Collection Stats ────────────────────────────────────────────────────────

app.post("/api/stats", async (req, res) => {
  const { uri, collections } = req.body;
  let client;
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db();

    const stats = await Promise.all(
      collections.map(async (name) => {
        try {
          const col = db.collection(name);
          const [count, colStats] = await Promise.all([
            col.estimatedDocumentCount(),
            db.command({ collStats: name, scale: 1024 }),
          ]);
          return {
            name,
            count,
            sizeKB: Math.round(colStats.size / 1024),
            avgObjSizeBytes: colStats.avgObjSize || 0,
            indexCount: colStats.nindexes || 0,
          };
        } catch {
          return {
            name,
            count: 0,
            sizeKB: 0,
            avgObjSizeBytes: 0,
            indexCount: 0,
          };
        }
      }),
    );

    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  } finally {
    if (client) await client.close();
  }
});

// ─── Stream Extract (single collection) ─────────────────────────────────────

app.post("/api/extract-stream", async (req, res) => {
  const {
    uri,
    collection,
    downloadDate,
    filter = {},
    format = "json",
  } = req.body;
  const dateFolder = downloadDate || new Date().toISOString().split("T")[0];
  const dirPath = getDataDir(dateFolder);
  const ext = format === "csv" ? "csv" : "json";
  const filePath = path.join(dirPath, `${collection}.${ext}`);

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const fileStream = fs.createWriteStream(filePath, { encoding: "utf8" });
  let csvHeaders = null;

  if (format === "json") fileStream.write("[\n");

  let client;
  try {
    client = new MongoClient(uri);
    await client.connect();
    const db = client.db();
    const col = db.collection(collection);
    const total = await col.estimatedDocumentCount();

    res.write(JSON.stringify({ type: "init", total, filePath }) + "\n");

    const BATCH_SIZE = 500;
    const queryFilter =
      typeof filter === "string" ? JSON.parse(filter) : filter;
    const cursor = col.find(queryFilter).batchSize(BATCH_SIZE);

    let count = 0;
    let batch = [];
    let isFirstDoc = true;

    for await (const doc of cursor) {
      const serialized = EJSON.serialize(doc);
      batch.push(serialized);
      count++;

      if (batch.length >= BATCH_SIZE) {
        await writeBatch(
          batch,
          fileStream,
          format,
          isFirstDoc,
          csvHeaders,
          (h) => {
            csvHeaders = h;
          },
        );
        isFirstDoc = false;

        const docsToSendToUI = count <= 5000 ? batch : [];
        res.write(
          JSON.stringify({
            type: "batch",
            docs: docsToSendToUI,
            current: count,
            total,
          }) + "\n",
        );
        batch = [];
      }
    }

    if (batch.length > 0) {
      await writeBatch(
        batch,
        fileStream,
        format,
        isFirstDoc,
        csvHeaders,
        (h) => {
          csvHeaders = h;
        },
      );
      const docsToSendToUI = count <= 5000 ? batch : [];
      res.write(
        JSON.stringify({
          type: "batch",
          docs: docsToSendToUI,
          current: count,
          total,
        }) + "\n",
      );
    }

    if (format === "json") fileStream.write("\n]");
    fileStream.end();

    res.write(JSON.stringify({ type: "done", total: count, filePath }) + "\n");
  } catch (e) {
    res.write(JSON.stringify({ type: "error", message: e.message }) + "\n");
  } finally {
    if (client) await client.close();
    if (!fileStream.writableEnded) fileStream.end();
    res.end();
  }
});

async function writeBatch(
  batch,
  fileStream,
  format,
  isFirstDoc,
  csvHeaders,
  setHeaders,
) {
  if (format === "csv") {
    let headers = csvHeaders;
    if (!headers) {
      headers = [...new Set(batch.flatMap((d) => Object.keys(d)))];
      setHeaders(headers);
      fileStream.write(headers.join(",") + "\n");
    }
    const rows = batch.map((doc) =>
      headers
        .map((h) => {
          const v = doc[h];
          if (v === undefined || v === null) return "";
          const s = typeof v === "object" ? JSON.stringify(v) : String(v);
          return `"${s.replace(/"/g, '""')}"`;
        })
        .join(","),
    );
    fileStream.write(rows.join("\n") + "\n");
  } else {
    const chunkStr = batch.map((d) => JSON.stringify(d, null, 2)).join(",\n");
    const prefix = isFirstDoc ? "" : ",\n";
    fileStream.write(prefix + chunkStr);
  }
}

// ─── Multi-Collection Bulk Extract ───────────────────────────────────────────

app.post("/api/extract-bulk", async (req, res) => {
  const {
    uri,
    collections,
    downloadDate,
    format = "json",
    filter = {},
  } = req.body;
  const dateFolder = downloadDate || new Date().toISOString().split("T")[0];

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  res.write(JSON.stringify({ type: "start", collections }) + "\n");

  let client;
  try {
    client = new MongoClient(uri);
    await client.connect();
    const db = client.db();

    for (const collection of collections) {
      const dirPath = getDataDir(dateFolder);
      const ext = format === "csv" ? "csv" : "json";
      const filePath = path.join(dirPath, `${collection}.${ext}`);
      const fileStream = fs.createWriteStream(filePath, { encoding: "utf8" });
      let csvHeaders = null;

      if (format === "json") fileStream.write("[\n");

      try {
        const col = db.collection(collection);
        const queryFilter =
          typeof filter === "string" ? JSON.parse(filter) : filter;
        const total = await col.countDocuments(queryFilter);

        res.write(
          JSON.stringify({ type: "collection-start", collection, total }) +
            "\n",
        );

        const BATCH_SIZE = 500;
        const cursor = col.find(queryFilter).batchSize(BATCH_SIZE);
        let count = 0;
        let batch = [];
        let isFirstDoc = true;

        for await (const doc of cursor) {
          batch.push(EJSON.serialize(doc));
          count++;
          if (batch.length >= BATCH_SIZE) {
            await writeBatch(
              batch,
              fileStream,
              format,
              isFirstDoc,
              csvHeaders,
              (h) => {
                csvHeaders = h;
              },
            );
            isFirstDoc = false;
            res.write(
              JSON.stringify({
                type: "collection-progress",
                collection,
                current: count,
                total,
                docs: count <= 5000 ? batch : [], // Send docs up to 5000 for preview
              }) + "\n",
            );
            batch = [];
          }
        }

        if (batch.length > 0) {
          await writeBatch(
            batch,
            fileStream,
            format,
            isFirstDoc,
            csvHeaders,
            (h) => {
              csvHeaders = h;
            },
          );
          // Send docs for preview even if it's the last/only batch
          res.write(
            JSON.stringify({
              type: "collection-progress",
              collection,
              current: count,
              total,
              docs: count <= 5000 ? batch : [],
            }) + "\n",
          );
        }

        if (format === "json") fileStream.write("\n]");
        fileStream.end();
        res.write(
          JSON.stringify({
            type: "collection-done",
            collection,
            total: count,
            filePath,
          }) + "\n",
        );
      } catch (e) {
        if (!fileStream.writableEnded) fileStream.end();
        res.write(
          JSON.stringify({
            type: "collection-error",
            collection,
            message: e.message,
          }) + "\n",
        );
      }
    }

    res.write(JSON.stringify({ type: "bulk-done" }) + "\n");
  } catch (e) {
    res.write(JSON.stringify({ type: "error", message: e.message }) + "\n");
  } finally {
    if (client) await client.close();
    res.end();
  }
});

// ─── List Saved Extractions ───────────────────────────────────────────────────

app.get("/api/saved", (req, res) => {
  const dataDir = path.join(baseDir, "data");
  if (!fs.existsSync(dataDir)) return res.json({ success: true, dates: [] });

  const dates = fs
    .readdirSync(dataDir)
    .filter((d) => fs.statSync(path.join(dataDir, d)).isDirectory())
    .sort()
    .reverse()
    .map((date) => {
      const dateDir = path.join(dataDir, date);
      const files = fs.readdirSync(dateDir).map((file) => {
        const filePath = path.join(dateDir, file);
        const stat = fs.statSync(filePath);
        return {
          name: file,
          collection: path.parse(file).name,
          format: path.extname(file).slice(1),
          sizeKB: Math.round(stat.size / 1024),
          modifiedAt: stat.mtime,
        };
      });
      return { date, files };
    });

  res.json({ success: true, dates });
});

// ─── Download Saved File ──────────────────────────────────────────────────────

app.get("/api/download/:date/:file", (req, res) => {
  const filePath = path.join(baseDir, "data", req.params.date, req.params.file);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "File not found" });
  res.download(filePath);
});

// ─── Delete Saved File ────────────────────────────────────────────────────────

app.delete("/api/saved/:date/:file", (req, res) => {
  const filePath = path.join(baseDir, "data", req.params.date, req.params.file);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "File not found" });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});

// ─── Upload (Restore) Collection ──────────────────────────────────────────────

app.post("/api/upload-stream", async (req, res) => {
  const {
    uri,
    collectionName,
    date,
    file,
    rawJson,
    dropCollection,
    schemaCode,
  } = req.body;

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let connection;
  let Model;
  let tempSchemaPath;

  try {
    let format = "json";
    if (!rawJson) {
      const filePath = path.join(baseDir, "data", date, file);
      if (!fs.existsSync(filePath)) throw new Error("File not found");
      format = path.extname(file).slice(1);
    }

    let db;
    if (schemaCode) {
      const cleanedCode = schemaCode
        .replace(/import\s+[\s\S]*?from\s+['"].*?['"];?/g, "")
        .replace(/import\s+['"].*?['"];?/g, "")
        .replace(/export\s+default\s+.*?;?/g, "")
        .replace(/export\s+const\s+/g, "const ")
        .replace(/const\s+mongoose\s*=\s*require\(['"]mongoose['"]\);?/g, "");

      let capturedSchema = null;
      const schemaCatcher = function (...args) {
        const s = new mongoose.Schema(...args);
        capturedSchema = s;
        return s;
      };
      schemaCatcher.Types = mongoose.Schema.Types;
      schemaCatcher.ObjectId = mongoose.Schema.ObjectId;

      const sandbox = {
        mongoose: {
          ...mongoose,
          Schema: schemaCatcher,
          model: () => {},
          models: {},
        },
        console: console,
        require: () => {
          return {};
        },
      };

      vm.createContext(sandbox);
      try {
        vm.runInContext(cleanedCode, sandbox);
      } catch (err) {
        throw new Error(`Schema parsing error: ${err.message}`);
      }

      if (!capturedSchema) {
        throw new Error(
          "Could not find a valid 'new mongoose.Schema(...)' in your code.",
        );
      }

      const schema = capturedSchema;

      // Clear mongoose models to prevent Next.js style caching
      for (const key in mongoose.models) delete mongoose.models[key];
      for (const key in mongoose.modelSchemas)
        delete mongoose.modelSchemas[key];

      connection = await mongoose.createConnection(uri).asPromise();
      Model = connection.model(collectionName, schema, collectionName); // force collection name
      db = connection.db;
    } else {
      connection = new MongoClient(uri);
      await connection.connect();
      db = connection.db();
    }

    const col = db.collection(collectionName);

    let docs = [];
    if (rawJson) {
      const parsed = JSON.parse(rawJson);
      docs = (Array.isArray(parsed) ? parsed : [parsed]).map((d) =>
        EJSON.deserialize(d),
      );
    } else {
      const filePath = path.join(baseDir, "data", date, file);
      const format = filePath.endsWith(".csv") ? "csv" : "json";
      const content = fs.readFileSync(filePath, "utf8");

      if (format === "json") {
        const parsed = JSON.parse(content);
        docs = (Array.isArray(parsed) ? parsed : [parsed]).map((d) =>
          EJSON.deserialize(d),
        );
      } else if (format === "csv") {
        const lines = content.split("\n").filter((l) => l.trim());
        const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, ""));
        docs = lines.slice(1).map((line) => {
          const values = line.split(",").map((v) => v.replace(/^"|"$/g, ""));
          const doc = {};
          headers.forEach((h, i) => {
            doc[h] = values[i];
          });
          return doc;
        });
      }
    }

    // PRE-FLIGHT DUPLICATE CHECKS

    // 1. Check for duplicate _id values within the uploaded file itself
    const fileIdSet = new Set();
    for (const d of docs) {
      if (!d._id) continue;
      const idStr = d._id.toString();
      if (fileIdSet.has(idStr)) {
        throw new Error(
          `Upload aborted: Duplicate _id '${idStr}' found within your file.`,
        );
      }
      fileIdSet.add(idStr);
    }

    // 2. Drop or check database
    if (dropCollection) {
      try {
        await col.drop();
      } catch (err) {
        if (err.code !== 26) {
          // 26 = ns not found
          throw err;
        }
      }
    } else {
      // If not dropping, check if any _id from the file already exists in the database
      const docIds = docs.map((d) => d._id).filter(Boolean);
      if (docIds.length > 0) {
        const existing = await col.findOne(
          { _id: { $in: docIds } },
          { projection: { _id: 1 } },
        );
        if (existing) {
          throw new Error(
            `Upload aborted: Document with _id '${existing._id}' already exists in the database. Please check "Drop existing data" or remove duplicates from your file.`,
          );
        }
      }
    }

    res.write(JSON.stringify({ type: "init", total: docs.length }) + "\n");

    let count = 0;
    const BATCH_SIZE = 500;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);
      if (Model) {
        await Model.insertMany(batch);
      } else {
        await col.insertMany(batch);
      }
      count += batch.length;
      res.write(
        JSON.stringify({
          type: "progress",
          current: count,
          total: docs.length,
        }) + "\n",
      );
    }

    res.write(
      JSON.stringify({ type: "done", current: count, total: docs.length }) +
        "\n",
    );
  } catch (e) {
    res.write(JSON.stringify({ type: "error", message: e.message }) + "\n");
  } finally {
    if (connection) {
      if (connection.close) await connection.close();
      else if (connection.disconnect) await connection.disconnect();
    }
    if (tempSchemaPath && fs.existsSync(tempSchemaPath)) {
      fs.unlinkSync(tempSchemaPath);
    }
    res.end();
  }
});

// ─── Preview Saved File ───────────────────────────────────────────────────────

app.get("/api/preview/:date/:file", (req, res) => {
  const filePath = path.join(baseDir, "data", req.params.date, req.params.file);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "File not found" });

  try {
    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath, "utf8");

    if (ext === ".json") {
      const data = JSON.parse(content);
      // Return first 5000 docs for preview
      res.json({
        success: true,
        docs: Array.isArray(data) ? data.slice(0, 5000) : [data],
      });
    } else if (ext === ".csv") {
      const lines = content.split("\n").filter((l) => l.trim());
      const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, ""));
      const docs = lines.slice(1, 5001).map((line) => {
        const values = line.split(",").map((v) => v.replace(/^"|"$/g, ""));
        const doc = {};
        headers.forEach((h, i) => {
          doc[h] = values[i];
        });
        return doc;
      });
      res.json({ success: true, docs });
    } else {
      res.status(400).json({ error: "Unsupported format" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 MongoDB Extractor running at http://localhost:${PORT}`);
  open(`http://localhost:${PORT}`);
});
