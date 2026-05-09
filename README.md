
# ⬡ MongoExtract

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-4EA94B?style=for-the-badge&logo=mongodb&logoColor=white)
![Express.js](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)

**MongoExtract** is a lightning-fast, portable, and web-based UI for extracting, previewing, and migrating MongoDB data. 

Whether you need to backup multiple collections, convert database documents to Excel-friendly CSVs, or migrate data to a new server with Mongoose schema validation, MongoExtract handles it all locally through a clean, terminal-inspired interface.

---

## ✨ Key Features

- 🚀 **Portable & Standalone**: Run it as a single `.exe` file with zero setup, or run it directly via Node.js.
- 📦 **Bulk Extraction**: Select multiple collections and stream them to disk simultaneously with real-time progress bars.
- 🔄 **Preserves BSON Types**: Uses `EJSON` to ensure complex types like `ObjectId`, `ISODate`, and `Decimal128` are not lost or corrupted during JSON export.
- 📊 **CSV / Excel Export**: Easily flatten and export your MongoDB documents to `.csv` format.
- 🔍 **Live Data Previewer**: A built-in, paginated table viewer with syntax highlighting to inspect your extracted data without leaving the app.
- 📥 **Smart Upload & Migration**: Drag-and-drop massive JSON/CSV files to restore or migrate data to a target database.
- 🛡️ **Mongoose Schema Validation**: Paste your Mongoose schema code directly into the UI to validate data *before* it gets inserted into the target database!
- 🛑 **Pre-flight Checks**: Automatically detects duplicate `_id` conflicts before starting an upload to prevent database corruption.

---

## 📥 Quick Start (Download the App)

The easiest way to use MongoExtract is to download the standalone executable. You **do not** need Node.js or MongoDB installed on your local machine to run this.

1. [**Download MongoExtract (.rar)**](https://drive.google.com/uc?export=download&id=1Og6Ot1i_VAsP0AK-sRc3t4qTRF40MHqB)
2. Extract the `.rar` file to a folder.
3. Double-click `mongo-extract.exe`.
4. A terminal will open, and your web browser will automatically launch the UI at `http://localhost:4001`.

*(Note: Extracted data will be saved in a `data/` folder right next to your `.exe` file).*

---

## 💻 Run from Source (For Developers)

If you prefer to run the tool from the source code, make sure you have [Node.js](https://nodejs.org/) installed, then follow these steps:

1. **Clone the repository**:
   ```bash
   git clone https://github.com/alaaelbana/mongo-extract.git
   cd mongo-extract
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the application**:
   ```bash
   npm start
   ```
   *(This runs `node index.js`. Your browser will open automatically).*

---

## 📖 How to Use

### 1. Connect & Save Profiles
Enter your standard MongoDB Connection String (e.g., `mongodb+srv://user:pass@cluster.mongodb.net/dbname`). You can save connection strings as "Profiles" in the sidebar to easily switch between your Dev, Staging, and Production databases.

### 2. Extracting Data
- Select one or more collections from the sidebar.
- Choose your format (**JSON** or **EXCEL/CSV**).
- *(Optional)* Provide a valid JSON filter (e.g., `{ "isActive": true }`).
- Click **EXTRACT**. The tool streams data directly to your local machine, keeping memory usage low even for multi-gigabyte collections.

### 3. Uploading / Restoring Data
Go to the **UPLOAD** tab to migrate data. 
- You can select a previously extracted file, paste raw JSON, or drag-and-drop a large file directly into the browser.
- Define a Target Database URI and Collection.
- *(Optional)* Paste your Mongoose `new Schema({...})` code. The tool runs a secure V8 Sandbox to validate your data against your actual backend schema during the upload process!

---

## 🔒 Privacy & Security

**MongoExtract is a 100% local tool.** 
- There are no cloud servers, no telemetry, and no tracking.
- Your database credentials and data never leave your local machine.
- Connection Profiles are saved entirely in your browser's local `localStorage`.

---

## 🛠️ Building the `.exe` yourself

We use [Bun](https://bun.sh/) to compile the source code into a lightning-fast executable. If you make changes to the code and want to build your own `.exe`:

```bash
# Ensure Bun is installed
bun build ./index.js --compile --minify --outfile mongo-extract.exe
```

---

## 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/alaaelbana/mongo-extract/issues).
