// backend/ozow.js
//
// Small helper module for Ozow integration (hosted payment page method).
// Docs: https://ozow.com/integrations / https://training.ozow.com
//
// You'll need these from your Ozow Dashboard (dash.ozow.com -> Merchant Details):
//   OZOW_SITE_CODE, OZOW_PRIVATE_KEY, OZOW_API_KEY
//
// Hash rule (used for BOTH building the outgoing request AND verifying the
// incoming notification): concatenate the relevant fields IN ORDER, append
// your private key, lowercase the whole string, then SHA512 hash it.

const crypto = require('crypto');

const OZOW_MODE = process.env.OZOW_MODE || 'test'; // 'test' | 'live'

const HOSTS = {
  test: 'https://stagingapi.ozow.com',
  live: 'https://api.ozow.com'
};

const PAY_URL = 'https://pay.ozow.com'; // hosted payment page, same for test/live (site code controls mode)

function getApiHost() {
  return HOSTS[OZOW_MODE] || HOSTS.test;
}

// Generic hash builder: fields must already be in the correct order.
function generateHash(orderedValues, privateKey) {
  const concatenated = orderedValues.join('');
  const withKey = `${concatenated}${privateKey}`;
  return crypto.createHash('sha512').update(withKey.toLowerCase()).digest('hex');
}

// Builds the fields + hash needed to redirect a customer to Ozow's hosted
// payment page. Field order here matters for the hash and MUST match the
// order Ozow expects (see their "Request" field table).
function buildPaymentRequest({
  siteCode,
  countryCode = 'ZA',
  currencyCode = 'ZAR',
  amount,
  txId,           // your own transaction id, sent as TransactionReference
  bankReference,  // short reference shown on the customer's bank statement
  cancelUrl,
  errorUrl,
  successUrl,
  notifyUrl,
  isTest,
  privateKey
}) {
  const fields = {
    SiteCode: siteCode,
    CountryCode: countryCode,
    CurrencyCode: currencyCode,
    Amount: Number(amount).toFixed(2),
    TransactionReference: txId,
    BankReference: bankReference,
    CancelUrl: cancelUrl,
    ErrorUrl: errorUrl,
    SuccessUrl: successUrl,
    NotifyUrl: notifyUrl,
    IsTest: isTest ? 'true' : 'false'
  };

  // Order required for the hash: SiteCode, CountryCode, CurrencyCode, Amount,
  // TransactionReference, BankReference, CancelUrl, ErrorUrl, SuccessUrl,
  // NotifyUrl, IsTest — in that exact order, values only (no field names).
  const orderedValues = [
    fields.SiteCode,
    fields.CountryCode,
    fields.CurrencyCode,
    fields.Amount,
    fields.TransactionReference,
    fields.BankReference,
    fields.CancelUrl,
    fields.ErrorUrl,
    fields.SuccessUrl,
    fields.NotifyUrl,
    fields.IsTest
  ];

  const hashCheck = generateHash(orderedValues, privateKey);

  return { ...fields, HashCheck: hashCheck };
}

// Builds the full hosted-page URL with fields as query params (GET redirect).
function buildPaymentUrl(fields) {
  const params = new URLSearchParams(fields);
  return `${PAY_URL}/?${params.toString()}`;
}

// Verifies an incoming notification's hash. Ozow notification fields arrive
// as form-encoded POST data. Order for notification hash verification:
// SiteCode, TransactionId, TransactionReference, Amount, Status,
// Optional1..Optional5, CurrencyCode, IsTest, StatusMessage — per Ozow's
// notification field table (excluding Hash itself).
function verifyNotificationHash(body, privateKey) {
  const orderedValues = [
    body.SiteCode,
    body.TransactionId,
    body.TransactionReference,
    body.Amount,
    body.Status,
    body.Optional1 || '',
    body.Optional2 || '',
    body.Optional3 || '',
    body.Optional4 || '',
    body.Optional5 || '',
    body.CurrencyCode,
    body.IsTest,
    body.StatusMessage || ''
  ];

  const expected = generateHash(orderedValues, privateKey);
  return expected === (body.Hash || '').toLowerCase();
}

// Calls Ozow's GetTransactionByReference API to independently confirm a
// transaction's status — useful both for polling and as a second check
// alongside the notification hash, since this hits Ozow's server directly.
function getTransactionByReference(siteCode, txId, apiKey) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const url = `${getApiHost()}/GetTransactionByReference?siteCode=${encodeURIComponent(siteCode)}&transactionReference=${encodeURIComponent(txId)}`;

    const options = {
      headers: { ApiKey: apiKey, Accept: 'application/json' }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

module.exports = {
  OZOW_MODE,
  getApiHost,
  generateHash,
  buildPaymentRequest,
  buildPaymentUrl,
  verifyNotificationHash,
  getTransactionByReference
};
