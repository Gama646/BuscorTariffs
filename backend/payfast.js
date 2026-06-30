// backend/payfast.js
//
// Small helper module for PayFast integration.
// Docs: https://developers.payfast.co.za/docs

const crypto = require('crypto');
const https = require('https');

const PAYFAST_MODE = process.env.PAYFAST_MODE || 'sandbox'; // 'sandbox' | 'live'

const HOSTS = {
  sandbox: 'sandbox.payfast.co.za',
  live: 'www.payfast.co.za'
};

function getPayfastHost() {
  return `https://${HOSTS[PAYFAST_MODE] || HOSTS.sandbox}/eng/process`;
}

// PayFast signature: concatenate name=value pairs (URL-encoded, spaces as '+'),
// in the exact order the fields are added (NOT alphabetical), then append
// passphrase if one is set, then MD5 hash the whole string.
function generateSignature(data, passphrase) {
  let pairs = [];
  for (const key in data) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
      pairs.push(`${key}=${encodeURIComponent(String(data[key]).trim()).replace(/%20/g, '+')}`);
    }
  }
  let queryString = pairs.join('&');

  if (passphrase) {
    queryString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
  }

  return crypto.createHash('md5').update(queryString).digest('hex');
}

// Builds the full set of fields to submit to PayFast for a payment,
// including the signature. Field order matters for the signature, so
// we build it as an ordered object.
function buildPaymentFields({
  txId,
  amount,
  itemName,
  itemDescription,
  returnUrl,
  cancelUrl,
  notifyUrl,
  merchantId,
  merchantKey,
  passphrase
}) {
  const fields = {
    merchant_id: merchantId,
    merchant_key: merchantKey,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    notify_url: notifyUrl,
    m_payment_id: txId,
    amount: Number(amount).toFixed(2),
    item_name: itemName,
    item_description: itemDescription || ''
  };

  const signature = generateSignature(fields, passphrase);

  return { ...fields, signature };
}

// Verifies an incoming ITN's signature against the same fields PayFast sent us.
// NOTE: kept for reference, but prefer verifyItnSignatureRaw below — re-encoding
// decoded values can mismatch PayFast's original raw encoding (e.g. %XX casing),
// causing false-positive signature mismatches on otherwise valid ITNs.
function verifyItnSignature(itnBody, passphrase) {
  const { signature, ...rest } = itnBody;
  const expected = generateSignature(rest, passphrase);
  return expected === signature;
}

// Verifies the ITN signature directly against PayFast's raw POST body string,
// which avoids any decode/re-encode mismatch. This is PayFast's recommended
// approach: strip the signature param, keep everything else exactly as
// PayFast sent it (already & and = separated, values URL-encoded with + for
// spaces), append &passphrase=... if set, then MD5 hash.
function verifyItnSignatureRaw(rawBody, passphrase) {
  const pairs = rawBody.split('&').filter((pair) => !pair.startsWith('signature='));
  let queryString = pairs.join('&');

  if (passphrase) {
    queryString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
  }

  const expected = crypto.createHash('md5').update(queryString).digest('hex');

  const match = rawBody.match(/signature=([^&]*)/);
  const provided = match ? match[1] : '';

  return expected === provided;
}

// PayFast requires you to post the raw ITN body back to their server to
// confirm it actually came from them (defense against spoofed requests).
function validateWithPayfast(rawBody) {
  return new Promise((resolve, reject) => {
    const host = HOSTS[PAYFAST_MODE] || HOSTS.sandbox;
    const options = {
      hostname: host,
      path: '/eng/query/validate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(rawBody)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data.trim() === 'VALID'));
    });

    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

module.exports = {
  getPayfastHost,
  generateSignature,
  buildPaymentFields,
  verifyItnSignature,
  verifyItnSignatureRaw,
  validateWithPayfast,
  PAYFAST_MODE
};