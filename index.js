const express = require("express");
const Stripe = require("stripe");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 3001;

const DOCUSEAL_BASE_URL =
  process.env.DOCUSEAL_BASE_URL || "https://api.docuseal.com";

const CONTRACT_PRICES = {
  sync_nonexclusive: 4900,
  sync_exclusive: 29900,
  artist_exclusive: 14900
};

/*
  IMPORTANT :
  Le webhook Stripe doit rester AVANT express.json(),
  sinon Stripe signature verification casse.
*/
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log("❌ Stripe webhook error:", err.message);
    return res.status(400).send("Webhook Error");
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    console.log("💰 Paiement reçu !");
    console.log("Client:", session.customer_details?.email || session.customer_email);
    console.log("Track:", session.metadata?.track_title);
    console.log("License:", session.metadata?.license_type);

    /*
      Étape suivante :
      ici on enverra automatiquement les fichiers.
    */
  }

  res.json({ received: true });
});

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("CB Contracts Worker is running.");
});

app.listen(PORT, () => {
  console.log("CB Contracts Worker lancé sur http://localhost.");
});


/*
  1. Le site appelle cette route.
  2. On crée une soumission DocuSeal.
  3. On renvoie le lien de signature au client.
*/
app.post("/api/create-contract", async (req, res) => {
  try {
    const data = req.body;

    if (!data.name || !data.email || !data.track_title || !data.profile) {
      return res.status(400).json({
        error: "Missing required fields"
      });
    }

    const licenseType = getLicenseType(data);
    const templateId = getTemplateId(data);

    console.log("📝 Création contrat :", {
      email: data.email,
      track: data.track_title,
      licenseType,
      templateId
    });

    const response = await axios.post(
      `${DOCUSEAL_BASE_URL}/api/submissions`,
      {
        template_id: Number(templateId),
        send_email: false,
        submitters: [
          {
            email: data.email,
            name: data.name,
            role: "Licencié",
            fields: [
              { name: "client_name", default_value: data.name, readonly: true },
              { name: "client_email", default_value: data.email, readonly: true },
              { name: "client_company", default_value: data.company || "-", readonly: true },
              { name: "project_name", default_value: data.project || "-", readonly: true },
              { name: "usage", default_value: data.usage || "-", readonly: true },
              { name: "track_title", default_value: data.track_title, readonly: true },
              { name: "selected_section", default_value: data.section || "Titre complet", readonly: true },
              { name: "license_type", default_value: licenseType, readonly: true },
              { name: "price", default_value: priceLabel(data), readonly: true }
            ]
          }
        ]
      },
      {
        headers: {
          "X-Auth-Token": process.env.DOCUSEAL_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    const submitter = response.data.submitters?.[0];

    const signingUrl =
      submitter?.url ||
      submitter?.embed_src ||
      submitter?.link ||
      response.data.url;

    if (!signingUrl) {
      console.log("DocuSeal response:", response.data);
      return res.status(500).json({
        error: "No signing URL returned by DocuSeal"
      });
    }

    res.json({
      ok: true,
      signing_url: signingUrl
    });

  } catch (err) {
    console.error("❌ DocuSeal error:", err.response?.data || err.message);
    res.status(500).json({
      error: "Contract creation failed",
      details: err.response?.data || err.message
    });
  }
});

/*
  Après signature, on créera le paiement Stripe.
  Pour l’instant, cette route sert aussi à tester.
*/
app.post("/api/create-payment", async (req, res) => {
  try {
    const data = req.body;

    const licenseKey = getLicenseKey(data);
    const unitAmount = CONTRACT_PRICES[licenseKey] || 4900;
    const licenseType = getLicenseType(data);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: data.email,
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `CB Production License - ${data.track_title}`,
              description: licenseType
            },
            unit_amount: unitAmount
          },
          quantity: 1
        }
      ],
      metadata: {
        email: data.email || "",
        track_title: data.track_title || "",
        profile: data.profile || "",
        license_type: licenseType,
        section: data.section || "Titre complet"
      },
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL
    });

    res.json({
      ok: true,
      checkout_url: session.url
    });

  } catch (err) {
    console.error("❌ Stripe create payment error:", err.message);
    res.status(500).json({
      error: "Payment creation failed"
    });
  }
});

function getLicenseKey(data) {
  if (data.profile === "artist") return "artist_exclusive";
  if (data.profile === "sync" && data.licenseMode === "exclusive") return "sync_exclusive";
  return "sync_nonexclusive";
}

function getLicenseType(data) {
  const key = getLicenseKey(data);

  if (key === "artist_exclusive") return "Licence artiste exclusive";
  if (key === "sync_exclusive") return "Licence de synchronisation exclusive";
  return "Licence de synchronisation non exclusive";
}

function getTemplateId(data) {
  if (data.profile === "artist") {
    return process.env.DOCUSEAL_TEMPLATE_ARTIST;
  }

  return process.env.DOCUSEAL_TEMPLATE_SYNC;
}

function priceLabel(data) {
  const cents = CONTRACT_PRICES[getLicenseKey(data)] || 4900;
  return `${(cents / 100).toFixed(2)} €`;
}

app.listen(PORT, () => {
  console.log(`🚀 CB Contracts Worker lancé sur http://localhost:${PORT}`);
});