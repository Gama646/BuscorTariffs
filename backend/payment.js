// server/routes/payment.js
//
// PayFast payment integration for Buscor trip refills.
// Plugs into the existing purchasesCollection / tripsCollection / cardsCollection
// that are created and connected in index.js.
//
// Usage in index.js (after your MongoDB connection block resolves):
//
//   const buildPaymentRouter = require('./routes/payment');
//   app.use('/api/payment', buildPaymentRouter({ cardsCollection, tripsCollection, purchasesCollection }));
//
// IMPORTANT: collections are injected as a function argument because in your
// current index.js they are assigned asynchronously inside the MongoClient
// .then() block. Requiring this file and mounting it AFTER that block resolves
// (or passing getters) avoids the "collection is undefined" issue.

const express = require('express');
const crypto = require('crypto');
const querystring = require('querystring');

function normalizeAliasNo(aliasNo) {
  return String(aliasNo || '').trim().replace(/[-\s]/g, '');
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

// Builds the MD5 signature PayFast requires, in the exact key order supplied.
// PayFast signature rules: do NOT alphabetically sort — use the order the
// fields were added to the form. Empty values are excluded.
function generateSignature(data, passphrase) {
  let pairs = [];
  for (const key in data) {
    if (data[key] !== '' && data[key] !== undefined && data[key] !== null) {
      pairs.push(`${key}=${encodeURIComponent(String(data[key]).trim()).replace(/%20/g, '+')}`);
    }
  }
  let str = pairs.join('&');
  if (passphrase) {
    str += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
  }
  return crypto.createHash('md5').update(str).digest('hex');
}

module.exports = function buildPaymentRouter({ cardsCollection, tripsCollection, purchasesCollection }) {
  const router = express.Router();

  const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
  const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;
  const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE || '';
  const PAYFAST_SANDBOX = process.env.PAYFAST_SANDBOX !== 'false'; // default true
  const BASE_URL = process.env.BASE_URL; // e.g. your ngrok URL
  const PAYFAST_HOST = PAYFAST_SANDBOX
    ? 'https://sandbox.payfast.co.za/eng/process'
    : 'https://www.payfast.co.za/eng/process';

  // ---------------------------------------------------------------------
  // STEP 1: Initiate payment.
  // Frontend calls this after the user picks Area/From/To/TicketType and
  // clicks "Pay". We validate the alias + trip server-side (never trust the
  // amount the frontend sends), create a "pending" purchase record, and
  // return the exact PayFast form fields + signature for the frontend to
  // auto-submit.
  // ---------------------------------------------------------------------
  router.post('/initiate', async (req, res) => {
    try {
      const { aliasNo, area, from, to, ticketType } = req.body;

      if (!aliasNo || !area || !from || !to || !ticketType) {
        return res.status(400).json({
          success: false,
          message: 'aliasNo, area, from, to and ticketType are all required.'
        });
      }

      const normalized = normalizeAliasNo(aliasNo);

      // 1. Validate the card exists and is active
      const card = await cardsCollection.findOne(aliasQuery(normalized));
      if (!card) {
        return res.status(404).json({ success: false, message: 'Alias number not found in system.' });
      }
      if (card.isActive === false) {
        return res.status(403).json({ success: false, message: 'This card is inactive or blocked.' });
      }

      // 2. Look up the trip + recalculate the price server-side.
      //    NEVER trust an amount sent from the frontend.
      const trip = await tripsCollection.findOne({ area, from, to });
      if (!trip) {
        return res.status(404).json({ success: false, message: 'Route not found.' });
      }

      const amount = trip.prices ? trip.prices[ticketType] : trip[ticketType];
      if (!amount) {
        return res.status(404).json({ success: false, message: 'Ticket type not found for this route.' });
      }

      // 3. Create the pending purchase record
      const txId = crypto.randomUUID ? crypto.randomUUID() : `tx_${Date.now()}`;

      const purchase = {
        txId,
        aliasNo: normalized,
        cardRef: card._id || null,
        trip: { area, from, to, ticketType },
        amount,
        status: 'pending',
        createdAt: new Date()
      };
      await purchasesCollection.insertOne(purchase);

      // 4. Build the PayFast payload.
      //    Field order matters for the signature — keep it consistent.
      const payfastData = {
        merchant_id: PAYFAST_MERCHANT_ID,
        merchant_key: PAYFAST_MERCHANT_KEY,
        return_url: `${BASE_URL}/payment-success.html?tx=${txId}`,
        cancel_url: `${BASE_URL}/payment-cancelled.html?tx=${txId}`,
        notify_url: `${BASE_URL}/api/payment/itn`,
        m_payment_id: txId,
        amount: Number(amount).toFixed(2),
        item_name: `Buscor ${ticketType} Ticket`,
        item_description: `${from} to ${to} (${area})`
      };

      const signature = generateSignature(payfastData, PAYFAST_PASSPHRASE);

      return res.status(200).json({
        success: true,
        txId,
        payfastHost: PAYFAST_HOST,
        fields: { ...payfastData, signature }
      });

    } catch (err) {
      console.error('Payment initiate error:', err);
      return res.status(500).json({ success: false, message: 'Server error initiating payment.' });
    }
  });

  // ---------------------------------------------------------------------
  // STEP 2: ITN (Instant Transaction Notification) webhook.
  // PayFast calls this server-to-server after the user pays (or fails to).
  // This must NOT be exposed/trusted blindly — verify everything.
  // ---------------------------------------------------------------------
  router.post('/itn', express.urlencoded({ extended: false }), async (req, res) => {
    // Always respond 200 quickly so PayFast doesn't retry endlessly,
    // but only after we've safely processed (or rejected) the notification.
    try {
      const data = req.body;
      const txId = data.m_payment_id;

      const purchase = await purchasesCollection.findOne({ txId });
      if (!purchase) {
        console.warn('ITN received for unknown txId:', txId);
        return res.status(200).send('OK'); // acknowledge, nothing to do
      }

      // Idempotency: if we've already processed this purchase, stop here.
      if (purchase.status === 'paid' || purchase.status === 'failed') {
        return res.status(200).send('OK');
      }

      // 1. Verify signature
      const receivedSignature = data.signature;
      const dataForSig = { ...data };
      delete dataForSig.signature;
      const expectedSignature = generateSignature(dataForSig, PAYFAST_PASSPHRASE);

      if (receivedSignature !== expectedSignature) {
        console.error('ITN signature mismatch for txId:', txId);
        await purchasesCollection.updateOne(
          { txId },
          { $set: { status: 'failed', failReason: 'signature_mismatch', updatedAt: new Date() } }
        );
        return res.status(200).send('OK');
      }

      // 2. Verify amount matches what we calculated server-side at initiate time
      const expectedAmount = Number(purchase.amount).toFixed(2);
      if (Number(data.amount_gross).toFixed(2) !== expectedAmount) {
        console.error('ITN amount mismatch for txId:', txId);
        await purchasesCollection.updateOne(
          { txId },
          { $set: { status: 'failed', failReason: 'amount_mismatch', updatedAt: new Date() } }
        );
        return res.status(200).send('OK');
      }

      // 3. Check payment status
      if (data.payment_status === 'COMPLETE') {
        await purchasesCollection.updateOne(
          { txId },
          {
            $set: {
              status: 'paid',
              paidAt: new Date(),
              payfastPaymentId: data.pf_payment_id || null,
              updatedAt: new Date()
            }
          }
        );
        // NOTE: this is where you'd call Buscor's real smartcard API
        // to actually load the trips onto the card, once that endpoint exists.
      } else {
        // FAILED, CANCELLED, etc.
        await purchasesCollection.updateOne(
          { txId },
          { $set: { status: 'failed', failReason: data.payment_status, updatedAt: new Date() } }
        );
      }

      return res.status(200).send('OK');

    } catch (err) {
      console.error('ITN processing error:', err);
      // Still 200 — PayFast just needs acknowledgment; we log internally.
      return res.status(200).send('OK');
    }
  });

  // ---------------------------------------------------------------------
  // STEP 3: Frontend polls this to find out what happened.
  // No login needed — txId is the only identifier, generated server-side
  // and only known to the user who initiated this specific payment.
  // ---------------------------------------------------------------------
  router.get('/status/:txId', async (req, res) => {
    try {
      const purchase = await purchasesCollection.findOne({ txId: req.params.txId });
      if (!purchase) {
        return res.status(404).json({ success: false, message: 'Transaction not found.' });
      }

      return res.status(200).json({
        success: true,
        status: purchase.status, // 'pending' | 'paid' | 'failed'
        failReason: purchase.failReason || null,
        txId: purchase.txId
      });
    } catch (err) {
      console.error('Status check error:', err);
      return res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  // ---------------------------------------------------------------------
  // STEP 4: Slip download — only available once status is "paid".
  // ---------------------------------------------------------------------
  router.get('/slip/:txId', async (req, res) => {
    try {
      const purchase = await purchasesCollection.findOne({ txId: req.params.txId });
      if (!purchase) {
        return res.status(404).json({ success: false, message: 'Transaction not found.' });
      }
      if (purchase.status !== 'paid') {
        return res.status(403).json({ success: false, message: 'Payment not completed yet.' });
      }

      const slip = {
        txId: purchase.txId,
        aliasNo: purchase.aliasNo,
        trip: purchase.trip,
        amount: purchase.amount,
        paidAt: purchase.paidAt,
        status: 'PAID'
      };

      return res.status(200).json({ success: true, slip });
    } catch (err) {
      console.error('Slip fetch error:', err);
      return res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  return router;
};
