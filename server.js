/* ===============================
   SERVER.JS - WITH EMAIL ALERTS
   =============================== */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer'); // <--- NEW IMPORT
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname)); 

// --- 1. MONGODB CONNECTION ---
const MONGO_URI = process.env.MONGO_URI;
if (MONGO_URI && typeof MONGO_URI === 'string') {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.log('❌ DB Error:', err.message));
} else {
  console.log('⚠️ MONGO_URI not set. Add MONGO_URI in Render Dashboard → Environment. DB/API will not work until set.');
}

// --- 2. EMAIL CONFIGURATION ---
const hasEmailEnv = process.env.EMAIL_USER && process.env.EMAIL_PASSWORD;
const transporter = hasEmailEnv ? nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
}) : null;
if (!hasEmailEnv) {
  console.log('⚠️ EMAIL_USER/EMAIL_PASSWORD not set. Add them in Render Dashboard → Environment for contact/appointment alerts.');
}

const SITE_URL = process.env.SITE_URL || 'https://final-auryvia.onrender.com';
const CONTACT_PHONE = process.env.CONTACT_PHONE || '7207310635';

function getClientEmailFooter() {
  let s = '\n\n---\n';
  if (SITE_URL) s += `Website: ${SITE_URL}\n`;
  if (CONTACT_PHONE) s += `Call us: ${CONTACT_PHONE}\n`;
  return s || '\n';
}

async function sendEmailAlert(subject, text) {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: `"Ayurvia Bot" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      subject: `🔔 ${subject}`,
      text: text
    });
    console.log(`📧 Admin email sent: ${subject}`);
  } catch (error) {
    console.error('❌ Admin Email Failed:', error.message);
  }
}

async function sendEmailToClient(toEmail, subject, text) {
  if (!transporter || !toEmail || typeof toEmail !== 'string') return;
  const email = toEmail.trim().toLowerCase();
  if (!email) return;
  try {
    await transporter.sendMail({
      from: `"Auryvia Infotech" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: subject,
      text: text
    });
    console.log(`📧 Client email sent to: ${email}`);
  } catch (error) {
    console.error('❌ Client Email Failed:', error.message);
  }
}

// --- 3. DATABASE MODELS ---
const Chat = mongoose.model('Chat', new mongoose.Schema({
  socketId: String,
  name: { type: String, default: 'Guest' },
  email: { type: String, default: '' },
  messages: [{ sender: String, text: String, timestamp: { type: Date, default: Date.now } }],
  isAdminActive: { type: Boolean, default: false },
  lastUpdated: { type: Date, default: Date.now }
}));

const Contact = mongoose.model('Contact', new mongoose.Schema({
  name: String, email: String, subject: String, message: String, date: { type: Date, default: Date.now }
}));

const Appointment = mongoose.model('Appointment', new mongoose.Schema({
  name: String, email: String, phone: String, type: String, date: String, slot: Object, createdAt: { type: Date, default: Date.now }
}));

// --- 4. SOCKET.IO LOGIC ---
const dbReady = () => mongoose.connection.readyState === 1;

io.on('connection', (socket) => {

  socket.on('admin_connected', async () => {
    if (!dbReady()) {
      socket.emit('admin_update_userlist', []);
      return;
    }
    try {
      const chats = await Chat.find({}).sort({ lastUpdated: -1 });
      socket.emit('admin_update_userlist', chats);
    } catch (e) {
      console.error(e);
      socket.emit('admin_update_userlist', []);
    }
  });

  socket.on('user_join', async (userData) => {
    if (!dbReady()) return;
    try {
      const safeEmail = (userData && userData.email) ? userData.email.toLowerCase().trim() : '';
      let chat;

      if (safeEmail) chat = await Chat.findOne({ email: safeEmail });
      if (!chat) chat = await Chat.findOne({ socketId: socket.id });

      if (chat) {
        chat.socketId = socket.id;
        chat.name = userData ? userData.name : chat.name;
        if (safeEmail) chat.email = safeEmail;
        chat.isAdminActive = false; 
        await chat.save();
        socket.emit('chat_history', chat.messages);
      } else {
        chat = new Chat({ 
          socketId: socket.id,
          name: userData ? userData.name : 'Guest',
          email: safeEmail,
          isAdminActive: false 
        }); 
        await chat.save(); 

        const userName = userData ? userData.name : 'Guest';
        sendEmailAlert(
          "New Chat Started!",
          `User: ${userName}\nEmail: ${safeEmail || '-'}\nHas started a conversation on the website.`
        );

        if (safeEmail) {
          const clientBody =
            `Hi ${userName},\n\nThanks for reaching out. We have received your message and will get back to you shortly.\n\n` +
            `Continue the conversation or explore our site: ${SITE_URL}` +
            getClientEmailFooter();
          sendEmailToClient(safeEmail, "We received your message – Auryvia Infotech", clientBody);
        }
      }

      const allChats = await Chat.find({}).sort({ lastUpdated: -1 });
      io.emit('admin_update_userlist', allChats);
    } catch (e) { console.error(e); }
  });

  socket.on('send_message', async (data) => {
    if (!dbReady()) return;
    try {
        let chat = await Chat.findOne({ socketId: socket.id });
        if (!chat) chat = new Chat({ socketId: socket.id });

        chat.messages.push({ sender: 'user', text: data.message });
        chat.lastUpdated = Date.now();
        await chat.save();

        io.emit('admin_receive_message', { socketId: socket.id, message: data.message, sender: 'user' });
        const allChats = await Chat.find({}).sort({ lastUpdated: -1 });
        io.emit('admin_update_userlist', allChats);

        if (!chat.isAdminActive) {
            setTimeout(async () => {
                const botReply = getAutoReply(data.message);
                chat.messages.push({ sender: 'bot', text: botReply });
                await chat.save();
                socket.emit('receive_message', { text: botReply, sender: 'bot' });
                io.emit('admin_receive_message', { socketId: socket.id, message: botReply, sender: 'bot' });
            }, 1500);
        }
    } catch (e) { console.error(e); }
  });

  socket.on('admin_join_chat', async (id) => {
    if (!dbReady()) return;
    await Chat.findOneAndUpdate({ socketId: id }, { isAdminActive: true });
  });
  socket.on('admin_leave_chat', async (id) => {
    if (!dbReady()) return;
    await Chat.findOneAndUpdate({ socketId: id }, { isAdminActive: false });
  });
  socket.on('admin_send_message', async (data) => {
    if (!dbReady()) return;
    const chat = await Chat.findOne({ socketId: data.targetSocketId });
    if (chat) {
      chat.messages.push({ sender: 'admin', text: data.message });
      await chat.save();
      io.to(data.targetSocketId).emit('receive_message', { text: data.message, sender: 'admin' });
    }
  });
});

function getAutoReply(msg) {
  msg = msg.toLowerCase();
  if (msg.includes('price') || msg.includes('cost')) return "Our pricing depends on scope. Shall we book a call?";
  if (msg.includes('hello') || msg.includes('hi')) return "Hi! Welcome to Ayurvia. How can I help?";
  return "Thanks! An agent will be with you shortly.";
}

// --- 5. ADMIN LOGIN ---
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    const ADMIN_PASSWORD = process.env.ADMIN_PASS || "Ayurvia2026"; 
    if (password === ADMIN_PASSWORD) { res.json({ success: true }); } 
    else { res.json({ success: false }); }
});

// --- 6. API ROUTES WITH EMAIL ALERTS ---

// Contact Form – email both admin and client
app.post('/api/contact', async (req, res) => {
  try {
    await new Contact(req.body).save();

    const { name, email, subject, message } = req.body;
    const inquiryLink = `${SITE_URL}/services.html`;
    const contactLink = `${SITE_URL}/contact.html`;

    sendEmailAlert(
      "New Contact Inquiry",
      `Name: ${name}\nEmail: ${email}\nSubject: ${subject || '-'}\nMessage: ${message}`
    );

    const clientBody =
      `Hi ${name || 'there'},\n\nThank you for getting in touch. We have received your inquiry and will get back to you shortly.\n\n` +
      `What you asked about: ${subject || 'General inquiry'}\n` +
      `Related link: ${inquiryLink}\n` +
      `Or contact us again: ${contactLink}` +
      getClientEmailFooter();

    sendEmailToClient(email, "We received your inquiry – Auryvia Infotech", clientBody);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Appointment Booking – email both admin and client
app.post('/api/appointments', async (req, res) => {
  try {
    await new Appointment(req.body).save();

    const { name, email, phone, type, date, slot } = req.body;
    const slotStr = slot ? `${slot.start} - ${slot.end}` : '';

    sendEmailAlert(
      "New Appointment Booked! 📅",
      `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\nType: ${type}\nDate: ${date}\nTime: ${slotStr}`
    );

    const clientBody =
      `Hi ${name || 'there'},\n\nYour appointment request has been received.\n\n` +
      `Type: ${type || 'Meeting'}\nDate: ${date || '-'}\nTime: ${slotStr || '-'}\n\n` +
      `We will confirm shortly. You can also visit our website or call us:\n` +
      `View or book again: ${SITE_URL}` +
      getClientEmailFooter();

    sendEmailToClient(email, "Appointment request received – Auryvia Infotech", clientBody);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/dashboard-data', async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ date: -1 });
    const appointments = await Appointment.find().sort({ createdAt: -1 });
    res.json({ contacts, appointments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Server running on Port ${PORT}`);
});