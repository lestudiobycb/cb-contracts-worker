const express = require("express");
const Stripe = require("stripe");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 3001;
const DOCUSEAL_BASE_URL = process.env.DOCUSEAL_BASE_URL || "http://104.168.10.250:3000";

const CONTRACT_PRICES = {
  sync_nonexclusive: 4900,   // 49 €
  sync_exclusive: 29900,     // 299 €
  artist_exclusive: 54900    // 549 €
};

const ADDON_PRICES = {
  addon_copyright_transfer: 300000, // 3000 €

  addon_artist_stems: 3000,             // 30 €
  addon_artist_all_tracks: 5000,        // 50 €
  addon_artist_protools_session: 25000, // 250 €
  addon_artist_master: 4000,            // 40 €
  addon_artist_mix: 10000,              // 100 €
  addon_artist_mix_master: 12000,       // 120 €

  addon_sync_stems: 2000,               // 20 €
  addon_sync_all_tracks: 5000,          // 50 €
  addon_sync_arrangement: 7000,         // 70 €
  addon_sync_structure: 7000,           // 70 €
  addon_sync_instrument: 4000           // 40 €
};

app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log("💰 Paiement reçu !");
      console.log("Client:", session.customer_details?.email || session.customer_email);
      console.log("Track:", session.metadata?.track_title);
      console.log("License:", session.metadata?.license_type);
      console.log("Total:", session.amount_total);
    }

    res.json({ received: true });
  } catch (err) {
    console.log("❌ Stripe webhook error:", err.message);
    res.status(400).send("Webhook Error");
  }
});

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("CB Contracts Worker is running.");
});

app.post("/api/create-contract", async (req, res) => {
  try {
    const data = req.body;

    if (!data.name || !data.email || !data.track_title || !data.profile) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const licenseType = getLicenseType(data);
    const templateId = getTemplateId(data);
    const fields = buildDocuSealFields(data, licenseType);

    console.log("📝 Création contrat :", {
      email: data.email,
      track: data.track_title,
      profile: data.profile,
      licenseType,
      templateId,
      basePrice: formatPrice(basePrice(data)),
      addons: addonsLabel(data),
      total: priceLabel(data),
      fields: fields.map(f => f.name)
    });

    if (!templateId || Number.isNaN(Number(templateId))) {
      return res.status(500).json({
        error: "Invalid DocuSeal template ID",
        templateId
      });
    }

    const response = await axios.post(
      `${DOCUSEAL_BASE_URL}/api/submissions`,
      {
        template_id: parseInt(templateId, 10),
        send_email: false,
        redirect_url: "https://cb-prod.com/payment.html",
        submitters: [
  {
    email: data.email,
    name: data.name,
    role: "Licencié",
    fields
  },
  {
    email: process.env.CB_EMAIL,
    name: "CB Production",
    role: "Concédant"
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

    console.log("✅ DocuSeal response:", response.data);

    const submitter = Array.isArray(response.data)
      ? response.data[0]
      : response.data.submitters?.[0];

    const signingUrl =
      submitter?.url ||
      submitter?.embed_src ||
      submitter?.link ||
      response.data?.url;

    if (!signingUrl) {
      return res.status(500).json({
        error: "No signing URL returned by DocuSeal",
        response: response.data
      });
    }

    res.json({
      ok: true,
      signing_url: signingUrl,
      base_price: formatPrice(basePrice(data)),
      addons: addonsLabel(data),
      total_price: priceLabel(data)
    });

  } catch (err) {
    console.error("❌ DocuSeal error:", err.response?.data || err.message);
    res.status(500).json({
      error: "Contract creation failed",
      details: err.response?.data || err.message
    });
  }
});

app.post("/api/create-payment", async (req, res) => {
  try {
    const data = req.body;

    const unitAmount = totalPriceCents(data);
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
              description: `${licenseType} · ${addonsLabel(data)}`
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
        section: data.section || "Titre complet",
        base_price: formatPrice(basePrice(data)),
        addons: addonsLabel(data),
        total_price: priceLabel(data)
      },
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL
    });

    res.json({
      ok: true,
      checkout_url: session.url,
      total_price: priceLabel(data)
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

function formatPrice(cents) {
  return `${(cents / 100).toFixed(2)} €`;
}

function basePrice(data) {
  return CONTRACT_PRICES[getLicenseKey(data)] || 4900;
}

function normalizeAddons(data) {
  if (Array.isArray(data.addons)) return data.addons;
  if (typeof data.addons === "string" && data.addons.trim()) return [data.addons];
  return [];
}

function isValidAddon(addon) {
  return Object.prototype.hasOwnProperty.call(ADDON_PRICES, addon);
}

function selectedAddons(data) {
  return normalizeAddons(data).filter(isValidAddon);
}

function addonsTotal(data) {
  return selectedAddons(data).reduce((total, addon) => {
    return total + ADDON_PRICES[addon];
  }, 0);
}

function totalPriceCents(data) {
  return basePrice(data) + addonsTotal(data);
}

function addonLabel(addon) {
  const labels = {
    addon_copyright_transfer: "Cession optionnelle de droits d’auteur",

    addon_artist_stems: "Stems artiste",
    addon_artist_all_tracks: "Toutes les pistes artiste",
    addon_artist_protools_session: "Session Pro Tools",
    addon_artist_master: "Mastering",
    addon_artist_mix: "Mixage CB Production",
    addon_artist_mix_master: "Mixage + mastering",

    addon_sync_stems: "Stems sync",
    addon_sync_all_tracks: "Toutes les pistes sync",
    addon_sync_arrangement: "Changement d’arrangement",
    addon_sync_structure: "Changement de structure",
    addon_sync_instrument: "Ajout / suppression d’un instrument ou élément"
  };

  return labels[addon] || addon;
}

function addonsLabel(data) {
  const addons = selectedAddons(data);

  if (!addons.length) return "-";

  return addons
    .map(addon => `${addonLabel(addon)} : ${formatPrice(ADDON_PRICES[addon])}`)
    .join(" | ");
}

function priceLabel(data) {
  return formatPrice(totalPriceCents(data));
}

function commonFields(data, licenseType) {
  return [
    { name: "client_company", default_value: data.company || "-", readonly: true },
    { name: "client_legal_form", default_value: data.legalForm || "-", readonly: true },
    { name: "client_registration", default_value: data.registration || "-", readonly: true },
    { name: "client_address", default_value: data.address || "-", readonly: true },
    { name: "client_representative", default_value: data.representative || data.name || "-", readonly: true },
    { name: "client_email", default_value: data.email || "-", readonly: true },

    { name: "track_title", default_value: data.track_title || "-", readonly: true },
    { name: "track_composers", default_value: data.composers || "CB Production", readonly: true },
    { name: "track_authors", default_value: data.authors || "-", readonly: true },
    { name: "track_duration", default_value: data.trackDuration || "-", readonly: true },
    { name: "track_bpm", default_value: data.bpm || "-", readonly: true },
    { name: "track_isrc", default_value: data.isrc || "-", readonly: true },
    { name: "track_iswc", default_value: data.iswc || "-", readonly: true },
    { name: "track_version", default_value: data.trackVersion || data.section || "-", readonly: true },
    { name: "track_section", default_value: data.section || "Titre complet", readonly: true },
    { name: "files_provided", default_value: data.filesProvided || "Master WAV / MP3", readonly: true },

    { name: "base_price", default_value: formatPrice(basePrice(data)), readonly: true },
    { name: "addons", default_value: addonsLabel(data), readonly: true },
    { name: "total_price", default_value: priceLabel(data), readonly: true }
  ];
}

function syncFields(data) {
  return [
    { name: "project_name", default_value: data.project || "-", readonly: true },
    { name: "project_type", default_value: data.usage || "-", readonly: true },
    { name: "final_client", default_value: data.finalClient || "-", readonly: true },
    { name: "production_company", default_value: data.productionCompany || "-", readonly: true },
    { name: "project_duration", default_value: data.projectDuration || "-", readonly: true },
    { name: "release_date", default_value: data.releaseDate || "-", readonly: true },
    { name: "license_duration", default_value: data.duration || "1 an", readonly: true },
    { name: "license_mode", default_value: data.licenseMode === "exclusive"
        ? "Exclusive"
        : "Non-exclusive", readonly: true },
    { name: "territory", default_value: data.territory || "-", readonly: true },
    { name: "supports", default_value: data.supports || "-", readonly: true },
    { name: "media_budget", default_value: data.mediaBudget || "-", readonly: true },

    { name: "sync_start_time", default_value: data.startTime || "-", readonly: true },
    { name: "sync_end_time", default_value: data.endTime || "-", readonly: true },
    {
      name: "sync_selected_duration",
      default_value: `${data.startTime || "-"} → ${data.endTime || "-"}`,
      readonly: true
    },

    { name: "notes", default_value: data.notes || "-", readonly: true }
  ];
}

function artistFields(data) {
  return [
    { name: "project_name", default_value: data.project || "-", readonly: true },
    { name: "artist_name", default_value: data.artistName || data.company || data.name || "-", readonly: true },
    { name: "artist_project_type", default_value: data.usage || "Artist release", readonly: true },
    { name: "artist_release_date", default_value: data.releaseDate || "-", readonly: true },
    { name: "artist_platforms", default_value: data.platforms || "Spotify, Apple Music, Deezer, YouTube Music", readonly: true },
    { name: "artist_territory", default_value: data.territory || "Monde entier", readonly: true },
    { name: "artist_distributor", default_value: data.distributor || "-", readonly: true },

    {
      name: "protools_warning",
      default_value:
        "CB Production ne garantit pas l’ouverture correcte de la session Pro Tools en cas d’absence de plugins, version incompatible, routing spécifique ou configuration différente.",
      readonly: true
    },

    { name: "notes", default_value: data.notes || "-", readonly: true }
  ];
}

function buildDocuSealFields(data, licenseType) {
  const fields = commonFields(data, licenseType);

  if (data.profile === "artist") {
    return fields.concat(artistFields(data));
  }

  return fields.concat(syncFields(data));
}

app.listen(PORT, () => {
  console.log(`🚀 CB Contracts Worker lancé sur http://localhost:${PORT}`);
});