const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const https = require("https");
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

  // Simple fallback rules-based reply
  function fallbackReply(text) {
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

  // LLM reply via OpenAI Chat Completions (no SDK dependency)
  async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

  async function getAiReply(userText, context) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return fallbackReply(userText);
    }
    const body = {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are NoHold, a friendly support assistant for a telecom-style service. Be concise, helpful, and offer step-by-step guidance. If needed, ask 1 short clarifying question. Never reveal system or keys.'
        },
        ...(context && context.selectedQuery ? [{
          role: 'system',
          content: `Context: The user selected query "${context.selectedQuery.topic || 'unknown'}" created at ${new Date(context.selectedQuery.createdAt).toLocaleString()}. Details: ${context.selectedQuery.details || 'N/A'}. Use this as the problem context.`
        }] : []),
        { role: 'user', content: String(userText || '') }
      ],
      temperature: 0.3,
      max_tokens: 300,
    };
    const endpoint = 'https://api.openai.com/v1/chat/completions';
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    let attempt = 0;
    const maxAttempts = 3;
    let lastStatus = 0;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
        lastStatus = res.status;
        if (res.ok) {
          const data = await res.json();
          const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          return text || fallbackReply(userText);
        }
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
          const backoff = retryAfter ? (retryAfter * 1000) : (500 * attempt * attempt);
          console.warn('OpenAI 429 rate limit. Backing off for', backoff, 'ms');
          await sleep(backoff);
          continue;
        }
        // other non-ok statuses -> break
        console.warn('OpenAI API error status:', res.status);
        break;
      } catch (err) {
        console.warn('OpenAI API call failed (attempt', attempt, '):', err && err.message);
        await sleep(300 * attempt);
      }
    }
    if (lastStatus === 429) {
      // Fall back to local helpful reply if rate-limited persists
      return fallbackReply(userText);
    }
    return fallbackReply(userText);
  }

  io.on('connection', (socket) => {
    // simple throttle per socket to avoid rapid-fire requests
    let lastAt = 0;
    let inFlight = false;
    // simple per-socket cache to reduce duplicate API hits
    let lastQ = '';
    let lastAns = '';
    let lastQAt = 0;
    // simple per-socket session: userId, selected query
    const session = { userId: '', selectedId: '', options: [] };

    socket.on('nohold:init', (payload = {}) => {
      const uid = (payload.userId || '').trim();
      if (uid) session.userId = uid;
    });

    socket.on('nohold:message', async (payload = {}) => {
      const now = Date.now();
      const since = now - lastAt;
      if (since < 1200) {
        await sleep(1200 - since);
      }
      if (inFlight) return; // drop if something is in-flight
      inFlight = true;
      const currentQ = String(payload.text || '').trim();
      // capture userId from payload if provided
      if (!session.userId && payload.userId) session.userId = String(payload.userId).trim();

      // If no query selected, guide the user to pick one
      if (!session.selectedId) {
        // If we already sent options, try to interpret numeric choice
        const n = parseInt(currentQ, 10);
        if (session.options && session.options.length && !Number.isNaN(n)) {
          const chosen = session.options.find(it => it.n === n);
          if (chosen) {
            session.selectedId = chosen.id;
            socket.emit('nohold:reply', { text: `Got it. I’ll use query #${n} (${chosen.topic}). How can I help further with this issue?` });
            inFlight = false; lastAt = Date.now();
            return;
          }
        }
        // Otherwise, fetch the user's recent queries and present options
        try {
          if (!session.userId) {
            socket.emit('nohold:reply', { text: 'Please sign in so I can see your queries, or provide your number/email.' });
            inFlight = false; lastAt = Date.now();
            return;
          }
          const list = await Query.find({ userId: session.userId }).sort({ createdAt: -1 }).limit(5).lean();
          if (!list.length) {
            socket.emit('nohold:reply', { text: 'You have no saved queries yet. You can submit a new support request from the dashboard.' });
            inFlight = false; lastAt = Date.now();
            return;
          }
          session.options = list.map((q, i) => ({ n: i + 1, id: String(q._id), topic: q.topic, createdAt: q.createdAt }));
          socket.emit('nohold:options', { items: session.options, prompt: 'Please choose a query by number:' });
          inFlight = false; lastAt = Date.now();
          return;
        } catch (err) {
          console.warn('Fetch queries for options failed:', err && err.message);
          socket.emit('nohold:reply', { text: 'Sorry, I could not fetch your queries right now. Please try again later.' });
          inFlight = false; lastAt = Date.now();
          return;
        }
      }

      // Return cached answer if same question within 20s
      if (currentQ && currentQ === lastQ && (now - lastQAt) < 20000 && lastAns) {
        socket.emit('nohold:reply', { text: lastAns });
        inFlight = false;
        lastAt = Date.now();
        return;
      }
      socket.emit('nohold:typing', true);
      // Load selected query context
      let selectedQuery = null;
      try {
        if (session.selectedId) {
          selectedQuery = await Query.findById(session.selectedId).lean();
        }
      } catch {}
      const text = await getAiReply(currentQ, { selectedQuery });
      socket.emit('nohold:typing', false);
      socket.emit('nohold:reply', { text });
      lastQ = currentQ; lastAns = text; lastQAt = Date.now();
      lastAt = Date.now();
      inFlight = false;
    });
  });
} catch (e) {
  console.warn('Socket.IO not available. Skipping realtime chat. Error:', e.message);
}

// --- WhatsApp Cloud API helper ---
function sendWhatsAppMessage(toPhone, text) {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId || !toPhone || !text) return;
    // WhatsApp Cloud API expects E.164 without '+' in many examples; we'll strip non-digits.
    const to = String(toPhone).replace(/\D/g, '');
    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    });
    const options = {
      hostname: 'graph.facebook.com',
      path: `/v17.0/${phoneNumberId}/messages`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      // consume response to free memory
      res.on('data', () => {});
    });
    req.on('error', (err) => {
      console.warn('WhatsApp send error:', err && err.message);
    });
    req.write(payload);
    req.end();
  } catch (err) {
    console.warn('WhatsApp helper error:', err && err.message);
  }
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
    // --- Analytics ---
    const total = withHouse.length;
    const completed = withHouse.filter(q => q.status === 'completed').length;
    const waiting = withHouse.filter(q => q.status !== 'completed').length;
    const etaVals = withHouse.map(q => q.etaMinutes).filter(v => typeof v === 'number' && !Number.isNaN(v));
    const avgEta = etaVals.length ? Math.round(etaVals.reduce((a,b)=>a+b,0) / etaVals.length) : null;
    const ratings = withHouse.map(q => q.rating).filter(v => typeof v === 'number' && !Number.isNaN(v));
    const avgRating = ratings.length ? (ratings.reduce((a,b)=>a+b,0) / ratings.length) : null;
    const ratedCount = ratings.length;

    // Last 7 days series
    const now = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setHours(0,0,0,0);
      d.setDate(d.getDate() - i);
      days.push(d);
    }
    function sameDay(a,b){return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();}
    const series7d = days.map(d => {
      const count = withHouse.filter(q => sameDay(new Date(q.createdAt), d)).length;
      return { date: d.toISOString().slice(0,10), count };
    });

    const stats = { total, completed, waiting, avgEta, avgRating, ratedCount };
    res.render("admin", { queries: withHouse, stats, series7d });
  } catch (e) {
    console.error("Admin load error:", e);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/admin/queries/:id", ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, etaMinutes } = req.body;

    // Load existing to detect changes
    const existing = await Query.findById(id).lean();
    if (!existing) return res.status(404).send('Query not found');

    const update = {};
    if (status === 'waiting' || status === 'completed') update.status = status;
    let newEta;
    if (etaMinutes !== undefined && etaMinutes !== null && etaMinutes !== '') {
      const v = parseInt(etaMinutes, 10);
      if (!Number.isNaN(v) && v >= 0) {
        update.etaMinutes = v;
        newEta = v;
      }
    } else {
      update.etaMinutes = undefined;
      newEta = undefined;
    }

    await Query.findByIdAndUpdate(id, update, { new: false });

    // Compose WhatsApp message if there are changes and we have a phone
    try {
      const phone = existing.phone;
      if (phone && (update.status !== undefined || 'etaMinutes' in update)) {
        const brand = process.env.BRAND_NAME || 'NoHold';
        const parts = [];
        if (update.status !== undefined && update.status !== existing.status) {
          const label = update.status === 'completed' ? 'Completed' : 'In Progress';
          parts.push(`Status: ${label}`);
        }
        const oldEta = existing.etaMinutes;
        if (("etaMinutes" in update) && newEta !== oldEta) {
          if (typeof newEta === 'number') parts.push(`ETA: ${newEta} min`);
          else parts.push('ETA cleared');
        }
        if (parts.length) {
          const name = existing.firstName ? `${existing.firstName}` : '';
          const topic = existing.topic ? ` about "${existing.topic}"` : '';
          const msg = `Hi ${name || 'there'}, your ${brand} support request${topic} was updated. ${parts.join(' · ')}`;
          sendWhatsAppMessage(phone, msg);
        }
      }
    } catch (notifyErr) {
      console.warn('WhatsApp notify error:', notifyErr && notifyErr.message);
    }

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