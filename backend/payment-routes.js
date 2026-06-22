// backend/payment-routes.js
//
// Mount this in server.js with:
//   const createPaymentRouter = require('./payment-routes');
//   app.use('/api/payment', createPaymentRouter({ cardsCollection, tripsCollection, purchasesCollection, aliasQuery, normalizeAliasNo }));
//
// Requires these env vars (see .env.example):
//   PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE (optional),
//   PAYFAST_MODE ('sandbox' or 'live'), APP_BASE_URL, PUBLIC_BASE_URL

const express = require('express');
const { randomUUID } = require('crypto');
const querystring = require('querystring');
const {
  getPayfastHost,
  buildPaymentFields,
  verifyItnSignature,
  validateWithPayfast
} = require('./payfast');

function createPaymentRouter({ cardsCollection, tripsCollection, purchasesCollection, aliasQuery, normalizeAliasNo }) {
  const router = express.Router();

  const MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
  const MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;
  const PASSPHRASE = process.env.PAYFAST_PASSPHRASE || '';

  // PUBLIC_BASE_URL is the address PayFast can reach (e.g. your ngrok URL).
  // APP_BASE_URL is where the user's browser is redirected back to.
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
  const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:5000';

  if (!MERCHANT_ID || !MERCHANT_KEY) {
    console.warn('⚠ PAYFAST_MERCHANT_ID / PAYFAST_MERCHANT_KEY not set — payment routes will fail.');
  }
  if (!PUBLIC_BASE_URL) {
    console.warn('⚠ PUBLIC_BASE_URL not set — PayFast will not be able to reach your ITN webhook. Use ngrok locally.');
  }

  // ---------------------------------------------------------------
  // POST /api/payment/initiate
  // ---------------------------------------------------------------
  router.post('/initiate', async (req, res) => {
    const { aliasNo, area, from, to, ticketType } = req.body;

    if (!aliasNo || !from || !to || !ticketType) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    try {
      const normalized = normalizeAliasNo(aliasNo);
      const card = await cardsCollection.findOne(aliasQuery(normalized));
      if (!card) {
        return res.status(404).json({ success: false, message: 'Alias number not found in system.' });
      }
      if (card.isActive === false) {
        return res.status(403).json({ success: false, message: 'This card is inactive or blocked.' });
      }

      // Look up the trip to get the authoritative price — never trust amount from the client.
      const tripQuery = { from, to, ticketType };
      if (area && area !== 'All Areas') tripQuery.area = area;
      const trip = await tripsCollection.findOne(tripQuery);

      if (!trip) {
        return res.status(404).json({ success: false, message: 'No matching trip/fare found.' });
      }

      const amount = trip.amount || trip.price;
      if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid fare amount for this trip.' });
      }

      const txId = randomUUID();

      const purchase = {
        txId,
        aliasNo: normalized,
        cardRef: card._id || null,
        trip: { area: trip.area, from: trip.from, to: trip.to, ticketType: trip.ticketType },
        amount,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await purchasesCollection.insertOne(purchase);

      const fields = buildPaymentFields({
        txId,
        amount,
        itemName: `Buscor Ticket: ${trip.from} to ${trip.to}`,
        itemDescription: `Ticket type: ${trip.ticketType}`,
        returnUrl: `${APP_BASE_URL}/payment-success.html?txId=${txId}`,
        cancelUrl: `${APP_BASE_URL}/payment-cancelled.html?txId=${txId}`,
        notifyUrl: `${PUBLIC_BASE_URL}/api/payment/notify`,
        merchantId: MERCHANT_ID,
        merchantKey: MERCHANT_KEY,
        passphrase: PASSPHRASE
      });

      return res.status(200).json({
        success: true,
        payfastHost: getPayfastHost(),
        fields,
        txId
      });
    } catch (err) {
      console.error('Initiate payment error:', err);
      return res.status(500).json({ success: false, message: 'Server error initiating payment.' });
    }
  });

  // ---------------------------------------------------------------
  // POST /api/payment/notify  (PayFast ITN webhook — server to server)
  // This is the ONLY place a purchase is ever marked as "paid".
  // ---------------------------------------------------------------
  router.post(
    '/notify',
    express.raw({ type: '*/*' }), // need the raw body to re-post it for validation
    async (req, res) => {
      // Always respond 200 quickly once we've read the body — PayFast retries
      // on non-200, but we do our checks first and just never throw past this point.
      let rawBody = req.body.toString('utf8');
      let parsed;

      try {
        parsed = querystring.parse(rawBody);
      } catch (err) {
        console.error('ITN parse error:', err);
        return res.status(400).send('Bad request');
      }

      try {
        // 1. Verify signature
        const sigOk = verifyItnSignature(parsed, PASSPHRASE);
        if (!sigOk) {
          console.warn('ITN signature mismatch for txId:', parsed.m_payment_id);
          return res.status(400).send('Invalid signature');
        }

        // 2. Confirm merchant_id matches ours
        if (parsed.merchant_id !== MERCHANT_ID) {
          console.warn('ITN merchant_id mismatch');
          return res.status(400).send('Merchant mismatch');
        }

        // 3. Re-validate the raw POST body with PayFast directly (server-to-server)
        const validated = await validateWithPayfast(rawBody);
        if (!validated) {
          console.warn('ITN failed PayFast server validation for txId:', parsed.m_payment_id);
          return res.status(400).send('Validation failed');
        }

        const txId = parsed.m_payment_id;
        const purchase = await purchasesCollection.findOne({ txId });
        if (!purchase) {
          console.warn('ITN for unknown txId:', txId);
          return res.status(404).send('Unknown transaction');
        }

        // 4. Confirm the amount PayFast says was paid matches what we expect.
        const paidAmount = parseFloat(parsed.amount_gross);
        const expectedAmount = parseFloat(purchase.amount);
        if (Math.abs(paidAmount - expectedAmount) > 0.01) {
          console.warn(`ITN amount mismatch for ${txId}: expected ${expectedAmount}, got ${paidAmount}`);
          await purchasesCollection.updateOne(
            { txId },
            { $set: { status: 'failed', failReason: 'Amount mismatch', updatedAt: new Date(), payfast: parsed } }
          );
          return res.status(200).send('OK'); // acknowledge receipt, but don't mark as paid
        }

        // 5. Map PayFast payment_status to our own status
        let newStatus = 'pending';
        if (parsed.payment_status === 'COMPLETE') newStatus = 'paid';
        else if (parsed.payment_status === 'FAILED') newStatus = 'failed';
        else if (parsed.payment_status === 'CANCELLED') newStatus = 'failed';

        await purchasesCollection.updateOne(
          { txId },
          {
            $set: {
              status: newStatus,
              failReason: newStatus === 'failed' ? (parsed.payment_status || 'Payment failed') : null,
              paidAt: newStatus === 'paid' ? new Date() : null,
              payfastPaymentId: parsed.pf_payment_id || null,
              payfast: parsed,
              updatedAt: new Date()
            }
          }
        );

        return res.status(200).send('OK');
      } catch (err) {
        console.error('ITN processing error:', err);
        // Still 500 here is fine — PayFast will retry the ITN.
        return res.status(500).send('Server error');
      }
    }
  );

  // ---------------------------------------------------------------
  // GET /api/payment/status/:txId  — frontend polls this
  // ---------------------------------------------------------------
  router.get('/status/:txId', async (req, res) => {
    const { txId } = req.params;
    try {
      const purchase = await purchasesCollection.findOne({ txId });
      if (!purchase) {
        return res.status(404).json({ success: false, message: 'Transaction not found.' });
      }

      return res.status(200).json({
        success: true,
        status: purchase.status,
        failReason: purchase.failReason || null
      });
    } catch (err) {
      console.error('Status check error:', err);
      return res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  // ---------------------------------------------------------------
  // GET /api/payment/slip/:txId  — only returns a slip if actually paid
  // ---------------------------------------------------------------
  router.get('/slip/:txId', async (req, res) => {
    const { txId } = req.params;
    try {
      const purchase = await purchasesCollection.findOne({ txId });
      if (!purchase) {
        return res.status(404).json({ success: false, message: 'Transaction not found.' });
      }
      if (purchase.status !== 'paid') {
        return res.status(409).json({ success: false, message: `Payment status is "${purchase.status}", not paid.` });
      }

      const slip = {
        txId: purchase.txId,
        aliasNo: purchase.aliasNo,
        trip: purchase.trip,
        amount: purchase.amount,
        paidAt: purchase.paidAt
      };

      return res.status(200).json({ success: true, slip });
    } catch (err) {
      console.error('Slip fetch error:', err);
      return res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  return router;
}

module.exports = createPaymentRouter;
