// frontend/payment-flow.js
//
// Called when the user clicks "Proceed to payment" after selecting
// Area / From / To / Ticket type and entering their alias number.

async function startPayment(aliasNo, area, from, to, ticketType) {
  try {
    const res = await fetch('/api/payment/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasNo, area, from, to, ticketType })
    });

    const data = await res.json();

    if (!data.success) {
      showFailureMessage(data.message || 'Could not start payment.');
      return;
    }

    // Build a hidden form and auto-submit it to PayFast.
    // This is the standard PayFast redirect pattern — no card details
    // ever touch your own server.
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = data.payfastHost;

    for (const [key, value] of Object.entries(data.fields)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = key;
      input.value = value;
      form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();

  } catch (err) {
    console.error(err);
    showFailureMessage('Network error. Please try again.');
  }
}

// ---------------------------------------------------------------------
// On the success page (payment-success.html), poll for the real outcome.
// Ozow's SuccessUrl is just where the BROWSER lands — it does NOT guarantee
// payment succeeded. The notification webhook is the source of truth, so we
// poll our own /status endpoint until it reflects "paid" or "failed".
// ---------------------------------------------------------------------
async function checkPaymentOutcome(txId, attempt = 1) {
  try {
    const res = await fetch(`/api/payment/status/${txId}`);
    const data = await res.json();

    if (!data.success) {
      showFailureMessage('Could not find this transaction.');
      return;
    }

    if (data.status === 'paid') {
      await showSuccessAndDownloadSlip(txId);
    } else if (data.status === 'failed') {
      showFailureMessage(
        'Payment was not successful' +
        (data.failReason ? ` (${data.failReason})` : '') +
        '. No trips were loaded onto your card. Please try again.'
      );
    } else if (attempt < 15) {
      // still pending — notification may take a few seconds. Keep polling.
      setTimeout(() => checkPaymentOutcome(txId, attempt + 1), 1500);
    } else {
      showFailureMessage('Payment is taking longer than expected. Please contact support with reference: ' + txId);
    }
  } catch (err) {
    console.error(err);
    showFailureMessage('Network error while confirming payment.');
  }
}

async function showSuccessAndDownloadSlip(txId) {
  const res = await fetch(`/api/payment/slip/${txId}`);
  const data = await res.json();

  if (!data.success) {
    showFailureMessage('Payment succeeded but slip could not be generated. Reference: ' + txId);
    return;
  }

  const slip = data.slip;

  // On-screen success message — no email, no SMS
  document.getElementById('result').innerHTML = `
    <div class="success-box">
      <h2>✅ Payment Successful</h2>
      <p>Reference: ${slip.txId}</p>
      <p>Card: ${slip.aliasNo}</p>
      <p>${slip.trip.from} → ${slip.trip.to} (${slip.trip.ticketType})</p>
      <p>Amount paid: R ${Number(slip.amount).toFixed(2)}</p>
      <p>Your receipt has downloaded automatically.</p>
      <button onclick="downloadSlipAgain('${slip.txId}')">Download receipt again</button>
    </div>
  `;

  downloadSlipAsFile(slip);
}

function downloadSlipAsFile(slip) {
  const t = slip.ticket;
  const startDate  = t ? new Date(t.startDate).toLocaleDateString('en-ZA')  : '-';
  const expiryDate = t ? new Date(t.expiryDate).toLocaleDateString('en-ZA') : '-';

  const content = `
BUSCOR (PTY) LTD - Payment Receipt
-----------------------------------
Reference: ${slip.txId}
Card: ${slip.aliasNo}
Route: ${slip.trip.from} -> ${slip.trip.to}
Ticket type: ${slip.trip.ticketType}
Start Date: ${startDate}
Valid Until: ${expiryDate}
Valid Days: ${t ? t.validDays : ''}
Amount paid: R ${Number(slip.amount).toFixed(2)}
Paid at: ${new Date(slip.paidAt).toLocaleString('en-ZA')}
Status: PAID
  `.trim();

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Buscor-Receipt-${slip.txId}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function showFailureMessage(message) {
  document.getElementById('result').innerHTML = `
    <div class="failure-box">
      <h2>❌ Payment Not Successful</h2>
      <p>${message}</p>
      <p>No trips were loaded onto your card.</p>
      <button onclick="window.location.href='/'">Try again</button>
    </div>
  `;
}