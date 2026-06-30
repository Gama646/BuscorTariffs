// backend/payment-routes.js
//
// Mount this in server.js with:
//   const createPaymentRouter = require('./payment-routes');
//   app.use('/api/payment', createPaymentRouter({ cardsCollection, tripsCollection, purchasesCollection, aliasQuery, normalizeAliasNo }));
//
// Requires these env vars (see .env.example):
//   OZOW_SITE_CODE, OZOW_PRIVATE_KEY, OZOW_API_KEY,
//   OZOW_MODE ('test' or 'live'), APP_BASE_URL, PUBLIC_BASE_URL

const express = require('express');
const { randomUUID } = require('crypto');
const {
  buildPaymentRequest,
  buildPaymentUrl,
  verifyNotificationHash,
  getTransactionByReference
} = require('./ozow');

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
function buildTicketFromPurchase(purchase, txId, ozowFields, paidAt) {
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
    approvalCode: ozowFields.TransactionId || null,
    paidAt
  };
}

function createPaymentRouter({ cardsCollection, tripsCollection, purchasesCollection, aliasQuery, normalizeAliasNo }) {
  const router = express.Router();

  const SITE_CODE = process.env.OZOW_SITE_CODE;
  const PRIVATE_KEY = process.env.OZOW_PRIVATE_KEY;
  const API_KEY = process.env.OZOW_API_KEY;
  const IS_TEST = (process.env.OZOW_MODE || 'test') !== 'live';

  // PUBLIC_BASE_URL is the address Ozow can reach (e.g. your ngrok URL).
  // APP_BASE_URL is where the user's browser is redirected back to.
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
  const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:5000';

  if (!SITE_CODE || !PRIVATE_KEY || !API_KEY) {
    console.warn('⚠ OZOW_SITE_CODE / OZOW_PRIVATE_KEY / OZOW_API_KEY not set — payment routes will fail.');
  }
  if (!PUBLIC_BASE_URL) {
    console.warn('⚠ PUBLIC_BASE_URL not set — Ozow will not be able to reach your notify webhook. Use ngrok locally.');
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

      const amount = trip.amount || trip.price;
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

      const fields = buildPaymentRequest({
        siteCode: SITE_CODE,
        amount,
        txId,
        bankReference: `Buscor-${normalized}`.slice(0, 20), // Ozow limits this field's length
        cancelUrl: `${APP_BASE_URL}/payment-cancelled.html?txId=${txId}`,
        errorUrl: `${APP_BASE_URL}/payment-cancelled.html?txId=${txId}&error=1`,
        successUrl: `${APP_BASE_URL}/payment-success.html?txId=${txId}`,
        notifyUrl: `${PUBLIC_BASE_URL}/api/payment/notify`,
        isTest: IS_TEST,
        privateKey: PRIVATE_KEY
      });

      const paymentUrl = buildPaymentUrl(fields);

      return res.status(200).json({
        success: true,
        paymentUrl,
        txId
      });
    } catch (err) {
      console.error('Initiate payment error:', err);
      return res.status(500).json({ success: false, message: 'Server error initiating payment.' });
    }
  });

  // ---------------------------------------------------------------
  // POST /api/payment/notify  (Ozow notification webhook — server to server)
  // This is the ONLY place a purchase is ever marked as "paid".
  // ---------------------------------------------------------------
  router.post(
    '/notify',
    express.urlencoded({ extended: false }), // Ozow posts form-encoded fields
    async (req, res) => {
      const body = req.body;

      try {
        // 1. Verify the notification hash
        const hashOk = verifyNotificationHash(body, PRIVATE_KEY);
        if (!hashOk) {
          console.warn('Notify hash mismatch for txId:', body.TransactionReference);
          return res.status(400).send('Invalid hash');
        }

        // 2. Confirm SiteCode matches ours
        if (body.SiteCode !== SITE_CODE) {
          console.warn('Notify SiteCode mismatch');
          return res.status(400).send('Site code mismatch');
        }

        const txId = body.TransactionReference;
        const purchase = await purchasesCollection.findOne({ txId });
        if (!purchase) {
          console.warn('Notify for unknown txId:', txId);
          return res.status(404).send('Unknown transaction');
        }

        // 3. Confirm the amount Ozow says was paid matches what we expect.
        const paidAmount = parseFloat(body.Amount);
        const expectedAmount = parseFloat(purchase.amount);
        if (Math.abs(paidAmount - expectedAmount) > 0.01) {
          console.warn(`Notify amount mismatch for ${txId}: expected ${expectedAmount}, got ${paidAmount}`);
          await purchasesCollection.updateOne(
            { txId },
            { $set: { status: 'failed', failReason: 'Amount mismatch', updatedAt: new Date(), ozow: body } }
          );
          return res.status(200).send('OK'); // acknowledge receipt, but don't mark as paid
        }

        // 4. Independently re-confirm status by querying Ozow directly,
        // rather than trusting the notification body alone.
        let verifiedStatus = body.Status;
        try {
          const lookup = await getTransactionByReference(SITE_CODE, txId, API_KEY);
          if (Array.isArray(lookup) && lookup.length > 0 && lookup[0].status) {
            verifiedStatus = lookup[0].status;
          } else if (lookup && lookup.status) {
            verifiedStatus = lookup.status;
          }
        } catch (lookupErr) {
          console.warn(`Could not independently verify txId ${txId} via GetTransactionByReference:`, lookupErr.message);
          // Fall back to the notification's own Status field — still hash-verified above.
        }

        // 5. Map Ozow status to our own status
        let newStatus = 'pending';
        if (verifiedStatus === 'Complete') newStatus = 'paid';
        else if (verifiedStatus === 'Error' || verifiedStatus === 'Abandoned') newStatus = 'failed';
        else if (verifiedStatus === 'Cancelled') newStatus = 'failed';

        const now = new Date();

        await purchasesCollection.updateOne(
          { txId },
          {
            $set: {
              status: newStatus,
              failReason: newStatus === 'failed' ? verifiedStatus : null,
              paidAt: newStatus === 'paid' ? now : null,
              ozowTransactionId: body.TransactionId || null,
              ozow: body,
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
            const ticket = buildTicketFromPurchase(purchase, txId, body, now);

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
        console.error('Notify processing error:', err);
        // Still 500 here is fine — Ozow will retry the notification.
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
