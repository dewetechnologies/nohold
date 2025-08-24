const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const multer = require("multer");
require("dotenv").config();

const User = require("./models/User");
const House = require("./models/House");
const Query = require("./models/Query");

const app = express();
const server = http.createServer(app);
let io; // will initialize after app setup
const PORT = process.env.PORT || 3000;

// set ejs as view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// serve static assets from /public
app.use(express.static(path.join(__dirname, "public")));

// parse form submissions
app.use(express.urlencoded({ extended: true }));

// Simple middleware to expose user context into views
app.use((req, res, next) => {
  const { userId, firstName, lastName, email, phone } = req.query || {};
  res.locals.userId = userId;
  res.locals.user = firstName || lastName || email || phone ? { firstName, lastName, email, phone } : null;
  res.locals.supportTel = process.env.SUPPORT_TEL || '';
  next();
});

// --- Socket.IO: NoHold AI chat ---
try {
  const { Server } = require("socket.io");
  io = new Server(server, {
    cors: { origin: false },
  });

  function generateBotReply(text) {
    const t = String(text || '').toLowerCase();
    if (t.includes('bill') || t.includes('charge')) {
      return 'I can help with billing. Do you want to query a bill or set up a payment arrangement?';
    }
    if (t.includes('internet') || t.includes('fibre') || t.includes('slow')) {
      return 'For internet issues, try restarting your router. If the problem persists, I can create a ticket. Would you like me to do that?';
    }
    if (t.includes('sim') || t.includes('puk')) {
      return 'For SIM and PUK assistance, please have your ID number ready. Would you like me to connect you to an agent?';
    }
    return "I’m NoHold. I can route billing, technical, or account queries. Tell me more about your issue.";
  }

  io.on('connection', (socket) => {
    socket.on('nohold:message', (payload = {}) => {
      // show typing indicator briefly
      socket.emit('nohold:typing', true);
      setTimeout(() => {
        socket.emit('nohold:typing', false);
        socket.emit('nohold:reply', { text: generateBotReply(payload.text) });
      }, 700);
    });
  });
} catch (e) {
  console.warn('Socket.IO not available. Skipping realtime chat. Error:', e.message);
}

// User: rate a completed query (1-5)
app.post('/queries/:id/rate', async (req, res) => {
  try {
    const { id } = req.params;
    const { rating } = req.body || {};
    // Prevent resubmission if rating already exists
    const existing = await Query.findById(id).select('rating').lean();
    const back = req.headers.referer || '/dashboard';
    if (existing && existing.rating !== undefined && existing.rating !== null) {
      return res.redirect(back);
    }
    let r = parseInt(rating, 10);
    if (Number.isNaN(r)) r = undefined;
    if (r !== undefined) {
      if (r < 1) r = 1;
      if (r > 5) r = 5;
    }
    await Query.findByIdAndUpdate(id, { rating: r });
    return res.redirect(back);
  } catch (e) {
    console.error('Rate query error:', e);
    return res.status(500).send('Internal Server Error');
  }
});

// connect to MongoDB
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error("MONGODB_URI is not set in .env");
} else {
  mongoose
    .connect(mongoUri)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch((err) => console.error("❌ MongoDB connection error:", err));
}

// ensure uploads directory exists
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// multer setup for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, "_");
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only image uploads are allowed"));
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// route
app.get("/", (req, res) => {
  res.render("index", { message: "Hello Full Stack 🚀" });
});

// signup page
app.get("/signup", (req, res) => {
  res.render("signup");
});

// contact page
app.get("/contact", (req, res) => {
  const { success } = req.query;
  res.render("contact", { success });
});

// about page
app.get("/about", (req, res) => {
  res.render("about");
});

// handle signup submit (placeholder)
app.post("/signup", async (req, res) => {
  try {
    const { firstName, lastName, phone, email, password, address1, houseNumber, suburb, city } = req.body;
    if (!firstName || !lastName || !phone || !email || !password) {
      return res.status(400).send("Missing required fields");
    }

    const existing = await User.findOne({ $or: [{ email: email.toLowerCase() }, { phone }] });
    if (existing) {
      return res.status(409).send("User with this email or phone already exists");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await User.create({ firstName, lastName, phone, email: email.toLowerCase(), passwordHash, address1, houseNumber, suburb, city });
    return res.redirect("/signin");
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

// signin page
app.get("/signin", (req, res) => {
  res.render("signin");
});

// handle signin submit (placeholder)
app.post("/signin", async (req, res) => {
  try {
    const { identifier, password } = req.body; // identifier can be email or phone
    if (!identifier || !password) return res.status(400).send("Missing credentials");

    const user = await User.findOne({
      $or: [
        { email: identifier.toLowerCase() },
        { phone: identifier }
      ],
    });

    if (!user) return res.status(401).send("Invalid credentials");

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).send("Invalid credentials");

    // Demo: redirect to dashboard with basic user info (no session yet)
    const qs = new URLSearchParams({
      userId: user._id.toString(),
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
    }).toString();
    return res.redirect(`/dashboard?${qs}`);
  } catch (err) {
    console.error("Signin error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

// simple logout: redirect to home (no session yet)
app.get("/logout", (req, res) => {
  return res.redirect("/");
});

// --- Admin minimal auth (cookie-based, no extra deps) ---
function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, part) => {
    const [k, ...v] = part.trim().split('=');
    if (!k) return acc;
    acc[k] = decodeURIComponent(v.join('='));
    return acc;
  }, {});
}

const ADMIN_EMAIL = 'smetchappy@gmail.com';
const ADMIN_PASS = 'securepassword123';

function ensureAdmin(req, res, next) {
  const cookies = parseCookies(req);
  if (cookies.admin_auth === '1') return next();
  return res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  const { error } = req.query;
  res.render('admin-login', { error });
});

app.post('/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
    res.setHeader('Set-Cookie', 'admin_auth=1; HttpOnly; Path=/; SameSite=Lax');
    return res.redirect('/admin');
  }
  return res.redirect('/admin/login?error=Invalid%20credentials');
});

app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  return res.redirect('/');
});

// Admin: list queries and allow updates
app.get("/admin", ensureAdmin, async (req, res) => {
  try {
    const queries = await Query.find({}).sort({ createdAt: -1 }).lean();
    // attach latest house image for each query's user
    const withHouse = [];
    for (const q of queries) {
      let house = null;
      if (q.userId) {
        try {
          house = await House.findOne({ userId: q.userId }).sort({ createdAt: -1 }).lean();
        } catch (e) {}
      }
      withHouse.push({ ...q, __house: house || null });
    }
    res.render("admin", { queries: withHouse });
  } catch (e) {
    console.error("Admin load error:", e);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/admin/queries/:id", ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, etaMinutes } = req.body;
    const update = {};
    if (status === 'waiting' || status === 'completed') update.status = status;
    if (etaMinutes !== undefined && etaMinutes !== null && etaMinutes !== '') {
      const v = parseInt(etaMinutes, 10);
      if (!Number.isNaN(v) && v >= 0) update.etaMinutes = v;
    } else {
      update.etaMinutes = undefined;
    }
    await Query.findByIdAndUpdate(id, update, { new: false });
    return res.redirect('/admin');
  } catch (e) {
    console.error('Update query error:', e);
    return res.status(500).send('Internal Server Error');
  }
});

// Dashboard (temporary: reads user info from querystring)
app.get("/dashboard", async (req, res) => {
  const { userId, firstName, lastName, email, phone, success } = req.query;
  const userFromQuery = firstName || lastName || email || phone ? { firstName, lastName, email, phone } : null;
  let houses = [];
  let queries = [];
  if (userId) {
    try {
      houses = await House.find({ userId }).sort({ createdAt: -1 }).lean();
      queries = await Query.find({ userId }).sort({ createdAt: -1 }).lean();
    } catch (e) {
      console.error("Dashboard load error:", e);
    }
  }
  res.render("dashbaoard", { user: userFromQuery, userId, houses, queries, success });
});

// Accept dashboard query submissions (temporary in-memory/logging only)
app.post("/queries", async (req, res) => {
  const { userId, firstName, lastName, email, phone, topic, details } = req.body;
  try {
    await Query.create({ userId, firstName, lastName, email, phone, topic, details });
  } catch (e) {
    console.error("Save query error:", e);
  }
  const qs = new URLSearchParams({
    success: "1",
    userId: userId || "",
    firstName: firstName || "",
    lastName: lastName || "",
    email: email || "",
    phone: phone || "",
  }).toString();
  return res.redirect(`/dashboard?${qs}`);
});

// Create house with image
app.post("/houses", upload.single("image"), async (req, res) => {
  try {
    const { userId, address1, houseNumber, suburb, city, firstName, lastName, email, phone } = req.body;
    if (!userId) return res.status(400).send("Missing userId");
    const imagePath = req.file ? `/uploads/${req.file.filename}` : "";
    await House.create({ userId, address1, houseNumber, suburb, city, imagePath });
    const qs = new URLSearchParams({ userId, firstName, lastName, email, phone }).toString();
    return res.redirect(`/dashboard?${qs}`);
  } catch (err) {
    console.error("Create house error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

// Replace house image
app.post("/houses/:id/image", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, firstName, lastName, email, phone } = req.body;
    const house = await House.findById(id);
    if (!house) return res.status(404).send("House not found");
    // delete old file if exists
    if (house.imagePath) {
      const absoluteOld = path.join(__dirname, "public", house.imagePath.replace(/^\/+/, ""));
      fs.unlink(absoluteOld, () => {});
    }
    const newPath = req.file ? `/uploads/${req.file.filename}` : house.imagePath;
    house.imagePath = newPath;
    await house.save();
    const qs = new URLSearchParams({ userId, firstName, lastName, email, phone }).toString();
    return res.redirect(`/dashboard?${qs}`);
  } catch (err) {
    console.error("Replace image error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

// (server and io were initialized above)

// start server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
});