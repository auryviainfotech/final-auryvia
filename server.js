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

// --- 2. EMAIL CONFIGURATION (FIXED FOR RENDER) ---
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,              // FIX 1: Use 587 (TLS) instead of 465
    secure: false,          // FIX 2: Must be false for port 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    },
    tls: {
        rejectUnauthorized: false
    },
    family: 4,              // FIX 3: Force IPv4 (Crucial for Node 22+ on Render)
    logger: true,           // Helpful for debugging
    debug: true
});

// Test email connection on startup (non-blocking)
// Don't block server startup if email fails
setTimeout(() => {
    transporter.verify(function(error, success) {
        if (error) {
            console.log('⚠️  Email connection failed:', error.message);
            console.log('   → Emails will be disabled. App will continue to work normally.');
            console.log('   → Check: Gmail App Password, firewall rules, or use alternative email service.');
        } else {
            console.log('✅ Email server is ready to send messages');
        }
    });
}, 2000); // Wait 2 seconds after server starts

// Helper Function to Send Emails
// Gracefully handles failures - app continues even if email fails
async function sendEmailAlert(subject, text) {
    // Skip if email credentials are missing
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        console.log('⚠️  Email skipped: Missing EMAIL_USER or EMAIL_PASSWORD in environment');
        return;
    }

    try {
        // Use EMAIL_TO if set, otherwise fallback to EMAIL_USER
        const recipientEmail = process.env.EMAIL_TO || process.env.EMAIL_USER;
        
        const mailOptions = {
            from: `"Ayurvia Bot" <${process.env.EMAIL_USER}>`,
            to: recipientEmail, // Recipient email address
            subject: `🔔 ${subject}`,
            text: text
        };
        
        // Set a timeout for the email send operation
        const emailPromise = transporter.sendMail(mailOptions);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Email send timeout after 20 seconds')), 20000)
        );
        
        const info = await Promise.race([emailPromise, timeoutPromise]);
        console.log(`📧 Email sent: ${subject} → ${recipientEmail} (Message ID: ${info.messageId})`);
    } catch (error) {
        // Log error but don't throw - allow app to continue
        console.error('❌ Email Failed:', error.message);
        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNECTION' || error.message.includes('timeout')) {
            console.error('   → Connection timeout. This is common on cloud platforms.');
            console.error('   → Consider using SendGrid, Mailgun, or AWS SES for production.');
        } else if (error.code === 'EAUTH') {
            console.error('   → Authentication failed. Check EMAIL_USER and EMAIL_PASSWORD in .env');
        }
        // Don't throw - app should continue working even if email fails
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
