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
  verifyItnSignatureRaw,
  validateWithPayfast
} = require('./payfast');

// Parses a ticketType string like "6 Days" / "5 Days" / "30 Days" into a
// number of days. Defaults to 5 (the minimum) if it can't be parsed.
function parseTicketDurationDays(ticketType) {
  const match = String(ticketType || '').match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 5;
}

// Tickets always start on a Monday, never any other day:
//  - Bought Mon/Tue/Wed/Thu -> starts THIS week's Monday (already underway)
//  - Bought Fri/Sat/Sun     -> starts NEXT week's Monday (this week's is spent)
function getTicketStartDate(purchaseDate) {
  const date = new Date(purchaseDate);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  const monday = new Date(date);

  if (day >= 1 && day <= 4) {
    // Mon(1)..Thu(4): roll back to this week's Monday
    monday.setDate(date.getDate() - (day - 1));
  } else {
    // Fri(5), Sat(6), Sun(0): roll forward to next Monday
    const daysUntilNextMonday = day === 0 ? 1 : (8 - day);
    monday.setDate(date.getDate() + daysUntilNextMonday);
  }

  return monday;
}

// Builds the day-validity code seen on Buscor receipts, e.g. "MTWTFSs" or "MTWTFSS".
// Each letter is a day (Mon..Sun); CAPITAL = valid that day, lowercase = not valid.
// Saturday and Sunday share the letter "S" — case is what distinguishes them.
// Rule: tickets shorter than a full week (<7 days) exclude Sunday (lowercase "s").
// Tickets of 7 days or more include Sunday too (capital "S").
function buildValidDaysCode(durationDays) {
  const includesSunday = durationDays >= 7;
  return 'MTWTFS' + (includesSunday ? 'S' : 's');
}

// Builds the "active ticket" object stored on the card — this mirrors the
// fields printed on the physical receipt (Type, Start Date, Valid Days,
// From, To, Price) so the driver's scanner can display the same info.
function buildTicketFromPurchase(purchase, txId, payfastFields, paidAt) {
  const durationDays = parseTicketDurationDays(purchase.trip.ticketType);
  const startDate = getTicketStartDate(paidAt); // anchored to a Monday — see rule above
  const expiryDate = new Date(startDate);
  expiryDate.setDate(expiryDate.getDate() + durationDays);

  return {
    ticketId: txId,
    cardNo: purchase.cardNo || null,
    aliasNo: purchase.aliasNo,
    type: purchase.trip.ticketType,        // e.g. "6 Days"
    startDate,
    expiryDate,
    validDays: purchase.trip.validDays || buildValidDaysCode(durationDays),
    from: purchase.trip.from,
    to: purchase.trip.to,
    price: purchase.amount,
    approvalCode: payfastFields.pf_payment_id || null,
    paidAt
  };
}

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

      // Tac tickets are never sold below 5 days — guard against a bad/typo'd
      // ticketType in the trips collection slipping through.
      const requestedDuration = parseTicketDurationDays(trip.ticketType);
      if (requestedDuration < 5) {
        return res.status(400).json({ success: false, message: 'Tickets are only available in 5 days or more.' });
      }

      // Price may be stored as a string (e.g. "R144.00" or "1,440") rather
      // than a clean number — strip anything that isn't a digit or dot.
      const rawAmount = trip.amount ?? trip.price;
      const amount = typeof rawAmount === 'number'
        ? rawAmount
        : parseFloat(String(rawAmount || '').replace(/[^0-9.]/g, ''));
      if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid fare amount for this trip.' });
      }

      const txId = randomUUID();

      const purchase = {
        txId,
        aliasNo: normalized,
        cardNo: card.Card_No || card.cardNo || card.CardNo || null,
        cardRef: card._id || null,
        trip: { area: trip.area, from: trip.from, to: trip.to, ticketType: trip.ticketType, validDays: trip.validDays || null },
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

      console.log(`→ Initiating payment ${txId}: notify_url=${PUBLIC_BASE_URL}/api/payment/notify`);
      console.log('→ Fields being sent to PayFast:', JSON.stringify(fields, null, 2));
      console.log('→ PayFast host:', getPayfastHost());

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
      console.log('← /api/payment/notify hit. Raw body:', rawBody.slice(0, 300));
      let parsed;

      try {
        parsed = querystring.parse(rawBody);
      } catch (err) {
        console.error('ITN parse error:', err);
        return res.status(400).send('Bad request');
      }

      try {
        // 1. Verify signature
        const sigOk = verifyItnSignatureRaw(rawBody, PASSPHRASE);
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

        const now = new Date();

        await purchasesCollection.updateOne(
          { txId },
          {
            $set: {
              status: newStatus,
              failReason: newStatus === 'failed' ? (parsed.payment_status || 'Payment failed') : null,
              paidAt: newStatus === 'paid' ? now : null,
              payfastPaymentId: parsed.pf_payment_id || null,
              payfast: parsed,
              updatedAt: now
            }
          }
        );

        // ---------------------------------------------------------------
        // After confirmed payment, update the card record so the ticket
        // (From/To/validity) is loaded onto it — exactly like the printed receipt.
        // ---------------------------------------------------------------
        if (newStatus === 'paid' && purchase.cardRef) {
          try {
            const ticket = buildTicketFromPurchase(purchase, txId, parsed, now);

            await cardsCollection.updateOne(
              { _id: purchase.cardRef },
              {
                // activeTicket is what the driver's scanner reads — From, To,
                // validity window — mirroring the printed receipt.
                $set:  { activeTicket: ticket, lastPaymentAt: now, lastPaymentTxId: txId },
                $push: { ticketHistory: ticket }
              }
            );
            console.log(`✓ Ticket loaded onto card for txId ${txId} (alias: ${purchase.aliasNo})`);
          } catch (cardErr) {
            // Log but don't fail — the payment is confirmed, the slip can still be shown.
            // You can add a retry/reconciliation job later if needed.
            console.error(`⚠ Payment confirmed but card update failed for txId ${txId}:`, cardErr.message);
          }
        }

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
        cardNo: purchase.cardNo || null,
        trip: purchase.trip,
        amount: purchase.amount,
        paidAt: purchase.paidAt
      };

      // Pull the matching ticket off the card if we have it, so the slip can
      // also show Start Date / Expiry / Valid Days exactly like the printed receipt.
      if (purchase.cardRef) {
        const card = await cardsCollection.findOne({ _id: purchase.cardRef });
        if (card && card.activeTicket && card.activeTicket.ticketId === txId) {
          slip.ticket = card.activeTicket;
        }
      }

      return res.status(200).json({ success: true, slip });
    } catch (err) {
      console.error('Slip fetch error:', err);
      return res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  return router;
}

module.exports = createPaymentRouter;