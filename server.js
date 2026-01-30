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
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.log('❌ DB Error:', err.message));

// --- 2. EMAIL CONFIGURATION (STEALTH MODE) ---
// We do NOT use 'service: gmail' because it forces Port 465 (often blocked).
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,              // Standard TLS port
    secure: false,          // Must be false for 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    },
    tls: {
        ciphers: 'SSLv3',   // Helps bypass some strict firewall handshakes
        rejectUnauthorized: false
    },
    family: 4,              // Force IPv4
    debug: true             // Keep debug on to see what happens
});

// ❌ REMOVED: transporter.verify()
// We removed the startup check. We will only connect when a user actually sends a message.
// This prevents the "Startup Timeout" error in your logs.
console.log('✅ Email configuration loaded (Connection will open on demand)');

// Updated Helper Function (No 20s Limit)
async function sendEmailAlert(subject, text) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        console.log('⚠️  Email skipped: Missing credentials');
        return;
    }

    try {
        const recipientEmail = process.env.EMAIL_TO || process.env.EMAIL_USER;
        
        const mailOptions = {
            from: `"Ayurvia Bot" <${process.env.EMAIL_USER}>`,
            to: recipientEmail,
            subject: `🔔 ${subject}`,
            text: text
        };
        
        // Removed the "Promise.race" 20s timeout. Let Nodemailer handle timeouts.
        const info = await transporter.sendMail(mailOptions);
        console.log(`📧 Email sent successfully: ${info.messageId}`);
    } catch (error) {
        console.error('❌ Email Failed:', error.message);
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
io.on('connection', (socket) => {
  
  socket.on('admin_connected', async () => {
      const chats = await Chat.find({}).sort({ lastUpdated: -1 });
      socket.emit('admin_update_userlist', chats);
  });

  // User Join
  socket.on('user_join', async (userData) => {
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
        
        // 🔔 ALERT: New Chat Started
        sendEmailAlert(
            "New Chat Started!", 
            `User: ${userData ? userData.name : 'Guest'}\nHas started a conversation on the website.`
        );
      }

      const allChats = await Chat.find({}).sort({ lastUpdated: -1 });
      io.emit('admin_update_userlist', allChats);
    } catch (e) { console.error(e); }
  });

  // User Message
  socket.on('send_message', async (data) => {
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

  // Admin Logic
  socket.on('admin_join_chat', async (id) => { await Chat.findOneAndUpdate({ socketId: id }, { isAdminActive: true }); });
  socket.on('admin_leave_chat', async (id) => { await Chat.findOneAndUpdate({ socketId: id }, { isAdminActive: false }); });
  socket.on('admin_send_message', async (data) => {
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

// Contact Form
app.post('/api/contact', async (req, res) => {
  try {
    await new Contact(req.body).save();
    
    // 🔔 ALERT: New Contact Inquiry
    sendEmailAlert(
        "New Contact Inquiry", 
        `Name: ${req.body.name}\nEmail: ${req.body.email}\nSubject: ${req.body.subject}\nMessage: ${req.body.message}`
    );

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Appointment Booking
app.post('/api/appointments', async (req, res) => {
  try {
    await new Appointment(req.body).save();

    // 🔔 ALERT: New Appointment
    sendEmailAlert(
        "New Appointment Booked! 📅", 
        `Name: ${req.body.name}\nPhone: ${req.body.phone}\nType: ${req.body.type}\nDate: ${req.body.date}\nTime: ${req.body.slot.start}`
    );

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
