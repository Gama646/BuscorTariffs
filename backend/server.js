const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const createPaymentRouter = require('./payment-routes');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URL = process.env.MONGODB_URL || process.env.MONGODB_URI;

// MongoDB client and collections
let cardsCollection;
let tripsCollection;
let purchasesCollection;

// Load trips data from project file
let seedTrips = [];
try {
  // generatedTrips.js exports the trips array
  seedTrips = require('../generatedTrips');
} catch (e) {
  console.warn('Could not load generatedTrips.js for seeding:', e.message);
}

// Helper function to normalize Alias_No input
function normalizeAliasNo(aliasNo) {
  return String(aliasNo || '')
    .trim()
    .replace(/[-\s]/g, '');
}

// Helper function to validate Alias_No format
function validateAliasNoFormat(aliasNo) {
  const normalized = normalizeAliasNo(aliasNo);
  return normalized.length > 0 && /^\d+$/.test(normalized);
}

function aliasQuery(normalized) {
  return {
    $or: [
      { Alias_No: normalized },
      { aliasNo: normalized },
      { AliasNo: normalized }
    ]
  };
}

// Connect to MongoDB
MongoClient.connect(MONGODB_URL, { useUnifiedTopology: true })
  .then(async (client) => {
    console.log('✓ Connected to MongoDB');
    const dbName = process.env.MONGODB_DB_NAME || 'BuscorTeriffs';
    const db = client.db(dbName);
    cardsCollection = db.collection('cards'); // existing cards collection
    tripsCollection = db.collection('trips');
    purchasesCollection = db.collection('purchases');

    // Seed trips collection if empty or count mismatch and seed data is available
    try {
      const count = await tripsCollection.countDocuments();
      if ((count === 0 || count !== seedTrips.length) && Array.isArray(seedTrips) && seedTrips.length > 0) {
        console.log(`Seeding: Database count ${count} doesn't match seed file count ${seedTrips.length}. Re-seeding...`);
        await tripsCollection.deleteMany({}); // clear old trips
        const docs = seedTrips.map((t) => ({ ...t, createdAt: new Date() }));
        await tripsCollection.insertMany(docs);
        console.log(`✓ Seeded ${docs.length} trips into the database`);
      } else {
        console.log(`✓ Trips collection has ${count} documents`);
      }
    } catch (seedErr) {
      console.error('Error while seeding trips:', seedErr.message);
    }

    // Mount payment routes only once the collections above are ready —
    // mounting earlier would capture them as undefined.
    app.use('/api/payment', createPaymentRouter({
      cardsCollection,
      tripsCollection,
      purchasesCollection,
      aliasQuery,
      normalizeAliasNo
    }));
    console.log('✓ Payment routes mounted at /api/payment (Ozow)');
  })
  .catch(error => {
    console.error('✗ Failed to connect to MongoDB:', error.message);
    process.exit(1);
  });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// API Route 1: Validate Alias_No and check if it exists in database
app.post('/api/cards/validate', async (req, res) => {
  const { aliasNo } = req.body;

  // Validate input
  if (!aliasNo) {
    return res.status(400).json({
      success: false,
      message: 'Alias number is required.',
      valid: false
    });
  }

  // Normalize alias number
  const normalized = normalizeAliasNo(aliasNo);

  // Check if alias number has valid format
  if (!validateAliasNoFormat(aliasNo)) {
    return res.status(400).json({
      success: false,
      message: 'Alias number format is invalid.',
      valid: false
    });
  }

  try {
    // Search for card by alias field in database
    const card = await cardsCollection.findOne(aliasQuery(normalized));

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Alias number not found in system.',
        valid: false
      });
    }

    // Check if card is active (you can add logic here based on your data)
    const isActive = card.isActive !== false; // Assume active unless explicitly set to false

    if (!isActive) {
      return res.status(403).json({
        success: false,
        message: 'This card appears to be inactive or blocked. Use another card or contact support.',
        valid: false
      });
    }

    // Card is valid and active — return minimal info
    return res.status(200).json({
      success: true,
      message: 'Alias number is valid and active.',
      valid: true,
      cardInfo: {
        aliasNo: card.Alias_No,
        isActive: isActive
      }
    });
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.',
      valid: false
    });
  }
});

// API Route 2: Get card details by Alias_No
app.get('/api/cards/:aliasNo', async (req, res) => {
  const { aliasNo } = req.params;
  const normalized = normalizeAliasNo(aliasNo);

  try {
    const card = await cardsCollection.findOne(aliasQuery(normalized));

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Alias number not found in system.'
      });
    }

    return res.status(200).json({
      success: true,
      card: {
        aliasNo: card.Alias_No || card.aliasNo || card.AliasNo,
        isActive: card.isActive !== false
      }
    });
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// API Route 4: Quick validation check by Alias_No
app.get('/api/cards/:aliasNo/check', async (req, res) => {
  const { aliasNo } = req.params;
  const normalized = normalizeAliasNo(aliasNo);

  try {
    const card = await cardsCollection.findOne(aliasQuery(normalized));

    if (!card) {
      return res.status(404).json({
        valid: false,
        message: 'Alias number not found.'
      });
    }

    const isActive = card.isActive !== false;

    return res.status(200).json({
      valid: isActive,
      message: isActive ? 'Alias number is active.' : 'Alias number is inactive.'
    });
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'Backend is running successfully.',
    database: cardsCollection ? 'Connected' : 'Disconnected'
  });
});

// Legacy purchase endpoint: create a purchase and return a slip
// NOTE: this is the original, unpaid "purchase" flow (no payment gateway
// involved). Kept here for backward compatibility, but for real payments
// use /api/payment/initiate (see payment-routes.js + ozow.js), which
// validates pricing server-side and confirms payment via Ozow's
// notification webhook before any trip/ticket is considered paid for.
app.post('/api/purchases', async (req, res) => {
  const { aliasNo, trip } = req.body;

  if (!aliasNo || !trip) {
    return res.status(400).json({ success: false, message: 'aliasNo and trip are required' });
  }

  try {
    // Validate alias
    const card = await cardsCollection.findOne(aliasQuery(normalizeAliasNo(aliasNo)));
    if (!card) return res.status(404).json({ success: false, message: 'Alias number not found' });

    // Find matching trip in database (match by from/to/ticketType)
    const query = {
      from: trip.from,
      to: trip.to,
      ticketType: trip.ticketType
    };
    const foundTrip = await tripsCollection.findOne(query) || trip;

    const { randomUUID } = require('crypto');
    const txId = (randomUUID && typeof randomUUID === 'function') ? randomUUID() : `tx_${Date.now()}`;

    const purchase = {
      aliasNo: String(aliasNo).trim(),
      cardRef: card._id || null,
      trip: foundTrip,
      amount: trip.amount || trip.price || 0,
      createdAt: new Date(),
      txId
    };

    const result = await purchasesCollection.insertOne(purchase);

    // Build a simple slip object to return
    const slip = {
      txId,
      aliasNo: purchase.aliasNo,
      holderName: card.holderName || null,
      trip: purchase.trip,
      amount: purchase.amount,
      purchasedAt: purchase.createdAt
    };

    return res.status(201).json({ success: true, slip });
  } catch (err) {
    console.error('Purchase error:', err);
    return res.status(500).json({ success: false, message: 'Server error during purchase' });
  }
});

// Get slip by transaction id (legacy /api/purchases flow)
app.get('/api/purchases/:txId', async (req, res) => {
  const { txId } = req.params;
  try {
    const purchase = await purchasesCollection.findOne({ txId });
    if (!purchase) return res.status(404).json({ success: false, message: 'Slip not found' });

    return res.status(200).json({ success: true, slip: purchase });
  } catch (err) {
    console.error('Get slip error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get trips with optional filters
app.get('/api/trips', async (req, res) => {
  try {
    const { area, from, to, ticketType, search } = req.query;

    const q = {};
    if (area && area !== 'All Areas') q.area = area;
    if (from) q.from = from;
    if (to) q.to = to;
    if (ticketType) q.ticketType = ticketType;

    // Basic text search across from and to if search provided
    let cursor;
    if (search) {
      const regex = new RegExp(search, 'i');
      cursor = tripsCollection.find({ $or: [{ from: regex }, { to: regex }, { area: regex }] });
    } else {
      cursor = tripsCollection.find(q);
    }

    const results = await cursor.toArray();
    return res.status(200).json({ success: true, trips: results });
  } catch (err) {
    console.error('Trips fetch error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`✓ Buscor backend server is running on http://localhost:${PORT}`);
  console.log(`✓ MongoDB Database: BuscorTeriffs`);
  console.log(`✓ API endpoints:`);
  console.log(`  POST /api/cards/validate - Validate Alias number (returns card info if valid)`);
  console.log(`  GET  /api/cards/:aliasNo - Get card details by Alias number`);
  console.log(`  GET  /api/cards/:aliasNo/check - Quick check if Alias number is active`);
  console.log(`  POST /api/payment/initiate - Start an Ozow payment for a trip`);
  console.log(`  POST /api/payment/notify - Ozow notification webhook (server-to-server)`);
  console.log(`  GET  /api/payment/status/:txId - Poll payment status`);
  console.log(`  GET  /api/payment/slip/:txId - Get paid slip`);
  console.log(`  GET  /api/health - Health check`);
});