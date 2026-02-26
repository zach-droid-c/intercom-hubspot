// index.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ─── CONFIG (use environment variables — never hardcode secrets) ───
const INTERCOM_SECRET  = process.env.INTERCOM_CLIENT_SECRET; // from Intercom app settings
const HUBSPOT_API_KEY  = process.env.HUBSPOT_ACCESS_TOKEN;   // from HubSpot private app

// ─── 1. VERIFY INTERCOM SIGNATURE ─────────────────────────────────
function verifyIntercom(req) {
  const sig = req.headers['x-hub-signature'];
  if (!sig) return false;

  const hash = 'sha1=' + crypto
    .createHmac('sha1', INTERCOM_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  return sig === hash;
}

// ─── 2. UPSERT CONTACT IN HUBSPOT ─────────────────────────────────
async function upsertHubSpotContact(email, fields = {}) {
  const url = `https://api.hubapi.com/crm/v3/objects/contacts`;

  // First, search for existing contact by email
  const searchRes = await axios.post(
    `${url}/search`,
    {
      filterGroups: [{
        filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
      }]
    },
    { headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}` } }
  );

  const existing = searchRes.data.results[0];

  if (existing) {
    // Update existing contact
    await axios.patch(
      `${url}/${existing.id}`,
      { properties: fields },
      { headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}` } }
    );
    console.log(`Updated HubSpot contact: ${existing.id}`);
  } else {
    // Create new contact
    await axios.post(
      url,
      { properties: { email, ...fields } },
      { headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}` } }
    );
    console.log(`Created new HubSpot contact for: ${email}`);
  }
}

// ─── 3. WEBHOOK ENDPOINT ──────────────────────────────────────────
app.post('/webhook/intercom', async (req, res) => {
  // Verify it's really from Intercom
 // if (!verifyIntercom(req)) {
  //  console.warn('Invalid signature — rejected');
 //   return res.status(401).send('Unauthorized');
  }

  const { topic, data } = req.body;

  // Only handle conversation_rating.created events
  if (topic !== 'conversation_rating.created') {
    return res.status(200).send('Ignored');
  }

  // ── EXTRACT FIELDS FROM INTERCOM PAYLOAD ──
  const item    = data?.item;
  const email   = item?.contact?.email;
  const csatScore = item?.rating;         // 1–5 numeric score
  const csatRemark = item?.remark ?? '';  // optional written comment

  if (!email) {
    console.warn('No email found in payload');
    return res.status(200).send('No email');
  }

  if (!csatScore) {
    console.warn('No CSAT score in payload');
    return res.status(200).send('No CSAT score');
  }

  // ── MAP TO HUBSPOT FIELDS ──
  // These match the custom HubSpot properties you create (see setup below)
  const hubspotFields = {
    intercom_csat_score:  String(csatScore),  // e.g. "4"
    intercom_csat_remark: csatRemark,         // optional comment from customer
  };

  try {
    await upsertHubSpotContact(email, hubspotFields);
    res.status(200).send('OK');
  } catch (err) {
    console.error('HubSpot error:', err.response?.data || err.message);
    res.status(500).send('Error');
  }
});

// ─── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));