// ------------------------------
// Video Reaction Recorder Server
// ------------------------------
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------
// View Engine Setup (EJS)
// ------------------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ------------------------------
// Middleware & Static Files
// ------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ------------------------------
// Ensure upload directories exist
// ------------------------------
["public/uploads", "public/recordings"].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ------------------------------
// Multer Setup
// ------------------------------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, "public/uploads/"),
  filename: (_, file, cb) =>
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});

const fileFilter = (_, file, cb) => {
  if (file.mimetype.startsWith("video/")) cb(null, true);
  else cb(new Error("Only video files are allowed!"), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// ------------------------------
// Routes
// ------------------------------
app.get("/", (_, res) => {
  res.render("index"); // renders views/index.ejs
});
app.get("/port", (_, res) => {
  res.render("port"); // renders views/index.ejs
});

// ------------------------------
app.get("/test", (_, res) => {
  res.render("test"); // renders views/index.ejs
});

app.post("/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file uploaded" });
  }
  res.json({
    message: "Video uploaded successfully",
    videoUrl: `/uploads/${req.file.filename}`,
    filename: req.file.filename,
  });
});

// ------------------------------
// Error Handling
// ------------------------------
app.use((err, _, res, __) => {
  console.error("Server Error:", err.message);
  res.status(500).json({ error: err.message || "Something went wrong!" });
});

// ------------------------------
// Start Server
// ------------------------------
app.listen(PORT, () => {
  console.log(`✅ Running on http://localhost:${PORT}`);
});
